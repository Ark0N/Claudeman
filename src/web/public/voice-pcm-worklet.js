/**
 * @fileoverview AudioWorklet that turns microphone audio into the PCM frames the
 * Claude voice endpoint expects.
 *
 * The endpoint is opened as `encoding=linear16, sample_rate=16000, channels=1`,
 * i.e. raw signed 16-bit little-endian mono. MediaRecorder cannot produce that
 * (it only emits container formats — webm/opus, mp4), which is why the Deepgram
 * path's capture code cannot be reused here: Deepgram sniffs the container,
 * Anthropic's endpoint does not.
 *
 * Sample rate is handled by the AudioContext, constructed at 16000 Hz so the
 * browser resamples the mic for us. This processor only converts Float32 [-1,1]
 * to Int16 and batches, because a raw 128-sample render quantum is a ~4 ms
 * WebSocket frame — 250 frames a second of pure overhead.
 *
 * Loaded via `audioWorklet.addModule()` from voice-input.js. Runs on the audio
 * thread: no DOM, no globals from the page.
 *
 * ⚠️ Edit this file and voice-input.js together. Static assets are served
 * `immutable` for a year and this one is fetched from JS, so it inherits its
 * cache-bust token from voice-input.js's script tag (see `_workletUrl()`); a
 * change here alone would keep serving the old copy to every returning browser.
 */

/** ~256 ms at 16 kHz. Big enough to keep frame overhead down, small enough that interim transcripts stay live. */
const FRAME_SAMPLES = 4096;

class PcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(FRAME_SAMPLES);
    this._offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // No input yet (mic still warming) — keep the processor alive.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // Clamp before scaling: values slightly outside [-1,1] are legal in Web Audio
      // and would wrap around to the opposite sign as Int16, which sounds like a click.
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this._buffer[this._offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      if (this._offset === FRAME_SAMPLES) {
        // Transfer a copy: the worklet keeps reusing its own buffer.
        const frame = new Int16Array(this._buffer);
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-frame-processor', PcmFrameProcessor);
