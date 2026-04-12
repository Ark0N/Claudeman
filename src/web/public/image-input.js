/**
 * Image Input Mixin - Clipboard paste and drag-and-drop image support
 *
 * For paste: intercepts Ctrl+V at the xterm keyboard level, creates a temporary
 * hidden contenteditable div ("paste trap"), lets the browser's native paste fill
 * it, then checks for image data. This works on HTTP (no secure context needed).
 *
 * For drag-and-drop: listens on the terminal container for file drops.
 *
 * @dependency app.js (uses global `app` for sendInput, activeSessionId, showToast)
 * @dependency panels-ui.js (provides showToast)
 */

Object.assign(CodemanApp.prototype, {

  initImageInput() {
    // Drag-and-drop handlers on terminal container
    const container = document.getElementById('terminalContainer');
    if (!container) return;

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        container.classList.add('drag-active');
      }
    });

    container.addEventListener('dragleave', (e) => {
      if (!container.contains(e.relatedTarget)) {
        container.classList.remove('drag-active');
      }
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      container.classList.remove('drag-active');

      if (!this.activeSessionId) return;
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;

      const imageFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        this.showToast('Only image files are supported', 'error');
        return;
      }
      this._uploadAndInsertImages(imageFiles);
    });
  },

  // Called from customKeyEventHandler in terminal-ui.js on Ctrl+V keydown.
  // Creates a hidden paste trap, lets the browser paste into it, then inspects
  // the result for images. Works on plain HTTP (no Clipboard API needed).
  _handleImagePaste() {
    const self = this;

    // Create a hidden contenteditable div to receive the paste
    const trap = document.createElement('div');
    trap.contentEditable = 'true';
    trap.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;overflow:hidden';
    document.body.appendChild(trap);
    trap.focus();

    // Listen for the paste event on our trap
    trap.addEventListener('paste', function(e) {
      e.stopPropagation();

      // Check for images in clipboard items
      var imageFiles = [];
      var items = e.clipboardData && e.clipboardData.items;
      if (items) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            var blob = items[i].getAsFile();
            if (blob) imageFiles.push(blob);
          }
        }
      }

      // Clean up the trap
      setTimeout(function() {
        if (trap.parentNode) trap.parentNode.removeChild(trap);
        // Refocus the terminal
        if (self.terminal) self.terminal.focus();
      }, 0);

      if (imageFiles.length > 0) {
        e.preventDefault();
        self._uploadAndInsertImages(imageFiles);
      } else {
        // No image -- extract text and send to terminal
        var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        e.preventDefault();
        if (text) self.sendInput(text);
      }
    });

    // Trigger the browser's native paste via execCommand
    // (this fires the paste event on our focused trap element)
    document.execCommand('paste');
  },

  async _uploadAndInsertImages(files) {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;

    this.showToast('Uploading ' + files.length + ' image' + (files.length > 1 ? 's' : '') + '...', 'info');

    const paths = [];
    for (const file of files) {
      try {
        const path = await this._uploadPasteImage(sessionId, file);
        paths.push(path);
      } catch (err) {
        this.showToast('Upload failed: ' + (err.message || 'unknown error'), 'error');
      }
    }

    if (paths.length > 0) {
      const pathStr = paths.join(' ');
      await this.sendInput(pathStr);
      this.showToast(paths.length + ' image' + (paths.length > 1 ? 's' : '') + ' ready', 'success');
    }
  },

  async _uploadPasteImage(sessionId, file) {
    const form = new FormData();
    form.append('image', file);

    const resp = await fetch('/api/sessions/' + sessionId + '/paste-image', {
      method: 'POST',
      body: form,
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || 'HTTP ' + resp.status);
    }

    const data = await resp.json();
    return data.path;
  },

});
