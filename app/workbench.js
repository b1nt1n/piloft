(() => {
  const $ = id => document.getElementById(id);
  const panel = $('workbench');
  const tabs = [...panel.querySelectorAll('[data-workbench-tab]')];
  const views = { overview: $('workbench-overview'), changes: $('changes-panel'), files: $('workbench-files'), attachments: $('workbench-attachments') };
  const search = $('workbench-search');
  const list = $('workbench-files-list');
  const status = $('workbench-file-status');
  const content = $('workbench-file-content');
  const toolbar = $('workbench-file-toolbar');
  const divider = $('workbench-divider');
  const languages = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', css: 'css', html: 'xml', svg: 'xml', xml: 'xml',
    md: 'markdown', json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml', sh: 'bash', ps1: 'powershell', sql: 'sql' };
  let activeTab = null;
  const projectContext = $('project-context');
  let branchRequest = 0;
  let branchReady = false;
  let folder;
  let activeFolder;
  let historyView;
  let file;
  let fileRequest = 0;
  let searchRequest = 0;
  let searchTimer;
  let returnFocus;
  let activeSnapshot;
  let attachmentKey = '';

  function open(tab, focus = true) {
    if (!views[tab]) return;
    if (!activeTab) returnFocus = document.activeElement;
    activeTab = tab;
    panel.hidden = false;
    document.body.classList.add('workbench-open');
    $('workbench-toggle').setAttribute('aria-expanded', String(tab === 'files'));
    $('overview-toggle').setAttribute('aria-expanded', String(tab === 'overview'));
    for (const [name, view] of Object.entries(views)) view.hidden = name !== tab;
    const selected = tabs.find(button => button.dataset.workbenchTab === tab);
    for (const button of tabs) button.setAttribute('aria-pressed', String(button === selected));
    document.dispatchEvent(new CustomEvent('freepi:workbench', { detail: { tab } }));
    if (tab === 'files') loadFiles();
    if (tab === 'attachments') showAttachments();
    if (focus) selected.focus({ preventScroll: true });
  }

  function close() {
    if (!activeTab) return;
    activeTab = null;
    panel.hidden = true;
    document.body.classList.remove('workbench-open');
    $('workbench-toggle').setAttribute('aria-expanded', 'false');
    $('overview-toggle').setAttribute('aria-expanded', 'false');
    document.dispatchEvent(new CustomEvent('freepi:workbench', { detail: { tab: null } }));
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  function notice(text) {
    status.textContent = text;
    status.hidden = !text;
  }

  function hideFile() {
    toolbar.hidden = true;
    content.parentElement.hidden = true;
    content.textContent = '';
    file = undefined;
  }

  async function openFile(path, line) {
    open('files', false);
    if (historyView?.loading || historyView?.error) return;
    const request = ++fileRequest;
    hideFile();
    notice(t("Opening file…"));
    try {
      const preview = await window.desktop.previewProjectFile(path);
      if (request !== fileRequest) return;
      file = preview.path;
      $('workbench-filename').textContent = file;
      $('workbench-filename').title = file;
      toolbar.hidden = false;
      content.className = '';
      content.removeAttribute('data-highlighted');
      content.textContent = preview.text;
      const language = languages[file.split('.').at(-1).toLowerCase()];
      if (language && preview.text.length < 65_536 && window.hljs?.getLanguage(language)) {
        content.className = 'language-' + language;
        window.hljs.highlightElement(content);
      }
      content.parentElement.hidden = false;
      notice(preview.truncated ? t("Showing the first 256 KB.") : '');
      $('workbench-file-preview').scrollTop = 0;
      if (Number.isInteger(line) && line > 0) highlightLine(preview.text, line);
      if (activeTab === 'files') $('workbench-file-preview').focus({ preventScroll: true });
    } catch (error) {
      if (request === fileRequest) notice(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
    }
  }

  function highlightLine(text, line) {
    const lines = text.split('\n');
    if (line > lines.length) {
      notice(t("Line {0} is not in the preview.", line));
      return;
    }
    // Use plain text for this view so a line can be targeted without splitting syntax-highlight spans.
    const index = line - 1;
    const target = document.createElement('mark');
    target.className = 'workbench-target-line';
    target.textContent = lines[index] || ' ';
    const prefix = index ? lines.slice(0, index).join('\n') + '\n' : '';
    const suffix = index + 1 < lines.length ? '\n' + lines.slice(index + 1).join('\n') : '';
    content.replaceChildren(prefix, target, suffix);
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  async function loadFiles() {
    clearTimeout(searchTimer);
    const query = search.value;
    const request = ++searchRequest;
    if (historyView?.loading || historyView?.error) return;
    searchTimer = setTimeout(async () => {
      let files;
      try {
        files = await window.desktop.findProjectFiles(query);
      } catch {}
      if (request !== searchRequest) return;
      list.replaceChildren();
      if (!files?.length) {
        const empty = document.createElement('p');
        empty.textContent = files ? t("No files found.") : t("Could not load project files.");
        list.append(empty);
        return;
      }
      for (const entry of files) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.path;
        button.title = entry.path;
        button.onclick = () => {
          if (entry.kind === 'directory') {
            search.value = entry.path;
            search.focus();
            loadFiles();
          } else void openFile(entry.path);
        };
        list.append(button);
      }
    }, 120);
  }

  function addContext(text) {
    document.dispatchEvent(new CustomEvent('freepi:add-context', { detail: text, cancelable: true }));
  }

  function showAttachments() {
    const attachmentSnapshot = historyView ?? activeSnapshot;
    const entries = attachmentSnapshot?.messages.flatMap(message => {
      if (message.role !== 'user') return [];
      const text = typeof message.content === 'string' ? message.content
        : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      return window.desktopAttachments.split(text).paths;
    }) ?? [];
    const nextKey = [attachmentSnapshot?.folder, attachmentSnapshot?.sessionId, historyView?.loading, historyView?.error, ...entries].join('\0');
    if (nextKey === attachmentKey && views.attachments.childElementCount) return;
    attachmentKey = nextKey;
    const view = views.attachments;
    view.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.textContent = historyView?.loading ? t("Loading history…") : historyView?.error ? t("History unavailable.")
        : t("This chat has no sent attachments.");
      view.append(empty);
    }
    for (const path of new Set(entries)) {
      view.append(window.desktopAttachments.savedFileButton(attachmentSnapshot.folder, path, true));
    }
  }

  const minWidth = 330;
  function maxWidth() {
    return Math.max(minWidth, Math.min(1100, innerWidth - $('sidebar').offsetWidth - 360));
  }

  function syncDivider() {
    divider.setAttribute('aria-valuemin', String(minWidth));
    divider.setAttribute('aria-valuemax', String(maxWidth()));
    divider.setAttribute('aria-valuenow', String(panel.offsetWidth));
  }

  function resize(width, save = false) {
    const next = Math.min(maxWidth(), Math.max(minWidth, width));
    document.body.style.setProperty('--workbench-width', next + 'px');
    if (save) localStorage.setItem('workbench-width', String(next));
  }

  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    divider.setPointerCapture(event.pointerId);
  });
  divider.addEventListener('pointermove', event => {
    if (divider.hasPointerCapture(event.pointerId)) resize(innerWidth - event.clientX);
  });
  divider.addEventListener('pointerup', event => {
    if (divider.hasPointerCapture(event.pointerId)) resize(innerWidth - event.clientX, true);
  });
  divider.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    resize(panel.offsetWidth + (event.key === 'ArrowLeft' ? 25 : -25), true);
  });
  const savedWidth = Number(localStorage.getItem('workbench-width'));
  if (savedWidth >= minWidth) document.body.style.setProperty('--workbench-width', savedWidth + 'px');
  new ResizeObserver(() => { if (activeTab && divider.offsetWidth) syncDivider(); }).observe(panel);

  $('workbench-toggle').onclick = () => activeTab === 'files' ? close() : open('files');
  $('overview-toggle').onclick = () => activeTab === 'overview' ? close() : open('overview');
  projectContext.onclick = () => open('files');
  $('workbench-close').onclick = close;
  tabs.forEach(button => { button.onclick = () => open(button.dataset.workbenchTab); });
  search.oninput = loadFiles;
  $('workbench-context').onclick = () => {
    if (file) addContext(/\s/u.test(file) ? `@"${file}"` : `@${file}`);
  };
  $('workbench-editor').onclick = async () => {
    if (!file || historyView?.loading || historyView?.error) return;
    const request = fileRequest;
    try {
      await window.desktop.openProjectEditor(file);
    } catch {
      if (request === fileRequest) notice(t("Could not open the file in the editor."));
    }
  };
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) close();
  });
  function updateProjectContext(nextFolder) {
    const request = ++branchRequest;
    projectContext.hidden = !nextFolder;
    projectContext.title = nextFolder ?? '';
    const name = nextFolder?.split(/[\\/]/).filter(Boolean).at(-1) ?? nextFolder ?? '';
    const label = projectContext.lastElementChild;
    label.textContent = name;
    if (nextFolder && !historyView?.loading && !historyView?.error) {
      void window.desktop.projectBranch().then(branch => {
        if (branch && request === branchRequest) label.textContent = `${name} · ${branch}`;
      }).catch(() => {});
    }
  }

  function updateFolder(nextFolder) {
    updateProjectContext(nextFolder);
    if (folder !== nextFolder || historyView?.loading) {
      folder = nextFolder;
      fileRequest++;
      hideFile();
      search.value = '';
      list.replaceChildren();
    }
    if (!file) notice(historyView?.loading ? t("Loading history…") : historyView?.error ? t("History unavailable.")
      : t("Choose a project file."));
    if (activeTab === 'files') loadFiles();
  }

  document.addEventListener('freepi:state', ({ detail }) => {
    const nextFolder = detail.activeFolder ?? (detail.viewingHistory ? activeFolder : detail.folder);
    const ready = Boolean(detail.ready);
    const becameReady = ready && !branchReady;
    branchReady = ready;
    if (activeFolder === nextFolder) {
      if (becameReady && !historyView) updateProjectContext(activeFolder);
      return;
    }
    activeFolder = nextFolder;
    if (!historyView) updateFolder(activeFolder);
  });
  document.addEventListener('freepi:history-view', ({ detail }) => {
    historyView = detail;
    updateFolder(detail.folder);
    if (activeTab === 'attachments') showAttachments();
  });
  document.addEventListener('freepi:history-return', () => {
    historyView = undefined;
    updateFolder(activeFolder);
    if (activeTab === 'attachments') showAttachments();
  });
  window.desktop.onTranscript(snapshot => {
    activeSnapshot = snapshot;
    if (!historyView && activeTab === 'attachments') showAttachments();
  });
  window.freepiWorkbench = { open, close, openFile, get activeTab() { return activeTab; } };
})();
