/**
 * @fileoverview Pure byte-stream to input-event parser for raw-mode stdin.
 *
 * Stateful (a sequence can arrive split across reads, and a UTF-8 character can
 * be split mid-code-point) but pure: it owns a byte buffer and nothing else, no
 * stdin, no timers. The one timing decision a terminal forces on us stays with
 * the caller: a lone ESC is indistinguishable from the start of an arrow key
 * until something either follows it or does not, so the parser HOLDS a trailing
 * ESC and the caller calls `flush()` after ~30ms of silence to turn it into an
 * Escape event.
 *
 * Unknown sequences are swallowed rather than leaked as text: a stray
 * `CSI 200~` must never end up typed into a prompt composer.
 *
 * @module tui/tui-keys
 */

/** Keys with a name rather than a character. */
export type TuiNamedKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'delete'
  | 'insert';

export type TuiMouseKind = 'press' | 'release' | 'wheel-up' | 'wheel-down';

/** Discriminated union, exhaustive-switch friendly (see `utils/assertNever`). */
export type TuiInputEvent =
  | { type: 'char'; value: string }
  | { type: 'enter' }
  | { type: 'tab' }
  | { type: 'backspace' }
  | { type: 'escape' }
  | { type: 'ctrl'; key: string }
  | { type: 'alt'; value: string }
  | { type: 'key'; name: TuiNamedKey }
  | { type: 'mouse'; kind: TuiMouseKind; x: number; y: number; button: number };

export interface TuiKeyParser {
  /** Decode a chunk. Incomplete tails are held for the next call. */
  feed(chunk: Buffer | string): TuiInputEvent[];
  /** Resolve a held ESC (the caller's disambiguation timer fired). */
  flush(): TuiInputEvent[];
  /** Bytes currently held back. Exposed for the ESC timer and for tests. */
  pending(): number;
}

/**
 * An unterminated sequence longer than this is not a sequence: the held bytes
 * are dropped whole, so a garbage burst can neither wedge the parser nor leak
 * its bytes into a prompt as typed characters.
 */
const MAX_PENDING_BYTES = 64;

/** Bytes in a UTF-8 sequence given its lead byte; 0 for a byte that cannot lead one. */
function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

const CSI_FINAL_KEYS: Record<string, TuiNamedKey> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};

/** `CSI <n> ~` keys, by their first numeric parameter. */
const CSI_TILDE_KEYS: Record<number, TuiNamedKey> = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
};

/** Result of trying to parse one sequence off the front of the buffer. */
type ParseStep = { consumed: number; events: TuiInputEvent[] } | 'incomplete';

const NOTHING: TuiInputEvent[] = [];

export function createKeyParser(): TuiKeyParser {
  let buf: Buffer = Buffer.alloc(0);

  /** Parse the CSI/SS3 sequence that starts at buf[0] === ESC. */
  const parseEscape = (): ParseStep => {
    if (buf.length < 2) return 'incomplete';
    const second = buf[1];

    // SS3 (`ESC O <final>`): the arrows/Home/End of application-cursor mode.
    if (second === 0x4f) {
      if (buf.length < 3) return 'incomplete';
      const name = CSI_FINAL_KEYS[String.fromCharCode(buf[2])];
      return { consumed: 3, events: name ? [{ type: 'key', name }] : NOTHING };
    }

    // ESC followed by a printable character IN THE SAME READ is Alt+that key:
    // that is how every terminal sends a meta chord. A lone Esc cannot look
    // like this, because a buffer holding only ESC returns 'incomplete' above
    // and is flushed as `escape` when the read ends, which is the standard way
    // to tell the two apart without a timer.
    //
    // ⚠️ Three characters are deliberately NOT treated as Alt chords, because
    // the terminal uses them to introduce sequences and a chord is
    // indistinguishable from one: `[` (CSI) and `O` (SS3) would swallow every
    // arrow key, and `]` (OSC) would swallow a terminal's colour-query reply.
    // Alt+[ and Alt+] therefore cannot exist in a terminal at all, which is why
    // the list binds bare `[` and `]` for the same job.
    if (second !== 0x5b) {
      if (second >= 0x20 && second <= 0x7e && second !== 0x4f && second !== 0x5d) {
        return { consumed: 2, events: [{ type: 'alt', value: String.fromCharCode(second) }] };
      }
      return { consumed: 1, events: [{ type: 'escape' }] };
    }

    let j = 2;
    while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x3f) j++;
    while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x2f) j++;
    if (j >= buf.length) return 'incomplete';
    const final = String.fromCharCode(buf[j]);
    const params = buf.subarray(2, j).toString('latin1');
    const consumed = j + 1;

    // X10 mouse (`CSI M` + 3 raw bytes): swallowed, but its payload bytes must
    // be consumed or they would surface as typed characters.
    if (params === '' && final === 'M') {
      if (buf.length < consumed + 3) return 'incomplete';
      return { consumed: consumed + 3, events: NOTHING };
    }

    if (params.startsWith('<') && (final === 'M' || final === 'm')) {
      return { consumed, events: parseSgrMouse(params.slice(1), final) };
    }

    if (final === '~') {
      const name = CSI_TILDE_KEYS[Number.parseInt(params, 10)];
      return { consumed, events: name ? [{ type: 'key', name }] : NOTHING };
    }

    // Modified arrows (`CSI 1;5A`) carry the same final byte; the modifier is
    // dropped rather than exposed, since nothing in the keymap wants it yet.
    const named = CSI_FINAL_KEYS[final];
    return { consumed, events: named ? [{ type: 'key', name: named }] : NOTHING };
  };

  const parseSgrMouse = (params: string, final: string): TuiInputEvent[] => {
    const parts = params.split(';');
    if (parts.length < 3) return NOTHING;
    const button = Number.parseInt(parts[0], 10);
    const x = Number.parseInt(parts[1], 10);
    const y = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(button) || !Number.isFinite(x) || !Number.isFinite(y)) return NOTHING;
    if (button >= 64) {
      // 64 = wheel up, 65 = wheel down (the low bit is the direction).
      const kind: TuiMouseKind = (button & 1) === 1 ? 'wheel-down' : 'wheel-up';
      return [{ type: 'mouse', kind, x, y, button }];
    }
    // Motion reports (bit 32) would fire on every pixel of a drag; nothing in
    // the keymap consumes them, so they are swallowed here rather than upstream.
    if ((button & 32) === 32) return NOTHING;
    return [{ type: 'mouse', kind: final === 'M' ? 'press' : 'release', x, y, button }];
  };

  /** Parse one non-escape byte (or one UTF-8 character) off the front. */
  const parseByte = (): ParseStep => {
    const b = buf[0];
    // LF counts as Enter because some terminals send it for Return; the cost is
    // that Ctrl+J is not bindable, which no key in the plan's keymap wants.
    if (b === 0x0d || b === 0x0a) return { consumed: 1, events: [{ type: 'enter' }] };
    if (b === 0x09) return { consumed: 1, events: [{ type: 'tab' }] };
    if (b === 0x7f || b === 0x08) return { consumed: 1, events: [{ type: 'backspace' }] };
    if (b === 0x00) return { consumed: 1, events: [{ type: 'ctrl', key: '@' }] };
    if (b >= 0x01 && b <= 0x1a) {
      return { consumed: 1, events: [{ type: 'ctrl', key: String.fromCharCode(b + 0x60) }] };
    }
    if (b >= 0x1c && b <= 0x1f) {
      return { consumed: 1, events: [{ type: 'ctrl', key: String.fromCharCode(b + 0x40) }] };
    }
    const length = utf8SequenceLength(b);
    if (length === 0) return { consumed: 1, events: NOTHING };
    if (buf.length < length) return 'incomplete';
    const value = buf.subarray(0, length).toString('utf8');
    // A lead byte followed by junk decodes to U+FFFD; that is corruption on the
    // wire, not something to type into a composer. Only the bad lead byte is
    // dropped, so whatever valid input followed it still decodes.
    if (value.includes('�')) return { consumed: 1, events: NOTHING };
    return { consumed: length, events: [{ type: 'char', value }] };
  };

  /** Drain the buffer, stopping at the first incomplete sequence. */
  const drain = (events: TuiInputEvent[]): void => {
    while (buf.length > 0) {
      const step = buf[0] === 0x1b ? parseEscape() : parseByte();
      if (step === 'incomplete') {
        if (buf.length > MAX_PENDING_BYTES) buf = Buffer.alloc(0);
        return;
      }
      for (const event of step.events) events.push(event);
      buf = buf.subarray(step.consumed);
    }
  };

  return {
    feed(chunk: Buffer | string): TuiInputEvent[] {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      buf = buf.length === 0 ? Buffer.from(bytes) : Buffer.concat([buf, bytes]);
      const events: TuiInputEvent[] = [];
      drain(events);
      return events;
    },

    flush(): TuiInputEvent[] {
      const events: TuiInputEvent[] = [];
      if (buf.length > 0 && buf[0] === 0x1b) {
        events.push({ type: 'escape' });
        buf = buf.subarray(1);
        drain(events);
      }
      return events;
    },

    pending(): number {
      return buf.length;
    },
  };
}
