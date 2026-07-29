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
 * @loadorder 5.55 of 16 - loaded after input-cjk.js, before terminal-input-controller.js
 */

const DEFAULT_MAX_TERMINAL_DRAFTS = 50;
const DEFAULT_MAX_TERMINAL_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TERMINAL_DRAFT_STORAGE_CHARS = 512 * 1024;
const DEFAULT_MAX_TOTAL_TERMINAL_DRAFT_STORAGE_CHARS = 2 * 1024 * 1024;

class TerminalInputStateStore {
  constructor(options = {}) {
    this._storageKey = options.storageKey || 'codeman:sessionDrafts';
    this._draftKeyPrefix = options.draftKeyPrefix || `${this._storageKey}:draft:`;
    this._snapshotPrefix = options.snapshotPrefix || 'codeman-xs-';
    this._debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 150;
    this._maxDrafts =
      Number.isInteger(options.maxDrafts) && options.maxDrafts > 0 ? options.maxDrafts : DEFAULT_MAX_TERMINAL_DRAFTS;
    this._maxDraftAgeMs =
      Number.isFinite(options.maxDraftAgeMs) && options.maxDraftAgeMs > 0
        ? options.maxDraftAgeMs
        : DEFAULT_MAX_TERMINAL_DRAFT_AGE_MS;
    this._maxPersistedChars =
      Number.isInteger(options.maxPersistedChars) && options.maxPersistedChars > 0
        ? options.maxPersistedChars
        : DEFAULT_MAX_TERMINAL_DRAFT_STORAGE_CHARS;
    this._maxTotalPersistedChars =
      Number.isInteger(options.maxTotalPersistedChars) && options.maxTotalPersistedChars > 0
        ? options.maxTotalPersistedChars
        : DEFAULT_MAX_TOTAL_TERMINAL_DRAFT_STORAGE_CHARS;
    this._now = typeof options.now === 'function' ? options.now : Date.now;
    const setTimer = typeof options.setTimer === 'function' ? options.setTimer : globalThis.setTimeout;
    const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : globalThis.clearTimeout;
    const requestIdle =
      typeof options.requestIdle === 'function' ? options.requestIdle : globalThis.requestIdleCallback;
    const cancelIdle = typeof options.cancelIdle === 'function' ? options.cancelIdle : globalThis.cancelIdleCallback;
    if (typeof requestIdle === 'function' && typeof cancelIdle === 'function') {
      this._scheduleWrite = (callback) => requestIdle(callback, { timeout: this._debounceMs });
      this._cancelWrite = (handle) => cancelIdle(handle);
    } else {
      this._scheduleWrite = (callback) => setTimer(callback, this._debounceMs);
      this._cancelWrite = (handle) => clearTimer(handle);
    }
    this._storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : this._resolveStorage();
    this._drafts = new Map();
    this._persistedSessionIds = new Set();
    this._persistedSizes = new Map();
    this._dirtySessionIds = new Set();
    this._nonDurableSessionIds = new Set();
    this._persistHandle = null;
    this._legacyStoragePresent = false;
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
        ptyOwned: source.ptyOwned === true,
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
        ptyOwned: source.ptyOwned === true,
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
    this._nonDurableSessionIds.delete(sessionId);
    this._dirtySessionIds.add(sessionId);
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
    this._nonDurableSessionIds.delete(sessionId);
    this._dirtySessionIds.add(sessionId);
    if (options.persist !== false) this.schedulePersist();
  }

  clearAll(options = {}) {
    for (const sessionId of this._drafts.keys()) this._dirtySessionIds.add(sessionId);
    for (const sessionId of this._persistedSessionIds) this._dirtySessionIds.add(sessionId);
    this._drafts.clear();
    this._nonDurableSessionIds.clear();
    if (options.persist !== false) this.schedulePersist();
  }

  load() {
    this._drafts.clear();
    this._persistedSessionIds.clear();
    this._persistedSizes.clear();
    this._dirtySessionIds.clear();
    this._nonDurableSessionIds.clear();
    this._legacyStoragePresent = false;
    const storage = this._storage;
    if (!storage) return;

    try {
      const raw = storage.getItem(this._storageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && saved.drafts && typeof saved.drafts === 'object') {
          this._legacyStoragePresent = true;
          for (const [sessionId, candidate] of Object.entries(saved.drafts)) {
            const draft = this._normalize(candidate);
            if (!draft) continue;
            this._drafts.set(sessionId, draft);
            this._dirtySessionIds.add(sessionId);
          }
        }
      }
    } catch {
      // Corrupt or disabled legacy storage must not block per-session records.
    }

    for (const key of this._storageKeys(storage)) {
      if (!key.startsWith(this._draftKeyPrefix)) continue;
      const sessionId = this._sessionIdFromKey(key);
      if (!sessionId) continue;
      try {
        const raw = storage.getItem(key);
        if (!raw) continue;
        const saved = JSON.parse(raw);
        const draft = this._normalize(saved?.draft ?? saved);
        if (!draft) continue;
        const existing = this._drafts.get(sessionId);
        if (!existing || draft.updatedAt >= existing.updatedAt) {
          this._drafts.set(sessionId, draft);
        }
        this._persistedSessionIds.add(sessionId);
        this._persistedSizes.set(sessionId, raw.length);
      } catch {
        // One corrupt draft must not hide the other sessions' editable state.
      }
    }
    this._pruneDrafts();
  }

  schedulePersist() {
    if (this._persistHandle !== null) return;
    this._persistHandle = this._scheduleWrite(() => {
      this._persistHandle = null;
      this.persistNow();
    });
  }

  persistNow() {
    if (this._persistHandle !== null) {
      this._cancelWrite(this._persistHandle);
      this._persistHandle = null;
    }
    const storage = this._storage;
    if (!storage) return false;

    this._pruneDrafts();
    let allDurable = this._nonDurableSessionIds.size === 0;
    let migrationComplete = true;
    for (const sessionId of Array.from(this._dirtySessionIds)) {
      const key = this._draftStorageKey(sessionId);
      const draft = this._drafts.get(sessionId);
      if (!draft) {
        if (!this._removeStorageKey(storage, key)) {
          allDurable = false;
          migrationComplete = false;
          continue;
        }
        this._dirtySessionIds.delete(sessionId);
        this._persistedSessionIds.delete(sessionId);
        this._persistedSizes.delete(sessionId);
        this._nonDurableSessionIds.delete(sessionId);
        continue;
      }

      const payload = JSON.stringify({ version: 1, draft: this._clone(draft) });
      if (payload.length > this._maxPersistedChars) {
        // Never leave an older value that could resurrect after reload.
        this._nonDurableSessionIds.add(sessionId);
        if (this._removeStorageKey(storage, key)) {
          this._dirtySessionIds.delete(sessionId);
          this._persistedSessionIds.delete(sessionId);
          this._persistedSizes.delete(sessionId);
        } else {
          migrationComplete = false;
        }
        allDurable = false;
        continue;
      }

      if (!this._persistDraft(storage, sessionId, key, payload)) {
        allDurable = false;
        migrationComplete = false;
        continue;
      }
      this._dirtySessionIds.delete(sessionId);
      this._nonDurableSessionIds.delete(sessionId);
      this._persistedSessionIds.add(sessionId);
      this._persistedSizes.set(sessionId, payload.length);
    }

    if (
      this._legacyStoragePresent &&
      migrationComplete &&
      this._nonDurableSessionIds.size === 0 &&
      this._dirtySessionIds.size === 0
    ) {
      try {
        storage.removeItem(this._storageKey);
        this._legacyStoragePresent = false;
      } catch {
        allDurable = false;
      }
    }
    return allDurable && this._nonDurableSessionIds.size === 0;
  }

  _normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const pendingText = this._text(raw.pendingText);
    const flushedText = this._text(raw.flushedText);
    const cjkText = this._text(raw.cjkText);
    const ptyOwned = raw.ptyOwned === true;
    if (!pendingText && !flushedText && !cjkText && !ptyOwned) return null;
    const draft = {
      pendingText,
      flushedText,
      cjkText,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : this._now(),
    };
    if (ptyOwned) draft.ptyOwned = true;
    return draft;
  }

  _clone(draft) {
    return draft
      ? {
          pendingText: draft.pendingText,
          flushedText: draft.flushedText,
          cjkText: draft.cjkText,
          updatedAt: draft.updatedAt,
          ...(draft.ptyOwned ? { ptyOwned: true } : {}),
        }
      : null;
  }

  _text(value) {
    return typeof value === 'string' ? value : '';
  }

  _persistDraft(storage, sessionId, key, payload) {
    if (!this._ensureTotalBudget(storage, sessionId, payload.length)) return false;
    let result = this._tryPersist(storage, key, payload);
    if (result.ok) return true;
    if (!this._isQuotaError(result.error)) return false;

    // Terminal snapshots are reproducible from the server; typed text is not.
    // Reclaim snapshot quota one entry at a time before abandoning the draft.
    for (const snapshotKey of this._storageKeys(storage)) {
      if (!snapshotKey.startsWith(this._snapshotPrefix)) continue;
      if (!this._removeStorageKey(storage, snapshotKey)) return false;
      result = this._tryPersist(storage, key, payload);
      if (result.ok) return true;
      if (!this._isQuotaError(result.error)) return false;
    }

    while (this._reclaimOldestDraft(storage, sessionId)) {
      result = this._tryPersist(storage, key, payload);
      if (result.ok) return true;
      if (!this._isQuotaError(result.error)) return false;
    }
    return false;
  }

  _ensureTotalBudget(storage, sessionId, payloadLength) {
    const previousLength = this._persistedSizes.get(sessionId) || 0;
    let nextTotal = this._totalPersistedChars() - previousLength + payloadLength;
    while (nextTotal > this._maxTotalPersistedChars) {
      if (!this._reclaimOldestDraft(storage, sessionId)) return false;
      nextTotal = this._totalPersistedChars() - previousLength + payloadLength;
    }
    return true;
  }

  _reclaimOldestDraft(storage, currentSessionId) {
    const candidates = Array.from(this._persistedSessionIds)
      .filter(
        (sessionId) =>
          sessionId !== currentSessionId && !this._dirtySessionIds.has(sessionId) && this._persistedSizes.has(sessionId)
      )
      .sort((left, right) => (this._drafts.get(left)?.updatedAt || 0) - (this._drafts.get(right)?.updatedAt || 0));
    const sessionId = candidates[0];
    if (!sessionId) return false;
    if (!this._removeStorageKey(storage, this._draftStorageKey(sessionId))) return false;
    this._persistedSessionIds.delete(sessionId);
    this._persistedSizes.delete(sessionId);
    if (this._drafts.has(sessionId)) this._nonDurableSessionIds.add(sessionId);
    return true;
  }

  _totalPersistedChars() {
    let total = 0;
    for (const size of this._persistedSizes.values()) total += size;
    return total;
  }

  _tryPersist(storage, key, payload) {
    try {
      storage.setItem(key, payload);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error };
    }
  }

  _isQuotaError(error) {
    if (!error || typeof error !== 'object') return false;
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    );
  }

  _pruneDrafts() {
    const now = this._now();
    if (Number.isFinite(now)) {
      for (const [sessionId, draft] of this._drafts) {
        if (now - draft.updatedAt > this._maxDraftAgeMs) {
          this._drafts.delete(sessionId);
          this._nonDurableSessionIds.delete(sessionId);
          this._dirtySessionIds.add(sessionId);
        }
      }
    }

    if (this._drafts.size <= this._maxDrafts) return;
    const oldestFirst = Array.from(this._drafts.entries()).sort(
      ([, left], [, right]) => left.updatedAt - right.updatedAt
    );
    for (const [sessionId] of oldestFirst.slice(0, this._drafts.size - this._maxDrafts)) {
      this._drafts.delete(sessionId);
      this._nonDurableSessionIds.delete(sessionId);
      this._dirtySessionIds.add(sessionId);
    }
  }

  _draftStorageKey(sessionId) {
    return `${this._draftKeyPrefix}${encodeURIComponent(sessionId)}`;
  }

  _sessionIdFromKey(key) {
    try {
      return decodeURIComponent(key.slice(this._draftKeyPrefix.length));
    } catch {
      return null;
    }
  }

  _removeStorageKey(storage, key) {
    try {
      storage.removeItem(key);
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
