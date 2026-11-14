(() => {
  const prompt = document.getElementById('prompt');
  const panel = document.getElementById('composer-completion');
  const title = document.getElementById('completion-title');
  const options = document.getElementById('completion-options');
  const status = document.getElementById('completion-status');
  let commands;
  let trigger;
  let items = [];
  let selected = -1;
  let generation = 0;
  let searchTimer;
  let suppressed;
  let folder;
  let activeSession;
  let viewingHistory = false;

  function token() {
    if (prompt.selectionStart !== prompt.selectionEnd) return;
    const cursor = prompt.selectionStart;
    const tail = prompt.value.slice(0, cursor);
    const command = !viewingHistory && /(?:^|\s)\/([\w:-]*)$/u.exec(tail);
    const mention = /(?:^|\s)(@"[^"\r\n]*|@[^\s@"]*)$/u.exec(tail);
    if (!command && !mention) return;
    const kind = command ? 'command' : 'file';
    const start = command ? tail.lastIndexOf('/') : cursor - mention[1].length;
    return { kind, start, cursor, inline: Boolean(command && tail.slice(0, start).trim()),
      query: tail.slice(start + 1).replace(/^"/, '') };
  }

  function hide() {
    generation++;
    clearTimeout(searchTimer);
    trigger = undefined;
    panel.hidden = true;
    prompt.removeAttribute('aria-activedescendant');
    items = [];
    selected = -1;
  }

  function setActive(index, scroll = false) {
    selected = index;
    for (const [offset, row] of [...options.children].entries()) {
      row.setAttribute('aria-selected', String(offset === index));
    }
    const row = options.children[index];
    if (row) {
      prompt.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    } else prompt.removeAttribute('aria-activedescendant');
  }

  function render(matches, message = '') {
    items = matches;
    options.replaceChildren();
    status.textContent = message;
    status.hidden = !message;
    for (const [index, item] of items.entries()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.id = `completion-${index}`;
      row.tabIndex = -1;
      row.className = 'completion-option';
      row.setAttribute('role', 'option');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(icon.namespaceURI, 'use');
      use.setAttribute('href', item.icon);
      icon.append(use);
      const label = document.createElement('span');
      label.className = 'completion-label';
      label.textContent = item.label;
      row.title = item.detail ? `${item.label} · ${item.detail}` : item.label;
      const detail = document.createElement('span');
      detail.className = 'completion-detail';
      detail.textContent = item.detail;
      row.append(icon, label, detail);
      row.onmousedown = event => event.preventDefault();
      row.onclick = () => choose(index);
      options.append(row);
    }
    options.scrollTop = 0;
    setActive(items.length ? 0 : -1);
  }

  function choose(index) {
    const item = items[index];
    if (!item || !trigger) return;
    const { start, cursor, inline } = trigger;
    const end = prompt.value[cursor] === '"' && prompt.value[start + 1] === '"' ? cursor + 1 : cursor;
    prompt.focus();
    if (item.attach) {
      prompt.setRangeText('', start, end, 'end');
      hide();
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('attach-files').click();
      return;
    }
    if (inline && !document.dispatchEvent(new CustomEvent('freepi:composer-command', {
      detail: item.value, cancelable: true,
    }))) {
      prompt.setRangeText('', start, end, 'end');
      hide();
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (inline) return;
    const value = item.directory ? item.value : item.value + ' ';
    prompt.setRangeText(value, start, end, 'end');
    if (item.directory && value.endsWith('"')) {
      prompt.selectionStart = prompt.selectionEnd = start + value.length - 1;
    }
    hide();
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function signature(match) {
    return `${match.start}:${match.cursor}:${match.kind}:${match.query}`;
  }

  function update() {
    if (document.activeElement !== prompt || document.querySelector('dialog[open]')) return hide();
    const match = token();
    if (!match || suppressed === signature(match)) return hide();
    if (trigger && signature(trigger) === signature(match)) return;
    trigger = match;
    const request = ++generation;
    clearTimeout(searchTimer);
    panel.hidden = false;
    title.textContent = match.kind === 'command' ? t("FreePi commands") : t("Project files");
    const query = match.query.toLowerCase();
    if (match.kind === 'command') {
      const list = (commands ?? []).filter(entry => entry.name.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query));
      list.sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)));
      render(list.map(entry => ({
        value: '/' + entry.name,
        label: '/' + entry.name,
        detail: entry.description || entry.argumentHint || '',
        icon: entry.source === 'skill' || entry.source === 'prompt' ? '#i-file' : '#i-terminal',
      })), list.length ? (match.inline ? t("The command runs separately from your draft.") : '')
        : commands ? t("No commands found.") : t("Command list unavailable. You can still type a command."));
      return;
    }
    render([], t("Searching files…"));
    searchTimer = setTimeout(async () => {
      try {
        const matches = await window.desktop.findProjectFiles(match.query);
        if (request !== generation) return;
        const files = matches.map(entry => ({
          value: entry.value, label: entry.path, detail: '', directory: entry.kind === 'directory',
          icon: entry.kind === 'directory' ? '#i-folder' : '#i-file',
        }));
        if (!match.query) files.unshift({ label: t("Attach files"), icon: '#i-plus', attach: true });
        render(files, files.length ? '' : t("No files or folders found."));
      } catch {
        if (request === generation) render([], t("Could not read project files."));
      }
    }, 125);
  }

  prompt.addEventListener('input', () => { suppressed = undefined; update(); });
  prompt.addEventListener('click', update);
  prompt.addEventListener('keyup', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update();
  });
  prompt.addEventListener('blur', hide);
  prompt.addEventListener('keydown', event => {
    if (panel.hidden || event.isComposing) return;
    const key = event.key;
    if (key === 'Escape') {
      if (trigger) suppressed = signature(trigger);
      hide();
    } else if ((key === 'ArrowUp' || key === 'ArrowDown') && items.length) {
      setActive((selected + (key === 'ArrowUp' ? -1 : 1) + items.length) % items.length, true);
    } else if ((key === 'Enter' || key === 'Tab') && !event.shiftKey && selected >= 0) {
      choose(selected);
    } else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  document.addEventListener('freepi:state', ({ detail }) => {
    if (detail.folder === folder && Boolean(detail.viewingHistory) === viewingHistory) return;
    folder = detail.folder;
    viewingHistory = Boolean(detail.viewingHistory);
    hide();
  });
  window.desktop.onLive(event => {
    if (event.type === 'session' && event.sessionId !== activeSession) {
      activeSession = event.sessionId;
      commands = undefined;
      hide();
    } else if (event.type === 'commands' && event.sessionId === activeSession) {
      commands = event.commands;
      trigger = undefined;
      update();
    }
  });
  window.desktop.onExit(() => {
    commands = undefined;
    hide();
  });
  window.freepiCompletion = { hide };
})();
