(() => {
  const toggle = document.getElementById('changes-toggle');
  const panel = document.getElementById('changes-panel');
  const port = window.desktop;
  const sections = new Map();
  const summaries = new Map();
  let comments = new Map();
  try { comments = new Map(JSON.parse(localStorage.getItem('freepi-review-comments') || '[]')); } catch {}
  let conversation;
  let recentMessage;
  let reviewedMessage;
  let loadRequest = 0;
  let active;
  let result;
  let selected;
  let split = false;
  let working = false;
  let focusedHunk;
  let commentEditor;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(className, label, action) {
    const element = node('button', className, label);
    element.type = 'button';
    element.onclick = action;
    return element;
  }

  function appendCounts(target, { additions, deletions }) {
    if (Number.isInteger(additions)) target.append(node('span', 'changes-added', `+${additions}`));
    if (Number.isInteger(deletions)) target.append(node('span', 'changes-removed', `−${deletions}`));
  }

  function totals(files) {
    const known = files.filter(file => Number.isInteger(file.additions) && Number.isInteger(file.deletions));
    if (!known.length) return {};
    return known.reduce((total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }), { additions: 0, deletions: 0 });
  }

  const toolbar = node('div', 'changes-toolbar');
  const scopes = node('div', 'changes-scopes');
  scopes.setAttribute('role', 'group');
  scopes.setAttribute('aria-label', t("Comparison scope"));
  const turnScope = button('', t("This reply"), () => void openReview(reviewedMessage ?? recentMessage, undefined, false));
  const workingScope = button('', t("Working folder"), () => void openWorking());
  scopes.append(turnScope, workingScope);
  const scope = node('span', 'changes-scope', t("Last request"));
  const counts = node('span', 'changes-totals');
  const wrap = button('changes-wrap', t("Wrap lines"), () => {
    const enabled = wrap.getAttribute('aria-pressed') !== 'true';
    wrap.setAttribute('aria-pressed', String(enabled));
    panel.dataset.wrap = String(enabled);
  });
  wrap.setAttribute('aria-pressed', 'false');
  const mode = button('changes-mode', t("Before / After"), () => {
    split = !split;
    mode.setAttribute('aria-pressed', String(split));
    for (const [path, section] of sections) {
      if (section.childElementCount < 2) continue;
      const file = result.files.find(entry => entry.path === path);
      section.replaceChildren(section.firstElementChild);
      loadPatch(section, file);
    }
    renderComments();
  });
  mode.setAttribute('aria-pressed', 'false');
  const commentToggle = button('changes-comment-count', t("Comments"), () => {
    commentList.hidden = !commentList.hidden;
    commentToggle.setAttribute('aria-expanded', String(!commentList.hidden));
  });
  commentToggle.setAttribute('aria-expanded', 'false');
  commentToggle.setAttribute('aria-controls', 'changes-comment-list');
  const previousChange = button('changes-jump', '↑', () => jumpChange(-1));
  const nextChange = button('changes-jump', '↓', () => jumpChange(1));
  previousChange.setAttribute('aria-label', t("Previous change"));
  nextChange.setAttribute('aria-label', t("Next change"));
  previousChange.title = previousChange.getAttribute('aria-label');
  nextChange.title = nextChange.getAttribute('aria-label');
  toolbar.append(scopes, scope, counts, wrap, mode, previousChange, nextChange, commentToggle);
  const status = node('div', 'changes-status');
  status.setAttribute('role', 'status');
  const review = node('div', 'changes-review');
  const preview = node('div', 'changes-preview');
  preview.tabIndex = 0;
  preview.setAttribute('aria-label', t("Diff preview"));
  preview.addEventListener('keydown', event => {
    if (!event.altKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    jumpChange(event.key === 'ArrowDown' ? 1 : -1);
  });
  const navigation = node('aside', 'changes-navigation');
  navigation.setAttribute('aria-label', t("Changed files"));
  const filter = node('input', 'changes-filter');
  filter.type = 'search';
  filter.placeholder = t("Filter files…");
  filter.setAttribute('aria-label', t("Filter files"));
  filter.oninput = applyFilter;
  const list = node('div', 'changes-file-list');
  navigation.append(filter, list);
  review.append(preview, navigation);
  const commentBatch = node('section', 'changes-comment-batch');
  commentBatch.setAttribute('aria-label', t("Diff comments"));
  const commentList = node('div', 'changes-comment-list');
  commentList.id = 'changes-comment-list';
  commentList.hidden = true;
  const addComments = button('changes-comment-send', t("Add to prompt"), () => {
    const items = currentComments();
    const text = [t("Address these review comments:"), ...items.map(item =>
      t("- {0}, line {1} ({2}): {3}\n  Code: {4}", JSON.stringify(item.path), item.number, sideLabel(item.side), item.text.replaceAll('\n', '\n  '), JSON.stringify(item.source)))].join('\n');
    if (!document.dispatchEvent(new CustomEvent('freepi:add-context', { detail: text, cancelable: true }))) {
      for (const item of items) comments.delete(commentKey(item));
      saveComments();
      closeCommentEditor();
      commentStatus.textContent = t("Comments added to the draft.");
    } else {
      commentStatus.textContent = t("Open the composer to add comments.");
    }
    renderComments();
  });
  const commentStatus = node('output', 'changes-comment-status');
  commentStatus.setAttribute('aria-live', 'polite');
  const commentFooter = node('div', 'changes-comment-footer');
  commentFooter.append(commentStatus, addComments);
  commentBatch.append(commentList, commentFooter);
  panel.append(toolbar, status, review, commentBatch);

  function setOpen(open, focusTarget = toggle) {
    if (open) window.freepiWorkbench.open('changes');
    else window.freepiWorkbench.close();
    if (!open) focusTarget.focus({ preventScroll: true });
  }

  document.addEventListener('freepi:workbench', ({ detail }) => {
    const open = detail.tab === 'changes';
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) closeCommentEditor();
    else if (!working && !result?.messageId && recentMessage) void openReview(recentMessage, undefined, false);
  });

  toggle.onclick = () => panel.hidden ? setOpen(true) : setOpen(false);
  async function openReview(messageId, file, reveal = true) {
    if (working) {
      working = false;
      loadRequest++;
      result = undefined;
    }
    if (messageId && messageId === result?.messageId && !result.loading) {
      if (reveal) setOpen(true);
      const selectedFile = file && result.files?.find(entry => entry.path === file.path);
      if (selectedFile) showFile(selectedFile);
      return;
    }
    reviewedMessage = messageId;
    if (messageId && conversation) result = { loading: true, messageId };
    if (reveal) setOpen(true);
    if (!messageId || !conversation) {
      render();
      return;
    }
    const request = ++loadRequest;
    commentList.hidden = true;
    commentToggle.setAttribute('aria-expanded', 'false');
    commentStatus.textContent = '';
    render();
    let stored;
    try {
      stored = await port.readTurnDiff({ ...conversation, messageId });
    } catch {}
    if (request !== loadRequest) return;
    result = stored ? { ...stored, messageId } : { messageId, message: t("Could not open saved changes.") };
    render();
    if (file && stored) {
      const selectedFile = stored.files.find(entry => entry.path === file.path);
      if (selectedFile) showFile(selectedFile);
    }
  }

  async function openWorking() {
    working = true;
    const request = ++loadRequest;
    result = { loading: true };
    render();
    try {
      const snapshot = await port.workingChanges();
      if (request === loadRequest) result = snapshot;
    } catch {
      if (request === loadRequest) result = { message: t("Could not load working folder changes.") };
    }
    if (request === loadRequest) render();
  }

  function jumpChange(direction) {
    const files = [...sections.values()].filter(section => !section.hidden);
    const section = sections.get(selected);
    if (!section || section.hidden || !section.open) {
      const target = direction > 0 ? files[0] : files.at(-1);
      if (target) showFile(result.files.find(file => sections.get(file.path) === target));
      return;
    }
    const hunks = [...section.querySelectorAll('[data-kind="hunk"]')];
    const top = preview.getBoundingClientRect().top;
    const current = hunks.includes(focusedHunk) ? hunks.indexOf(focusedHunk)
      : hunks.findLastIndex(hunk => hunk.getBoundingClientRect().top <= top + 3);
    const target = hunks[current + direction];
    if (target) {
      focusedHunk?.removeAttribute('data-current-hunk');
      focusedHunk = target;
      target.setAttribute('data-current-hunk', '');
      target.scrollIntoView({ block: 'start', inline: 'nearest' });
      return;
    }
    const neighbour = files[files.indexOf(section) + direction];
    if (neighbour) showFile(result.files.find(file => sections.get(file.path) === neighbour));
  }

  function markSelected(file) {
    if (selected !== file.path) {
      focusedHunk?.removeAttribute('data-current-hunk');
      focusedHunk = undefined;
    }
    selected = file.path;
    for (const item of list.querySelectorAll('.changes-file')) {
      if (item.dataset.file === selected) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
  }

  function showFile(file) {
    const section = sections.get(file.path);
    if (!section) return;
    markSelected(file);
    for (const item of sections.values()) item.open = item === section;
    loadPatch(section, file);
    section.scrollIntoView({ block: 'start', inline: 'nearest' });
  }

  function fileLabel(path) {
    return path.split(/[\\/]/).at(-1);
  }

  function fileButton(file, action, short = false) {
    const item = button('changes-file', '', action);
    item.dataset.file = file.path;
    item.title = file.path;
    const marker = node('span', 'changes-file-marker', { added: 'A', deleted: 'D', modified: 'M' }[file.status]);
    marker.title = { added: t("Added"), deleted: t("Deleted"), modified: t("Modified") }[file.status];
    marker.dataset.status = file.status;
    const name = fileLabel(file.path);
    const label = node('span', 'changes-file-name', name);
    if (!short && name !== file.path) label.append(node('small', 'changes-diff-path', file.path.slice(0, -name.length - 1)));
    item.append(marker, label);
    appendCounts(item, file);
    return item;
  }

  function sideLabel(side) {
    return side === 'old' ? t("before the change") : t("after the change");
  }

  function commentKey(anchor) {
    return JSON.stringify([anchor.scope, anchor.messageId, anchor.path, anchor.side, anchor.number]);
  }

  function currentComments() {
    return [...comments.values()].filter(comment => comment.scope === key(conversation)
      && comment.messageId === result?.messageId);
  }

  function saveComments() {
    try { localStorage.setItem('freepi-review-comments', JSON.stringify([...comments])); } catch {}
  }

  function closeCommentEditor() {
    if (!commentEditor) return;
    commentEditor.remove();
    commentEditor = undefined;
    mode.disabled = false;
  }

  function editComment(anchor, insert, focusTarget) {
    closeCommentEditor();
    const identity = commentKey(anchor);
    const form = node('form', 'changes-comment-editor');
    const label = node('label', '', t("Line {0} ({1})", anchor.number, sideLabel(anchor.side)));
    const input = node('textarea');
    input.rows = 2;
    input.maxLength = 2000;
    input.placeholder = t("What needs to change?");
    input.required = true;
    input.value = comments.get(identity)?.text ?? '';
    label.append(input);
    const actions = node('div', 'changes-comment-actions');
    const save = node('button', '', t("Save"));
    save.type = 'submit';
    const cancel = button('', t("Cancel"), () => {
      closeCommentEditor();
      focusTarget.focus();
    });
    actions.append(cancel, save);
    form.append(label, actions);
    form.onsubmit = event => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      comments.set(identity, { ...anchor, text });
      saveComments();
      closeCommentEditor();
      renderComments();
      const target = focusTarget.isConnected ? focusTarget : commentList.querySelector('.changes-comment-actions button');
      target.focus();
    };
    form.onkeydown = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancel.click();
      }
    };
    commentEditor = form;
    mode.disabled = true;
    insert(form);
    input.focus();
  }

  function removeComment(item) {
    comments.delete(commentKey(item));
    saveComments();
    closeCommentEditor();
    renderComments();
  }

  function renderComments() {
    const items = currentComments();
    commentBatch.hidden = !result?.messageId || (!items.length && !commentStatus.textContent);
    commentToggle.hidden = !items.length;
    commentToggle.textContent = t("Comments · {0}", items.length);
    addComments.hidden = !items.length;
    commentList.replaceChildren();
    if (!items.length) {
      commentList.hidden = true;
      commentToggle.setAttribute('aria-expanded', 'false');
    }
    for (const item of items) {
      const row = node('div', 'changes-comment-item');
      row.append(node('div', 'changes-comment-anchor', `${item.path}:${item.number} (${sideLabel(item.side)})`),
        node('div', 'changes-comment-text', item.text));
      const actions = node('div', 'changes-comment-actions');
      const edit = button('', t("Edit"), () => editComment(item, form => row.after(form), edit));
      const remove = button('', t("Delete"), () => {
        removeComment(item);
        (commentToggle.hidden ? mode : commentToggle).focus();
      });
      actions.append(edit, remove);
      row.append(actions);
      commentList.append(row);
    }
    for (const action of preview.querySelectorAll('[data-comment-key]')) {
      action.toggleAttribute('data-commented', comments.has(action.dataset.commentKey));
    }
  }

  function commentButton(file, line, side, row) {
    const number = side === 'old' ? line.oldNumber : line.newNumber;
    if (working || number === undefined) return node('span', 'changes-line-comment-spacer');
    const anchor = { scope: key(conversation), messageId: result.messageId, path: file.path, side, number, source: line.text.slice(0, 300) };
    const add = button('changes-line-comment', '+', () => editComment(anchor, form => row.after(form), add));
    add.dataset.commentKey = commentKey(anchor);
    add.setAttribute('aria-label', t("Comment on line {0} ({1})", number, sideLabel(side)));
    add.toggleAttribute('data-commented', comments.has(add.dataset.commentKey));
    add.title = t("Add or edit a comment");
    return add;
  }

  function lineText(line, withMarker = true) {
    const text = node('span', 'changes-line-text');
    const marker = { add: '+', delete: '−', context: ' ' }[line.kind];
    if (withMarker && marker !== undefined) text.append(node('span', 'changes-line-marker', marker));
    if (line.kind === 'gap') text.append(t("Unchanged lines: {0}", line.count));
    else if (line.parts) {
      for (const part of line.parts) text.append(part.changed ? node('mark', 'changes-inline-mark', part.text) : part.text);
    } else text.append(line.text);
    return text;
  }

  function lineNumber(number) {
    return node('span', 'changes-line-number', number ?? '');
  }

  function unifiedRow(file, line) {
    const row = node('div', 'changes-line');
    row.dataset.kind = line.kind;
    row.append(commentButton(file, line, line.kind === 'delete' ? 'old' : 'new', row),
      lineNumber(line.oldNumber), lineNumber(line.newNumber), lineText(line));
    linkLine(row.children[2], file, line.newNumber);
    return row;
  }

  function splitRow(file, previous, next) {
    const row = node('div', 'changes-line-pair');
    for (const [side, line] of [['old', previous], ['new', next]]) {
      const cell = node('div', 'changes-line changes-side');
      if (line) {
        cell.dataset.kind = line.kind;
        cell.append(commentButton(file, line, side, row), lineNumber(side === 'old' ? line.oldNumber : line.newNumber), lineText(line, false));
        if (side === 'new') linkLine(cell.children[1], file, line.newNumber);
      } else cell.classList.add('changes-side-empty');
      row.append(cell);
    }
    return row;
  }

  function linkLine(number, file, line) {
    if (!line || file.status === 'deleted') return;
    const open = button('changes-open-line', String(line), () => window.freepiWorkbench.openFile(file.path, line));
    open.title = t("Open file at line {0}", line);
    open.setAttribute('aria-label', open.title);
    number.replaceChildren(open);
  }

  function addSplitRows(append, file, lines) {
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      if (line.kind === 'delete' || line.kind === 'add') {
        const previous = [];
        const next = [];
        while (index < lines.length && (lines[index].kind === 'delete' || lines[index].kind === 'add')) {
          const edit = lines[index++];
          (edit.kind === 'delete' ? previous : next).push(edit);
        }
        for (let offset = 0; offset < Math.max(previous.length, next.length); offset++) {
          append(splitRow(file, previous[offset], next[offset]));
        }
      } else {
        append(line.kind === 'context' ? splitRow(file, line, line) : unifiedRow(file, line));
        index++;
      }
    }
  }

  function loadPatch(section, file) {
    if (section.childElementCount > 1) return;
    if (file.status !== 'deleted') {
      const actions = node('div', 'changes-file-actions');
      const open = button('', t("Open file"), () => window.freepiWorkbench.openFile(file.path));
      actions.append(open);
      section.append(actions);
    }
    if (!file.patch) {
      section.append(node('p', 'changes-note', file.note));
      return;
    }
    const patch = node('div', split ? 'changes-patch changes-patch-split' : 'changes-patch');
    const lines = parseDiffLines(file.patch);
    if (split) {
      const labels = node('div', 'changes-side-headings');
      labels.append(node('span', '', t("Before")), node('span', '', t("After")));
      patch.append(labels);
    }
    let group;
    const append = row => {
      if (lines.length > 500 && (!group || group.childElementCount === 200)) {
        group = node('div', 'changes-patch-chunk');
        patch.append(group);
      }
      (group ?? patch).append(row);
    };
    if (split) addSplitRows(append, file, lines);
    else for (const line of lines) append(unifiedRow(file, line));
    section.append(patch);
  }

  function diffSection(file) {
    const section = node('details', 'changes-diff-file');
    const header = node('summary', 'changes-diff-header');
    const name = fileLabel(file.path);
    header.append(node('span', 'changes-diff-name', name));
    if (name !== file.path) header.append(node('span', 'changes-diff-path', file.path.slice(0, -name.length - 1)));
    const fileCounts = node('span', 'changes-totals');
    appendCounts(fileCounts, file);
    header.append(fileCounts);
    header.onclick = () => {
      if (!section.open) {
        markSelected(file);
        loadPatch(section, file);
      }
    };
    section.append(header);
    return section;
  }

  function applyFilter() {
    const query = filter.value.trim().toLocaleLowerCase();
    let matching = 0;
    for (const item of list.querySelectorAll('.changes-file')) {
      const visible = item.dataset.file.toLocaleLowerCase().includes(query);
      item.hidden = !visible;
      sections.get(item.dataset.file).hidden = !visible;
      if (visible) matching++;
    }
    const empty = list.querySelector('.changes-filter-empty');
    if (empty) empty.hidden = matching > 0;
  }

  function render() {
    closeCommentEditor();
    selected = undefined;
    focusedHunk = undefined;
    const files = result?.files ?? [];
    const recent = summaries.get(recentMessage)?.data;
    updateToggle(recent);
    turnScope.setAttribute('aria-pressed', String(!working));
    workingScope.setAttribute('aria-pressed', String(working));
    workingScope.title = working ? t("Refresh comparison with HEAD") : t("Show changes against HEAD");
    scope.textContent = working ? t("Compared with HEAD")
      : result?.messageId && result.messageId !== recentMessage ? t("Saved request") : '';
    const statistics = totals(files);
    counts.replaceChildren();
    appendCounts(counts, statistics);
    for (const control of [wrap, mode, previousChange, nextChange]) control.hidden = !files.length;
    commentToggle.hidden = !files.length || working;
    status.textContent = result?.loading ? t("Loading diff…") : result?.message
      || (result?.status === 'unsupported' ? t("Project snapshot unavailable.")
        : result?.limited ? t("Some files or patches exceed the preview limit.")
        : result && !files.length ? t("No project files changed.")
        : !result ? (active ? t("Comparing files after the reply…") : t("Changes will appear here after the next request.")) : '');
    status.hidden = !status.textContent;
    review.hidden = !files.length;
    sections.clear();
    list.replaceChildren();
    preview.replaceChildren();
    filter.value = '';
    for (const file of files) {
      const section = diffSection(file);
      sections.set(file.path, section);
      preview.append(section);
      list.append(fileButton(file, () => showFile(file), true));
    }
    if (files.length) {
      list.append(node('p', 'changes-filter-empty', t("No files found.")));
      const first = files[0];
      const section = sections.get(first.path);
      section.open = true;
      markSelected(first);
      loadPatch(section, first);
      applyFilter();
    }
    renderComments();
  }

  function makeSummary(data) {
    const summary = node('section', 'changes-summary');
    summary.setAttribute('aria-label', t("Change summary"));
    const header = node('div', 'changes-summary-header');
    const files = node('div', 'changes-summary-files');
    files.id = `changes-files-${data.messageId}`;
    const disclosure = button('changes-summary-toggle', '', () => {
      files.hidden = !files.hidden;
      disclosure.setAttribute('aria-expanded', String(!files.hidden));
    });
    disclosure.setAttribute('aria-controls', files.id);
    disclosure.setAttribute('aria-expanded', 'true');
    disclosure.append(node('span', '', t("Files changed: {0}", data.files.length)));
    appendCounts(disclosure, totals(data.files));
    header.append(disclosure, button('changes-summary-review', t("Review"), () => openReview(data.messageId)));
    for (const file of data.files) files.append(fileButton(file, () => openReview(data.messageId, file)));
    summary.append(header, files);
    return summary;
  }

  function publishSummary(data) {
    summaries.set(data.messageId, { data, node: makeSummary(data) });
    document.dispatchEvent(new Event('freepi:diff-history'));
  }

  async function persist(turn) {
    if (!turn.diff || !turn.messageId || turn.saving || !turn.context?.sessionId) return;
    turn.saving = true;
    try {
      const summary = await port.saveTurnDiff({ ...turn.context, messageId: turn.messageId, result: turn.diff });
      if (summary && key(turn.context) === key(conversation)) {
        publishSummary(summary);
        if (!working && !result?.messageId && !panel.hidden) void openReview(summary.messageId);
      }
    } catch {
      if (key(turn.context) === key(conversation)) {
        result = { message: t("Could not save the diff.") };
        render();
      }
    }
  }

  function key(context) {
    return context ? `${context.folder.toLowerCase()}\0${context.sessionId}` : '';
  }

  function updateToggle(summary) {
    const label = summary ? t("Changes · {0}", summary.files.length) : t("Changes");
    toggle.lastElementChild.textContent = label;
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }

  window.desktopChanges = {
    recentFiles(messageIds) {
      const id = messageIds.findLast(value => summaries.has(value));
      return (summaries.get(id)?.data.files ?? []).map(file => ({ path: file.path, status: file.status, messageId: id }));
    },
    openFileDiff(messageId, path) { void openReview(messageId, { path }); },
    async begin(context, text) {
      const turn = { token: null, context, text };
      active = turn;
      if (!result?.messageId) render();
      try {
        turn.token = await port.beginChanges();
      } catch {}
    },
    submitted() {
      if (active && !active.finishing) active.submittedAt = Date.now();
    },
    attachUser(event) {
      if (active?.submittedAt && active.context?.sessionId === event.sessionId) {
        active.messageId = event.messageId;
        void persist(active);
      }
    },
    observeTranscript(snapshot) {
      if (!active?.submittedAt || active.messageId || active.context?.sessionId !== snapshot.sessionId) return;
      const user = snapshot.messages.find(message => message.role === 'user'
        && Number(message.timestamp) >= active.submittedAt
        && (Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : message.content)?.trim() === active.text.trim());
      if (user) {
        active.messageId = user.id;
        void persist(active);
      }
    },
    async finish() {
      const turn = active;
      if (!turn || turn.finishing) return;
      turn.finishing = true;
      let snapshot;
      try {
        snapshot = await port.finishChanges(turn.token);
      } catch {
        snapshot = { status: 'error', files: [], message: t("Could not compare project files.") };
      }
      if (snapshot?.files.length) {
        turn.diff = snapshot;
        await persist(turn);
      }
      if (active === turn) {
        if (!turn.diff || turn.messageId) active = undefined;
        if (!result?.messageId) render();
      }
    },
    reset() {
      active = undefined;
    },
    async setConversation(context) {
      if (key(context) === key(conversation)) return;
      conversation = context;
      loadRequest++;
      working = false;
      result = undefined;
      selected = undefined;
      recentMessage = undefined;
      reviewedMessage = undefined;
      summaries.clear();
      commentStatus.textContent = '';
      render();
      if (!context) return;
      try {
        const records = await port.listTurnDiffs(context);
        if (conversation !== context) return;
        for (const data of records) {
          if (!summaries.has(data.messageId)) summaries.set(data.messageId, { data, node: makeSummary(data) });
        }
        document.dispatchEvent(new Event('freepi:diff-history'));
        if (!working && !panel.hidden && recentMessage && !result?.messageId) void openReview(recentMessage, undefined, false);
      } catch {}
    },
    summariesFor(messageIds) {
      const nextRecent = messageIds.findLast(id => summaries.has(id));
      if (recentMessage !== nextRecent) {
        recentMessage = nextRecent;
        const recent = summaries.get(recentMessage)?.data;
        updateToggle(recent);
        if (result?.messageId) scope.textContent = result.messageId === recentMessage ? '' : t("Saved request");
      }
      return summaries;
    },
  };
  render();
})();
