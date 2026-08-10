# Claude voice dictation in Codeman

Wire Codeman's existing mic button to the same speech-to-text service Claude Code's own
`/voice` mode uses, so dictation works with **no third-party API key** for anyone already
signed in to Claude Code on the server.

## Why the CLI's own voice mode cannot be reused directly

Claude Code 2.1.x ships voice input: `/voice hold|tap|off` arms it, the CLI opens the
**host's** microphone (native `audio-capture-napi`, falling back to `sox`/`arecord` on Linux
after probing `/proc/asound/cards`), streams PCM upstream and types the transcript into its
own composer.

Every part of that is on the wrong machine for Codeman. The CLI runs inside a tmux pane on
the server, which is typically headless and has no sound card at all, while the human is in
a browser on a phone somewhere else. Toggling `/voice` in the pane from Codeman would arm a
microphone nobody is sitting in front of. So Codeman keeps capturing audio in the browser,
where the user actually is, and only borrows the CLI's **transcription backend**.

## The backend, as the CLI uses it

Extracted from the 2.1.226 binary (`connectVoiceStream`):

| | |
| --- | --- |
| URL | `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream` |
| Query | `encoding=linear16`, `sample_rate=16000`, `channels=1`, `endpointing_ms=300`, `utterance_end_ms=1000`, `language=<lang>`, `use_conversation_engine=true`, `stt_provider=deepgram-nova3` |
| Headers | `Authorization: Bearer <Claude Code OAuth access token>`, `User-Agent`, `x-app: cli`, `anthropic-client-platform`, optional `x-config-keyterms` |
| Audio | raw binary frames, PCM signed 16-bit little-endian, 16 kHz, mono |
| Keepalive | `{"type":"KeepAlive"}` on open, then every 8 s |
| Finalize | `{"type":"CloseStream"}`, then wait for the endpoint frame |
| Downstream | `{"type":"TranscriptText"\|"TranscriptInterim","data":"…"}` (running interim), `{"type":"TranscriptEndpoint"}` (promotes the pending interim to final), `{"type":"TranscriptError",…}`, `{"type":"error","message":…}` |

Deepgram Nova-3 runs server-side, so the Deepgram-quality result arrives without a Deepgram
account. Verified against the live endpoint before this design was written: connect, stream
PCM, receive interims and an endpoint frame.

## Architecture

The browser cannot call that endpoint itself: it would need the OAuth bearer token in page
JavaScript (and CORS would refuse anyway). So the audio goes browser → Codeman → Anthropic,
and Codeman is the only thing that ever touches the token.

```
mic → AudioWorklet (Float32 → PCM16 @16 kHz)
    → wss://<codeman>/ws/voice/stream          [cookie/basic auth, Origin+Host guarded]
    → VoiceStreamRelay (reads ~/.claude/.credentials.json per connect)
    → wss://api.anthropic.com/api/ws/speech_to_text/voice_stream
    ← {"t":"transcript","text":…,"final":…}    → existing _insertText() path
```

Nothing about the insert path changes: the transcript lands in the same preview overlay,
the same direct/compose insert modes, the same green Send button.

### Server pieces

- **`src/claude-credentials.ts`** — locate and parse the Claude Code OAuth credentials.
  `parseClaudeCredentials()` is pure (JSON string + `now` → status) and unit-tested;
  `readClaudeOAuthToken()` wraps it with IO: `$CLAUDE_CONFIG_DIR/.credentials.json` or
  `~/.claude/.credentials.json`, and on macOS the login keychain
  (`security find-generic-password -s "Claude Code-credentials"`).
  **Read-only, always.** Codeman never writes credentials and never refreshes the token: a
  refresh rotates the refresh token, and racing Claude Code's own refresh could sign the
  user out of their CLI. An expired token surfaces as a plain "run a Claude session to
  refresh" error instead.
  The token is never logged, never returned by any endpoint, and never sent to the browser.

- **`src/web/voice-stream.ts`** — pure `buildVoiceStreamUrl()` / `buildVoiceStreamHeaders()` /
  `sanitizeKeyterms()` (ASCII-only, deduped, 1024-char cap, mirroring the CLI), plus
  `VoiceStreamRelay`, which owns one upstream socket: keepalive timer, audio passthrough,
  transcript translation, finalize, and the caps below.

- **`src/web/routes/voice-routes.ts`**
  - `GET /api/voice/status` → `{ available, reason, subscriptionType?, expiresAt? }`. Never
    the token. `available:false` with a machine-readable `reason` (`disabled`, `no-credentials`,
    `expired`) is what the settings row and the provider resolver read.
  - `GET /ws/voice/stream?language=&keyterms=` → the relay. Same upgrade guard as
    `/ws/sessions/:id/terminal`: allowed Host, same-site Origin, and the global auth hook has
    already run on the handshake.

Caps, because an open mic is an open pipe: one stream per connection, `MAX_VOICE_STREAMS`
concurrent server-wide, a hard `MAX_STREAM_MS` per stream, and a per-frame size cap. A tab
left recording cannot bill an unbounded amount of upstream audio.

### Frontend pieces

- **`voice-pcm-worklet.js`** — an `AudioWorkletProcessor` converting Float32 blocks to PCM16
  and posting ~256 ms frames back. `MediaRecorder` cannot produce raw PCM, which is why the
  existing Deepgram path (container audio, auto-detected) cannot be reused as-is. Falls back
  to `ScriptProcessorNode` where AudioWorklet is unavailable.
- **`ClaudeVoiceProvider`** in `voice-input.js` — mirrors `DeepgramProvider`'s shape
  (`start({language, keyterms, onStream, onResult, onError, onEnd})`) so `VoiceInput` treats
  the three providers uniformly.
- **Provider resolution** — new `voiceSettings.provider`: `auto` (default) | `claude` |
  `deepgram` | `webspeech`. `auto` picks Claude when `/api/voice/status` reports it
  available, else Deepgram when a key is set, else Web Speech. Pinning a provider always
  wins, so an existing Deepgram user can keep exactly what they have.

### Settings

- `claudeVoiceEnabled` — synced, **default OFF**, gating the whole server side. Off is the
  honest default: turning it on means this machine's Claude subscription starts paying for
  transcription for whoever can reach the UI, and the audio goes to Anthropic rather than to
  wherever it went before. One switch in Settings → Voice, and the mic works with no key.
- `voiceSettings.provider` — per the resolution table above; joins the existing synced
  `voiceSettings` object.

## Things worth knowing

- **This uses an undocumented endpoint with subscription credentials.** It is the user's own
  token, on the user's own machine, driving the user's own Claude Code install, but it is not
  a published API and Anthropic can change or restrict it. Default-OFF is deliberate; the
  Deepgram and Web Speech paths stay untouched as the supported fallbacks.
- **Multi-user mode**: every user's dictation would run on the server owner's Claude
  credentials, exactly as every user's *sessions* already run on them. Consistent, but worth
  stating out loud in the settings copy.
- **Token lifetime** is about 8 hours, refreshed by Claude Code itself whenever it runs. The
  relay re-reads the file on every connect rather than caching, so a refresh is picked up on
  the next press of the mic.
- **HTTPS or localhost**: `getUserMedia` needs a secure context. Prod is HTTPS behind
  `tailscale serve`, so this is already satisfied; the existing error copy covers the rest.
