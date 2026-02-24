# Voice Input Implementation Plan

## Executive Summary

Add a microphone button to Claudeman (desktop + mobile) that uses the **Web Speech API** for real-time speech-to-text. Users tap the mic, speak their prompt, see live interim transcription, review the text, and press Enter to send. Zero server cost, sub-200ms perceived latency, ~90% browser coverage (Chrome + Safari).

---

## Architecture Decision: Web Speech API (Primary, No Fallback for MVP)

### Why Web Speech API
- **Free** — no API keys, no server-side processing, no cost per minute
- **Fast** — interim results in ~150ms, feels real-time
- **Simple** — ~80 lines of JS, no server changes needed for MVP
- **Good coverage** — Chrome (desktop + Android) + Safari (desktop + iOS) = ~90% of users

### Why NOT a server-side fallback (for MVP)
- Firefox has <5% desktop share, even less on mobile
- Edge's Web Speech API is broken despite being Chromium (events don't fire)
- Adding Whisper/Deepgram requires API keys, server endpoints, audio streaming — significant complexity
- **Decision**: Hide the mic button on unsupported browsers. Add server fallback in Phase 2 if demand exists.

### Browser Support Matrix

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome Desktop | YES | `webkitSpeechRecognition`, sends to Google servers |
| Chrome Android | YES | Same as desktop |
| Safari Desktop | YES | `webkitSpeechRecognition`, requires Siri enabled |
| Safari iOS | YES | Shows system permission modal |
| Firefox | NO | API exists behind flag but disabled by default |
| Edge | NO | Events don't fire despite API present |

### Microphone Permissions
- HTTPS required, but **localhost is exempt** (Claudeman default)
- Claudeman with `--https` also works
- Chrome: persistent permission per domain (ask once)
- Safari: re-asks per page reload (less persistent, no workaround)
- Can pre-request via `getUserMedia()` on first interaction to avoid delay later

---

## UX Design

### Interaction Model: Toggle Mode
- **Tap mic** → start recording (button turns red, pulses)
- **Tap again** → stop recording (text inserted into terminal)
- Auto-stop after **5 seconds of silence** as safety net
- Single-utterance mode (`continuous: false`) — perfect for prompt dictation

Why toggle over push-to-talk: Terminal prompts are short, toggle is simpler, works one-handed on mobile, impossible to accidentally leave recording on with the auto-stop safety net.

### Visual Feedback

**While recording:**
1. Mic button turns red with CSS pulsing animation (1.5s breathing cycle)
2. Interim text appears in a small overlay near the terminal bottom, styled in dim/italic to indicate "draft"
3. Text updates in real-time as user speaks (~150ms updates)

**On completion:**
1. Final text inserted at terminal prompt via `sendInput()`
2. User reviews text, presses Enter when ready
3. Button returns to idle state (gray/outlined)

### Text Flow
```
User speaks → SpeechRecognition interim result → Show in preview overlay
                                               → Replace preview on each update
           → SpeechRecognition final result    → Insert text via sendInput()
                                               → Clear preview overlay
                                               → User presses Enter to submit
```

**Critical: NO auto-submit.** User must press Enter. This is a terminal where wrong commands could be destructive.

### Error States

| Error | Behavior |
|-------|----------|
| Browser unsupported | Hide mic button entirely (feature detection) |
| No mic permission | Show toast: "Microphone access needed" with retry link |
| Permission denied | Show toast: "Mic blocked. Check browser settings" |
| No speech detected (5s) | Auto-stop, show brief "No speech detected" toast |
| Network error | Show toast: "Voice input requires internet" |
| Accidental tap | Tap again immediately to cancel; ignore <0.5s recordings |

---

## Implementation Details

### Phase 1: MVP (Single PR)

#### Files to Modify

| File | Changes |
|------|---------|
| `src/web/public/app.js` | `VoiceInput` class, keyboard shortcut, integration with `KeyboardAccessoryBar` |
| `src/web/public/index.html` | Desktop mic button in `toolbar-right` |
| `src/web/public/styles.css` | Desktop voice button styles, recording animation |
| `src/web/public/mobile.css` | Mobile voice button in accessory bar, recording animation |

**No server-side changes needed.** Voice runs entirely in the browser.

#### 1. VoiceInput Class (`app.js`)

New singleton class (~80 lines) managing the Web Speech API lifecycle:

```javascript
class VoiceInput {
  constructor() {
    this.recognition = null;
    this.isRecording = false;
    this.supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    this.silenceTimeout = null;
    this.previewEl = null;

    if (this.supported) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.recognition = new SR();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';
      this.recognition.maxAlternatives = 1;

      this.recognition.onresult = (e) => this._onResult(e);
      this.recognition.onerror = (e) => this._onError(e);
      this.recognition.onend = () => this._onEnd();
    }
  }

  toggle() { this.isRecording ? this.stop() : this.start(); }

  start() {
    if (!this.supported || this.isRecording) return;
    this.isRecording = true;
    this._updateButtons('recording');
    this._showPreview('');
    this.recognition.start();
    // Auto-stop after 5s silence
    this._resetSilenceTimeout();
  }

  stop() {
    if (!this.isRecording) return;
    this.isRecording = false;
    clearTimeout(this.silenceTimeout);
    this._updateButtons('idle');
    this.recognition.stop();
  }

  _onResult(event) {
    this._resetSilenceTimeout();
    let interim = '', final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }

    if (final) {
      this._hidePreview();
      this._insertText(final);
      this.stop();
    } else {
      this._showPreview(interim);
      // iOS workaround: isFinal is always false
      this._iosStabilityCheck(interim);
    }
  }

  _onError(event) {
    this.stop();
    if (event.error === 'not-allowed') {
      app.showToast('Microphone access denied. Check browser settings.', 'error');
    } else if (event.error === 'no-speech') {
      // Silent fail — auto-stop is enough
    } else if (event.error === 'network') {
      app.showToast('Voice input requires internet connection.', 'error');
    }
  }

  _onEnd() {
    if (this.isRecording) this.stop(); // Cleanup if ended unexpectedly
  }

  _insertText(text) {
    if (!app.activeSessionId || !text.trim()) return;
    app.sendInput(text.trim());
    // Don't add \r — let user review and press Enter
  }

  _resetSilenceTimeout() {
    clearTimeout(this.silenceTimeout);
    this.silenceTimeout = setTimeout(() => this.stop(), 5000);
  }

  // iOS Safari: isFinal is always false. Detect stability.
  _lastTranscript = '';
  _stabilityTimer = null;
  _iosStabilityCheck(transcript) {
    if (transcript !== this._lastTranscript) {
      this._lastTranscript = transcript;
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = setTimeout(() => {
        this._hidePreview();
        this._insertText(transcript);
        this.stop();
      }, 750);
    }
  }

  _showPreview(text) { /* Update DOM overlay with interim text */ }
  _hidePreview() { /* Remove DOM overlay */ }
  _updateButtons(state) { /* Toggle .recording class on mic buttons */ }
}
```

#### 2. Mobile Button (KeyboardAccessoryBar)

**Insert in HTML template** (after `/compact` button, before `paste`):
```html
<button class="accessory-btn accessory-btn-voice" data-action="voice" title="Voice input">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
</button>
```

**Add to handleAction switch:**
```javascript
case 'voice':
  if (typeof voiceInput !== 'undefined') voiceInput.toggle();
  break;
```

**Conditionally show:** Only render the button if `VoiceInput.supported` is true.

#### 3. Desktop Button (index.html)

**Insert in `toolbar-right`:**
```html
<div class="toolbar-right">
  <button class="btn-toolbar btn-voice" id="voiceInputBtn" onclick="app.toggleVoiceInput()"
          title="Voice input (Ctrl+Shift+V)" style="display: none;">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  </button>
</div>
```

Show via JS on init: `if (voiceInput.supported) voiceInputBtn.style.display = '';`

#### 4. Keyboard Shortcut

**Ctrl+Shift+V** (in `setupEventListeners` keydown handler):
```javascript
if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
  e.preventDefault();
  if (typeof voiceInput !== 'undefined') voiceInput.toggle();
}
```

Why Ctrl+Shift+V: Ctrl+V is paste (sacred), but Ctrl+Shift+V ("paste without formatting") has no meaning in a terminal context. V for Voice is memorable.

#### 5. CSS Styles

**styles.css (desktop):**
```css
.btn-voice.recording {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.4);
  color: #ef4444;
  animation: voice-pulse 1.5s ease-in-out infinite;
}

@keyframes voice-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.08); opacity: 0.8; }
}

.voice-preview {
  position: fixed;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.85);
  color: rgba(255, 255, 255, 0.6);
  font-style: italic;
  padding: 6px 16px;
  border-radius: 8px;
  font-size: 0.85rem;
  max-width: 80%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 100;
  pointer-events: none;
}
```

**mobile.css:**
```css
.accessory-btn-voice.recording {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.4);
  color: #ef4444;
  animation: voice-pulse 1.5s ease-in-out infinite;
}
```

#### 6. Interim Text Preview Overlay

A small floating `<div>` showing live transcription:
```javascript
_showPreview(text) {
  if (!this.previewEl) {
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'voice-preview';
    document.body.appendChild(this.previewEl);
  }
  this.previewEl.textContent = text || 'Listening...';
  this.previewEl.style.display = '';
}

_hidePreview() {
  if (this.previewEl) {
    this.previewEl.style.display = 'none';
  }
}
```

#### 7. Cleanup (Memory Leak Prevention)

Following Claudeman's cleanup patterns:
- Store `VoiceInput` instance as `window.voiceInput` singleton
- On SSE reconnect (`handleInit()`): stop any active recording, reset state
- Remove preview element from DOM in cleanup
- Clear all timeouts (silenceTimeout, stabilityTimer)

#### 8. Accessibility

```html
<button role="button" aria-label="Start voice input" aria-pressed="false">
```
- Toggle `aria-pressed` and `aria-label` between "Start/Stop voice input"
- Use `aria-live="polite"` region for interim text preview
- Mic button focusable and activatable via Enter/Space

---

### Phase 2: Enhancements (Future)

1. **Server-side Whisper fallback** — For Firefox/Edge users, add `/api/transcribe` endpoint that accepts audio blobs and forwards to OpenAI Whisper API. Requires `OPENAI_API_KEY` in env.
2. **Language selector** — Settings dropdown to change `recognition.lang` (es-ES, de-DE, fr-FR, etc.)
3. **Waveform visualization** — Small canvas with `AnalyserNode` bars near mic button
4. **Haptic feedback** — `navigator.vibrate(50)` on start, `navigator.vibrate([30,50,30])` on stop (mobile)
5. **Configurable auto-stop timeout** — Settings slider: 3-10 seconds
6. **Voice command shortcuts** — "clear", "compact", "new session" recognized as commands
7. **Recording duration indicator** — Small timer next to mic button

---

## Testing Plan

### Manual Testing Matrix

| Scenario | Chrome Desktop | Safari Desktop | Chrome Android | Safari iOS |
|----------|---------------|----------------|----------------|------------|
| Mic button visible | | | | |
| Click starts recording | | | | |
| Pulse animation plays | | | | |
| Interim text appears | | | | |
| Final text inserted | | | | |
| Click stops recording | | | | |
| Auto-stop on silence | | | | |
| Permission denied error | | | | |
| No speech timeout | | | | |
| Ctrl+Shift+V shortcut | | | N/A | N/A |
| Button hidden on Firefox | N/A | N/A | N/A | N/A |

### Automated Tests (Playwright)

```javascript
// In mobile-test/ or a new test file
test('voice button visible on Chrome', async ({ page }) => {
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const voiceBtn = page.locator('#voiceInputBtn');
  // Chrome supports SpeechRecognition, button should be visible
  await expect(voiceBtn).toBeVisible();
});

test('voice button hidden on Firefox', async ({ page, browserName }) => {
  test.skip(browserName !== 'firefox');
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  const voiceBtn = page.locator('#voiceInputBtn');
  await expect(voiceBtn).not.toBeVisible();
});
```

Note: Actual SpeechRecognition can't be tested in headless Playwright (no mic). Tests verify button visibility and state toggling only.

---

## Implementation Sequence

1. Add `VoiceInput` class to `app.js` (~80 lines)
2. Add desktop button to `index.html` `toolbar-right`
3. Add mobile button to `KeyboardAccessoryBar` template in `app.js`
4. Add CSS styles to `styles.css` and `mobile.css`
5. Wire keyboard shortcut `Ctrl+Shift+V` in `setupEventListeners`
6. Add feature detection: hide button on unsupported browsers
7. Add preview overlay for interim results
8. Add cleanup in `handleInit()` for SSE reconnect
9. Test on Chrome desktop + Android + Safari iOS
10. COM

**Estimated scope**: ~200 lines of JS, ~40 lines of CSS, ~5 lines of HTML. Single PR, no server changes.

---

## Key Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| iOS `isFinal` always false | High | Stability timer workaround (750ms) |
| Chrome auto-stops after silence | Medium | Silence timeout handles this gracefully |
| Safari re-asks mic permission per reload | Medium | Acceptable UX; no workaround exists |
| Edge events don't fire | High | Feature detection hides button |
| User on Firefox feels excluded | Low | <5% share; Phase 2 adds Whisper fallback |
| Noisy environment → bad transcription | Low | Web Speech API handles noise internally; not our problem |
| 60-second Chrome limit | Low | Prompts are short; auto-stop at 5s silence covers this |
