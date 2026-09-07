/**
 * Recover explicit keyCode 229 terminal input when a browser reports a key but
 * never mutates xterm's helper textarea. xterm remains authoritative whenever
 * it emits canonical data or the browser enters a real composition lifecycle.
 */
(function (global) {
  'use strict';

  const LATE_INPUT_WINDOW_MS = 250;
  const MAX_RECOVERED_RECORDS = 32;

  function explicitTerminalDataForEvent(event) {
    if (!event || event.type !== 'keydown' || event.isComposing) return null;
    if (event.ctrlKey || event.altKey || event.metaKey) return null;
    try {
      if (event.getModifierState?.('AltGraph')) return null;
    } catch {
      return null;
    }

    const key = event.key;
    if (key === 'Enter') return '\r';
    if (key === 'Process' || key === 'Unidentified' || key === 'Dead') return null;
    if (typeof key !== 'string' || Array.from(key).length !== 1) return null;
    const codePoint = key.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return null;
    return key;
  }

  function terminalDataForEvent(event) {
    if (event?.keyCode !== 229) return null;
    return explicitTerminalDataForEvent(event);
  }

  function create(options) {
    const textarea = options?.textarea;
    const emitRecovered = options?.emitRecovered;
    if (!textarea?.addEventListener || !textarea?.removeEventListener || typeof emitRecovered !== 'function') {
      return null;
    }

    const enqueueMicrotask = options.queueMicrotask || global.queueMicrotask.bind(global);
    const setTimer = options.setTimer || global.setTimeout.bind(global);
    const clearTimer = options.clearTimer || global.clearTimeout.bind(global);
    const now = options.now || (() => global.performance?.now?.() ?? Date.now());

    let destroyed = false;
    let keySequence = 0;
    let activeKey = null;
    let beforeInputClaim = null;
    const pending = [];
    const recovered = [];

    function removePending(candidate) {
      const index = pending.indexOf(candidate);
      if (index !== -1) pending.splice(index, 1);
      if (candidate.timer !== null) {
        try {
          clearTimer(candidate.timer);
        } catch {}
        candidate.timer = null;
      }
      candidate.active = false;
    }

    function cancelPending(predicate = () => true) {
      for (const candidate of [...pending]) {
        if (predicate(candidate)) removePending(candidate);
      }
    }

    function pruneRecovered() {
      const current = now();
      for (let index = recovered.length - 1; index >= 0; index -= 1) {
        if (recovered[index].expiresAt < current) recovered.splice(index, 1);
      }
    }

    function handleKeyEvent(event) {
      if (destroyed || event?.type !== 'keydown') return;
      const record = {
        sequence: ++keySequence,
        data: explicitTerminalDataForEvent(event),
        candidate: null,
      };
      activeKey = record;
      const data = terminalDataForEvent(event);
      const candidate = data === null ? null : { sequence: record.sequence, data, active: true, timer: null };
      if (candidate) {
        record.candidate = candidate;
        pending.push(candidate);
      }
      try {
        // The custom key handler runs before xterm's CompositionHelper. Queueing
        // our timer from a microtask places it after xterm's own zero-delay
        // textarea diff, while keeping the recovery delay to one browser task.
        enqueueMicrotask(() => {
          if (activeKey === record) activeKey = null;
          if (destroyed || !candidate?.active) return;
          try {
            candidate.timer = setTimer(() => {
              if (destroyed || !candidate.active) return;
              removePending(candidate);
              try {
                emitRecovered(candidate.data);
              } catch {
                // No dedupe record is retained when delivery fails. A later
                // canonical xterm value must remain free to pass through.
                return;
              }
              pruneRecovered();
              recovered.push({
                sequence: candidate.sequence,
                data: candidate.data,
                expiresAt: now() + LATE_INPUT_WINDOW_MS,
                claimedByInput: false,
              });
              if (recovered.length > MAX_RECOVERED_RECORDS) {
                recovered.splice(0, recovered.length - MAX_RECOVERED_RECORDS);
              }
            }, 0);
          } catch {
            removePending(candidate);
          }
        });
      } catch {
        if (activeKey === record) activeKey = null;
        if (candidate) removePending(candidate);
      }
    }

    function claimCanonicalInput(data) {
      if (activeKey?.data === data) {
        if (activeKey.candidate?.active) removePending(activeKey.candidate);
        return;
      }
      const matchingPending = pending.find((candidate) => candidate.active && candidate.data === data);
      if (matchingPending) {
        removePending(matchingPending);
        return;
      }
      const matchingRecovery = recovered.find((record) => !record.claimedByInput && record.data === data);
      if (matchingRecovery) matchingRecovery.claimedByInput = true;
    }

    function onCanonicalInput(event) {
      if (destroyed) return;
      const inputData = typeof event?.data === 'string' ? event.data : null;
      if (inputData === null) return;
      if (event.type === 'input' && beforeInputClaim?.data === inputData) {
        beforeInputClaim = null;
        return;
      }
      if (event.type === 'beforeinput') {
        const claim = { data: inputData };
        beforeInputClaim = claim;
        try {
          enqueueMicrotask(() => {
            if (beforeInputClaim === claim) beforeInputClaim = null;
          });
        } catch {
          beforeInputClaim = null;
        }
      }
      claimCanonicalInput(inputData);
    }

    function resetForCompositionOrFocusLoss() {
      if (destroyed) return;
      keySequence += 1;
      activeKey = null;
      beforeInputClaim = null;
      cancelPending();
      recovered.splice(0);
    }

    function consumeTerminalData(data) {
      if (destroyed) return false;
      pruneRecovered();

      if (activeKey?.data === data) {
        if (activeKey.candidate?.active) removePending(activeKey.candidate);
        return false;
      }

      const canonical = pending.find((candidate) => candidate.active && candidate.data === data);
      if (canonical) {
        removePending(canonical);
        return false;
      }

      const duplicateIndex = recovered.findIndex((record) => record.data === data && record.claimedByInput);
      if (duplicateIndex === -1) return false;
      recovered.splice(duplicateIndex, 1);
      return true;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      activeKey = null;
      beforeInputClaim = null;
      cancelPending();
      recovered.splice(0);
      try {
        textarea.removeEventListener('beforeinput', onCanonicalInput, true);
        textarea.removeEventListener('input', onCanonicalInput, true);
        textarea.removeEventListener('compositionstart', resetForCompositionOrFocusLoss, true);
        textarea.removeEventListener('blur', resetForCompositionOrFocusLoss, true);
      } catch {}
    }

    try {
      textarea.addEventListener('beforeinput', onCanonicalInput, true);
      textarea.addEventListener('input', onCanonicalInput, true);
      textarea.addEventListener('compositionstart', resetForCompositionOrFocusLoss, true);
      textarea.addEventListener('blur', resetForCompositionOrFocusLoss, true);
    } catch {
      destroy();
      return null;
    }

    return Object.freeze({ handleKeyEvent, consumeTerminalData, destroy });
  }

  global.CodemanKeyCode229Recovery = Object.freeze({ create, terminalDataForEvent });
})(typeof window !== 'undefined' ? window : globalThis);
