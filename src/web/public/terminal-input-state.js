/**
 * @fileoverview Durable editable terminal input state, scoped by session.
 *
 * This store owns the complete local draft record and its persistence lifecycle.
 * It deliberately does not render text or deliver bytes to a PTY. Callers provide
 * snapshots from their input adapters and explicitly consume `handoff().flushText`
 * through Codeman's separate exactly-once delivery layer.
 *
 * @globals {TerminalInputStateStore}
 * @dependency None
 * @loadorder 5.75 of 16 - loaded after input-cjk.js, before app.js
 */

class TerminalInputStateStore {
  constructor(options = {}) {
    this._storageKey = options.storageKey || 'codeman:sessionDrafts';
    this._snapshotPrefix = options.snapshotPrefix || 'codeman-xs-';
    this._debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 150;
    this._now = typeof options.now === 'function' ? options.now : Date.now;
    const setTimer = typeof options.setTimer === 'function' ? options.setTimer : globalThis.setTimeout;
    const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : globalThis.clearTimeout;
    this._setTimer = (callback, delay) => setTimer(callback, delay);
    this._clearTimer = (timer) => clearTimer(timer);
    this._storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : this._resolveStorage();
    this._drafts = new Map();
    this._persistTimer = null;
    this.load();
  }

  capture(sessionId, snapshot, options = {}) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return this.set(
      sessionId,
      {
        // OS composition sessions cannot survive a page suspension. Preserve
        // the visible candidate as ordinary editable text on capture.
        pendingText: this._text(source.pendingText) + this._text(source.compositionText),
        flushedText: this._text(source.flushedText),
        cjkText: this._text(source.cjkText),
      },
      options
    );
  }

  handoff(sessionId, snapshot, options = {}) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const flushText = this._text(source.pendingText);
    const draft = this.set(
      sessionId,
      {
        // A live composition remains editable; only committed pending text is
        // flushed into the outgoing session's PTY input buffer.
        pendingText: this._text(source.compositionText),
        flushedText: this._text(source.flushedText) + flushText,
        cjkText: this._text(source.cjkText),
      },
      options
    );
    return { flushText, draft };
  }

  set(sessionId, candidate, options = {}) {
    if (!sessionId) return null;
    const draft = this._normalize(candidate);
    if (draft) {
      this._drafts.set(sessionId, draft);
    } else {
      this._drafts.delete(sessionId);
    }
    if (options.persist !== false) this.schedulePersist();
    return this._clone(draft);
  }

  get(sessionId) {
    return this._clone(this._drafts.get(sessionId) || null);
  }

  has(sessionId) {
    return this._drafts.has(sessionId);
  }

  hasFlushed(sessionId) {
    return !!this._drafts.get(sessionId)?.flushedText;
  }

  clear(sessionId, options = {}) {
    if (!sessionId) return;
    this._drafts.delete(sessionId);
    if (options.persist !== false) this.schedulePersist();
  }

  clearAll(options = {}) {
    this._drafts.clear();
    if (options.persist !== false) this.schedulePersist();
  }

  load() {
    this._drafts.clear();
    const storage = this._storage;
    if (!storage) return;
    try {
      const raw = storage.getItem(this._storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || !saved.drafts || typeof saved.drafts !== 'object') return;
      for (const [sessionId, candidate] of Object.entries(saved.drafts)) {
        const draft = this._normalize(candidate);
        if (draft) this._drafts.set(sessionId, draft);
      }
    } catch {
      // Corrupt or disabled storage must not block the terminal from starting.
      this._drafts.clear();
    }
  }

  schedulePersist() {
    if (this._persistTimer !== null) return;
    this._persistTimer = this._setTimer(() => {
      this._persistTimer = null;
      this.persistNow();
    }, this._debounceMs);
  }

  persistNow() {
    if (this._persistTimer !== null) {
      this._clearTimer(this._persistTimer);
      this._persistTimer = null;
    }
    const storage = this._storage;
    if (!storage) return false;

    const drafts = {};
    for (const [sessionId, draft] of this._drafts) {
      drafts[sessionId] = this._clone(draft);
    }
    const payload = JSON.stringify({ version: 1, drafts });
    if (this._tryPersist(storage, payload)) return true;

    // Terminal snapshots are reproducible from the server; typed text is not.
    // Reclaim snapshot quota one entry at a time before abandoning the draft.
    for (const key of this._storageKeys(storage)) {
      if (!key.startsWith(this._snapshotPrefix)) continue;
      try {
        storage.removeItem(key);
      } catch {
        return false;
      }
      if (this._tryPersist(storage, payload)) return true;
    }
    return false;
  }

  _normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const pendingText = this._text(raw.pendingText);
    const flushedText = this._text(raw.flushedText);
    const cjkText = this._text(raw.cjkText);
    if (!pendingText && !flushedText && !cjkText) return null;
    return {
      pendingText,
      flushedText,
      cjkText,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : this._now(),
    };
  }

  _clone(draft) {
    return draft
      ? {
          pendingText: draft.pendingText,
          flushedText: draft.flushedText,
          cjkText: draft.cjkText,
          updatedAt: draft.updatedAt,
        }
      : null;
  }

  _text(value) {
    return typeof value === 'string' ? value : '';
  }

  _tryPersist(storage, payload) {
    try {
      storage.setItem(this._storageKey, payload);
      return true;
    } catch {
      return false;
    }
  }

  _storageKeys(storage) {
    try {
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null) keys.push(key);
      }
      return keys;
    } catch {
      return [];
    }
  }

  _resolveStorage() {
    try {
      return globalThis.localStorage || null;
    } catch {
      return null;
    }
  }
}

globalThis.TerminalInputStateStore = TerminalInputStateStore;
