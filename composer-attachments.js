(() => {
  const prompt = document.getElementById('prompt');
  const composer = prompt.closest('.composer');
  const tray = document.getElementById('composer-attachments');
  const status = document.getElementById('attachment-status');
  const input = document.getElementById('attachment-files');
  const add = document.getElementById('attach-files');
  const dialog = document.getElementById('attachment-dialog');
  const dialogTitle = document.getElementById('attachment-title');
  const previewStatus = document.getElementById('attachment-preview-status');
  const previewContent = document.getElementById('attachment-preview-content');
  const reveal = document.getElementById('attachment-reveal');
  const formats = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const imageName = /\.(?:png|jpe?g|webp)$/i;
  const marker = '\n\n[FreePi Desktop attachments]\n';
  const oldGuidance = '\nUse the official look_at_image tool on these project-relative images if needed to answer the request.';
  const guidance = '\nThese are project-relative file paths. Use look_at_image for supported images, read for text, or an appropriate local tool to inspect binary files as needed.';
  const relative = /^freepi-attachments\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}(?:\.(?:png|jpg|webp)|--[\p{L}\p{N} ._()\-]{1,100})$/u;
  const maxBytes = 25 * 1024 * 1024;
  const maxFiles = 6;
  const attachments = [];
  let revision = 0;
  let draftLocked = false;
  let selected;

  function notify(text) {
    status.textContent = text;
    status.hidden = !text;
  }

  function render() {
    tray.replaceChildren();
    for (const [index, item] of attachments.entries()) {
      const card = document.createElement('div');
      card.className = 'composer-attachment';
      const name = item.file.name || t("Attachment {0}", index + 1);
      const source = item.preview;
      const content = source ? document.createElement('img') : fileLabel(name);
      if (source) {
        card.classList.add('composer-attachment-image');
        content.alt = name;
        content.onerror = () => {
          if (item.preview === source) {
            URL.revokeObjectURL(source);
            item.preview = undefined;
          }
          card.classList.remove('composer-attachment-image');
          content.replaceWith(fileLabel(name));
        };
        content.src = source;
      }
      content.title = name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.disabled = draftLocked;
      remove.textContent = '×';
      remove.setAttribute('aria-label', t("Remove attachment {0}", name));
      remove.onclick = () => {
        if (item.preview) URL.revokeObjectURL(item.preview);
        attachments.splice(attachments.indexOf(item), 1);
        notify('');
        render();
        (tray.querySelectorAll('button')[index] ?? prompt).focus();
      };
      card.append(content, remove);
      tray.append(card);
    }
    tray.hidden = !attachments.length;
    revision++;
    document.dispatchEvent(new Event('freepi:attachments'));
  }

  function attach(files, restoration = false) {
    if (draftLocked && !restoration) return;
    const errors = new Set();
    for (const file of files) {
      if (attachments.length >= maxFiles) errors.add(t("Attach up to 6 files."));
      else if (file.size > maxBytes) errors.add(t("Each file can be up to 25 MB."));
      else {
        const isImage = formats.has(file.type) || imageName.test(file.name);
        attachments.push({ file, preview: isImage && file.size ? URL.createObjectURL(file) : undefined });
      }
    }
    notify(Array.from(errors).join(' ') || (attachments.length && !restoration ? t("Files are saved in the project folder when sent.") : ''));
    render();
  }

  add.onclick = () => input.click();
  input.onchange = () => {
    attach(Array.from(input.files));
    input.value = '';
    prompt.focus();
  };
  composer.addEventListener('paste', event => {
    if (draftLocked) return;
    const items = Array.from(event.clipboardData?.items ?? [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile()).filter(Boolean);
    const files = items.length ? items : Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    attach(files);
  });
  composer.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
  });
  composer.addEventListener('drop', event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    attach(event.dataTransfer.files);
  });

  function split(text) {
    const position = text.lastIndexOf(marker);
    const end = [guidance, oldGuidance].find(suffix => text.trimEnd().endsWith(suffix));
    if (position < 0 || !end) return { text, paths: [] };
    const paths = text.trimEnd().slice(position + marker.length, -end.length).split('\n');
    if (!paths.length || paths.length > maxFiles || !paths.every(file => relative.test(file))) return { text, paths: [] };
    return { text: text.slice(0, position), paths };
  }

  function filename(file) {
    const name = file.split('/').at(-1);
    return name.slice(36, 38) === '--' ? name.slice(38) : name;
  }

  function fileLabel(name) {
    const label = document.createElement('span');
    label.className = 'attachment-file';
    label.textContent = name;
    label.title = name;
    return label;
  }

  async function thumbnail(folder, file) {
    if (!folder || !relative.test(file) || !imageName.test(file)) return null;
    return window.desktop.readAttachment(folder, file, true).catch(() => null);
  }

  function savedFileButton(folder, file, showName = false) {
    const name = filename(file);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'saved-attachment';
    button.title = name;
    button.setAttribute('aria-label', t("Preview {0}", name));
    button.setAttribute('aria-haspopup', 'dialog');
    const label = fileLabel(name);
    button.append(label);
    button.onclick = () => void inspect(folder, file, name);
    void thumbnail(folder, file).then(source => {
      if (!source) return;
      const image = document.createElement('img');
      image.src = source;
      image.alt = '';
      image.loading = 'lazy';
      if (showName) button.prepend(image);
      else button.replaceChildren(image);
    });
    return button;
  }

  function setPreviewStatus(text) {
    previewStatus.textContent = text;
    previewStatus.hidden = !text;
  }

  async function inspect(folder, file, name) {
    const item = selected = { folder, file };
    dialogTitle.textContent = name;
    previewContent.replaceChildren();
    reveal.disabled = true;
    setPreviewStatus(t("Loading…"));
    dialog.showModal();
    const preview = await window.desktop.readAttachment(folder, file, 'inspect').catch(() => null);
    if (!dialog.open || selected !== item) return;
    reveal.disabled = !preview;
    setPreviewStatus(!preview ? t("The saved attachment is unavailable.") : preview.kind === 'file'
      ? t("Preview is unavailable for this file. You can show it in File Explorer.") : preview.truncated ? t("Showing the first 256 KB.") : '');
    if (preview?.kind === 'image') {
      const image = document.createElement('img');
      image.src = preview.source;
      image.alt = name;
      image.onerror = () => {
        image.remove();
        setPreviewStatus(t("Preview is unavailable for this file. You can show it in File Explorer."));
      };
      previewContent.append(image);
    } else if (preview?.kind === 'text') {
      const pre = document.createElement('pre');
      pre.tabIndex = 0;
      pre.textContent = preview.text || t("This file is empty.");
      previewContent.append(pre);
    }
  }

  reveal.onclick = async () => {
    const item = selected;
    if (!item) return;
    const shown = await window.desktop.revealAttachment(item.folder, item.file).catch(() => false);
    if (selected === item && dialog.open && !shown) setPreviewStatus(t("Could not show the attachment in File Explorer."));
  };
  dialog.addEventListener('close', () => { selected = undefined; });

  function clearTray() {
    for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
    attachments.length = 0;
  }

  window.desktopAttachments = {
    get hasFiles() { return attachments.length > 0; },
    get revision() { return revision; },
    draftFiles() { return attachments.map(item => item.file); },
    addDraftFiles: attach,
    setDraftLocked(locked) {
      if (draftLocked === locked) return;
      draftLocked = locked;
      add.disabled = locked;
      for (const button of tray.querySelectorAll('.attachment-remove')) button.disabled = locked;
    },
    restoreDraft(files) {
      clearTray();
      attach(Array.isArray(files) ? files : [], true);
    },
    async prepare(text, folder) {
      if (!attachments.length) return text;
      const items = attachments.slice();
      const missing = items.filter(item => !item.path || item.folder !== folder);
      if (missing.length) {
        try {
          const paths = await window.desktop.stageAttachments(
            await Promise.all(missing.map(async ({ file }) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))),
            folder,
          );
          paths.forEach((path, index) => Object.assign(missing[index], { path, folder }));
        } catch (error) {
          notify(error.message.replace(/^Error invoking remote method 'attachments:stage': Error: /, ''));
          throw error;
        }
      }
      const message = text.trim() || t("Review the attached files and briefly describe them.");
      return message + marker + items.map(item => item.path).join('\n') + guidance;
    },
    clear() {
      clearTray();
      notify('');
      render();
    },
    split,
    savedFileButton,
    async restoreFile(folder, file) {
      if (!folder || !relative.test(file)) return null;
      const data = await window.desktop.readAttachment(folder, file, false).catch(() => null);
      if (!data) return null;
      const name = filename(file);
      const type = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : '';
      return new File([data], name, { type });
    },
  };
})();
