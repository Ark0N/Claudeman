/**
 * @fileoverview Mobile keyboard accessory bar and modal focus trap.
 *
 * Defines three exports:
 *
 * - KeyboardAccessoryBar (singleton object) — Quick action buttons shown above the virtual
 *   keyboard on mobile: arrow up/down, /init, /clear, /compact, paste, Esc, and dismiss.
 *   The paste button opens a dialog that handles both text paste and image attach
 *   (native picker + best-effort image paste, routed through app._uploadAndInsertImages).
 *   Destructive actions (/clear, /compact) require double-tap confirmation (2s amber state).
 *   Commands are sent as text + Enter separately for Ink compatibility.
 *   Only initializes on touch devices (MobileDetection.isTouchDevice guard).
 * - PathPicker (singleton object) — Lazy server-side file/folder browser shared
 *   by Link Existing and the extended mobile keyboard bar.
 *
 * - FocusTrap (class) — Traps Tab/Shift+Tab keyboard focus within a modal element.
 *   Saves and restores previously focused element on deactivate. Used by Ralph wizard
 *   and other modal dialogs.
 *
 * @globals {object} KeyboardAccessoryBar
 * @globals {object} PathPicker
 * @globals {class} FocusTrap
 *
 * @dependency mobile-handlers.js (MobileDetection.isTouchDevice)
 * @dependency app.js (uses global `app` for sendInput, activeSessionId, terminal)
 * @loadorder 5 of 15 — loaded after notification-manager.js, before app.js
 */

// Codeman — Keyboard accessory bar and focus trap for modals
// Loaded after mobile-handlers.js, before app.js

// ═══════════════════════════════════════════════════════════════
// Shared Filesystem Path Picker
// ═══════════════════════════════════════════════════════════════

const PathPicker = {
  overlay: null,
  _options: null,
  _selectedPath: '',
  _previousFocus: null,
  _keydownHandler: null,
  _loadSequence: 0,
  _previewOverlay: null,
  _previewRequestSequence: 0,
  _previewPreviousFocus: null,

  /**
   * Open the lazy filesystem browser.
   * @param {{sessionId?: string, initialPath?: string, directoriesOnly?: boolean,
   *   title?: string, onSelect: (path: string) => void}} options
   */
  open(options) {
    this.close(false);
    this._options = options;
    this._selectedPath = '';
    this._previousFocus = document.activeElement;
    this._previousFocus?.blur?.();

    const overlay = document.createElement('div');
    overlay.className = 'path-picker-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', options.title || 'Select a path');
    overlay.innerHTML = `
      <div class="path-picker-dialog">
        <div class="path-picker-header">
          <strong class="path-picker-title"></strong>
          <button type="button" class="path-picker-close" aria-label="Close">&times;</button>
        </div>
        <div class="path-picker-roots-row">
          <label for="pathPickerRoot">Location</label>
          <select id="pathPickerRoot" class="path-picker-roots"></select>
        </div>
        <div class="path-picker-nav">
          <button type="button" class="path-picker-up" title="Parent folder" aria-label="Parent folder">&#x2191;</button>
          <div class="path-picker-current" title="Current folder"></div>
          <button type="button" class="path-picker-refresh" title="Refresh" aria-label="Refresh">&#x21BB;</button>
        </div>
        <div class="path-picker-status" aria-live="polite">Loading...</div>
        <div class="path-picker-list" role="listbox"></div>
        <div class="path-picker-selection">
          <span class="path-picker-selection-label">Selected</span>
          <span class="path-picker-selection-value">None</span>
        </div>
        <div class="path-picker-actions">
          <button type="button" class="path-picker-current-select">Select Current Folder</button>
          <span class="path-picker-action-spacer"></span>
          <button type="button" class="path-picker-cancel">Cancel</button>
          <button type="button" class="path-picker-confirm" disabled>Select</button>
        </div>
      </div>`;

    this.overlay = overlay;
    overlay.querySelector('.path-picker-title').textContent = options.title || 'Select a Path';
    overlay.querySelector('.path-picker-close').addEventListener('click', () => this.close(true));
    overlay.querySelector('.path-picker-cancel').addEventListener('click', () => this.close(true));
    overlay.querySelector('.path-picker-confirm').addEventListener('click', () => this.confirm());
    overlay.querySelector('.path-picker-current-select').addEventListener('click', () => {
      const current = overlay.querySelector('.path-picker-current').textContent;
      if (current) this.select(current);
    });
    overlay.querySelector('.path-picker-refresh').addEventListener('click', () => this.load());
    overlay.querySelector('.path-picker-up').addEventListener('click', () => {
      const parent = overlay.querySelector('.path-picker-up').dataset.parent;
      if (parent) this.load(parent);
    });
    overlay.querySelector('.path-picker-roots').addEventListener('change', (event) => this.load(event.target.value));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.close(true);
    });
    this._keydownHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (this._previewOverlay) this.closePreview(true);
        else this.close(true);
      }
    };
    document.addEventListener('keydown', this._keydownHandler);
    document.body.appendChild(overlay);
    this.load(options.initialPath || '');
  },

  async load(path) {
    if (!this.overlay || !this._options) return;
    const loadSequence = ++this._loadSequence;
    const list = this.overlay.querySelector('.path-picker-list');
    const status = this.overlay.querySelector('.path-picker-status');
    list.replaceChildren();
    status.textContent = 'Loading...';

    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (this._options.sessionId) params.set('sessionId', this._options.sessionId);
    try {
      const response = await fetch(`/api/filesystem/browse?${params.toString()}`);
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to browse this folder');
      if (!this.overlay || loadSequence !== this._loadSequence) return;
      this.render(result.data);
    } catch (error) {
      if (!this.overlay || loadSequence !== this._loadSequence) return;
      if (path) {
        this.load('');
        return;
      }
      status.textContent = error.message || 'Failed to browse this folder';
      status.classList.add('error');
    }
  },

  render(data) {
    const rootSelect = this.overlay.querySelector('.path-picker-roots');
    rootSelect.replaceChildren();
    for (const root of data.roots) {
      const option = document.createElement('option');
      option.value = root.path;
      option.textContent = `${root.label} — ${root.path}`;
      option.selected = data.path === root.path || data.root === root.path;
      rootSelect.appendChild(option);
    }

    this.overlay.querySelector('.path-picker-current').textContent = data.path;
    const up = this.overlay.querySelector('.path-picker-up');
    up.dataset.parent = data.parent || '';
    up.disabled = !data.parent;
    const status = this.overlay.querySelector('.path-picker-status');
    status.classList.remove('error');
    status.textContent = data.entries.length === 0
      ? 'This folder is empty'
      : `${data.entries.length} item${data.entries.length === 1 ? '' : 's'}${data.truncated ? ' (first 500)' : ''}`;

    const list = this.overlay.querySelector('.path-picker-list');
    list.replaceChildren();
    for (const entry of data.entries) {
      const row = document.createElement('div');
      row.className = 'path-picker-item';
      if (entry.type === 'file' && this._options.directoriesOnly && !entry.previewKind) {
        row.classList.add('not-selectable');
      }
      row.dataset.path = entry.path;
      row.dataset.type = entry.type;
      row.setAttribute('role', 'option');

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'path-picker-item-main';
      const icon = document.createElement('span');
      icon.className = 'path-picker-item-icon';
      icon.textContent = entry.type === 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
      const name = document.createElement('span');
      name.className = 'path-picker-item-name';
      name.textContent = entry.name;
      open.append(icon, name);
      if (entry.symlink) {
        const link = document.createElement('span');
        link.className = 'path-picker-item-link';
        link.textContent = '\u2197';
        open.appendChild(link);
      }
      if (entry.type === 'directory') {
        const chevron = document.createElement('span');
        chevron.className = 'path-picker-item-chevron';
        chevron.textContent = '\u203A';
        open.appendChild(chevron);
        open.addEventListener('click', () => this.load(entry.path));
      } else if (entry.previewKind) {
        const preview = document.createElement('span');
        preview.className = 'path-picker-item-preview';
        preview.textContent = '\uD83D\uDC41';
        open.appendChild(preview);
        open.title = `Preview ${entry.name}`;
        open.setAttribute('aria-label', `Preview ${entry.name}`);
        open.addEventListener('click', () => this.openPreview(entry));
      } else if (!this._options.directoriesOnly) {
        open.addEventListener('click', () => this.select(entry.path));
      } else {
        open.disabled = true;
      }
      row.appendChild(open);

      if (entry.type === 'directory' || !this._options.directoriesOnly) {
        const choose = document.createElement('button');
        choose.type = 'button';
        choose.className = 'path-picker-item-select';
        choose.textContent = 'Choose';
        choose.addEventListener('click', () => this.select(entry.path));
        row.appendChild(choose);
      }
      list.appendChild(row);
    }
  },

  select(path) {
    if (!this.overlay) return;
    this._selectedPath = path;
    this.overlay.querySelector('.path-picker-selection-value').textContent = path;
    this.overlay.querySelector('.path-picker-confirm').disabled = false;
    this.overlay.querySelectorAll('.path-picker-item').forEach((row) => {
      const selected = row.dataset.path === path;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  },

  openPreview(entry) {
    this.closePreview(false);
    this._previewPreviousFocus = document.activeElement;
    const requestSequence = ++this._previewRequestSequence;
    const params = new URLSearchParams({ path: entry.path });
    if (this._options?.sessionId) params.set('sessionId', this._options.sessionId);
    const previewUrl = `/api/filesystem/preview?${params.toString()}`;

    const overlay = document.createElement('div');
    overlay.className = 'path-preview-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `Preview ${entry.name}`);
    overlay.innerHTML = `
      <div class="path-preview-dialog">
        <div class="path-preview-header">
          <div class="path-preview-heading">
            <strong class="path-preview-title"></strong>
            <span class="path-preview-path"></span>
          </div>
          <a class="path-preview-open" target="_blank" rel="noopener noreferrer">Open</a>
          <button type="button" class="path-preview-close" aria-label="Close preview">&times;</button>
        </div>
        <div class="path-preview-body"><div class="path-preview-loading">Loading preview...</div></div>
      </div>`;
    overlay.querySelector('.path-preview-title').textContent = entry.name;
    overlay.querySelector('.path-preview-path').textContent = entry.path;
    overlay.querySelector('.path-preview-open').href = previewUrl;
    overlay.querySelector('.path-preview-close').addEventListener('click', () => this.closePreview(true));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.closePreview(true);
    });
    document.body.appendChild(overlay);
    this._previewOverlay = overlay;

    const body = overlay.querySelector('.path-preview-body');
    if (entry.previewKind === 'image') {
      const image = document.createElement('img');
      image.className = 'path-preview-image';
      image.alt = entry.name;
      image.addEventListener('load', () => body.querySelector('.path-preview-loading')?.remove());
      image.addEventListener('error', () => this.showPreviewError('Image preview failed to load'));
      image.src = previewUrl;
      body.appendChild(image);
    } else if (entry.previewKind === 'text') {
      fetch(previewUrl)
        .then(async (response) => {
          const content = await response.text();
          if (!response.ok) {
            let message = 'Text preview failed to load';
            try {
              message = JSON.parse(content).error || message;
            } catch {}
            throw new Error(message);
          }
          return content;
        })
        .then((content) => {
          if (!this._previewOverlay || requestSequence !== this._previewRequestSequence) return;
          const pre = document.createElement('pre');
          pre.className = 'path-preview-text';
          pre.textContent = content;
          body.replaceChildren(pre);
        })
        .catch((error) => {
          if (requestSequence === this._previewRequestSequence) this.showPreviewError(error.message);
        });
    } else {
      const frame = document.createElement('iframe');
      frame.className = 'path-preview-frame';
      frame.title = entry.name;
      frame.addEventListener('load', () => body.querySelector('.path-preview-loading')?.remove());
      frame.src = previewUrl;
      body.appendChild(frame);
    }
    overlay.querySelector('.path-preview-close').focus();
  },

  showPreviewError(message) {
    const body = this._previewOverlay?.querySelector('.path-preview-body');
    if (!body) return;
    const error = document.createElement('div');
    error.className = 'path-preview-error';
    error.textContent = message || 'Preview failed to load';
    body.replaceChildren(error);
  },

  closePreview(restoreFocus = true) {
    this._previewRequestSequence += 1;
    this._previewOverlay?.remove();
    this._previewOverlay = null;
    const previousFocus = this._previewPreviousFocus;
    this._previewPreviousFocus = null;
    if (restoreFocus) previousFocus?.focus?.();
  },

  confirm() {
    if (!this._selectedPath || !this._options) return;
    const selectedPath = this._selectedPath;
    const onSelect = this._options.onSelect;
    this.close(false);
    onSelect(selectedPath);
  },

  close(restoreFocus = true) {
    if (this._keydownHandler) document.removeEventListener('keydown', this._keydownHandler);
    this._keydownHandler = null;
    this._loadSequence += 1;
    this.closePreview(false);
    this.overlay?.remove();
    this.overlay = null;
    const previousFocus = this._previousFocus;
    this._previousFocus = null;
    this._options = null;
    this._selectedPath = '';
    if (restoreFocus) previousFocus?.focus?.();
  },
};

// ═══════════════════════════════════════════════════════════════
// Mobile Keyboard Accessory Bar
// ═══════════════════════════════════════════════════════════════

/**
 * KeyboardAccessoryBar - Quick action buttons shown above keyboard when typing.
 */
const KeyboardAccessoryBar = {
  element: null,
  _mode: 'simple', // 'simple' or 'extended'

  /** HTML for simple mode: arrows, commands, paste, Esc, dismiss */
  _simpleButtons: `
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-up" title="Arrow up">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 15l7-7 7 7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-down" title="Arrow down">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="init" title="/init">/init</button>
      <button class="accessory-btn" data-action="clear" title="/clear">/clear</button>
      <button class="accessory-btn" data-action="paste" title="Paste from clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="esc" title="Escape">Esc</button>
      <button class="accessory-btn accessory-btn-dismiss" data-action="dismiss" title="Dismiss keyboard">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>`,

  /** HTML for extended mode: all keys including arrows, Tab, Esc, etc. */
  _extendedButtons: `
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-up" title="Arrow up">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 15l7-7 7 7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-down" title="Arrow down">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="arrow-left" title="Arrow left">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M15 19l-7-7 7-7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="arrow-right" title="Arrow right">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M9 5l7 7-7 7"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="paste" title="Paste from clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="pick-path" title="Insert a file or folder path">&#x1F4C1; Path</button>
      <button class="accessory-btn" data-action="clear-input" title="Clear the current unsent input">&#x232B; All</button>
      <button class="accessory-btn" data-action="tab" title="Tab">Tab</button>
      <button class="accessory-btn" data-action="shift-tab" title="Shift+Tab">⇧Tab</button>
      <button class="accessory-btn" data-action="effort-max" title="/effort max">Max</button>
      <button class="accessory-btn" data-action="ctrl-o" title="Ctrl+O">⌃O</button>
      <button class="accessory-btn" data-action="opt-enter" title="Option+Enter (newline)">⌥Enter</button>
      <button class="accessory-btn" data-action="esc" title="Escape">Esc</button>
      <button class="accessory-btn" data-action="init" title="/init">/init</button>
      <button class="accessory-btn" data-action="clear" title="/clear">/clear</button>
      <button class="accessory-btn" data-action="compact" title="/compact">/compact</button>
      <button class="accessory-btn accessory-btn-dismiss" data-action="dismiss" title="Dismiss keyboard">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>`,

  /** Create and inject the accessory bar */
  init() {
    // Only on mobile
    if (!MobileDetection.isTouchDevice()) return;

    // Create accessory bar element
    this.element = document.createElement('div');
    this.element.className = 'keyboard-accessory-bar';
    this.element.innerHTML = this._simpleButtons;

    // Add click handlers — preventDefault stops event from reaching terminal
    this.element.addEventListener('click', (e) => {
      const btn = e.target.closest('.accessory-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const action = btn.dataset.action;
      this.handleAction(action, btn);

      // Refocus terminal so keyboard stays open (tap blurs terminal → keyboard dismisses → toolbar shifts)
      const refocusActions = new Set(['scroll-up', 'scroll-down', 'arrow-left', 'arrow-right', 'tab', 'shift-tab', 'ctrl-o', 'opt-enter', 'esc', 'effort-max', 'clear-input']);
      if (refocusActions.has(action) ||
          ((action === 'clear' || action === 'compact') && this._confirmAction)) {
        if (typeof app !== 'undefined' && app.terminal) {
          app.terminal.focus();
        }
      }
    });

    // Insert before toolbar
    const toolbar = document.querySelector('.toolbar');
    if (toolbar && toolbar.parentNode) {
      toolbar.parentNode.insertBefore(this.element, toolbar);
    }
  },

  /** Switch between 'simple' and 'extended' button layouts */
  setMode(mode) {
    if (mode === this._mode || !this.element) return;
    this._mode = mode;
    this.clearConfirm();
    this.element.innerHTML = mode === 'extended' ? this._extendedButtons : this._simpleButtons;
  },

  _confirmTimer: null,
  _confirmAction: null,

  /** Handle accessory button actions */
  handleAction(action, btn) {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    switch (action) {
      case 'scroll-up':
        this.sendKey('\x1b[A');
        break;
      case 'scroll-down':
        this.sendKey('\x1b[B');
        break;
      case 'arrow-left':
        this.sendKey('\x1b[D');
        break;
      case 'arrow-right':
        this.sendKey('\x1b[C');
        break;
      case 'esc':
        this.sendKey('\x1b');
        break;
      case 'opt-enter':
        this.sendKey('\x1b\r');
        break;
      case 'tab':
        this.sendKey('\t');
        break;
      case 'shift-tab':
        this.sendKey('\x1b[Z');
        break;
      case 'ctrl-o':
        this.sendKey('\x0f');
        break;
      case 'effort-max':
        this.sendCommand('/effort max');
        break;
      case 'init':
        this.sendCommand('/init');
        break;
      case 'clear':
      case 'compact': {
        const cmd = action === 'clear' ? '/clear' : '/compact';
        if (this._confirmAction === action && this._confirmTimer) {
          this.clearConfirm();
          this.sendCommand(cmd);
        } else {
          this.setConfirm(action, btn);
        }
        break;
      }
      case 'paste':
        this.pasteFromClipboard();
        break;
      case 'pick-path':
        this.pickPath();
        break;
      case 'clear-input':
        app.clearTerminalInput?.();
        break;
      case 'dismiss':
        // Blur active element to dismiss keyboard
        document.activeElement?.blur();
        break;
    }
  },

  /** Enter confirm state: button turns amber for 2s waiting for second tap */
  setConfirm(action, btn) {
    this.clearConfirm();
    this._confirmAction = action;
    if (btn) {
      btn.classList.add('confirming');
      btn.dataset.origHtml = btn.innerHTML;
      btn.textContent = 'Tap again';
    }
    this._confirmTimer = setTimeout(() => this.clearConfirm(), 2000);
  },

  /** Reset confirm state */
  clearConfirm() {
    if (this._confirmTimer) {
      clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
    }
    if (this._confirmAction && this.element) {
      const btn = this.element.querySelector(`[data-action="${this._confirmAction}"]`);
      if (btn && btn.dataset.origHtml) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
      }
      if (btn) btn.classList.remove('confirming');
    }
    this._confirmAction = null;
  },

  /** Send a slash command to the active session.
   *  Sends text and Enter separately so Ink processes them as distinct events. */
  sendCommand(command) {
    if (!app.activeSessionId) return;
    app.sendTerminalCommand(command);
  },

  /** Send a special key through the controller-owned ordered input path. */
  sendKey(escapeSequence) {
    if (!app.activeSessionId) return;
    app.sendTerminalKey(escapeSequence);
  },

  /** Browse the active session's workspace and insert a selected path without Enter. */
  pickPath() {
    if (!app.activeSessionId) return;
    const session = app.sessions?.get(app.activeSessionId);
    PathPicker.open({
      title: 'Insert File or Folder Path',
      sessionId: app.activeSessionId,
      initialPath: session?.workingDir || '',
      directoriesOnly: false,
      onSelect: (path) => {
        app.insertTerminalText?.(path);
        setTimeout(() => app.terminal?.focus(), 100);
      },
    });
  },

  /** Show a paste overlay for iOS compatibility.
   *  Handles three input paths from one dialog:
   *   - Text: long-press the textarea → Paste → Send (unchanged).
   *   - Image (picker): the "Image" button opens a native file picker
   *     (accept=image/* → camera / photo library / files), the most reliable
   *     way to attach a photo on mobile.
   *   - Image (paste): if the browser exposes image blobs on the textarea's
   *     paste event, we intercept them and upload directly. Support is spotty
   *     on mobile, so it is a best-effort enhancement layered on the picker.
   *  All image paths reuse app._uploadAndInsertImages() (image-input.js), which
   *  uploads to /api/sessions/:id/paste-image and inserts the saved path. */
  pasteFromClipboard() {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'paste-overlay';
    overlay.innerHTML = `
      <div class="paste-dialog">
        <textarea class="paste-textarea" placeholder="Long-press to paste text — or tap 🖼 to attach an image"></textarea>
        <div class="paste-actions">
          <button class="paste-image">🖼 Image</button>
          <button class="paste-cancel">Cancel</button>
          <button class="paste-send">Send</button>
        </div>
        <input type="file" class="paste-file-input" accept="image/*" multiple hidden>
      </div>
    `;

    const textarea = overlay.querySelector('.paste-textarea');
    const fileInput = overlay.querySelector('.paste-file-input');

    const close = () => overlay.remove();

    const sendText = () => {
      const text = textarea.value;
      close();
      if (text) {
        app.sendPastedText(text, { submit: true });
      }
    };

    // Filter to images, close the dialog, and hand off to the shared
    // upload+insert pipeline. Returns true if any image was handled.
    const handleImages = (files) => {
      const images = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) return false;
      close();
      if (typeof app._uploadAndInsertImages === 'function') app._uploadAndInsertImages(images);
      return true;
    };

    // Image picker (camera / photo library) — the reliable mobile path.
    overlay.querySelector('.paste-image').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => handleImages(fileInput.files));

    // Best-effort: capture images pasted straight into the textarea.
    textarea.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const imageFiles = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const blob = items[i].getAsFile();
          if (blob) imageFiles.push(blob);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleImages(imageFiles);
      }
    });

    overlay.querySelector('.paste-cancel').addEventListener('click', close);
    overlay.querySelector('.paste-send').addEventListener('click', sendText);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    document.body.appendChild(overlay);
    textarea.focus();
  },

  /** Show the accessory bar */
  show() {
    if (this.element) {
      this.element.classList.add('visible');
    }
  },

  /** Hide the accessory bar */
  hide() {
    if (this.element) {
      this.element.classList.remove('visible');
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// Accessibility: Focus Trap for Modals
// ═══════════════════════════════════════════════════════════════

/**
 * FocusTrap - Traps keyboard focus within an element (typically a modal).
 * Saves the previously focused element and restores focus when deactivated.
 */
class FocusTrap {
  constructor(element) {
    this.element = element;
    this.previouslyFocused = null;
    this.boundHandleKeydown = this.handleKeydown.bind(this);
  }

  activate() {
    this.previouslyFocused = document.activeElement;
    this.element.addEventListener('keydown', this.boundHandleKeydown);

    // Focus first focusable element after a brief delay (for CSS transitions)
    requestAnimationFrame(() => {
      const focusable = this.getFocusableElements();
      if (focusable.length) {
        focusable[0].focus();
      }
    });
  }

  deactivate() {
    this.element.removeEventListener('keydown', this.boundHandleKeydown);
    if (this.previouslyFocused && typeof this.previouslyFocused.focus === 'function') {
      this.previouslyFocused.focus();
    }
  }

  getFocusableElements() {
    const selector = [
      'button:not([disabled]):not([tabindex="-1"])',
      'input:not([disabled]):not([tabindex="-1"])',
      'select:not([disabled]):not([tabindex="-1"])',
      'textarea:not([disabled]):not([tabindex="-1"])',
      'a[href]:not([tabindex="-1"])',
      '[tabindex]:not([tabindex="-1"]):not([disabled])'
    ].join(', ');

    return [...this.element.querySelectorAll(selector)].filter(
      el => el.offsetParent !== null // Exclude hidden elements
    );
  }

  handleKeydown(e) {
    if (e.key !== 'Tab') return;

    const focusable = this.getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
