(() => {
  const feed = document.getElementById('chat-feed');
  const messages = document.getElementById('chat-messages');
  const latest = document.getElementById('chat-latest');
  const empty = document.getElementById('chat-empty');
  const emptyHeading = empty?.querySelector('h1');
  const runStatus = element('div', 'chat-run-status');
  runStatus.hidden = true;
  feed.insertBefore(runStatus, feed.firstChild);
  const markdown = window.markdownit({ html: false }).disable('image');
  const rows = new Map();
  const toolGroups = new Map();
  let activeFeed = createFeed();
  let historyFeed;
  let following = true;
  let renderFrame;
  const pluralFiles = new Intl.PluralRules(document.documentElement.lang);

  const toolTitles = {
    read: t("Read file"),
    write: t("Write file"),
    edit: t("Edit file"),
    bash: t("Command"),
    grep: t("Search contents"),
    find: t("Find files"),
    ls: t("List files"),
  };

  markdown.validateLink = value => /^https?:\/\//i.test(value);

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function asBlocks(content) {
    return typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
  }

  function asText(content) {
    return asBlocks(content).filter(block => block.type === 'text').map(block => block.text).join('\n');
  }

  function replyKey(message) {
    return message.timestamp == null ? message.id : `reply:${message.timestamp}`;
  }

  function toolKey(id, fallback) {
    return id ? `tool:${id}` : fallback;
  }

  function createFeed(sessionId, folder, messages = []) {
    return { sessionId, folder, messages, liveReplies: new Map(), liveTools: new Map(), nextOrder: 0 };
  }

  function assistantEntries(message, reply, toolFor) {
    const entries = [];
    let textIndex = 0;
    let thinkingIndex = 0;
    for (const block of asBlocks(message.content)) {
      if (block.type === 'toolCall') {
        const tool = toolFor(block);
        if (tool) entries.push(tool);
      } else if (block.type === 'text' && block.text.trim()) {
        entries.push({ key: `${reply}:${textIndex++}`, type: 'assistant', messageId: message.id, text: block.text, streaming: message.complete === false });
      } else if (block.type === 'thinking' && !block.redacted && typeof block.thinking === 'string') {
        const key = `${reply}:thinking:${thinkingIndex++}`;
        const streaming = message.complete === false && block.streaming === true;
        if (streaming || block.thinking.trim()) entries.push({ key, type: 'thinking', text: block.thinking, streaming });
      }
    }
    return entries;
  }

  function entriesFor({ messages: transcript, folder, liveReplies, liveTools, startedAt }) {
    const output = [];
    const tail = [];
    const calls = new Set();
    const replies = new Set();
    const results = new Map();
    for (const message of transcript) {
      if (message.role === 'toolResult') results.set(message.toolCallId, message);
      else if (message.role === 'assistant') {
        for (const block of asBlocks(message.content)) {
          if (block.type === 'toolCall') calls.add(block.id);
        }
      }
    }
    for (const message of transcript) {
      if (message.role === 'assistant') {
        const reply = replyKey(message);
        replies.add(reply);
        output.push(...assistantEntries(message, reply, block => ({
          key: toolKey(block.id, message.id), type: 'tool', call: block,
          result: results.get(block.id), live: results.has(block.id) ? undefined : liveTools.get(block.id),
        })));
        if (message.stopReason === 'aborted' || message.errorMessage) {
          output.push({ key: `${message.id}:status`, type: 'status',
            text: message.stopReason === 'aborted' ? t("Execution stopped") : message.errorMessage });
        }
      } else if (message.role === 'user') {
        const { text, paths } = window.desktopAttachments.split(asText(message.content));
        if (text.trim() || paths.length) output.push({ key: message.id, type: 'user', text, paths, folder });
      } else if (message.role === 'toolResult' && !calls.has(message.toolCallId)) {
        // A branch can retain a result without the originating call.
        output.push({ key: toolKey(message.toolCallId, message.id), type: 'tool', result: message });
      }
    }
    for (const [reply, message] of liveReplies) {
      if (replies.has(reply)) {
        liveReplies.delete(reply);
        continue;
      }
      const entries = assistantEntries(message, reply, block => {
        const live = liveTools.get(block.id);
        if (!live || calls.has(block.id) || results.has(block.id)) return;
        calls.add(block.id);
        return { key: toolKey(block.id), type: 'tool', live };
      });
      for (const entry of entries) tail.push({ ...entry, order: message.order });
    }
    for (const [id, tool] of liveTools) {
      if (results.has(id)) {
        liveTools.delete(id);
      } else if (!calls.has(id)) {
        tail.push({ key: toolKey(id), type: 'tool', live: tool, order: tool.order });
      }
    }
    return groupTurnErrors(output.concat(tail.sort((left, right) => left.order - right.order)), Boolean(startedAt));
  }

  function groupTurnErrors(entries, running) {
    const output = [];
    let start = 0;
    for (let end = 0; end <= entries.length; end++) {
      if (end < entries.length && entries[end].type !== 'user') continue;
      const turn = entries.slice(start, end);
      const statuses = turn.filter(entry => entry.type === 'status');
      if (statuses.length) {
        const last = statuses.at(-1);
        const recovered = turn.slice(turn.indexOf(last) + 1).some(entry => entry.type === 'assistant' && !entry.streaming);
        const entry = {
          key: `${turn[0].key}:attempts`, type: 'status', recovered,
          retry: !recovered && !(running && end === entries.length) && turn[0].type === 'user' ? turn[0] : undefined,
          details: statuses.map(status => status.text),
        };
        if (!recovered) turn.splice(turn.indexOf(last), 0, entry);
        output.push(...turn.filter(item => !statuses.includes(item)));
        if (recovered) output.push(entry);
      } else output.push(...turn);
      start = end;
    }
    return output;
  }

  function renderMarkdown(body, text) {
    body.innerHTML = markdown.render(text);
    for (const code of body.querySelectorAll(':not(pre) > code')) {
      const path = code.textContent.trim();
      if (!/^(?!https?:|[a-z]+:\/\/)[^<>\r\n]+\.[a-z\d]{1,12}$/i.test(path) || path.length > 220) continue;
      const link = element('button', 'message-file-link', path);
      link.type = 'button';
      link.title = t("Open file in the workbench");
      link.onclick = () => void window.freepiWorkbench.openFile(path);
      code.replaceChildren(link);
    }
    for (const table of body.querySelectorAll('table')) {
      const wrap = element('div', 'chat-table-wrap');
      table.replaceWith(wrap);
      wrap.append(table);
    }
    for (const code of body.querySelectorAll('pre > code')) {
      const pre = code.parentElement;
      const section = element('div', 'chat-code');
      const header = element('div', 'chat-code-header');
      const language = code.className.match(/(?:^|\s)language-([\w+.-]+)/)?.[1] || t("Code");
      const copy = element('button', 'chat-code-copy', t("Copy"));
      copy.type = 'button';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(code.textContent);
          copy.textContent = t("Copied");
        } catch {
          copy.textContent = t("Could not copy");
        }
      };
      header.append(element('span', 'chat-code-language', language), copy);
      pre.replaceWith(section);
      section.append(header, pre);
    }
  }

  function toolSection(label, value) {
    const section = element('div', 'chat-tool-section');
    section.append(element('h4', undefined, label), element('pre', undefined, value));
    return section;
  }

  function updateTool(details, { call, result, live }) {
    const name = call?.name || result?.toolName || live?.toolName || t("Tool");
    const args = live?.args ?? call?.arguments;
    const subject = args?.path ?? args?.file_path ?? args?.command ?? args?.query ?? args?.pattern;
    const label = toolTitles[name] ?? name;
    const status = result ? (result.isError ? 'error' : 'done') : live?.state ?? 'waiting';
    details.dataset.status = status;
    const summary = details.querySelector('summary');
    const title = element('span', 'chat-tool-name', label);
    summary.replaceChildren(title);
    if (typeof subject === 'string' && subject.trim()) {
      const argument = element('code', 'chat-tool-argument', subject.replace(/\s+/g, ' ').slice(0, 180));
      argument.title = subject;
      summary.append(argument);
    }
    summary.append(element('span', 'chat-tool-status', {
      done: t("Done"), error: t("Error"), running: t("Running"), waiting: t("Waiting for a result"),
    }[status]));

    const body = details.querySelector('.chat-tool-body');
    body.replaceChildren();
    const fill = () => {
      if (args && Object.keys(args).length) body.append(toolSection(t("Input"), JSON.stringify(args, null, 2)));
      if (result) {
        const text = asText(result.content);
        body.append(toolSection(t("Result"), text || t("No text output")));
      }
      if (!body.hasChildNodes()) body.append(element('p', undefined, t("No result recorded yet")));
    };
    if (details.open) fill();
    details.ontoggle = () => {
      if (!details.isConnected) return;
      if (details.open && !body.hasChildNodes()) fill();
      updateLatest();
    };
  }

  function userAttachments(entry) {
    const attachments = element('div', 'chat-attachments');
    for (const file of entry.paths) {
      attachments.append(window.desktopAttachments.savedFileButton(entry.folder, file));
    }
    return attachments;
  }

  function makeRow(entry) {
    if (entry.type === 'thinking') {
      const details = element('details', 'chat-thinking');
      details.append(element('summary', 'chat-tool-summary'), element('div', 'chat-thinking-body'));
      updateThinking(details, entry);
      return details;
    }
    if (entry.type === 'tool') {
      const details = element('details', 'chat-tool');
      details.append(element('summary', 'chat-tool-summary'), element('div', 'chat-tool-body'));
      updateTool(details, entry);
      return details;
    }
    if (entry.type === 'status') {
      const affected = element('section', 'chat-attempts');
      affected.dataset.recovered = String(entry.recovered);
      const details = element('details', 'chat-tool');
      const rateLimit = entry.details.every(text => /\b(?:429|rate limit)\b/i.test(text));
      const concurrent = rateLimit && entry.details.every(text => /one request at a time/i.test(text));
      const label = entry.recovered ? t("Reply received after a failure")
        : concurrent ? t("FreePi is already handling another request")
          : rateLimit ? t("FreePi temporarily limited requests")
            : entry.details.at(-1) === t("Execution stopped") ? t("Execution stopped") : t("The request failed");
      const summary = element('summary', 'chat-tool-summary');
      summary.append(element('strong', '', label), element('span', 'chat-tool-status', t("Entries: {0}", entry.details.length)));
      const body = element('div', 'chat-tool-body chat-attempt-details');
      for (const [text, count] of entry.details.reduce((counts, text) => counts.set(text, (counts.get(text) ?? 0) + 1), new Map())) {
        body.append(toolSection(count > 1 ? t("Occurrences: {0}", count) : t("CLI message"), text));
      }
      details.append(summary, body);
      affected.append(details);
      if (entry.retry && (entry.retry.text || entry.retry.paths.length)) {
        const restore = element('button', 'chat-restore-prompt', t("Restore prompt to draft"));
        restore.type = 'button';
        restore.onclick = () => {
          const session = historyFeed ?? activeFeed;
          document.dispatchEvent(new CustomEvent('freepi:restore-prompt', {
            detail: { ...entry.retry, sessionId: session.sessionId, folder: session.folder },
          }));
        };
        affected.append(restore);
      }
      return affected;
    }
    const row = element('article', 'chat-message');
    row.id = `message-${encodeURIComponent(entry.key)}`;
    row.dataset.role = entry.type;
    row.setAttribute('aria-label', entry.type === 'user' ? t("You") : t("free-pi reply"));
    if (entry.type === 'user') {
      const body = element('div', 'chat-user-text');
      if (entry.paths.length) body.append(userAttachments(entry));
      if (entry.text) body.append(element('div', 'chat-user-prompt', entry.text));
      row.append(body);
    }
    else {
      const body = element('div', 'chat-markdown');
      renderMarkdown(body, entry.text);
      row.append(body);
      row.toggleAttribute('data-streaming', Boolean(entry.streaming));
      appendMessageActions(row, entry);
    }
    return row;
  }

  function updateThinking(details, entry) {
    const label = entry.streaming ? t("Thinking…") : t("Reasoning");
    if (details.firstElementChild.textContent !== label) details.firstElementChild.textContent = label;
    if (details.lastElementChild.textContent !== entry.text) details.lastElementChild.textContent = entry.text;
    details.toggleAttribute('data-streaming', entry.streaming);
  }

  function appendMessageActions(row, entry) {
    const actions = element('div', 'message-actions');
    actions.hidden = Boolean(entry.streaming);
    function copy(label, value, icon) {
      const button = element('button', 'icon');
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.title = label;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(svg.namespaceURI, 'use');
      use.setAttribute('href', icon);
      svg.append(use);
      button.append(svg);
      button.onclick = async () => {
        try {
          await navigator.clipboard.writeText(value);
          button.title = t("Copied");
          use.setAttribute('href', '#i-check');
          setTimeout(() => {
            button.title = label;
            use.setAttribute('href', icon);
          }, 1000);
        } catch {
          button.title = t("Could not copy");
        }
      };
      actions.append(button);
    }
    copy(t("Copy reply"), entry.text, '#i-copy');
    copy(t("Copy message link"), `#${row.id}`, '#i-link');
    if (entry.messageId) {
      const fork = element('button', 'icon message-fork');
      fork.type = 'button';
      fork.title = t("Fork from this message");
      fork.setAttribute('aria-label', fork.title);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(svg.namespaceURI, 'use');
      use.setAttribute('href', '#i-branch');
      svg.append(use);
      fork.append(svg);
      fork.onclick = () => document.dispatchEvent(new CustomEvent('freepi:fork-message', { detail: { id: entry.messageId, sessionId: activeFeed.sessionId } }));
      actions.append(fork);
    }
    row.append(actions);
  }

  function updateRow(entry) {
    const previous = rows.get(entry.key);
    const signature = JSON.stringify(entry);
    let node = previous?.node;
    if (!node) node = makeRow(entry);
    else if (signature !== previous.signature) {
      if (entry.type === 'thinking') updateThinking(node, entry);
      else if (entry.type === 'tool') updateTool(node, entry);
      else if (entry.type === 'status') {
        const open = node.firstElementChild.open;
        const replacement = makeRow(entry);
        replacement.firstElementChild.open = open;
        node.replaceWith(replacement);
        node = replacement;
      }
      else if (entry.type === 'assistant') {
        if (entry.text !== previous.text || entry.messageId !== previous.messageId) {
          renderMarkdown(node.firstElementChild, entry.text);
          node.lastElementChild.remove();
          appendMessageActions(node, entry);
        }
        node.lastElementChild.hidden = Boolean(entry.streaming);
        node.toggleAttribute('data-streaming', Boolean(entry.streaming));
      } else {
        const replacement = makeRow(entry);
        node.replaceWith(replacement);
        node = replacement;
      }
    }
    rows.set(entry.key, { node, signature, text: entry.text, messageId: entry.messageId });
    return node;
  }

  function consecutiveTools(entries) {
    const groups = [];
    let tools = [];
    function finishTools() {
      if (tools.length > 1) groups.push(tools);
      else groups.push(...tools);
      tools = [];
    }
    for (const entry of entries) {
      if (entry.type === 'tool') tools.push(entry);
      else {
        finishTools();
        groups.push(entry);
      }
    }
    finishTools();
    return groups;
  }

  function appendInOrder(container, nodes) {
    let position = container.firstElementChild;
    for (const node of nodes) {
      if (node !== position) container.insertBefore(node, position);
      position = node.nextElementSibling;
    }
  }

  function renderToolGroup(entries) {
    const key = entries[0].key;
    const tools = entries.map(updateRow);
    let group = toolGroups.get(key);
    if (!group) {
      group = element('details', 'chat-tool chat-tool-group');
      group.append(
        element('summary', 'chat-tool-summary chat-tool-group-summary'),
        element('div', 'chat-tool-group-body'),
      );
      group.ontoggle = () => { if (group.isConnected) updateLatest(); };
      toolGroups.set(key, group);
    }
    if (tools.some(tool => !group.contains(tool) && (tool.open || tool.contains(document.activeElement)))) {
      group.open = true;
    }
    const count = entries.length;
    const files = { one: t("file"), few: t("file.plural.few"), many: t("file.plural.many"), other: 'files' }[pluralFiles.select(count)];
    const reading = entries.every(entry => (entry.call?.name ?? entry.result?.toolName) === 'read' && entry.result && !entry.result.isError);
    const running = entries.findLast(entry => entry.live?.state === 'running' && !entry.result);
    const name = running?.live.toolName;
    const label = reading ? t("Read {0} {1}", count, files)
      : running ? t("{0} · actions: {1}", toolTitles[name] ?? name, count) : t("Actions: {0}", count);
    group.dataset.status = running ? 'running' : entries.some(entry => entry.result?.isError || entry.live?.state === 'error') ? 'error' : 'done';
    const summary = group.firstElementChild;
    if (summary.textContent !== label) summary.textContent = label;
    appendInOrder(group.lastElementChild, tools);
    return group;
  }

  function nearBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 48;
  }

  function updateLatest() {
    following = nearBottom();
    latest.hidden = following || !rows.size;
  }

  function scrollToLatest() {
    feed.scrollTop = feed.scrollHeight;
    updateLatest();
  }

  feed.addEventListener('scroll', updateLatest, { passive: true });
  latest.onclick = () => {
    scrollToLatest();
    feed.focus({ preventScroll: true });
  };
  new ResizeObserver(() => {
    if (following) scrollToLatest();
    else updateLatest();
  }).observe(feed);

  messages.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    window.desktop.openLink(link.href);
  });

  function resetRows() {
    rows.clear();
    toolGroups.clear();
    messages.replaceChildren();
  }

  function renderFeed(changedSession = false) {
    if (changedSession) resetRows();
    const state = historyFeed ?? activeFeed;
    const atBottom = changedSession || (following && nearBottom());
    const focused = document.activeElement;
    const entries = entriesFor(state);
    const keys = new Set(entries.map(entry => entry.key));
    for (const [key, row] of rows) {
      if (keys.has(key)) continue;
      row.node.remove();
      rows.delete(key);
    }
    const activeGroups = new Set();
    const nodes = consecutiveTools(entries).map(entry => {
      if (!Array.isArray(entry)) return updateRow(entry);
      activeGroups.add(entry[0].key);
      return renderToolGroup(entry);
    });
    for (const [key, group] of toolGroups) {
      if (activeGroups.has(key)) continue;
      group.remove();
      toolGroups.delete(key);
    }
    const userIds = state.messages.filter(message => message.role === 'user').map(message => message.id);
    const summaries = window.desktopChanges.summariesFor(userIds);
    const userNodes = new Map(userIds.map(id => [rows.get(id)?.node, id]));
    const ordered = [];
    let turn;
    for (const message of nodes) {
      if (userNodes.has(message)) {
        if (summaries.has(turn)) ordered.push(summaries.get(turn).node);
        turn = userNodes.get(message);
      }
      ordered.push(message);
    }
    if (summaries.has(turn)) ordered.push(summaries.get(turn).node);
    for (const summary of messages.querySelectorAll(':scope > .changes-summary')) {
      if (!ordered.includes(summary)) summary.remove();
    }
    appendInOrder(messages, ordered);
    if (focused !== document.activeElement && messages.contains(focused)) focused.focus({ preventScroll: true });
    if (empty) empty.hidden = rows.size > 0;
    if (emptyHeading && !rows.size) {
      emptyHeading.textContent = state.loading ? t("Loading history…") : state.error ? t("History unavailable")
        : historyFeed ? t("This chat has no messages yet") : t("What are we working on?");
    }
    updateRunStatus();
    if (atBottom) scrollToLatest();
    else updateLatest();
  }

  function updateRunStatus() {
    const started = !historyFeed && activeFeed.startedAt;
    runStatus.hidden = !started;
    if (!started) return;
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const tool = [...activeFeed.liveTools.values()].findLast(entry => entry.state === 'running')?.toolName;
    const action = tool ? toolTitles[tool] ?? tool : t("Agent is working");
    const duration = elapsed >= 60 ? t("{0} min {1} sec", Math.floor(elapsed / 60), elapsed % 60) : t("{0} sec", elapsed);
    const label = `${action} · ${duration}`;
    if (runStatus.textContent !== label) runStatus.textContent = label;
  }

  let runClock;
  document.addEventListener('freepi:diff-history', () => renderFeed());
  document.addEventListener('freepi:history-view', ({ detail }) => {
    const changed = historyFeed?.sessionId !== detail.sessionId || historyFeed?.folder !== detail.folder;
    historyFeed = Object.assign(createFeed(detail.sessionId, detail.folder, detail.messages), {
      loading: detail.loading, error: detail.error,
    });
    renderFeed(changed);
  });
  document.addEventListener('freepi:history-return', () => {
    if (!historyFeed) return;
    historyFeed = undefined;
    renderFeed(true);
  });
  document.addEventListener('freepi:message-link', event => {
    const target = document.getElementById(event.detail);
    if (!target || !messages.contains(target)) return;
    event.preventDefault();
    for (const row of messages.querySelectorAll('[data-message-target]')) row.removeAttribute('data-message-target');
    target.setAttribute('data-message-target', '');
    target.scrollIntoView({ block: 'center' });
  });

  window.desktop.onTranscript(snapshot => {
    const changed = activeFeed.sessionId !== snapshot.sessionId;
    if (changed) activeFeed = createFeed(snapshot.sessionId);
    if (snapshot.folder) activeFeed.folder = snapshot.folder;
    activeFeed.messages = snapshot.messages;
    if (!historyFeed) renderFeed(changed);
  });

  window.desktop.onLive(event => {
    if (event.type === 'session') {
      if (activeFeed.sessionId !== event.sessionId) {
        clearInterval(runClock);
        activeFeed = createFeed(event.sessionId, event.folder);
        if (!historyFeed) renderFeed(true);
      }
      return;
    }
    if (event.sessionId !== activeFeed.sessionId) return;
    const { liveReplies, liveTools } = activeFeed;
    if (event.type === 'started') {
      activeFeed.startedAt = Date.now();
      clearInterval(runClock);
      runClock = setInterval(updateRunStatus, 1000);
    } else if (event.type === 'assistant') {
      const key = replyKey(event);
      liveReplies.set(key, { ...event, order: liveReplies.get(key)?.order ?? activeFeed.nextOrder++ });
    } else if (event.type === 'tool') {
      const previous = liveTools.get(event.toolCallId);
      liveTools.set(event.toolCallId, { ...previous, ...event, order: previous?.order ?? activeFeed.nextOrder++ });
    } else if (event.type === 'settled') {
      activeFeed.startedAt = undefined;
      clearInterval(runClock);
      for (const reply of liveReplies.values()) reply.complete = true;
      for (const [id, tool] of liveTools) {
        if (tool.state === 'running') liveTools.delete(id);
      }
    } else return;
    if (!historyFeed && !renderFrame) {
      renderFrame = requestAnimationFrame(() => {
        renderFrame = undefined;
        if (!historyFeed) renderFeed();
      });
    }
  });
  window.desktop.onExit(() => {
    activeFeed.startedAt = undefined;
    clearInterval(runClock);
    for (const reply of activeFeed.liveReplies.values()) reply.complete = true;
    if (!historyFeed) renderFeed();
  });
})();
