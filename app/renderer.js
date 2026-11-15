const $ = id => document.getElementById(id);
const bridge = window.desktop;
const terminal = new Terminal({
  fontFamily: 'IBM Plex Mono, Cascadia Mono, Consolas, monospace',
  fontSize: 15,
  lineHeight: 1.12,
  cursorBlink: true,
  scrollback: 6000,
  screenReaderMode: true,
  windowsPty: { backend: 'conpty' },
  theme: { background: '#141414', foreground: '#ededed', cursor: '#c8c8c8', selectionBackground: '#515151' },
  linkHandler: { activate: (_event, url) => bridge.openLink(url) },
});
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open($('terminal'));
terminal.onData(data => bridge.write(data));
terminal.onBinary(data => bridge.write(data));
terminal.onResize(({ cols, rows }) => bridge.resize(cols, rows));
new ResizeObserver(() => fit.fit()).observe($('terminal'));

const terminalPalettes = {
  dark: { black: '#252525', red: '#e58787', green: '#a0cca8', yellow: '#d3bb83', blue: '#9ebbe1',
    magenta: '#c3a8d2', cyan: '#96cac9', white: '#e4e4e4', brightBlack: '#9d9d9d' },
  light: { black: '#222222', red: '#a02238', green: '#20623a', yellow: '#755100', blue: '#315984',
    magenta: '#724480', cyan: '#14646a', white: '#383838', brightBlack: '#717171',
    brightRed: '#a02238', brightGreen: '#20623a', brightYellow: '#755100', brightBlue: '#315984',
    brightMagenta: '#724480', brightCyan: '#14646a', brightWhite: '#121212' },
};

async function applyTerminalAppearance(preferences) {
  if (!preferences) return;
  const { theme, motion, terminalFont, terminalSize, colors } = preferences;
  terminal.options.theme = {
    ...terminalPalettes[theme], background: colors.background, foreground: colors.foreground,
    cursor: colors.accent, cursorAccent: colors.background, selectionBackground: theme === 'light' ? '#d5d5d5' : '#515151',
  };
  terminal.options.cursorBlink = motion !== 'reduced';
  if (terminal.options.fontFamily === terminalFont && terminal.options.fontSize === terminalSize) return;
  // Wait for local font metrics before changing the dimensions of the running ConPTY.
  await document.fonts.load(`${terminalSize}px ${terminalFont.split(',')[0]}`).catch(() => {});
  if (window.freepiAppearance.state.terminalFont !== terminalFont
    || window.freepiAppearance.state.terminalSize !== terminalSize) return;
  terminal.options.fontFamily = terminalFont;
  terminal.options.fontSize = terminalSize;
  fit.fit();
}
document.addEventListener('freepi:appearance', event => void applyTerminalAppearance(event.detail));

const settings = $('settings-panel');
const terminalPane = $('terminal-pane');
const terminalButton = $('focus-terminal');
const chatFeed = $('chat-feed');
const adSlot = $('freepi-ad');
const picker = $('picker');
const search = $('search');
const promptInput = $('prompt');
const send = $('send');
const stop = $('stop');
const offer = $('offer');
const thinkingLabel = $('thinking-label');
const pickerUsage = $('picker-usage');
const toolButtons = Array.from(document.querySelectorAll('[data-tools]'));
const commandButtons = [$('model'), $('usage'), $('thinking'), $('integrations'), $('compact-chat'), $('workspace-fork'), ...toolButtons];
const projectDialog = $('project-dialog');
const projectName = $('project-name');
const projectPath = $('project-location');
const projectSubmit = $('project-submit');
const projectStatus = $('project-dialog-status');
const escape = '\x1b';
const up = '\x1b[A';
const down = '\x1b[B';
let folder;
let viewed;
let viewRequest = 0;
let executionInFlight = false;
const completedChats = new Map();
let running = false;
let starting = false;
let projectLocation;
let projectCreatesFolder = false;
let projectBusy = false;
let nextProject;
let pending = '';
let pendingTimer;
let pickerKind;
let targetKey;
let pickerSignature = '';
let modelCatalog = [];
let catalogSize = 0;
let catalogDestination;
let catalogAttempts = 0;
let catalogWasRefreshing = false;
let screen = {};
let opened = false;
let activeModel = '';
let reportedModel;
const confirmedModelNames = new Map();
let sessionId = null;
let lifecycle;
let replacedSessionId;
let identifySession = true;
let lookAcrossProjects = false;
let sessionPageUp = false;
let sessionStartScreen;
let sessionProbeTimer;
let sessionIdentifyTimer;
let sessionIdentifyAfter = 0;
let sessionLookupFailed = false;
let observedSession = false;
let nativeStatus;
let nativePrompts = 0;
const activeTools = new Map();
let closingWindow = false;
let showTerminal = false;
let integrationsOpen = false;
let terminalRequired = true;
let dismissedTerminalFallback = false;
let terminalFallbackTimer;
let adSignature = '';
let projectState = '';
let showUsageOnReady = false;
let focusPromptOnReady = false;
let turnStartScreen;
let collectingChanges = false;
let taskSwitching = false;
let startupStep = 'loading';
let startupEnded = false;
let reviewingTurn = false;
let reviewWasBusy = false;
let searchQuery = '';

const thinkingLabels = {
  off: t("Off"),
  minimal: t("Minimal"),
  low: t("Low"),
  medium: t("Medium"),
  high: t("High"),
  xhigh: t("Very high"),
  max: t("Maximum"),
};
promptInput.disabled = false;
offer.title = offer.textContent;

function status(text) {
  if (viewed) return;
  if ($('status').textContent !== text) $('status').textContent = text;
  $('status').title = text;
}

function nativeBusy() {
  return nativeStatus ? nativeStatus === 'working' : screen.busy;
}

function nativeConfirmation() {
  return (executionInFlight && nativePrompts > 0) || nativeStatus === 'blocked' || Boolean(screen.customQuestion);
}

function chatKey(project, id) {
  return `${project?.toLowerCase() ?? ''}\0${id ?? ''}`;
}

function activeOccupied() {
  return running && (nativeBusy() || executionInFlight || nativeConfirmation() || pending === 'turn');
}

function rememberCompletion(state) {
  if (folder && sessionId) completedChats.set(chatKey(folder, sessionId), { folder, sessionId, state });
}

function acknowledgeVisibleChat() {
  if (!completedChats.size || document.hidden || !document.hasFocus() || chatFeed.inert) return;
  if (viewed) {
    if (!viewed.loading && !viewed.error) completedChats.delete(chatKey(viewed.folder, viewed.sessionId));
  } else if (!starting && !nextProject && pending !== 'switch' && !nativeConfirmation()) {
    completedChats.delete(chatKey(folder, sessionId));
  }
}

function canSwitchFromHistory() {
  return viewed && !viewed.loading && !viewed.error && !activeOccupied() && !starting && !pending
    && !nextProject && !closingWindow && !window.desktopDrafts.saving
    && (!running || (screen.ready && readScreen(terminal, folder).ready));
}

function canContinueHistory() {
  return canSwitchFromHistory() && viewed.folderAvailable !== false;
}

function setLabel(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function updateHistoryBanner(execution) {
  const banner = $('background-chat');
  const returnButton = $('return-running-chat');
  const continueButton = $('activate-viewed-chat');
  const state = execution?.state ?? 'history';
  const labels = {
    working: [t("The agent is working in another chat"), agentActivity()],
    confirmation: [t("The agent needs confirmation"), t("Open the running chat to confirm")],
    done: [t("The other chat has finished"), t("Your draft is saved in this chat")],
    failed: [t("Work in the other chat was interrupted"), t("Your draft is saved in this chat")],
    history: [t("Chat history"), t("Your draft is saved in this chat")],
  };
  const [title, detail] = labels[state];
  banner.dataset.state = state;
  setLabel($('background-title'), title);
  setLabel($('background-detail'), viewed.loading ? t("Loading chat…")
    : viewed.error ? t("Could not load chat history")
      : viewed.folderAvailable === false ? t("Project folder unavailable. Saved chats are available to read.") : detail);
  setLabel(returnButton, state === 'confirmation' ? t("Open confirmation") : running ? t("Go to running chat") : t("Back to workspace"));
  continueButton.hidden = !canContinueHistory();
}

function renderTerminal(focus = false) {
  const open = !viewed && (showTerminal || terminalRequired);
  const mode = !open ? 'hidden' : terminalRequired || integrationsOpen ? 'full' : 'dock';
  const changed = terminalPane.dataset.open !== String(open);
  if (terminalPane.dataset.mode !== mode || changed || terminalButton.getAttribute('aria-expanded') !== String(open)) {
    terminalPane.dataset.open = String(open);
    terminalPane.dataset.mode = mode;
    terminalPane.setAttribute('aria-hidden', String(!open));
    terminalPane.inert = !open;
    chatFeed.inert = mode === 'full';
    terminalButton.setAttribute('aria-expanded', String(open));
  }
  terminalButton.disabled = Boolean(viewed) || nativeConfirmation() || (terminalRequired && running && !opened);
  const title = terminalButton.disabled ? t("Native free-pi output") : open ? t("Show chat") : t("Open terminal");
  if (terminalButton.title !== title) terminalButton.title = title;
  terminalButton.setAttribute('aria-label', title);
  terminalButton.querySelector('use').setAttribute('href', open ? '#i-chat' : '#i-terminal');
  renderStartupGuide(mode);
  if (open && (focus || (changed && terminalRequired))) terminal.focus();
  else if (changed && terminal.textarea === document.activeElement) promptInput.focus();
}

function renderStartupGuide(mode) {
  const guide = $('startup-guide');
  const retry = $('startup-retry');
  const step = startupEnded && startupStep !== 'declined' && startupStep !== 'sign-in-ended' ? 'stopped' : startupStep;
  const items = {
    loading: [t("Starting FreePi"), t("Follow any instructions in the terminal below. The chat opens when FreePi is ready.")],
    consent: [t("Review the FreePi terms"), t("Read the terms below. To accept, type the English letter y and press Enter. To stop, press Enter without typing.")],
    referral: [t("Optional: how did you find FreePi?"), t("Press Enter to skip, or type one of the numbers shown below and press Enter.")],
    'sign-in': [t("Sign in with GitHub"), t("Open the link shown in the terminal if your browser did not open. Match the code in both places and finish connecting in the browser. Then return here.")],
    trust: [t("Review folder trust"), t("Read the prompt below. Press Enter to continue without trusting this folder. To trust its local settings, type the English letter y and press Enter.")],
    declined: [t("FreePi did not start"), t("The terms were not accepted. Choose Try again to review them and restart setup.")],
    'sign-in-ended': [t("GitHub sign-in did not finish"), t("Choose Try again to start a new sign-in.")],
    stopped: [t("FreePi stopped before setup finished"), t("Check the terminal below for details, then choose Try again.")],
  };
  guide.hidden = mode !== 'full' || opened || !folder;
  if (guide.hidden) return;
  setLabel($('startup-guide-title'), items[step][0]);
  setLabel($('startup-guide-detail'), items[step][1]);
  retry.hidden = !startupEnded;
}

function updateTerminalVisibility() {
  if (screen.ready) dismissedTerminalFallback = false;
  const required = !running || !opened || nativeConfirmation();
  // A manually opened terminal may clip the footer. That alone must not resize it.
  const unknown = !showTerminal && !screen.ready && !nativeBusy() && !executionInFlight && !pickerKind && !pending;
  if (required || !unknown) {
    clearTimeout(terminalFallbackTimer);
    terminalFallbackTimer = undefined;
    terminalRequired = required;
  } else if (!terminalRequired && !dismissedTerminalFallback && terminalFallbackTimer === undefined) {
    // ConPTY emits intermediate frames while redrawing selectors, the editor and footer.
    terminalFallbackTimer = setTimeout(() => {
      terminalFallbackTimer = undefined;
      if (showTerminal || !running || !opened || screen.ready || nativeBusy() || executionInFlight || pickerKind || pending || dismissedTerminalFallback) return;
      terminalRequired = true;
      renderTerminal();
      status(t("Enter input in the terminal"));
    }, 240);
  }
  renderTerminal();
}

terminal.attachCustomWheelEventHandler(event => {
  if (terminal.buffer.active.type !== 'alternate' || terminal.modes.mouseTrackingMode !== 'none') return true;
  event.preventDefault();
  if (!event.deltaY || !opened || nativeStatus === 'blocked' || !screen.emptyEditor || pending) return false;
  // ConPTY consumes DEC mouse modes. Pi's native SGR wheel handler still accepts the input.
  bridge.write(`\x1b[<${event.deltaY < 0 ? 64 : 65};1;1M`);
  return false;
});

function renderAds(ads) {
  const signature = JSON.stringify(ads);
  if (signature === adSignature) return;
  adSignature = signature;
  const nodes = ads.map(ad => {
    const card = document.createElement('div');
    card.className = 'ad-card';
    const label = document.createElement('span');
    label.className = 'ad-label';
    label.textContent = t("Advertisement");
    const copy = document.createElement('div');
    copy.className = 'ad-lines';
    const lines = ad.lines.map(line => line.replace(/[\u2580-\u259f]+/gu, '').trim()).filter(Boolean);
    const cta = lines.at(-1)?.startsWith('▸ ') ? lines.pop().slice(2) : '';
    const [headline, ...body] = lines;
    const title = document.createElement('strong');
    title.textContent = headline || cta || t("free-pi advertisement");
    copy.append(title);
    for (const line of body) {
      const text = document.createElement('span');
      text.textContent = line;
      copy.append(text);
    }
    const link = document.createElement('button');
    link.className = 'ad-link';
    link.type = 'button';
    link.textContent = headline && cta ? cta : t("Open");
    link.onclick = () => bridge.openLink(ad.url);
    card.append(label, copy, link);
    return card;
  });
  adSlot.replaceChildren(...nodes);
  adSlot.hidden = !nodes.length;
}

function updateButtons() {
  const drafts = window.desktopDrafts;
  const canSend = !viewed && running && screen.ready && !nativeBusy() && !executionInFlight && !nativeConfirmation() && !pending && !pickerKind
    && !collectingChanges && !drafts.saving && !closingWindow;
  const canSwitch = !starting && !nextProject && !closingWindow && !drafts.queued
    && (viewed ? Boolean(canSwitchFromHistory()) : !running || canSend);
  const activeBusy = running && (nativeBusy() || executionInFlight || pending === 'turn');
  const busy = !viewed && activeBusy;
  const canBrowse = Boolean(sessionId && (opened || viewed) && !starting && !nextProject && !collectingChanges && !pickerKind
    && !closingWindow && !drafts.queued && !drafts.saving && (!pending || pending === 'turn'));
  commandButtons.forEach(button => { button.disabled = !canSend; });
  $('workspace-worktree').disabled = !canSwitch || !folder || Boolean(viewed);
  $('workspace-preview').disabled = !(viewed?.folder ?? folder);
  $('workspace-capture-preview').disabled = !detailPreviewFolder();
  if (pickerKind) $(pickerKind === 'model' ? 'model' : 'thinking').disabled = false;
  $('new-project').disabled = closingWindow;
  send.disabled = !canSend || drafts.queued || !terminal.modes.bracketedPasteMode || (!promptInput.value.trim() && !window.desktopAttachments.hasFiles);
  $('show-confirmation').hidden = Boolean(viewed) || !nativeConfirmation();
  send.hidden = busy || Boolean(viewed);
  stop.hidden = !busy;
  stop.disabled = !busy;
  $('restart').hidden = Boolean(viewed) || running || starting || !folder;
  acknowledgeVisibleChat();
  const currentState = nativeConfirmation() ? 'confirmation' : activeBusy ? 'working'
    : completedChats.get(chatKey(folder, sessionId))?.state;
  const execution = sessionId && folder && currentState ? { folder, sessionId, state: currentState } : undefined;
  if (viewed) updateHistoryBanner(execution);
  const detail = { folder: viewed?.folder ?? folder, activeFolder: folder,
    sessionId: viewed?.sessionId ?? (screen.ready || opened ? sessionId : null),
    canSwitch, canBrowse, viewingHistory: Boolean(viewed), running,
    ready: !viewed && Boolean(screen.ready), busy, execution, completedChats: [...completedChats.values()],
    startupStep: !opened ? readStartupStep(screen.lines) : undefined };
  detail.taskReady = Boolean(!collectingChanges && !starting && !nextProject && !closingWindow && !drafts.saving && !drafts.queued
    && !pending && !pickerKind && !showTerminal && !activeOccupied() && (!running || (screen.ready && terminal.modes.bracketedPasteMode)));
  const nextState = JSON.stringify(detail);
  if (nextState !== projectState) {
    projectState = nextState;
    document.dispatchEvent(new CustomEvent('freepi:state', { detail }));
  }
  drafts.tick({
    busy,
    working: nativeBusy(),
    ready: canSend && !starting && !nextProject && !showTerminal && nativeStatus !== 'error' && terminal.modes.bracketedPasteMode,
    blocked: nativeConfirmation(),
  }, sendPrompt);
}

window.addEventListener('focus', updateButtons);
document.addEventListener('visibilitychange', updateButtons);

function waitForScreen(kind) {
  pending = kind;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    if (pending === 'switch') nextProject = undefined;
    if (pending === 'usage-menu') showUsageOnReady = false;
    if (pending === 'usage') setUsageStatus(t("FreePi has not returned usage data. Try refreshing again."));
    const returningToChat = pending === 'return-chat';
    if (pending === 'session-info') {
      if (sessionPageUp && !nativeConfirmation()) bridge.write('\x1b[1;5F');
      sessionLookupFailed = true;
      showTerminal = true;
    }
    pending = '';
    if (pickerKind) hidePicker();
    status(returningToChat ? t("Close the FreePi menu in the terminal, then choose “Show chat.”") : t("Check the free-pi status in the terminal"));
    renderTerminal();
    updateButtons();
  }, 5000);
  updateButtons();
}

function clearPending() {
  clearTimeout(pendingTimer);
  clearTimeout(sessionProbeTimer);
  pending = '';
  turnStartScreen = undefined;
}

function command(text, kind = 'command') {
  if (viewed || !running || !screen.ready || nativeBusy() || executionInFlight || nativeConfirmation() || pending || !readScreen(terminal, folder).ready) return false;
  waitForScreen(kind);
  bridge.write(`${text}\r`);
  return true;
}

function openCommandTerminal() {
  showTerminal = true;
  integrationsOpen = true;
  renderTerminal(true);
}

const desktopCommands = new Map([
  ['/settings', () => openDesktopSettings()],
  ['/model', () => $('model').click()],
  ['/thinking', () => $('thinking').click()],
  ['/usage', () => {
    window.freepiAppearance.show(true, 'usage');
    refreshUsage();
  }],
  ['/resume', () => $('resume').click()],
  ['/new', () => switchProject(folder, undefined, true)],
  ['/tools', () => window.freepiAppearance.show(true, 'agent')],
  ['/hotkeys', () => window.freepiAppearance.show(true, 'shortcuts')],
]);

document.addEventListener('freepi:composer-command', event => {
  const action = desktopCommands.get(event.detail);
  if (action && !$('model').disabled && !$('resume').disabled) {
    event.preventDefault();
    action();
    return;
  }
  if (!command(event.detail)) return;
  event.preventDefault();
  openCommandTerminal();
});

async function sendPrompt(job) {
  if (job instanceof Event || typeof job === 'undefined') job = null;
  const draft = promptInput.value;
  let text = (job?.prompt ?? draft).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  const hasFiles = !job && window.desktopAttachments.hasFiles;
  if (viewed || (!job && send.disabled) || !readScreen(terminal, folder).ready) return false;
  const action = desktopCommands.get(text.trim());
  if (action) {
    promptInput.value = '';
    window.desktopDrafts.noteSent({ established: false });
    window.freepiCompletion.hide();
    updateButtons();
    action();
    return;
  }
  const nativeCommand = /^\s*[!\/]/u.test(text);
  if (hasFiles && nativeCommand) {
    const notice = $('attachment-status');
    notice.textContent = t("Remove attachments to run a command. You can send files in a regular message.");
    notice.hidden = false;
    return;
  }
  window.freepiCompletion.hide();
  if (nativeCommand) {
    waitForScreen('command');
    openCommandTerminal();
    bridge.write(`\x1b[200~${text}\x1b[201~\r`);
    promptInput.value = '';
    window.desktopDrafts.noteSent({ established: false });
    updateButtons();
    return;
  }
  {
    const target = folder;
    const attachmentRevision = window.desktopAttachments.revision;
    collectingChanges = true;
    status(hasFiles ? t("Preparing attachments…") : t("Taking a file snapshot…"));
    updateButtons();
    try {
      if (hasFiles) text = await window.desktopAttachments.prepare(text, target);
      await window.desktopChanges.begin(sessionId && folder ? { folder, sessionId } : undefined, text);
    } catch {
      status('');
      return false;
    } finally {
      collectingChanges = false;
      updateButtons();
    }
    if (!running || target !== folder || !readScreen(terminal, folder).ready || nativeConfirmation() || nativeBusy()
      || (!job && (promptInput.value !== draft || window.desktopAttachments.revision !== attachmentRevision))) {
      window.desktopChanges.reset();
      updateButtons();
      return false;
    }
    reviewingTurn = true;
    reviewWasBusy = false;
  }
  // Let the native editor interpret one paste and one submit, even with embedded newlines.
  turnStartScreen = screen.lines.join('\n');
  waitForScreen('turn');
  if (reviewingTurn) window.desktopChanges.submitted();
  bridge.write(`\x1b[200~${text}\x1b[201~\r`);
  if (job) {
    updateButtons();
    return true;
  }
  promptInput.value = '';
  if (hasFiles) window.desktopAttachments.clear();
  window.desktopDrafts.noteSent();
  updateButtons();
  promptInput.focus();
}

window.runDesktopTask = (job, switched = false) => {
  if (starting || closingWindow || pending || pickerKind || activeOccupied() || collectingChanges || window.desktopDrafts.queued) return 'wait';
  const current = running && chatKey(folder) === chatKey(job.folder)
    && (job.sessionId ? job.sessionId === sessionId : switched && taskSwitching);
  if (current) {
    if (!screen.ready || window.desktopDrafts.saving || !terminal.modes.bracketedPasteMode) return 'wait';
    if (viewed) returnToExecution();
    taskSwitching = false;
    return sendPrompt(job);
  }
  if (switched) return false;
  if (viewed && !canSwitchFromHistory()) return 'wait';
  taskSwitching = switchProject(job.folder, job.sessionId, !job.sessionId, false);
  return taskSwitching ? 'switching' : false;
};

function showSettings(open) {
  window.freepiAppearance.show(open);
}

function openDesktopSettings() {
  window.freepiAppearance.show(true);
}

function hidePicker() {
  picker.hidden = true;
  picker.inert = true;
  $('model').setAttribute('aria-expanded', 'false');
  $('thinking').setAttribute('aria-expanded', 'false');
  pickerKind = undefined;
  targetKey = undefined;
  pickerSignature = '';
  modelCatalog = [];
  catalogSize = 0;
  catalogDestination = undefined;
  catalogAttempts = 0;
  catalogWasRefreshing = false;
}

function dismissPicker() {
  if (pending === 'select') return;
  if (pickerKind) {
    waitForScreen('dismiss');
    bridge.write(escape);
  }
  hidePicker();
  promptInput.focus();
  updateButtons();
}

function openPicker(kind) {
  if (!command(kind === 'model' ? '/model' : '/thinking', 'open')) return;
  pickerKind = kind;
  picker.dataset.kind = kind;
  picker.inert = false;
  picker.hidden = false;
  search.value = searchQuery = '';
  $('search-box').hidden = kind !== 'model';
  pickerUsage.hidden = kind !== 'model';
  $('picker-title').textContent = kind === 'model' ? t("Models") : t("Reasoning level");
  $('model').setAttribute('aria-expanded', String(kind === 'model'));
  $('thinking').setAttribute('aria-expanded', String(kind === 'thinking'));
  $('choices').textContent = t("Opening the free-pi picker…");
  $('choices').scrollTop = 0;
  if (kind === 'model') search.focus();
  else $('dismiss').focus();
  updateButtons();
}

function choose(key) {
  const menu = screen.menu;
  if (!menu || menu.kind !== pickerKind || (pending && pending !== 'catalog')) return;
  targetKey = key;
  if (!pending) advancePicker(menu);
}

function moveNativePicker(from, to, kind) {
  const offset = to - from;
  if (!offset) return;
  waitForScreen(kind);
  bridge.write((offset > 0 ? down : up).repeat(Math.abs(offset)));
}

function collectModelRows(menu) {
  if (catalogSize !== menu.total || (catalogWasRefreshing && !menu.refreshing)) {
    modelCatalog = [];
    catalogSize = menu.total;
    catalogAttempts = 0;
    catalogDestination = undefined;
    if (pending === 'catalog') clearPending();
  }
  catalogWasRefreshing = menu.refreshing;
  const highlighted = menu.entries.findIndex(entry => entry.selected);
  if (highlighted < 0) return;
  const start = menu.position - 1 - highlighted;
  if (start < 0 || start + menu.entries.length > menu.total) return;
  menu.entries.forEach((entry, offset) => {
    const index = start + offset;
    const previous = modelCatalog[index];
    const name = entry.selected ? menu.modelName : previous?.key === entry.key ? previous.name : undefined;
    modelCatalog[index] = { ...entry, name };
  });
}

function advancePicker(menu) {
  if (pending === 'catalog' && menu.position === catalogDestination) clearPending();
  if (pending === 'navigate') {
    if (menu.refreshing || !menu.entries.some(entry => entry.selected && entry.key === targetKey)) return;
    waitForScreen('select');
    bridge.write('\r');
    return;
  }
  if (pending || menu.refreshing) return;
  const from = menu.position - 1;
  if (from < 0) return;
  if (targetKey) {
    const to = (menu.kind === 'model' ? modelCatalog : menu.entries).findIndex(entry => entry?.key === targetKey);
    if (to < 0) {
      targetKey = undefined;
      return;
    }
    if (from === to && menu.entries.some(entry => entry.selected && entry.key === targetKey)) {
      waitForScreen('select');
      bridge.write('\r');
    } else {
      moveNativePicker(from, to, 'navigate');
    }
    return;
  }
  if (menu.kind !== 'model' || catalogAttempts >= Math.ceil(menu.total / 5) + 1) return;
  let missing = 0;
  while (missing < catalogSize && modelCatalog[missing]) missing++;
  if (missing === catalogSize) return;
  const to = Math.min(missing + 4, catalogSize - 1);
  catalogAttempts++;
  catalogDestination = to + 1;
  moveNativePicker(from, to, 'catalog');
}

function renderPicker(menu) {
  const query = searchQuery.toLocaleLowerCase();
  const entries = menu.kind === 'model' ? modelCatalog.filter(entry =>
    `${entry.label} ${entry.name ?? ''} ${entry.detail}`.toLocaleLowerCase().includes(query)) : menu.entries;
  const options = entries.map(({ key, label, name, detail, current, id }) => ({ key, label, name, detail, current, id }));
  const signature = JSON.stringify(options);
  if (signature === pickerSignature) return;
  pickerSignature = signature;
  const choices = $('choices');
  const scrollTop = choices.scrollTop;
  const focusedKey = document.activeElement?.dataset.key;
  choices.replaceChildren();
  for (const entry of options) {
    const button = document.createElement('button');
    button.className = 'choice';
    button.dataset.key = entry.key;
    if (entry.current) button.setAttribute('aria-current', 'true');
    const label = document.createElement('span');
    label.textContent = menu.kind === 'thinking' ? thinkingLabels[entry.id] : entry.label;
    const detail = document.createElement('small');
    detail.textContent = entry.name?.includes('Free Unlimited: limited time') ? 'Free Unlimited' : entry.detail;
    const check = document.createElement('span');
    check.className = 'choice-check';
    check.textContent = entry.current ? '✓' : '';
    check.setAttribute('aria-hidden', 'true');
    button.append(label, detail, check);
    button.onclick = () => choose(entry.key);
    choices.append(button);
    if (entry.key === focusedKey) button.focus({ preventScroll: true });
  }
  choices.scrollTop = scrollTop;
  if (!options.length) {
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = t("No options available");
    choices.append(message);
  }
}

function syncScreen() {
  screen = readScreen(terminal, folder);
  const { menu, ready, title, free, selected, footer, footerModel, balance, lines } = screen;
  const busy = nativeBusy();
  if (!viewed && nativeConfirmation() && settings.open) {
    showSettings(false);
    terminal.focus();
  }
  if (reviewingTurn && !observedSession) {
    if (busy) reviewWasBusy = true;
    else if (ready && (reviewWasBusy || (pending === 'turn' && lines.join('\n') !== turnStartScreen))) finishReview();
  }
  if (nativeConfirmation() && pickerKind) {
    clearPending();
    hidePicker();
  }
  const previousModel = activeModel;
  const highlighted = menu?.entries.find(entry => entry.selected);
  const pickerName = menu?.modelName?.split(' · ')[0];
  if (menu?.kind === 'model' && highlighted && pickerName) {
    confirmedModelNames.set(highlighted.id, pickerName);
    confirmedModelNames.set(pickerName.toLowerCase(), pickerName);
  }
  if (!opened) {
    const step = readStartupStep(lines);
    if (step !== 'loading' || !['declined', 'sign-in-ended'].includes(startupStep)) startupStep = step;
  }
  if (title || ready) opened = true;
  if (reportedModel || title || footerModel || (selected && !menu)) {
    const prettyFooter = footerModel && activeModel.toLowerCase() === footerModel ? activeModel : footerModel;
    activeModel = reportedModel?.name?.split(' · ')[0].replace(/^🔥\s*/u, '') || title
      || confirmedModelNames.get(footerModel || selected) || prettyFooter || selected;
    $('model-name').textContent = activeModel;
    $('model').title = reportedModel?.id || selected || activeModel;
    if (reportedModel) $('offer').hidden = !reportedModel.name?.includes($('offer').textContent);
    else if (title || footer) $('offer').hidden = !(title ? free : footerModel);
  } else if (footer && !$('offer').hidden && !reportedModel) {
    activeModel = '';
    $('model-name').textContent = t("Model");
    $('model').removeAttribute('title');
    $('offer').hidden = true;
  }
  if (!observedSession && screen.lifecycle && screen.lifecycle !== lifecycle) {
    lifecycle = screen.lifecycle;
    replacedSessionId = lifecycle === '✓ New session started' ? sessionId : undefined;
    sessionId = null;
    reportedModel = undefined;
    window.desktopChanges.reset();
    if (!viewed) void window.desktopChanges.setConversation(undefined);
    bridge.bindTranscript(null);
    identifySession = true;
    sessionIdentifyAfter = 0;
    lookAcrossProjects = lifecycle === 'Resumed session';
    thinkingLabel.textContent = t("Reasoning");
  }
  if (previousModel !== activeModel) thinkingLabel.textContent = t("Reasoning");
  const level = screen.thinking || (menu?.kind === 'thinking' && menu.entries.find(entry => entry.current)?.id);
  if (thinkingLabels[level]) thinkingLabel.textContent = thinkingLabels[level];
  const toolMode = lines.findLast(line => /^\s*Tool calls are (?:now |shown )(compact|full|hidden)\b/.test(line))
    ?.trim().match(/^Tool calls are (?:now |shown )(compact|full|hidden)\b/)?.[1];
  if (toolMode) toolButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tools === toolMode)));
  const usage = lines.findLastIndex(line => /^\s*tier: \S+/.test(line));
  const usageBalance = usage >= 0 && lines.slice(usage + 1, usage + 6).find(line => /credits left|daily allowance used/i.test(line));
  if (balance || usageBalance) {
    const value = usageBalance ? usageBalance.trim() : balance;
    if ($('balance').textContent !== value) $('balance').textContent = value;
    const refill = value?.match(/\b(?:resets?|refills?)\s+([^·\n]+)/i)?.[1];
    if (refill) setLabel($('usage-reset'), refill.trim());
  }
  if (activeModel && $('settings-model').textContent !== activeModel) $('settings-model').textContent = activeModel;
  if (pickerKind && menu?.kind === pickerKind) {
    if (pending === 'open') clearPending();
    if (menu.kind === 'model') collectModelRows(menu);
    renderPicker(menu);
    advancePicker(menu);
  } else if (pickerKind && ready && pending !== 'open') {
    clearPending();
    hidePicker();
    promptInput.focus();
  }
  if (pending === 'dismiss' && ready && !menu) clearPending();
  if (pending === 'command' && ready) clearPending();
  if (pending === 'return-chat') {
    if (nativeConfirmation()) clearPending();
    else if (ready) {
      clearPending();
      showChat();
    }
  }
  if (pending === 'usage' && ready && usageBalance && lines.join('\n') !== usageBefore) {
    clearPending();
    setUsageStatus('');
    $('usage-updated').textContent = new Date().toLocaleString(document.documentElement.lang);
  }
  if (pending === 'turn' && (busy || (ready && lines.join('\n') !== turnStartScreen))) clearPending();
  if (pending === 'session-info' && !nativeConfirmation()
    && screen.reportedSessionId && screen.reportedSessionId !== replacedSessionId
    && (sessionPageUp || lines.join('\n') !== sessionStartScreen)) {
    sessionId = screen.reportedSessionId;
    if (!viewed && !lookAcrossProjects && folder) void window.desktopDrafts.bind(folder, sessionId);
    bridge.bindTranscript(sessionId, lookAcrossProjects);
    identifySession = false;
    lookAcrossProjects = false;
    clearPending();
    if (sessionPageUp) bridge.write('\x1b[1;5F');
  } else if (pending === 'session-info' && !nativeConfirmation() && !sessionPageUp && screen.sessionStats
    && lines.join('\n') !== sessionStartScreen && terminal.buffer.active.type === 'alternate') {
    sessionPageUp = true;
    clearTimeout(sessionProbeTimer);
    bridge.write('\x1b[5~');
  }
  if (pending === 'usage-menu' && ready && !menu && showUsageOnReady) {
    clearPending();
    showUsageOnReady = false;
    window.freepiAppearance.show(true, 'usage');
    refreshUsage();
  }
  if (ready && focusPromptOnReady) {
    focusPromptOnReady = false;
    if (document.activeElement === terminal.textarea) promptInput.focus();
  }
  const cliVersion = lines.find(line => /›π free-pi v[\w.-]+/.test(line))?.match(/›π free-pi v([\w.-]+)/)?.[1];
  if (cliVersion) setLabel($('desktop-cli-version'), cliVersion);
  updateTerminalVisibility();
  if (running) {
    if (nativeStatus === 'error') status(t("free-pi error"));
    else if (nativeConfirmation()) status(t("Confirmation is required in the terminal"));
    else status(busy || executionInFlight || pending === 'turn' ? agentActivity() : opened
      ? (terminalRequired ? t("Enter input in the terminal") : '') : t("Loading free-pi…"));
  }
  if (screen.ads.length) renderAds(screen.ads);
  updateButtons();
  if (identifySession && running && (ready || (lookAcrossProjects && screen.emptyEditor))
    && !busy && !nativeConfirmation() && !pending) {
    if (bridge.onLive) {
      // Give the official session hook priority over the viewport-based /session fallback.
      if (!sessionIdentifyAfter) sessionIdentifyAfter = Date.now() + 1400;
      const remaining = sessionIdentifyAfter - Date.now();
      if (remaining > 0) {
        if (sessionIdentifyTimer === undefined) sessionIdentifyTimer = setTimeout(() => {
          sessionIdentifyTimer = undefined;
          syncScreen();
        }, remaining);
        return;
      }
    }
    identifySession = false;
    sessionPageUp = false;
    sessionStartScreen = lines.join('\n');
    waitForScreen('session-info');
    bridge.write('/session\r');
    sessionProbeTimer = setTimeout(() => {
      if (pending === 'session-info' && !nativeConfirmation() && screen.sessionStats
        && !sessionPageUp && terminal.buffer.active.type === 'alternate') {
        sessionPageUp = true;
        bridge.write('\x1b[5~');
      }
    }, 500);
  }
}

let refreshFrame;
terminal.parser.registerOscHandler(7501, data => {
  if (data === '?') bridge.write('\x1b]7501;?\x1b\\');
  else {
    const state = /^state=(idle|working|blocked|done|error|clear)(?=:|$)/.exec(data)?.[1];
    if (state) {
      nativeStatus = state === 'clear' ? undefined : state;
      if (!observedSession && (state === 'done' || state === 'error')) rememberCompletion(state === 'done' ? 'done' : 'failed');
      if (state === 'error' && !executionInFlight) rememberCompletion('failed');
    }
  }
  return true;
});
terminal.onWriteParsed(() => {
  cancelAnimationFrame(refreshFrame);
  refreshFrame = requestAnimationFrame(syncScreen);
});
bridge.onData(data => terminal.write(data));
bridge.onLive?.(event => {
  if (event.type === 'user') window.desktopChanges.attachUser(event);
  if (event.type === 'confirmation' && event.sessionId === sessionId) {
    nativePrompts = Math.max(0, nativePrompts + (event.open === true ? 1 : -1));
    syncScreen();
  }
  if (event.type === 'started' && event.sessionId === sessionId) {
    executionInFlight = true;
    completedChats.delete(chatKey(folder, sessionId));
    updateButtons();
  }
  if (event.sessionId === sessionId && event.type === 'tool') {
    if (event.state === 'running') activeTools.set(event.toolCallId, event.toolName);
    else activeTools.delete(event.toolCallId);
    if (nativeBusy() && !nativeConfirmation()) status(agentActivity());
  }
  if (event.type === 'settled' && event.sessionId === sessionId) {
    executionInFlight = false;
    rememberCompletion(event.aborted || (event.failed ?? nativeStatus === 'error') ? 'failed' : 'done');
    if (!viewed) window.desktopDrafts.onSettled?.(event.aborted);
    activeTools.clear();
    finishReview();
    syncScreen();
  }
  if (event.type === 'model' && event.sessionId === sessionId) {
    reportedModel = event.model;
    syncScreen();
    if (thinkingLabels[event.thinking]) thinkingLabel.textContent = thinkingLabels[event.thinking];
    return;
  }
  if (event.type !== 'session' || (!running && !starting)) return;
  if (event.sessionId !== sessionId) {
    executionInFlight = false;
    nativePrompts = 0;
    reviewingTurn = false;
    window.desktopChanges.reset();
  }
  observedSession = true;
  sessionId = event.sessionId;
  reportedModel = event.model;
  if (!viewed && event.folder) void window.desktopChanges.setConversation({ folder: event.folder, sessionId });
  identifySession = false;
  lookAcrossProjects = false;
  clearTimeout(sessionIdentifyTimer);
  sessionIdentifyTimer = undefined;
  if (pending === 'session-info') {
    if (sessionPageUp && !nativeConfirmation()) bridge.write('\x1b[1;5F');
    clearPending();
  }
  if (sessionLookupFailed) {
    sessionLookupFailed = false;
    showTerminal = false;
  }
  if (event.folder) folder = event.folder;
  if (!viewed && folder) void window.desktopDrafts.bind(folder, sessionId);
  syncScreen();
  if (thinkingLabels[event.thinking]) thinkingLabel.textContent = thinkingLabels[event.thinking];
  if (event.preferenceError) status(t(event.preferenceError));
});
bridge.onTranscript(snapshot => {
  if (snapshot.folder && snapshot.sessionId === sessionId) {
    if (!viewed) {
      void window.desktopDrafts.bind(snapshot.folder, sessionId);
      void window.desktopChanges.setConversation({ folder: snapshot.folder, sessionId });
    }
    window.desktopChanges.observeTranscript(snapshot);
  }
  if (!snapshot.folder || snapshot.sessionId !== sessionId || folder?.toLowerCase() === snapshot.folder.toLowerCase()) return;
  folder = snapshot.folder;
  syncScreen();
});

async function start(project, savedSession, draftOptions) {
  starting = true;
  startupStep = 'loading';
  startupEnded = false;
  activeTools.clear();
  executionInFlight = false;
  void window.desktopDrafts.start(project, savedSession, draftOptions);
  reviewingTurn = false;
  window.desktopChanges.reset();
  void window.desktopChanges.setConversation(project && savedSession ? { folder: project, sessionId: savedSession } : undefined);
  running = false;
  screen = {};
  opened = false;
  activeModel = '';
  reportedModel = undefined;
  sessionId = savedSession ?? null;
  lifecycle = undefined;
  replacedSessionId = undefined;
  identifySession = !savedSession;
  clearTimeout(sessionIdentifyTimer);
  sessionIdentifyTimer = undefined;
  sessionIdentifyAfter = 0;
  showTerminal = false;
  integrationsOpen = false;
  dismissedTerminalFallback = false;
  sessionLookupFailed = false;
  observedSession = false;
  lookAcrossProjects = false;
  nativeStatus = undefined;
  nativePrompts = 0;
  clearTimeout(terminalFallbackTimer);
  terminalFallbackTimer = undefined;
  terminalRequired = true;
  folder = project;
  renderTerminal();
  renderAds([]);
  focusPromptOnReady = true;
  thinkingLabel.textContent = t("Reasoning");
  hidePicker();
  showSettings(false);
  clearPending();
  terminal.reset();
  $('model-name').textContent = t("Model");
  $('model').removeAttribute('title');
  $('offer').hidden = true;
  $('balance').textContent = t("No data yet.");
  $('usage-reset').textContent = '—';
  $('settings-model').textContent = '—';
  setUsageStatus('');
  toolButtons.forEach(button => button.removeAttribute('aria-pressed'));
  status(t("Starting free-pi…"));
  updateButtons();
  fit.fit();
  try {
    const projectFolder = await bridge.start({ folder, sessionId: savedSession ?? undefined, cols: terminal.cols, rows: terminal.rows });
    running = true;
    if (!observedSession || !folder) folder = projectFolder;
    terminal.focus();
  } catch (error) {
    startupEnded = true;
    renderTerminal();
    status(error.message);
  } finally {
    starting = false;
    updateButtons();
  }
}

bridge.onExit(code => {
  if (!opened) {
    // Process exit can arrive before the final terminal frame is parsed.
    terminal.write('', () => {
      if (starting || running || opened || !startupEnded) return;
      const step = readStartupStep(readScreen(terminal, folder).lines);
      if (step === 'declined' || step === 'sign-in-ended') startupStep = step;
      renderStartupGuide('full');
    });
    startupEnded = true;
  }
  if (code !== 0 && activeOccupied()) rememberCompletion('failed');
  executionInFlight = false;
  nativeStatus = undefined;
  nativePrompts = 0;
  screen = {};
  window.desktopDrafts.cancelQueue();
  if (reviewingTurn) finishReview();
  running = false;
  clearTimeout(sessionIdentifyTimer);
  sessionIdentifyTimer = undefined;
  clearTimeout(terminalFallbackTimer);
  terminalFallbackTimer = undefined;
  clearPending();
  if (nextProject) {
    const { project, savedSession, draftOptions } = nextProject;
    nextProject = undefined;
    void start(project, savedSession, draftOptions);
    return;
  }
  hidePicker();
  $('offer').hidden = true;
  $('model-name').textContent = t("Model");
  status(code === 0 ? t("free-pi ended") : t("free-pi exited with code {0}", code));
  terminalRequired = true;
  renderTerminal();
  renderAds([]);
  updateButtons();
});

bridge.onClosing(async () => {
  if (closingWindow) return;
  const idle = !running || (screen.ready && !pending && !activeOccupied());
  if ((!idle || window.desktopSettingsUI?.preferences.confirmClose)
    && !window.confirm(idle ? t("Close PiLoft?") : t("Stop the current free-pi process?"))) return;
  closingWindow = true;
  window.desktopDrafts.cancelQueue();
  await window.desktopDrafts.flush();
  bridge.close(idle);
});

window.restartForLanguage = async () => {
  if (closingWindow || starting || nextProject || pending || pickerKind || collectingChanges
    || activeOccupied() || window.desktopDrafts.queued || window.desktopDrafts.saving
    || (running && !screen.ready)) return false;
  closingWindow = true;
  updateButtons();
  await window.desktopDrafts.flush();
  bridge.restart();
  return true;
};

async function browseHistory(project, savedSession) {
  const request = ++viewRequest;
  viewed = { folder: project, sessionId: savedSession, loading: true };
  $('background-chat').hidden = false;
  document.body.classList.add('history-view');
  window.freepiCompletion.hide();
  promptInput.placeholder = t("Draft for this chat");
  promptInput.setAttribute('aria-label', t("Draft for this chat"));
  setLabel($('status'), t("Draft"));
  $('status').title = t("Your draft is saved in this chat");
  void window.desktopDrafts.start(project, savedSession);
  void window.desktopChanges.setConversation(viewed);
  document.dispatchEvent(new CustomEvent('freepi:history-view', { detail: { ...viewed, messages: [] } }));
  renderTerminal();
  updateButtons();
  const snapshot = await bridge.readHistory(project, savedSession).catch(() => null);
  if (request !== viewRequest) return;
  viewed.loading = false;
  viewed.error = !snapshot;
  viewed.folderAvailable = snapshot?.folderAvailable;
  document.dispatchEvent(new CustomEvent('freepi:history-view', { detail: snapshot ?? { ...viewed, messages: [] } }));
  updateButtons();
}

function returnToExecution(restoreDraft = true) {
  if (!viewed) return;
  viewed = undefined;
  viewRequest++;
  bridge.clearHistory();
  $('background-chat').hidden = true;
  document.body.classList.remove('history-view');
  promptInput.placeholder = t("What would you like to do?");
  promptInput.setAttribute('aria-label', t("Message to free-pi"));
  window.freepiCompletion.hide();
  void window.desktopChanges.setConversation(folder && sessionId ? { folder, sessionId } : undefined);
  document.dispatchEvent(new CustomEvent('freepi:history-return'));
  if (!restoreDraft) return;
  void window.desktopDrafts.start(folder, sessionId);
  if (running) syncScreen();
  else {
    status(t("free-pi ended"));
    renderTerminal();
    updateButtons();
  }
  if (nativeConfirmation()) {
    window.freepiWorkbench.close();
    terminal.focus();
  } else promptInput.focus({ preventScroll: true });
}

function switchProject(project, savedSession, newChat = false, openHistory = true, folderAvailable = true) {
  if (!project || starting || nextProject || closingWindow) return false;
  if (openHistory) taskSwitching = false;
  if (savedSession && (viewed || running) && chatKey(project, savedSession) === chatKey(folder, sessionId)) {
    if (viewed) returnToExecution();
    return true;
  }
  if (savedSession && (!folderAvailable || activeOccupied() || (viewed && openHistory))) {
    if (collectingChanges || pickerKind || window.desktopDrafts.queued || window.desktopDrafts.saving
      || closingWindow || (pending && pending !== 'turn')) return false;
    if (chatKey(project, savedSession) !== chatKey(viewed?.folder, viewed?.sessionId)
      && chatKey(project, savedSession) !== chatKey(folder, sessionId)) void browseHistory(project, savedSession);
    return true;
  }
  if (viewed) {
    if (!canSwitchFromHistory()) return false;
    if (running && !newChat && chatKey(project) === chatKey(folder)) {
      returnToExecution();
      return true;
    }
    returnToExecution(false);
  }
  if (running && !savedSession && !newChat && project.toLowerCase() === folder?.toLowerCase()) return false;
  const draftOptions = { restoreUnsaved: !newChat };
  if (running) {
    if (!command('/quit', 'switch')) return false;
    nextProject = { project, savedSession, draftOptions };
    updateButtons();
  } else {
    void start(project, savedSession, draftOptions);
  }
  return true;
}

$('return-running-chat').onclick = () => returnToExecution();
document.addEventListener('freepi:project-availability', ({ detail }) => {
  if (!viewed || viewed.loading || viewed.error) return;
  const project = detail.find(item => item.folder.toLowerCase() === viewed.folder.toLowerCase());
  if (!project || project.available === viewed.folderAvailable) return;
  viewed.folderAvailable = project.available;
  updateButtons();
});
$('activate-viewed-chat').onclick = () => {
  if (!canContinueHistory()) return;
  const target = viewed;
  returnToExecution(false);
  if (!switchProject(target.folder, target.sessionId)) void browseHistory(target.folder, target.sessionId);
};

function updateProjectDialog() {
  const name = projectName.value.trim();
  const location = projectCreatesFolder && name && projectLocation
    ? `${projectLocation.replace(/[\\/]+$/, '')}\\${name}` : projectLocation;
  setLabel($('project-folder-mode'), !projectLocation ? t("On this computer")
    : projectCreatesFolder ? t("The new folder uses the project name") : t("Existing folder selected"));
  projectPath.textContent = location ?? '';
  projectPath.hidden = !location;
  projectName.disabled = projectBusy;
  $('project-pick-folder').disabled = projectBusy;
  $('project-pick-parent').disabled = projectBusy;
  projectDialog.querySelectorAll('[data-close-project-dialog]').forEach(button => { button.disabled = projectBusy; });
  projectSubmit.disabled = projectBusy || !projectLocation || !name;
}

function openProjectDialog() {
  if (projectDialog.open) return;
  $('project-form').reset();
  projectLocation = undefined;
  projectCreatesFolder = false;
  projectStatus.textContent = '';
  $('first-project-guide').hidden = Boolean(folder);
  updateProjectDialog();
  projectDialog.showModal();
}

async function chooseProjectFolder(createFolder, trigger) {
  projectBusy = true;
  projectStatus.textContent = '';
  updateProjectDialog();
  try {
    const selected = await bridge.pickFolder(projectLocation ?? viewed?.folder ?? folder, createFolder);
    if (!selected) return;
    projectLocation = selected;
    projectCreatesFolder = createFolder;
    if (!createFolder && !projectName.value.trim()) {
      projectName.value = selected.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, projectName.maxLength) ?? '';
    }
  } catch {
    projectStatus.textContent = t("Could not open the folder picker.");
  } finally {
    projectBusy = false;
    updateProjectDialog();
    if (projectDialog.open) (projectCreatesFolder && !projectName.value.trim() ? projectName : trigger).focus();
  }
}

$('new-project').onclick = openProjectDialog;
$('project-pick-folder').onclick = event => void chooseProjectFolder(false, event.currentTarget);
$('project-pick-parent').onclick = event => void chooseProjectFolder(true, event.currentTarget);
projectName.oninput = () => {
  projectStatus.textContent = '';
  updateProjectDialog();
};
projectDialog.addEventListener('cancel', event => {
  if (projectBusy) event.preventDefault();
});
projectDialog.querySelectorAll('[data-close-project-dialog]').forEach(button => {
  button.onclick = () => projectDialog.close();
});
$('project-form').onsubmit = async event => {
  event.preventDefault();
  if (projectSubmit.disabled) return;
  const name = projectName.value.trim();
  projectBusy = true;
  projectStatus.textContent = '';
  updateProjectDialog();
  try {
    const result = await bridge.registerProject({ name, location: projectLocation, createFolder: projectCreatesFolder });
    if (result.error) {
      projectStatus.textContent = result.error;
      return;
    }
    projectDialog.close();
    document.dispatchEvent(new Event('freepi:projects'));
    if (!activeOccupied() && !window.desktopDrafts.queued) switchProject(result.folder);
  } catch {
    projectStatus.textContent = t("Could not save the project.");
  } finally {
    projectBusy = false;
    updateProjectDialog();
    if (projectDialog.open) projectName.focus();
  }
};
$('restart').onclick = () => void start(folder, sessionId, { restoreUnsaved: true });
$('startup-retry').onclick = () => $('restart').click();
function showChat() {
  if (viewed || terminalButton.disabled) return;
  if (pending === 'return-chat') return;
  if (running && !nativeBusy()) {
    const current = readScreen(terminal, folder);
    if (!current.ready) {
      if (current.dismissibleMenu && !nativeConfirmation() && !current.customQuestion) {
        waitForScreen('return-chat');
        // A docked viewport can clip the native footer after dismissing a selector.
        openCommandTerminal();
        bridge.write(escape);
      } else if (terminalPane.dataset.mode === 'dock') {
        // Check the full screen when leaving the dock, including when its editor hint was clipped.
        waitForScreen('return-chat');
        openCommandTerminal();
      } else {
        status(t("Finish the action in the terminal, then choose “Show chat.”"));
        terminal.focus();
      }
      return;
    }
    if (pending === 'command') return;
  }
  dismissedTerminalFallback = true;
  terminalRequired = false;
  showTerminal = false;
  integrationsOpen = false;
  renderTerminal();
  updateButtons();
  promptInput.focus();
}

function finishReview() {
  if (!reviewingTurn) return;
  reviewingTurn = false;
  void window.desktopChanges.finish();
}

terminalButton.onclick = () => {
  if (terminalButton.disabled) return;
  if (terminalPane.dataset.open === 'true') showChat();
  else {
    showTerminal = true;
    renderTerminal(true);
  }
};
stop.onclick = () => {
  window.desktopDrafts.cancelQueue();
  bridge.write(escape);
  promptInput.focus();
};
send.onclick = sendPrompt;
promptInput.oninput = updateButtons;
document.addEventListener('freepi:attachments', updateButtons);
document.addEventListener('freepi:draft-state', updateButtons);
document.addEventListener('freepi:add-context', event => {
  if (typeof event.detail !== 'string' || !event.detail.trim() || window.desktopDrafts.saving || window.desktopDrafts.queued) return;
  if (collectingChanges || /^\s*[!\/]/u.test(promptInput.value)) return;
  event.preventDefault();
  const separator = promptInput.value.trim() ? '\n\n' : '';
  promptInput.value += separator + event.detail;
  promptInput.dispatchEvent(new Event('input', { bubbles: true }));
  promptInput.focus({ preventScroll: true });
});
document.addEventListener('freepi:restore-prompt', async ({ detail }) => {
  const target = chatKey(viewed?.folder ?? folder, viewed?.sessionId ?? sessionId);
  if (chatKey(detail.folder, detail.sessionId) !== target || collectingChanges
    || window.desktopDrafts.saving || window.desktopDrafts.queued) return;
  const notice = $('attachment-status');
  const files = (await Promise.all(detail.paths.map(path => window.desktopAttachments.restoreFile(detail.folder, path)))).filter(Boolean);
  if (chatKey(viewed?.folder ?? folder, viewed?.sessionId ?? sessionId) !== target
    || collectingChanges || window.desktopDrafts.saving || window.desktopDrafts.queued) return;
  const preserved = promptInput.value.trim();
  if (detail.text && !preserved) promptInput.value = detail.text;
  else if (detail.text && preserved !== detail.text && !preserved.endsWith('\n\n' + detail.text)) promptInput.value += '\n\n' + detail.text;
  if (files.length) window.desktopAttachments.addDraftFiles(files);
  if (files.length < detail.paths.length) {
    notice.textContent = t("Some files from this request are unavailable.");
    notice.hidden = false;
  }
  promptInput.dispatchEvent(new Event('input', { bubbles: true }));
  promptInput.focus({ preventScroll: true });
});
function focusNativeConfirmation() {
  if (viewed) returnToExecution();
  if (!nativeConfirmation() && (opened || readStartupStep(screen.lines) !== 'trust')) return;
  window.freepiWorkbench.close();
  terminal.focus();
}
$('show-confirmation').onclick = focusNativeConfirmation;
document.addEventListener('freepi:open-confirmation', focusNativeConfirmation);
$('compact-chat').onclick = () => {
  if (!command('/compact')) return;
  document.dispatchEvent(new Event('freepi:compact-requested'));
};
$('workspace-fork').onclick = () => {
  if (command('/fork')) openCommandTerminal();
};
document.addEventListener('freepi:fork-message', ({ detail }) => {
  if (detail.sessionId === sessionId && /^[a-z0-9_-]{1,128}$/iu.test(detail.id)) command(`/desktop-fork ${detail.id}`);
});

const worktreeDialog = $('new-worktree-dialog');
$('workspace-worktree').onclick = () => {
  if ($('workspace-worktree').disabled) return;
  $('new-worktree-status').textContent = '';
  worktreeDialog.showModal();
};
$('new-worktree-cancel').onclick = () => worktreeDialog.close();
$('new-worktree-form').onsubmit = async event => {
  event.preventDefault();
  if ($('workspace-worktree').disabled) return;
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  const output = $('new-worktree-status');
  output.textContent = t("Creating worktree…");
  try {
    const result = await bridge.createWorktree(folder, $('worktree-base').value.trim());
    if (result.error) {
      output.textContent = result.error;
      return;
    }
    worktreeDialog.close();
    document.dispatchEvent(new Event('freepi:projects'));
    switchProject(result.folder, undefined, true);
  } catch (error) {
    output.textContent = t("Could not create a Git worktree.");
  } finally { submit.disabled = false; }
};

const localPreviewDialog = $('local-preview-dialog');
let previewFolder;
function detailPreviewFolder() { return previewFolder && previewFolder === (viewed?.folder ?? folder); }
$('workspace-preview').onclick = () => {
  $('local-preview-status').textContent = '';
  localPreviewDialog.showModal();
};
$('local-preview-cancel').onclick = () => localPreviewDialog.close();
$('local-preview-form').onsubmit = async event => {
  event.preventDefault();
  try {
    if (await bridge.openLocalPreview($('local-preview-url').value.trim())) {
      previewFolder = viewed?.folder ?? folder;
      $('workspace-capture-preview').hidden = false;
      updateButtons();
      localPreviewDialog.close();
    }
    else $('local-preview-status').textContent = t("Enter an HTTP or HTTPS address on localhost, 127.0.0.1 or [::1].");
  } catch {
    $('local-preview-status').textContent = t("The preview could not load. Check that the local server is running.");
  }
};
const previewCapture = $('workspace-capture-preview');
previewCapture.onclick = async () => {
  if (previewCapture.disabled) return;
  const target = chatKey(viewed?.folder ?? folder, viewed?.sessionId ?? sessionId);
  try {
    const data = await bridge.captureLocalPreview();
    if (data && target === chatKey(viewed?.folder ?? folder, viewed?.sessionId ?? sessionId)
      && !window.desktopDrafts.saving && !window.desktopDrafts.queued) {
      window.desktopAttachments.addDraftFiles([new File([Uint8Array.fromBase64(data)], 'local-preview.png', { type: 'image/png' })]);
    } else if (target === chatKey(viewed?.folder ?? folder, viewed?.sessionId ?? sessionId)) {
      $('attachment-status').textContent = t("Open a local preview first.");
      $('attachment-status').hidden = false;
    }
  } catch {
    $('attachment-status').textContent = t("Could not capture the local preview.");
    $('attachment-status').hidden = false;
  }
};
promptInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    sendPrompt();
  } else if (event.key === 'Escape' && !stop.hidden) {
    event.preventDefault();
    stop.click();
  }
});
$('settings').onclick = () => showSettings(!settings.open);
$('usage').onclick = refreshUsage;
$('integrations').onclick = () => {
  if (!command('/mcp')) return;
  showSettings(false);
  openCommandTerminal();
};
toolButtons.forEach(button => {
  button.onclick = () => command(`/tools ${button.dataset.tools}`);
});
$('model').onclick = () => {
  showSettings(false);
  if (pickerKind === 'model') dismissPicker();
  else openPicker('model');
};
$('thinking').onclick = () => {
  showSettings(false);
  if (pickerKind === 'thinking') dismissPicker();
  else openPicker('thinking');
};
$('dismiss').onclick = dismissPicker;
pickerUsage.onclick = () => {
  if (screen.menu?.kind !== 'model' || pending) return;
  hidePicker();
  showUsageOnReady = true;
  waitForScreen('usage-menu');
  bridge.write(escape);
};

search.oninput = () => {
  searchQuery = search.value.replace(/[\x00-\x1f\x7f]/g, '').trim();
  $('choices').scrollTop = 0;
  if (screen.menu?.kind === 'model') renderPicker(screen.menu);
};
picker.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    dismissPicker();
  } else if (event.key === 'Enter' && event.target === search) {
    event.preventDefault();
    $('choices').querySelector('.choice')?.click();
  }
});
document.addEventListener('pointerdown', event => {
  const pickerTrigger = pickerKind && $(pickerKind === 'model' ? 'model' : 'thinking');
  if (pickerKind && !picker.contains(event.target) && !pickerTrigger.contains(event.target) && !$('stop').contains(event.target)) dismissPicker();
});

let usageBefore;

function setUsageStatus(text) {
  $('usage-status').textContent = text;
  $('usage-status').hidden = !text;
}

function refreshUsage() {
  usageBefore = screen.lines?.join('\n');
  if (command('/usage', 'usage')) setUsageStatus(t("Refreshing usage…"));
  else setUsageStatus(t("Usage can be refreshed when free-pi is ready."));
}

function agentActivity() {
  const tools = [...activeTools.values()];
  if (tools.length > 1) return t("Running {0} tools", tools.length);
  const tool = tools[0];
  if (!tool) return t("Agent is working");
  if (tool === 'read') return t("Reading a file");
  if (tool === 'bash' || tool === 'powershell') return t("Running a command");
  if (tool === 'edit' || tool === 'write') return t("Editing a file");
  return t("Tool: {0}", tool);
}

document.addEventListener('DOMContentLoaded', async () => {
  terminalRequired = false;
  renderTerminal();
  status('');
  const preferences = await window.desktopSettingsUI.readPreferences();
  if (!await window.freepiOnboarding.beforeStartup(preferences)) return;

  const [workspace] = await Promise.all([
    bridge.restoreWorkspace().catch(() => ({})),
    applyTerminalAppearance(window.freepiAppearance?.state),
    document.fonts.ready,
  ]);
  if (folder || running || starting) return;
  if (workspace.folder) return start(workspace.folder, workspace.sessionId, { restoreUnsaved: true });
  if (workspace.unavailableFolder && workspace.sessionId) return browseHistory(workspace.unavailableFolder, workspace.sessionId);
  document.querySelector('#chat-empty h1').textContent = t("Pick a project folder");
  updateButtons();
  if (!workspace.unavailableFolder && !document.querySelector('dialog[open]')) openProjectDialog();
}, { once: true });
