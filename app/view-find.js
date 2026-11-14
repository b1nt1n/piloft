(() => {
  const limit = 1000;
  const highlights = CSS.highlights;
  const dialog = document.createElement('div');
  dialog.className = 'view-find';
  dialog.hidden = true;
  dialog.setAttribute('role', 'search');
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = t("Find…");
  input.setAttribute('aria-label', t("Find in the open view"));
  const result = document.createElement('span');
  result.className = 'view-find-result';
  result.setAttribute('role', 'status');
  function button(label, text, action) {
    const control = document.createElement('button');
    control.type = 'button';
    control.setAttribute('aria-label', label);
    control.title = label;
    control.textContent = text;
    control.onclick = action;
    return control;
  }
  const previous = button(t("Previous match"), '↑', () => move(-1));
  const next = button(t("Next match"), '↓', () => move(1));
  const close = button(t("Close search"), '×', () => hide());
  dialog.append(input, result, previous, next, close);
  document.body.append(dialog);
  let view;
  let focusBefore;
  let matches = [];
  let active = -1;
  let generation;

  const targets = {
    chat: ['#chat-messages', '#chat-feed', t("Conversation")],
    files: ['#workbench-file-content', '#workbench-file-preview', t("File")],
    changes: ['.changes-preview', '.changes-preview', t("Changes")],
  };

  function targetFor(element) {
    if (dialog.contains(element)) return view;
    const tab = window.freepiWorkbench?.activeTab;
    const section = element?.closest?.('#workbench, #workbench-toggle, #changes-toggle');
    const [contentSelector, viewportSelector, label] = targets[section && targets[tab] ? tab : 'chat'];
    const content = document.querySelector(contentSelector);
    const viewport = document.querySelector(viewportSelector);
    if (content && viewport?.getClientRects().length && !viewport.closest('[hidden],[inert]')) {
      return { content, viewport, label };
    }
  }

  const observer = new MutationObserver(() => schedule());
  const resize = new ResizeObserver(() => place());

  function place() {
    if (!view || !view.viewport.getClientRects().length || view.viewport.closest('[hidden],[inert]')) {
      hide(false);
      return;
    }
    const rect = view.viewport.getBoundingClientRect();
    const left = Math.max(8, rect.right - dialog.offsetWidth - 10);
    dialog.style.left = `${Math.min(left, innerWidth - dialog.offsetWidth - 8)}px`;
    dialog.style.top = `${Math.max(8, rect.top + 8)}px`;
  }

  function show(target) {
    if (view?.viewport !== target.viewport) {
      hide(false);
      focusBefore = document.activeElement;
      view = target;
      observer.observe(view.content, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden'] });
      resize.observe(view.viewport);
      input.setAttribute('aria-label', t("Find: {0}", view.label));
    }
    dialog.hidden = false;
    place();
    input.focus({ preventScroll: true });
    input.select();
    find(false);
  }

  function hide(restoreFocus = true) {
    observer.disconnect();
    resize.disconnect();
    clearTimeout(generation);
    highlights?.delete('freepi-matches');
    highlights?.delete('freepi-match');
    matches = [];
    active = -1;
    dialog.hidden = true;
    view = undefined;
    if (restoreFocus && focusBefore?.isConnected) focusBefore.focus({ preventScroll: true });
    focusBefore = undefined;
  }

  function blocks() {
    const walker = document.createTreeWalker(view.content, NodeFilter.SHOW_TEXT);
    const groups = [];
    const visibility = new Map();
    let block;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent.closest('button, textarea, .changes-line-number, .changes-line-marker, .sr-only, [hidden], [aria-hidden="true"]')) continue;
      if (!visibility.has(parent)) visibility.set(parent, parent.getClientRects().length > 0);
      if (!visibility.get(parent)) continue;
      const group = parent.closest('p, li, h1, h2, h3, h4, h5, td, th, pre, summary, .chat-user-text, .changes-line-text')
        ?? parent;
      if (!block || block.group !== group) {
        block = { group, text: '', parts: [] };
        groups.push(block);
      }
      block.parts.push({ node, start: block.text.length });
      block.text += node.data;
    }
    return groups;
  }

  function find(reveal) {
    if (!view) return;
    const previousMatch = matches[active];
    matches = [];
    active = -1;
    const query = input.value;
    if (query) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      for (const block of blocks()) {
        let firstPart = 0;
        let lastPart = 0;
        pattern.lastIndex = 0;
        for (const match of block.text.matchAll(pattern)) {
          const start = match.index;
          const end = start + match[0].length;
          while (block.parts[firstPart + 1]?.start <= start) firstPart++;
          lastPart = Math.max(firstPart, lastPart);
          while (block.parts[lastPart + 1]?.start < end) lastPart++;
          const first = block.parts[firstPart];
          const last = block.parts[lastPart];
          const range = new Range();
          range.setStart(first.node, start - first.start);
          range.setEnd(last.node, end - last.start);
          matches.push(range);
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
      }
      if (matches.length) {
        const old = matches.findIndex(range => range.startContainer === previousMatch?.startContainer && range.startOffset === previousMatch.startOffset);
        active = Math.max(0, old);
      }
    }
    if (highlights) highlights.set('freepi-matches', new Highlight(...matches));
    markActive(reveal);
  }

  function markActive(reveal) {
    const range = matches[active];
    result.textContent = input.value ? `${active + 1} / ${matches.length}${matches.length === limit ? '+' : ''}` : '';
    previous.disabled = next.disabled = !range;
    if (highlights) {
      const current = range ? new Highlight(range) : new Highlight();
      current.priority = 1;
      highlights.set('freepi-match', current);
    }
    if (!range || !reveal || !view) return;
    const rect = range.getBoundingClientRect();
    const viewport = view.viewport.getBoundingClientRect();
    // Scroll only the focused view, leaving the adjacent chat or terminal untouched.
    view.viewport.scrollTop += rect.top - viewport.top - Math.max(38, viewport.height / 3);
    if (rect.left < viewport.left || rect.right > viewport.right) {
      view.viewport.scrollLeft += rect.left - viewport.left - 18;
    }
    const line = range.startContainer.parentElement.closest('.changes-line-text');
    if (line && line.scrollWidth > line.clientWidth) {
      const bounds = line.getBoundingClientRect();
      if (rect.left < bounds.left || rect.right > bounds.right) line.scrollLeft += rect.left - bounds.left - 12;
    }
  }

  function move(offset) {
    if (!matches.length) return;
    active = (active + offset + matches.length) % matches.length;
    markActive(true);
  }

  function schedule(reveal = false) {
    clearTimeout(generation);
    generation = setTimeout(() => find(reveal), 110);
  }

  input.oninput = () => {
    matches = [];
    active = -1;
    schedule(true);
  };
  dialog.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide();
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      clearTimeout(generation);
      if (!matches.length) find(true);
      else move(event.shiftKey ? -1 : 1);
    }
  });
  document.addEventListener('freepi:workbench', () => {
    if (view) place();
  });
  document.addEventListener('freepi:state', () => {
    if (view) place();
  });
  window.addEventListener('resize', () => { if (view) place(); });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.shiftKey || event.altKey
      || !(event.ctrlKey || event.metaKey) || event.code !== 'KeyF') return;
    if (document.querySelector('dialog[open]') || event.target.closest?.('#terminal-pane')) return;
    const target = targetFor(document.activeElement);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    show(target);
  }, true);
})();
