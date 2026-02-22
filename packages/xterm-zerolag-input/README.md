# xterm-zerolag-input

Instant keystroke feedback overlay for [xterm.js](https://xtermjs.org/) — eliminates perceived input latency over high-RTT connections.

## The Problem

When using xterm.js over a remote connection (SSH web clients, cloud IDEs, mobile terminals), every keystroke takes a full round-trip to the server before appearing on screen. At 100-500ms RTT, typing feels sluggish and unresponsive.

## The Solution

`xterm-zerolag-input` renders typed characters **immediately** as a pixel-perfect DOM overlay positioned on the terminal's character grid. The overlay covers the terminal canvas at the prompt location, showing characters instantly while the server echo travels back. Once the server responds, the overlay is cleared and the real terminal output takes over.

**No changes to your backend needed.** The addon is purely client-side.

## Install

```bash
npm install xterm-zerolag-input
```

Zero runtime dependencies. Compatible with both `xterm` (pre-5.4) and `@xterm/xterm` (5.4+).

## Quick Start

```typescript
import { Terminal } from '@xterm/xterm';
import { ZerolagInputAddon } from 'xterm-zerolag-input';

const terminal = new Terminal();
terminal.open(document.getElementById('terminal')!);

// 1. Create addon with your prompt character
const zerolag = new ZerolagInputAddon({
  prompt: { type: 'character', char: '$', offset: 2 },
});
terminal.loadAddon(zerolag);

// 2. Wire your input handler
terminal.onData((data) => {
  if (data === '\r') {
    const text = zerolag.pendingText;
    zerolag.clear();
    ws.send(text + '\r');
  } else if (data === '\x7f') {
    const source = zerolag.removeChar();
    if (source === 'flushed') ws.send(data); // only backspace text already in PTY
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    zerolag.addChar(data);
  }
});

// 3. Re-render after terminal output (optional, for full-screen TUI frameworks)
terminal.onWriteParsed(() => {
  if (zerolag.hasPending) zerolag.rerender();
});
```

## Prompt Detection

The addon needs to know where user input starts on the terminal line. It scans the terminal buffer bottom-up looking for the prompt. Three strategies are supported:

### Character (default)

Scans bottom-up for a single character. Uses `lastIndexOf` to find the rightmost occurrence on each line.

```typescript
// Bash: user@host:~$
{ type: 'character', char: '$', offset: 2 }

// Zsh: user@host ~ %
{ type: 'character', char: '%', offset: 2 }

// Fish / Starship: ❯
{ type: 'character', char: '\u276f', offset: 2 }

// Simple arrow: >
{ type: 'character', char: '>', offset: 2 }
```

The `offset` is how many characters after the marker the user input begins (e.g., `"$ "` = 2, `">"` with no space = 1).

### Regex

For complex prompts. The global (`g`) flag is safely stripped to prevent `lastIndex` mutation across renders.

```typescript
// Match dollar sign at end of prompt
{ type: 'regex', pattern: /\$\s*$/, offset: 2 }

// Match specific virtualenv prompt
{ type: 'regex', pattern: /\(venv\)\s+\w+\s+%/, offset: 2 }
```

### Custom

Full control — provide your own function:

```typescript
{
  type: 'custom',
  offset: 0,
  find: (terminal) => {
    // Your logic here — return { row, col } or null
    // row is viewport-relative (0 = top of viewport)
    return { row: terminal.rows - 1, col: 0 };
  },
}
```

## API Reference

### `ZerolagInputAddon`

Implements xterm.js `ITerminalAddon`. Load via `terminal.loadAddon(addon)`.

The addon does **not** hook `terminal.onData()` — you wire your own input handler and call the methods below. This gives you full control over which keystrokes are echoed vs forwarded.

#### Input Methods

| Method | Description |
|--------|-------------|
| `addChar(char)` | Add a single printable character to the overlay. Call for `charCode >= 32, length === 1`. On first keystroke after empty state, auto-detects existing buffer text as flushed. |
| `appendText(text)` | Append multiple characters at once (paste). Same auto-detection as `addChar`. |
| `removeChar()` | Remove last character. See [removeChar Cascade](#removechar-cascade) below. |
| `clear()` | Clear all state (pending + flushed), hide overlay. Call on Enter, Ctrl+C, Escape, or any action that submits/cancels input. Resets buffer detection guard. |

#### removeChar Cascade

`removeChar()` returns `'pending' | 'flushed' | false` indicating the source of the removed character:

```
Step 1: pendingText non-empty  → pop last char    → return 'pending'
Step 2: flushed text exists    → decrement flushed → return 'flushed'
Step 3: both empty             → detect buffer     → return 'flushed' (if found)
Step 4: nothing found          →                   → return false
```

**How to use the return value:**

| Return | Meaning | Action |
|--------|---------|--------|
| `'pending'` | Removed a character that was never sent to PTY | Do nothing — no backspace needed |
| `'flushed'` | Removed a character that was already sent to PTY | Send `\x7f` (backspace) to PTY |
| `false` | Nothing to remove | Do nothing |

Step 3 handles tab completion and arrow-key edits: if the user tabs to complete a command and immediately hits backspace, the overlay detects the completed text from the terminal buffer and removes from it.

#### Flushed Text Tracking

"Flushed" text is text that has been sent to the PTY but whose echo hasn't arrived in the terminal buffer yet. This happens during:
- **Tab switching**: Pending overlay text is flushed to PTY before switching, then restored as flushed on switch-back
- **Tab completion**: Shell fills text on the prompt; overlay syncs via `detectBufferText()`

| Method | Description |
|--------|-------------|
| `setFlushed(count, text, render?)` | Mark characters as sent-but-unacknowledged. Pass `render=false` when restoring during a tab switch before the new buffer has loaded (prevents stale prompt column locking). Default: `true`. |
| `getFlushed()` | Returns `{ count: number, text: string }`. |
| `clearFlushed()` | Clear flushed state (call when server echo has arrived). |

#### Buffer Detection

The overlay can scan the terminal buffer for text that already exists after the prompt but wasn't typed through the overlay (tab completion, arrow-key edits, shell history).

| Method | Description |
|--------|-------------|
| `detectBufferText()` | Scan buffer for text after prompt. Returns the detected text string, or `null`. If found, sets it as flushed text. Guarded: only runs once per `clear()` cycle. |
| `resetBufferDetection()` | Re-enable detection (e.g., after tab completion response arrives). |
| `suppressBufferDetection()` | Prevent detection until next `clear()`. Use when switching to a session whose buffer has UI framework text (e.g., Ink status bars) after the prompt marker that would be falsely detected. |
| `undoDetection()` | Undo the last `detectBufferText()` — clears flushed state and re-enables detection. Use when tab completion detection found text matching the pre-tab baseline (no real completion happened) and needs to retry. |

#### Rendering

| Method | Description |
|--------|-------------|
| `rerender()` | Force re-render at current prompt position. Clears the render cache so the DOM is rebuilt. Call after terminal buffer reloads, full-screen redraws, or SSE reconnects. |
| `refreshFont()` | Re-read font properties (family, size, weight, letter-spacing, colors) from the terminal and re-render. Call after font size changes or theme switches. |

#### Prompt Utilities

| Method | Description |
|--------|-------------|
| `findPrompt()` | Find prompt position using the configured strategy. Returns `{ row, col }` (viewport-relative) or `null`. |
| `readPromptText()` | Read text after the prompt marker on the prompt line. Returns the text or `null`. |

#### State Properties

| Property | Type | Description |
|----------|------|-------------|
| `pendingText` | `string` | Characters typed but not acknowledged. Read-only. |
| `hasPending` | `boolean` | `true` if overlay has any content (pending or flushed). |
| `state` | `ZerolagInputState` | Read-only snapshot: `{ pendingText, flushedLength, flushedText, visible, promptPosition }`. Safe to call before `activate()` (returns `visible: false`). |

### Options

```typescript
interface ZerolagInputOptions {
  prompt?: PromptFinder;       // Default: { type: 'character', char: '>', offset: 2 }
  zIndex?: number;             // Default: 7
  backgroundColor?: string;    // Default: from terminal theme, then '#0d0d0d'
  foregroundColor?: string;    // Default: from computed .xterm-rows style, then theme, then '#eeeeee'
  showCursor?: boolean;        // Default: true
  cursorColor?: string;        // Default: from terminal theme cursor, then '#e0e0e0'
  scrollDebounceMs?: number;   // Default: 50
}
```

## Integration Patterns

### Buffered Input (hold until Enter)

The quick start example above uses buffered mode — characters accumulate in the overlay and are sent on Enter. This is common for remote shells where you want to batch input.

### Char-at-a-Time (send immediately)

For applications that need each keystroke sent immediately:

```typescript
terminal.onData((data) => {
  if (data === '\r') {
    zerolag.clear();
    ws.send('\r');
  } else if (data === '\x7f') {
    zerolag.removeChar(); // always 'pending' since nothing is buffered
    ws.send(data);
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    zerolag.addChar(data);
    ws.send(data);
    // The overlay shows the char immediately; the PTY echo will arrive later
    // and the overlay continues showing until the next rerender()
  }
});
```

### Tab Switching (multi-session)

When your app has multiple terminal sessions in tabs:

```typescript
function switchToSession(newSessionId: string) {
  // 1. Save current overlay state
  const pending = zerolag.pendingText;
  const { count, text } = zerolag.getFlushed();
  if (pending) {
    sendToPty(currentSessionId, pending); // flush unsent text to PTY
  }
  const totalCount = count + pending.length;
  const totalText = text + pending;
  savedFlushed.set(currentSessionId, { count: totalCount, text: totalText });
  zerolag.clear();

  // 2. Switch terminal buffer to new session
  loadSessionBuffer(newSessionId);

  // 3. Restore overlay state for new session
  zerolag.suppressBufferDetection(); // prevent false detection of UI text
  const saved = savedFlushed.get(newSessionId);
  if (saved) {
    zerolag.setFlushed(saved.count, saved.text, false); // render=false: buffer not loaded yet
  }

  // 4. Re-render after buffer loads
  terminal.write('', () => {
    zerolag.rerender(); // finds prompt, positions overlay correctly
  });
}
```

### Tab Completion Detection

After sending a Tab key to the PTY, you can detect whether the shell completed text:

```typescript
// Before Tab: snapshot baseline
const baseline = zerolag.readPromptText();
zerolag.clear();
sendToPty('\t');

// After PTY response arrives:
zerolag.resetBufferDetection();
const detected = zerolag.detectBufferText();
if (detected && detected !== baseline) {
  // Tab completion occurred — overlay now shows the completed text
  zerolag.rerender();
} else if (detected) {
  // Same text as before Tab — no real completion. Undo and retry next cycle.
  zerolag.undoDetection();
}
```

### Full-Screen TUI Frameworks (Ink, Blessed)

Frameworks like Ink redraw the entire screen on state changes, which can move the prompt. Re-render the overlay after each terminal write:

```typescript
terminal.onWriteParsed(() => {
  if (zerolag.hasPending) zerolag.rerender();
});
```

### SSE/WebSocket Reconnect

After a connection drop and reconnect, the terminal buffer reloads. Preserve overlay text across reconnects:

```typescript
function onReconnect() {
  // Buffer reloaded — re-render overlay at new prompt position
  zerolag.rerender();
}
```

### Terminal Resize

After the terminal is resized (columns/rows change), cell dimensions change:

```typescript
fitAddon.fit();
zerolag.rerender(); // recalculates cell dimensions and prompt position
```

### Font Size / Theme Changes

```typescript
terminal.options.fontSize = 18;
zerolag.refreshFont(); // re-caches font properties, re-renders
```

## How It Works

### Architecture

```
User types 'a'    addChar('a')     DOM overlay       Instant feedback
    │                  │               │                    │
    ▼                  ▼               ▼                    ▼
 Keyboard ─────► ZerolagAddon ─────► <span> at ─────► User sees 'a'
                      │              grid pos          immediately
                      │
                      │   (meanwhile, 200ms later...)
                      │
                      ▼
                PTY echo 'a' ─────► xterm.js canvas ─────► Canvas shows 'a'
                                                           (overlay still on top,
                                                            cleared on next clear())
```

### DOM Overlay Positioning

The overlay is a `<div>` inserted into xterm.js's `.xterm-screen` element:

```
div.xterm-screen (position: relative)
  ├── div.xterm-helpers (z-index: 5)
  ├── div.xterm-rows (z-index: auto)
  ├── div.xterm-selection (z-index: 1)
  ├── div.xterm-decoration-container (z-index: 6-7)
  └── div[zerolag overlay] (z-index: 7) ← our overlay
```

Each character is rendered as an absolutely-positioned `<span>` on the terminal's cell grid:

```
left = charIndex * cellWidth      (CSS pixels)
top  = lineIndex * cellHeight     (CSS pixels)
width = cellWidth                 (one cell per character)
```

Cell dimensions are read from xterm.js:
- **v5.x**: `terminal._core._renderService.dimensions.css.cell` (private API)
- **v7+**: `terminal.dimensions.css.cell` (public API, auto-detected)

### Font Matching

The overlay matches the terminal's font rendering by:
1. Caching `fontFamily`, `fontSize`, `fontWeight` from `terminal.options`
2. Reading `letterSpacing` from the computed style of `.xterm-rows`
3. Applying `-webkit-font-smoothing: antialiased` (matches canvas grayscale rendering)
4. Disabling ligatures via `font-feature-settings: 'liga' 0, 'calt' 0`
5. Using `text-rendering: geometricPrecision` for consistent glyph sizing

### Render Cache

A render key based on `displayText:startCol:row:col:totalCols:flushedOffset` prevents redundant DOM rebuilds. The cache is cleared by `rerender()`, `refreshFont()`, and internally on state changes that affect the display.

### Scroll Awareness

The overlay hides when the user scrolls away from the bottom of the terminal (where the prompt lives). A scroll listener on `.xterm-viewport` detects `viewportY !== baseY` and hides the overlay. When the user scrolls back to the bottom, a debounced re-render (50ms default) repositions the overlay.

### Prompt Column Locking

When flushed text exists, the prompt column is locked to prevent visual jitter from full-screen redraws that temporarily shift the prompt marker. The row is allowed to change (output scrolls the prompt down), but the column stays fixed until the flushed state is cleared.

### Text Wrapping

Long input that exceeds the terminal width is wrapped at column boundaries:
- Line 0: `(totalCols - startCol)` characters (starts after prompt)
- Line 1+: `totalCols` characters (starts at column 0)

This matches xterm.js's character-level wrapping behavior.

## Compatibility

- **xterm.js v5.x**: Uses private API `terminal._core._renderService.dimensions` for cell sizing. Fully supported.
- **xterm.js v7+** (future): Will automatically use public `terminal.dimensions` API when available.
- **Renderers**: Best results with the canvas/WebGL renderer. DOM renderer works but the overlay is redundant since DOM text is already positioned identically.

## Known Limitations

- **Canvas/WebGL font mismatch**: Minor sub-pixel differences between DOM overlay text and canvas-rendered text are possible. The per-character absolute positioning minimizes this, but it's not pixel-identical on all platforms.
- **Unicode/emoji**: Multi-byte characters (emoji, CJK) are not reliably echoed — they occupy variable cell widths that can't be predicted client-side. The overlay renders them at single-cell width, causing misalignment.
- **Misprediction**: If the server processes input differently than expected (e.g., password prompts that suppress echo), the overlay shows characters that aren't actually displayed. Call `clear()` when you detect such cases.
- **Prompt character in output**: If the prompt character appears in command output (e.g., `$` in a log message), the overlay may position at the wrong location. Use a more specific regex or custom finder to avoid this.

## License

MIT
