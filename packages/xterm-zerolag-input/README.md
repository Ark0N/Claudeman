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
    // Don't send to server yet — wait for Enter
    // Or send immediately if your app uses char-at-a-time mode
  }
});

// 3. Re-render after terminal output (optional, for frameworks like Ink)
terminal.onWriteParsed(() => {
  if (zerolag.hasPending) zerolag.rerender();
});
```

## Prompt Detection

The addon needs to know where user input starts on the terminal line. Three strategies are supported:

### Character (default)
Scans bottom-up for a single character:

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

The `offset` is how many characters after the marker the input begins (e.g., `"$ "` = 2).

### Regex
For complex prompts:

```typescript
// Match end-of-prompt patterns
{ type: 'regex', pattern: /\$\s*$/, offset: 2 }

// Match specific prompt format
{ type: 'regex', pattern: /\(venv\)\s+\w+\s+%/, offset: 2 }
```

### Custom
Full control:

```typescript
{
  type: 'custom',
  offset: 0,
  find: (terminal) => {
    // Your logic here — return { row, col } or null
    return { row: terminal.rows - 1, col: 0 };
  },
}
```

## API

### `ZerolagInputAddon`

Implements xterm.js `ITerminalAddon`. Load via `terminal.loadAddon(addon)`.

#### Input Methods

| Method | Description |
|--------|-------------|
| `addChar(char)` | Add a single printable character to the overlay |
| `appendText(text)` | Append multiple characters (e.g., paste) |
| `removeChar(): 'pending' \| 'flushed' \| false` | Remove last char. Returns source (`'pending'` = unsent, `'flushed'` = send backspace to PTY) or `false` |
| `clear()` | Clear all state and hide overlay |

#### Flushed Text Tracking

For scenarios where text has been sent to the PTY but the echo hasn't arrived yet (e.g., tab switching between sessions):

| Method | Description |
|--------|-------------|
| `setFlushed(count, text)` | Mark characters as sent-but-unacknowledged |
| `getFlushed()` | Get `{ count, text }` of flushed state |
| `clearFlushed()` | Clear flushed state (echo arrived) |

#### Rendering

| Method | Description |
|--------|-------------|
| `rerender()` | Force re-render at current prompt position |
| `refreshFont()` | Re-read font properties after size/theme change |

#### Buffer Detection

| Method | Description |
|--------|-------------|
| `detectBufferText()` | Scan buffer for text after prompt; returns detected text or `null` |
| `resetBufferDetection()` | Allow re-detection (auto-reset on `clear()`) |

#### Prompt Utilities

| Method | Description |
|--------|-------------|
| `findPrompt()` | Find prompt position using configured strategy |
| `readPromptText()` | Read text after prompt marker |

#### State

| Property | Type | Description |
|----------|------|-------------|
| `pendingText` | `string` | Characters typed but not acknowledged |
| `hasPending` | `boolean` | Whether overlay has any content |
| `state` | `ZerolagInputState` | Full read-only state snapshot |

### Options

```typescript
interface ZerolagInputOptions {
  prompt?: PromptFinder;       // Default: { type: 'character', char: '>', offset: 2 }
  zIndex?: number;             // Default: 7
  backgroundColor?: string;    // Default: from terminal theme
  foregroundColor?: string;    // Default: from terminal theme
  showCursor?: boolean;        // Default: true
  cursorColor?: string;        // Default: from terminal theme
  scrollDebounceMs?: number;   // Default: 50
}
```

## How It Works

1. A `<div>` overlay is inserted into xterm.js's `.xterm-screen` element at z-index 7
2. Each character is rendered as an absolutely-positioned `<span>` on the terminal's cell grid
3. Cell dimensions are read from xterm.js's render service (private API on v5, public on v7+)
4. Font properties (family, size, weight, letter-spacing) are cached from the terminal's computed styles
5. The overlay is hidden when the user scrolls away from the bottom of the terminal
6. A render cache (`renderKey`) prevents redundant DOM rebuilds at 60fps

### xterm.js DOM Structure

```
div.xterm-screen (position: relative)
  ├── div.xterm-helpers (z-index: 5)
  ├── div.xterm-rows (z-index: auto)
  ├── div.xterm-selection (z-index: 1)
  ├── div.xterm-decoration-container (z-index: 6-7)
  └── div.zerolag-overlay (z-index: 7) ← our overlay
```

## Compatibility

- **xterm.js v5.x**: Uses private API `terminal._core._renderService.dimensions` for cell sizing
- **xterm.js v7+** (future): Will automatically use public `terminal.dimensions` API

## Known Limitations

- **Canvas/WebGL renderer**: Minor sub-pixel font differences between DOM overlay and canvas text are possible. Best results with the DOM renderer.
- **Unicode/emoji**: Multi-byte characters (emoji, CJK) are not echoed (they have varying cell widths that are hard to predict client-side).
- **Misprediction**: If the server processes input differently than expected (e.g., password prompts that don't echo), the overlay will show characters that aren't actually there. Call `clear()` when you detect such cases.

## License

MIT
