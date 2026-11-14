(() => {
  const $ = id => document.getElementById(id);
  const panel = $('workbench-overview');
  const meter = $('context-meter');
  const popover = $('context-popover');
  const progress = $('context-progress');
  const actionStatus = $('context-action-status');
  const contextDialog = $('context-details-dialog');
  const numbers = new Intl.NumberFormat(document.documentElement.lang);
  let snapshot, history, state = {}, session, context, contextContent, confirmation;
  const tools = new Map();
  const activities = { read: t("Reading a file"), bash: t("Running a command"), powershell: t("Running a command"),
    edit: t("Editing a file"), write: t("Editing a file") };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function icon(name) {
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glyph.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(glyph.namespaceURI, 'use');
    use.setAttribute('href', `#i-${name}`);
    glyph.append(use);
    return glyph;
  }

  function renderContext() {
    const capacity = context?.contextWindow;
    const used = context?.tokens;
    meter.disabled = !session || Boolean(history);
    const known = Number.isFinite(used) && capacity > 0;
    const pct = known && Math.round(used / capacity * 100);
    meter.title = known ? t("Context used: {0}%", pct) : t("Chat context");
    meter.setAttribute('aria-label', meter.title);
    $('context-meter-value').textContent = known ? `${pct}%` : '';
    $('context-meter-value').hidden = !known;
    progress.hidden = !known;
    if (known) {
      progress.max = capacity;
      progress.value = used;
    }
    $('context-usage').textContent = known ? t("{0} of {1} tokens used ({2}%)", numbers.format(used), numbers.format(capacity), pct)
      : capacity > 0 ? t("Context window: {0} tokens. Usage estimate pending.", numbers.format(capacity)) : t("Context usage is unavailable.");
    if (meter.disabled && popover.matches(':popover-open')) popover.hidePopover();
  }

  popover.addEventListener('toggle', () => meter.setAttribute('aria-expanded', String(popover.matches(':popover-open'))));
  document.addEventListener('freepi:open-context', () => { if (!meter.disabled) popover.showPopover({ source: meter }); });
  $('context-details').onclick = () => {
    popover.hidePopover();
    renderContextDetails();
    contextDialog.showModal();
  };
  contextDialog.addEventListener('close', () => { if (!meter.disabled) meter.focus(); });

  function renderContextDetails() {
    const list = $('context-details-list');
    const opened = new Set([...list.querySelectorAll('details[open]')].map(item => item.dataset.key));
    const status = $('context-details-status');
    const entries = contextContent?.entries ?? [];
    status.textContent = !entries.length && !contextContent?.tools.length ? t("The CLI has not reported context details yet.")
      : contextContent?.limited ? t("Showing the latest 100 context entries. Long entries are shortened.")
        : t("Context reported by the CLI for this chat. Long entries are shortened.");
    const roles = { system: t("System instructions"), initialPrompt: t("New chat instructions"), user: t("You"),
      assistant: t("free-pi reply"), toolResult: t("Tool result"), compactionSummary: t("Compaction summary"), branchSummary: t("Branch summary") };
    const rows = entries.map((entry, index) => {
      const item = element('details');
      item.dataset.key = `${entry.role}:${index}`;
      item.open = opened.has(item.dataset.key);
      item.append(element('summary', roles[entry.role] ?? t("Session context")), element('pre', entry.text));
      return item;
    });
    if (contextContent?.tools.length) {
      const item = element('details');
      item.dataset.key = 'tools';
      item.open = opened.has(item.dataset.key);
      item.append(element('summary', t("Tools")), element('pre', contextContent.tools.join('\n')));
      rows.splice(entries[0]?.role === 'system' ? 1 : 0, 0, item);
    }
    list.replaceChildren(...rows);
  }
  document.addEventListener('freepi:compact-requested', () => {
    actionStatus.textContent = t("Compacting context…");
    actionStatus.hidden = false;
  });

  function render() {
    if (panel.hidden) return;
    const expanded = new Set([...panel.querySelectorAll('details[open]')].map(node => node.dataset.result));
    const active = history ?? snapshot;
    const messages = active?.messages ?? [];
    const sections = [];
    function section(title, rows, kind) {
      if (!rows.length) return;
      const group = element('section', undefined, 'overview-section');
      if (kind) group.dataset.kind = kind;
      const items = element('div', undefined, 'overview-items');
      items.append(...rows);
      group.append(element('h3', title), items);
      sections.push(group);
    }
    const waiting = state.execution?.state === 'confirmation';
    const startupConfirmation = !history && state.startupStep === 'trust';
    if (waiting || startupConfirmation) {
      const open = element('button', t("Go to confirmation"));
      open.type = 'button';
      open.onclick = () => document.dispatchEvent(new Event('freepi:open-confirmation'));
      const title = startupConfirmation ? t("Review folder trust in the terminal")
        : confirmation?.title ?? (history ? t("The agent is waiting in another chat") : t("Confirmation is required in the terminal"));
      section(t("Confirmation needed"), [element('p', title), open], 'confirmation');
    } else if (!history && state.busy) {
      const activeTools = [...new Set(tools.values())].map(tool => activities[tool] ?? t("Tool: {0}", tool));
      section(t("Current activity"), [element('p', activeTools.join(' · ') || t("Agent is working"))], 'activity');
    }
    const todos = active?.todos ?? [];
    if (todos.length) {
      const list = element('ul');
      for (const todo of todos) {
        const item = element('li');
        item.dataset.done = String(todo.done);
        const badge = element('span', todo.done ? t("Done") : t("Pending"), 'overview-state');
        badge.prepend(icon(todo.done ? 'check' : 'history'));
        item.append(element('span', todo.text), badge);
        list.append(item);
      }
      section(t("Tasks"), [list]);
    }
    const changes = window.desktopChanges?.recentFiles(messages.filter(message => message.role === 'user').map(message => message.id)) ?? [];
    section(t("Changed files"), changes.map(({ path, messageId }) => {
      const button = element('button', undefined, 'overview-file');
      button.type = 'button';
      button.title = path;
      button.append(icon('diff'), element('span', path), icon('chevron-right'));
      button.onclick = () => window.desktopChanges.openFileDiff(messageId, path);
      return button;
    }));
    section(t("Documents"), changes.filter(({ path, status }) => status !== 'deleted' && /\.(?:md|txt|html?|svg|csv)$/i.test(path)).map(({ path }) => {
      const button = element('button', undefined, 'overview-file');
      button.type = 'button';
      button.title = t("Open file in the workbench");
      button.setAttribute('aria-label', t("Preview {0}", path));
      button.append(icon('file'), element('span', path), icon('chevron-right'));
      button.onclick = () => void window.freepiWorkbench.openFile(path);
      return button;
    }));
    const calls = new Map();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const part of message.content ?? []) if (part.type === 'toolCall') calls.set(part.id, part.arguments);
    }
    const results = messages.filter(message => message.role === 'toolResult' && ['bash', 'powershell'].includes(message.toolName)).slice(-5);
    section(t("Command results"), results.map(result => {
      const command = element('details');
      command.dataset.result = result.id;
      command.open = expanded.has(result.id);
      const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const summary = element('summary');
      const title = calls.get(result.toolCallId)?.command ?? result.toolName;
      summary.title = title;
      const badge = element('span', result.isError ? t("Error") : t("Done"), 'overview-state');
      badge.dataset.error = String(result.isError);
      summary.append(icon('terminal'), element('code', title), badge, icon('chevron-right'));
      command.append(summary, element('pre', text || t("No text output")));
      return command;
    }));
    panel.replaceChildren(...(sections.length ? sections : [element('p', history?.loading ? t("Loading history…")
      : history?.error ? t("History unavailable.") : t("No activity or changes for this chat yet."))]));
  }

  window.desktop.onTranscript(value => {
    snapshot = value;
    if (!history) render();
  });
  window.desktop.onLive(event => {
    if (event.type === 'session') {
      session = event.sessionId;
      context = undefined;
      contextContent = undefined;
      if (contextDialog.open) contextDialog.close();
      confirmation = undefined;
      actionStatus.hidden = true;
      tools.clear();
      renderContext();
      render();
    } else if (event.sessionId === session) {
      if (event.type === 'context') { context = event.context; renderContext(); }
      else if (event.type === 'context-content') {
        contextContent = event;
        if (contextDialog.open) renderContextDetails();
      }
      else if (event.type === 'compaction') {
        actionStatus.textContent = { done: t("Context compacted."), small: t("This chat is too short to compact."),
          cancelled: t("Compaction cancelled."), failed: t("Could not compact context. See the terminal for details.") }[event.state] ?? '';
        actionStatus.hidden = !actionStatus.textContent;
      }
      else if (event.type === 'confirmation') { confirmation = event.open ? event : undefined; render(); }
      else if (event.type === 'tool') {
        if (event.state === 'running') tools.set(event.toolCallId, event.toolName);
        else tools.delete(event.toolCallId);
        render();
      }
    }
  });
  window.desktop.onExit(() => { session = undefined; context = undefined; contextContent = undefined; confirmation = undefined; tools.clear(); if (contextDialog.open) contextDialog.close(); renderContext(); render(); });
  document.addEventListener('freepi:state', ({ detail }) => { state = detail; render(); });
  document.addEventListener('freepi:history-view', ({ detail }) => { history = detail; renderContext(); render(); });
  document.addEventListener('freepi:history-return', () => { history = undefined; renderContext(); render(); });
  document.addEventListener('freepi:workbench', render);
  document.addEventListener('freepi:diff-history', render);
})();
