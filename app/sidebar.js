(() => {
  const projectsList = document.getElementById('projects-list');
  const pinnedSection = document.getElementById('pinned-section');
  const pinnedList = document.getElementById('pinned-list');
  const pinStatus = document.getElementById('sidebar-pin-status');
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('toggle-sidebar');
  const folderName = document.getElementById('folder-name');
  const projectTitle = document.getElementById('project-title');
  const resume = document.getElementById('resume');
  const sessionsDialog = document.getElementById('sessions-dialog');
  const sessionsSearch = document.getElementById('sessions-search');
  const sessionsResults = document.getElementById('sessions-results');
  const sessionsStatus = document.getElementById('sessions-status');
  const sessionsTitle = document.getElementById('sessions-heading');
  const projectMenu = document.getElementById('project-menu');
  const renameHeading = document.getElementById('rename-project-heading');
  const renameDialog = document.getElementById('rename-project-dialog');
  const renameName = document.getElementById('rename-project-name');
  const renameStatus = document.getElementById('rename-project-status');
  const renameSubmit = document.getElementById('rename-project-submit');
  const renameCancel = document.getElementById('rename-project-cancel');
  const activity = document.createElement('button');
  activity.className = 'sidebar-activity';
  activity.type = 'button';
  activity.hidden = true;
  const activityIndicator = document.createElement('span');
  activityIndicator.className = 'sidebar-activity-indicator';
  activityIndicator.setAttribute('aria-hidden', 'true');
  const activityCopy = document.createElement('span');
  activityCopy.className = 'sidebar-activity-copy';
  const activityTitle = document.createElement('strong');
  const activityStatus = document.createElement('span');
  activityStatus.className = 'sidebar-activity-status';
  activityStatus.setAttribute('role', 'status');
  activityCopy.append(activityTitle, activityStatus);
  activity.append(activityIndicator, activityCopy);
  resume.after(activity);
  const categories = document.createElement('div');
  categories.className = 'search-categories';
  categories.setAttribute('role', 'group');
  categories.setAttribute('aria-label', t("Search scope"));
  sessionsSearch.after(categories);
  const selectionStatus = document.createElement('span');
  selectionStatus.className = 'sr-only';
  selectionStatus.setAttribute('role', 'status');
  sessionsResults.after(selectionStatus);
  sessionsTitle.textContent = t("Search");
  resume.title = t("Quick search (Ctrl+K)");
  sessionsDialog.querySelector('.sessions-header button')?.setAttribute('aria-label', t("Close search"));
  sessionsSearch.placeholder = t("Chats, files, and actions");
  sessionsSearch.setAttribute('aria-label', t("Chats, files, and actions"));
  sessionsSearch.setAttribute('aria-controls', sessionsResults.id);
  sessionsResults.setAttribute('aria-label', t("Search results"));
  const narrow = matchMedia('(max-width: 810px)');
  const dateFormat = new Intl.DateTimeFormat(document.documentElement.lang, { day: 'numeric', month: 'short' });
  let state = {};
  let projects = [];
  let pinnedSessions = [];
  let pinsRefreshId = 0;
  const projectSessions = new Map();
  const expandedProjects = new Map();
  const fullChatLists = new Set();
  let refreshId = 0;
  let allSessions = [];
  let searchId = 0;
  let searchTimer;
  let editingSession;
  let savingSession = false;
  let searchScope = 'all';
  let fileMatches = [];
  let searchFailures = 0;
  let noMessageLink;
  let searchRows = [];
  let selectedRow = -1;
  let menuProject;
  let renamingProject;
  const activityLabels = {
    working: t("Working"),
    confirmation: t("Awaiting confirmation"),
    done: t("Done"),
    failed: t("Interrupted"),
  };

  const searchActions = [
    [t("New chat"), t("new session new chat"), 'plus', '.project-group[data-current] .project-new-chat'],
    [t("New project"), t("open folder new project"), 'folder', '#new-project'],
    [t("Switch model"), t("models model"), 'sliders', '#model'],
    [t("Reasoning level"), t("effort thinking"), 'sliders', '#thinking'],
    [t("Project files"), t("open file files"), 'file', '#workbench-toggle'],
    [t("Project commands"), t("run build test commands"), 'play', '#project-actions'],
    [t("Tasks"), t("queue schedules tasks"), 'list-check', '#desktop-task-list'],
    [t("Open changes"), t("review diff"), 'diff', '#changes-toggle'],
    [t("Chat overview"), t("progress results confirmation"), 'list-check', '#overview-toggle'],
    [t("Chat context"), t("context tokens limit"), 'gauge', '#context-meter'],
    [t("Compact context"), 'compact context', 'gauge', '#compact-chat'],
    [t("Fork chat"), 'fork branch conversation', 'branch', '#workspace-fork'],
    [t("New chat in worktree"), 'git worktree branch', 'branch', '#workspace-worktree'],
    [t("Open local preview"), 'preview localhost browser', 'panel', '#workspace-preview'],
    [t("Attach preview screenshot"), 'capture preview screenshot', 'paperclip', '#workspace-capture-preview'],
    [t("Terminal"), t("console terminal"), 'terminal', '#focus-terminal'],
    [t("Settings"), t("appearance settings"), 'settings', '#settings'],
    [t("Open MCP"), t("integrations tools servers"), 'plug', '#integrations'],
  ];

  for (const [scope, title] of [['all', t("All")], ['chats', t("Chats")], ['files', t("Files")], ['actions', t("Actions")], ['archive', t("Archive")]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = title;
    button.dataset.scope = scope;
    button.setAttribute('aria-pressed', String(scope === searchScope));
    button.onclick = () => {
      if (searchScope === scope) return;
      setScope(scope);
      sessionsSearch.focus();
      void loadSessions();
    };
    categories.append(button);
  }

  function setScope(scope) {
    searchScope = scope;
    editingSession = undefined;
    allSessions = [];
    fileMatches = [];
    searchFailures = 0;
    clearTimeout(searchTimer);
    for (const button of categories.children) {
      button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
    }
  }

  function showSidebar(open, animate = false) {
    if (!open) closeProjectMenu();
    sidebar.toggleAttribute('data-motion', open && animate);
    document.body.classList.toggle('sidebar-closed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? t("Collapse projects") : t("Show projects");
    toggle.setAttribute('aria-label', toggle.title);
  }

  showSidebar(!narrow.matches);
  narrow.addEventListener('change', event => showSidebar(!event.matches));
  toggle.onclick = event => showSidebar(document.body.classList.contains('sidebar-closed'), event.detail > 0);

  function makeRow(text, icon, classes) {
    const row = document.createElement('button');
    row.className = `nav-button ${classes}`;
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glyph.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(glyph.namespaceURI, 'use');
    use.setAttribute('href', `#i-${icon}`);
    const label = document.createElement('span');
    label.textContent = text;
    glyph.append(use);
    row.append(glyph, label);
    return row;
  }

  function projectMenuTrigger(project) {
    if (project.trigger?.isConnected) return project.trigger;
    const key = project.trigger?.dataset.row ?? `project-menu:${project.folder.toLowerCase()}`;
    return [...sidebar.querySelectorAll('.project-menu-trigger')].find(button => button.dataset.row === key);
  }

  function focusProjectMenuTrigger(project) {
    (projectMenuTrigger(project) ?? document.getElementById('new-project')).focus({ preventScroll: true });
  }

  function closeProjectMenu(restoreFocus = false) {
    if (!menuProject) return;
    const project = menuProject;
    menuProject = undefined;
    projectMenu.hidden = true;
    projectMenuTrigger(project)?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) focusProjectMenuTrigger(project);
  }

  function openProjectMenu(project, trigger, position, last = false) {
    closeProjectMenu();
    menuProject = project;
    trigger.setAttribute('aria-expanded', 'true');
    projectMenu.setAttribute('aria-label', trigger.title);
    for (const item of projectMenu.querySelectorAll('button')) {
      item.hidden = item.id.startsWith('chat-') !== Boolean(project.id);
    }
    if (!project.id && project.available === false) {
      document.getElementById('project-menu-explorer').hidden = true;
      document.getElementById('project-menu-settings').hidden = true;
    }
    if (project.id) document.querySelector('#chat-menu-pin span').textContent = project.pinned ? t("Unpin") : t("Pin");
    projectMenu.hidden = false;
    const { right, top, bottom } = trigger.getBoundingClientRect();
    const x = position?.x ?? right - projectMenu.offsetWidth;
    const y = position?.y ?? bottom + 3;
    const upper = position?.y ?? top;
    const height = projectMenu.offsetHeight;
    projectMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - projectMenu.offsetWidth - 8)) + 'px';
    projectMenu.style.top = Math.max(8, y + height + 8 > window.innerHeight ? upper - height - 3 : y) + 'px';
    const items = projectMenu.querySelectorAll('button:not([hidden])');
    items[last ? items.length - 1 : 0].focus({ preventScroll: true });
  }

  projectMenu.addEventListener('keydown', event => {
    const { key } = event;
    if (key === 'Escape' || key === 'Tab') {
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      closeProjectMenu(true);
      return;
    }
    const menuItems = [...projectMenu.querySelectorAll('button:not([hidden])')];
    const current = menuItems.indexOf(document.activeElement);
    const count = menuItems.length;
    const index = key === 'Home' ? 0 : key === 'End' ? count - 1
      : key === 'ArrowDown' ? (current + 1) % count : key === 'ArrowUp' ? (current + count - 1) % count : -1;
    if (index < 0) return;
    event.preventDefault();
    menuItems[index].focus({ preventScroll: true });
  });
  projectMenu.addEventListener('focusout', event => {
    const target = event.relatedTarget;
    if (menuProject && target && !projectMenu.contains(target) && target !== projectMenuTrigger(menuProject)) {
      closeProjectMenu();
    }
  });

  document.addEventListener('pointerdown', event => {
    if (menuProject && !projectMenu.contains(event.target) && !projectMenuTrigger(menuProject)?.contains(event.target)) {
      closeProjectMenu();
    }
  });
  projectsList.parentElement.addEventListener('scroll', () => closeProjectMenu());
  window.addEventListener('resize', () => closeProjectMenu());
  window.addEventListener('blur', () => closeProjectMenu());

  function openRename() {
    renamingProject = menuProject;
    closeProjectMenu(true);
    setRenameStatus('');
    renameHeading.textContent = renamingProject.id ? t("Rename chat") : t("Rename project");
    renameName.maxLength = renamingProject.id ? 160 : 120;
    renameName.value = renamingProject.title ?? renamingProject.name;
    renameDialog.showModal();
    renameName.select();
  }
  document.getElementById('project-menu-rename').onclick = openRename;
  document.getElementById('project-menu-settings').onclick = () => {
    const project = menuProject;
    closeProjectMenu(true);
    window.desktopSettingsUI.openProject(project.folder);
  };
  document.getElementById('chat-menu-rename').onclick = openRename;
  document.getElementById('chat-menu-pin').onclick = () => {
    const session = menuProject;
    closeProjectMenu(true);
    void updateSession(session, { pinned: !session.pinned });
  };
  document.getElementById('chat-menu-archive').onclick = () => {
    const session = menuProject;
    closeProjectMenu(true);
    void updateSession(session, { archived: true });
  };
  document.getElementById('project-menu-explorer').onclick = () =>
    void runProjectAction('openProjectFolder', t("Unable to open the folder in File Explorer."));
  document.getElementById('project-menu-hide').onclick = () =>
    void runProjectAction('hideProject', t("Could not remove the project from the list."));

  async function runProjectAction(action, errorMessage) {
    const project = menuProject;
    closeProjectMenu(true);
    setPinStatus('');
    try {
      const result = await window.desktop[action](project.folder);
      if (result?.error) setPinStatus(result.error);
      else if (action === 'hideProject') await refreshProjects();
    } catch {
      setPinStatus(errorMessage);
    }
  }

  function setRenameStatus(message) {
    renameStatus.textContent = message;
    renameStatus.hidden = !message;
    if (message) {
      renameName.setAttribute('aria-invalid', 'true');
      renameName.setAttribute('aria-describedby', renameStatus.id);
    } else {
      renameName.removeAttribute('aria-invalid');
      renameName.removeAttribute('aria-describedby');
    }
  }

  renameName.oninput = () => setRenameStatus('');
  renameCancel.onclick = () => renameDialog.close();
  renameDialog.addEventListener('cancel', event => {
    if (renameSubmit.disabled) event.preventDefault();
  });
  renameDialog.addEventListener('close', () => focusProjectMenuTrigger(renamingProject));
  document.getElementById('rename-project-form').onsubmit = async event => {
    event.preventDefault();
    if (renameSubmit.disabled) return;
    renameName.readOnly = renameSubmit.disabled = renameCancel.disabled = true;
    try {
      if (renamingProject.id) {
        if (await updateSession(renamingProject, { title: renameName.value.trim() })) renameDialog.close();
        else setRenameStatus(t("Could not rename the chat."));
        return;
      }
      const result = await window.desktop.renameProject(renamingProject.folder, renameName.value.trim());
      if (result?.error) setRenameStatus(result.error);
      else {
        await refreshProjects();
        renameDialog.close();
      }
    } catch {
      setRenameStatus(t("Could not rename the project."));
    } finally {
      renameName.readOnly = renameSubmit.disabled = renameCancel.disabled = false;
      if (renameDialog.open) renameName.focus();
    }
  };

  function projectRows(project, index, currentFolder) {
    const key = project.folder.toLowerCase();
    const current = key === currentFolder;
    const expanded = expandedProjects.get(key) === true;
    const missing = project.available === false;
    const group = document.createElement('div');
    group.className = 'project-group';
    if (current) group.setAttribute('data-current', '');
    const disclosure = document.createElement('button');
    disclosure.type = 'button';
    disclosure.className = 'project-disclosure';
    disclosure.dataset.row = `toggle:${key}`;
    disclosure.title = expanded ? t("Collapse chats") : t("Expand chats");
    disclosure.setAttribute('aria-label', `${disclosure.title}: ${project.name}`);
    disclosure.setAttribute('aria-expanded', String(expanded));
    disclosure.setAttribute('aria-controls', `project-chats-${index}`);
    disclosure.onclick = () => {
      expandedProjects.set(key, !expanded);
      if (expanded) renderProjects();
      else void loadProjectSessions(project.folder);
    };
    const row = makeRow(project.name, 'folder', 'project-row');
    row.dataset.row = `folder:${key}`;
    row.title = project.folder;
    if (projects.some(other => other !== project && other.name.toLowerCase() === project.name.toLowerCase())) {
      const parent = project.folder.split(/[\\/]/).filter(Boolean).at(-2);
      if (parent) row.lastElementChild.append(Object.assign(document.createElement('small'), { textContent: ` · ${parent}` }));
    }
    if (missing) {
      const label = row.lastElementChild;
      const badge = document.createElement('small');
      badge.className = 'project-unavailable';
      badge.textContent = t("Folder unavailable");
      label.append(badge);
      row.title = `${badge.textContent}\n${project.folder}`;
      row.setAttribute('aria-expanded', String(expanded));
      row.setAttribute('aria-controls', `project-chats-${index}`);
    }
    row.disabled = !missing && !current && !state.canSwitch;
    if (current) row.setAttribute('aria-current', 'true');
    row.onclick = () => {
      if (missing) return disclosure.click();
      if (!current && !switchProject(project.folder)) return;
      if (narrow.matches) showSidebar(false);
      if (current) document.getElementById('focus-terminal').focus();
    };
    const newChat = sessionAction(t("New chat in {0}", project.name), 'plus', () => {
      if (!state.canSwitch || !switchProject(project.folder, undefined, true)) return;
      if (!expandedProjects.get(key)) {
        expandedProjects.set(key, true);
        void loadProjectSessions(project.folder);
      }
      if (narrow.matches) showSidebar(false);
    });
    newChat.className = 'icon project-new-chat';
    newChat.setAttribute('aria-label', newChat.title);
    newChat.dataset.row = `new-chat:${key}`;
    newChat.disabled = !state.canSwitch;
    newChat.hidden = missing;
    const menu = sessionAction(t("Project actions: {0}", project.name), 'ellipsis', () => {
      if (menuProject?.folder === project.folder) closeProjectMenu(true);
      else openProjectMenu(project, menu);
    });
    menu.className = 'icon project-menu-trigger';
    menu.dataset.row = `project-menu:${key}`;
    menu.setAttribute('aria-label', menu.title);
    menu.setAttribute('aria-haspopup', 'menu');
    menu.setAttribute('aria-controls', projectMenu.id);
    menu.setAttribute('aria-expanded', String(menuProject?.folder === project.folder));
    menu.onkeydown = event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openProjectMenu(project, menu, undefined, event.key === 'ArrowUp');
    };
    group.oncontextmenu = event => {
      event.preventDefault();
      openProjectMenu(project, menu, event.button === 2 ? { x: event.clientX, y: event.clientY } : undefined);
    };
    group.append(disclosure, row, newChat, menu);
    const list = document.createElement('div');
    list.className = 'session-list';
    list.id = `project-chats-${index}`;
    list.hidden = !expanded;
    if (!expanded) return [group, list];
    const saved = projectSessions.get(key);
    const sessions = (saved?.sessions ?? []).filter(session => !session.archived);
    if (!sessions.length || saved?.failed) {
      const notice = document.createElement('p');
      notice.className = 'project-sessions-status';
      notice.textContent = saved?.failed ? t("Could not load chats.") : saved?.loading
        ? t("Loading chats…") : t("No chats in this project yet.");
      list.append(notice);
    }
    const all = fullChatLists.has(key);
    const recent = [...sessions].sort((left, right) => right.modified.localeCompare(left.modified));
    for (const [index, session] of recent.entries()) {
      if (all || index < 5 || sameSession(session, state) || sameSession(session, state.execution)) {
        list.append(sidebarChat(session, currentFolder));
      }
    }
    if (recent.length > 5) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'project-show-chats';
      more.dataset.row = `more-chats:${key}`;
      more.textContent = all ? t("Show fewer chats") : t("All chats ({0})", recent.length);
      more.setAttribute('aria-expanded', String(all));
      more.onclick = () => {
        if (all) fullChatLists.delete(key);
        else fullChatLists.add(key);
        renderProjects();
      };
      list.append(more);
    }
    return [group, list];
  }

  function sidebarChat(session, currentFolder, shortcut = false) {
    const group = document.createElement('div');
    group.className = 'sidebar-chat-row';
    const item = makeRow(session.title, 'chat', 'session-row');
    const key = sessionKey(session);
    item.dataset.row = `${shortcut ? 'pinned-chat' : 'chat'}:${key}`;
    const active = session.folder.toLowerCase() === currentFolder && session.id === state.sessionId;
    if (active) item.setAttribute('aria-current', 'true');
    item.disabled = !active && !canOpenSession(session);
    item.title = shortcut ? `${session.title}\n${session.folder}` : session.title;
    if (missingSessionFolder(session)) item.title += `\n${t("Folder unavailable")}`;
    if (!appendChatState(item, session) && !shortcut) {
      const date = document.createElement('time');
      date.dateTime = session.modified;
      date.textContent = dateFormat.format(new Date(session.modified));
      item.append(date);
    }
    item.onclick = () => {
      if (!active && !openSavedChat(session)) return;
      if (narrow.matches) showSidebar(false);
      if (active) showChat();
    };
    const pin = sessionAction(t("{0} chat: {1}", session.pinned ? t("Unpin") : t("Pin"), session.title), 'pin', () => {
      void updateSession(session, { pinned: !session.pinned });
    });
    pin.classList.add('sidebar-pin');
    pin.setAttribute('aria-pressed', String(Boolean(session.pinned)));
    pin.dataset.row = `${shortcut ? 'pin-shortcut' : 'pin-chat'}:${key}`;
    if (savingSession) pin.setAttribute('aria-disabled', 'true');
    const menuKey = `chat-menu:${item.dataset.row}`;
    const menu = sessionAction(t("Chat actions: {0}", session.title), 'ellipsis', () => {
      if (menuProject?.trigger?.dataset.row === menuKey) closeProjectMenu(true);
      else openProjectMenu({ ...session, trigger: menu }, menu);
    });
    menu.className = 'icon project-menu-trigger chat-menu-trigger';
    menu.dataset.row = menuKey;
    menu.setAttribute('aria-label', menu.title);
    menu.setAttribute('aria-haspopup', 'menu');
    menu.setAttribute('aria-controls', projectMenu.id);
    menu.setAttribute('aria-expanded', String(menuProject?.trigger?.dataset.row === menuKey));
    menu.onkeydown = event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openProjectMenu({ ...session, trigger: menu }, menu, undefined, event.key === 'ArrowUp');
    };
    group.oncontextmenu = event => {
      event.preventDefault();
      openProjectMenu({ ...session, trigger: menu }, menu, event.button === 2 ? { x: event.clientX, y: event.clientY } : undefined);
    };
    group.append(item, pin, menu);
    return group;
  }

  function renderProjects() {
    const currentFolder = state.folder?.toLowerCase();
    const name = projects.find(project => project.folder.toLowerCase() === currentFolder)?.name
      ?? state.folder?.split(/[\\/]/).filter(Boolean).at(-1) ?? t("Project");
    if (folderName.textContent !== name) folderName.textContent = name;
    if (folderName.title !== (state.folder ?? '')) folderName.title = state.folder ?? '';
    const activeSession = projectSessions.get(currentFolder)?.sessions?.find(session => session.id === state.sessionId);
    const title = activeSession?.title || (state.sessionId ? t("Saved session") : t("Chat"));
    if (projectTitle.textContent !== title) projectTitle.textContent = title;
    if (projectTitle.title !== title) projectTitle.title = title;
    renderActivity();
    const projectSection = projectsList.parentElement;
    const focusedRow = projectSection.contains(document.activeElement) ? document.activeElement : undefined;
    const scrollTop = projectSection.scrollTop;
    const rows = document.createDocumentFragment();
    const pins = document.createDocumentFragment();
    for (const session of pinnedSessions) pins.append(sidebarChat(session, currentFolder, true));
    for (const [index, project] of projects.entries()) {
      rows.append(...projectRows(project, index, currentFolder));
    }
    pinnedSection.hidden = !pins.childElementCount;
    replaceRows(pinnedList, pins);
    replaceRows(projectsList, rows);
    projectSection.scrollTop = scrollTop;
    const previousFocus = focusedRow?.dataset.row;
    if (previousFocus && !focusedRow.isConnected) {
      const buttons = [...projectSection.querySelectorAll('button')];
      const restore = buttons.find(row => row.dataset.row === previousFocus)
        ?? (previousFocus.startsWith('pin-shortcut:') ? buttons.find(row =>
          row.dataset.row === previousFocus.replace('pin-shortcut:', 'pin-chat:')) : undefined)
        ?? resume;
      restore?.focus({ preventScroll: true });
    }
  }

  function replaceRows(list, rows) {
    const existing = [...list.children];
    if (existing.length !== rows.childElementCount || existing.some((row, i) => !row.isEqualNode(rows.children[i]))) {
      list.replaceChildren(rows);
    }
  }

  async function loadProjectSessions(folder) {
    const key = folder.toLowerCase();
    const request = { sessions: projectSessions.get(key)?.sessions, loading: true };
    projectSessions.set(key, request);
    renderProjects();
    try {
      request.sessions = await window.desktop.listSessions(folder);
    } catch {
      request.failed = true;
    } finally {
      request.loading = false;
      if (projectSessions.get(key) === request) renderProjects();
    }
  }

  async function refreshProjects() {
    const id = ++refreshId;
    try {
      const folders = await window.desktop.listProjects();
      if (id !== refreshId) return;
      projects = folders;
      renderProjects();
      document.dispatchEvent(new CustomEvent('freepi:project-availability', { detail: folders }));
      if (sessionsDialog.open && !editingSession && !savingSession) renderSessions();
    } catch {
      // Keep the visible projects if refreshing fails.
    }
  }

  async function refreshPins() {
    const id = ++pinsRefreshId;
    try {
      const pins = await window.desktop.listPinnedSessions();
      if (id !== pinsRefreshId) return;
      pinnedSessions = pins;
      renderProjects();
    } catch {
      // Keep the visible pins if refreshing fails.
    }
  }

  function setPinStatus(message) {
    pinStatus.textContent = message;
    pinStatus.hidden = !message;
  }

  function setSessionsStatus(message) {
    sessionsStatus.textContent = message;
    sessionsStatus.hidden = !message;
  }

  function sessionAction(label, icon, handler) {
    const button = makeRow(label, icon, 'session-action');
    button.classList.remove('nav-button');
    button.type = 'button';
    button.lastElementChild.className = 'sr-only';
    button.title = label;
    button.onclick = handler;
    return button;
  }

  function sessionKey(session) {
    return `${session.folder.toLowerCase()}/${session.id}`;
  }

  function sameSession(session, entry) {
    return session.id === entry?.sessionId && session.folder.toLowerCase() === entry.folder?.toLowerCase();
  }

  function missingSessionFolder(session) {
    const project = projects.find(project => project.folder.toLowerCase() === session.folder.toLowerCase());
    return (project?.available ?? session.folderAvailable) === false;
  }

  function openSavedChat(session) {
    return switchProject(session.folder, session.id, false, true, !missingSessionFolder(session));
  }

  function canOpenSession(session) {
    return Boolean(missingSessionFolder(session) || state.canSwitch || state.canBrowse || sameSession(session, state.execution));
  }

  function appendChatState(row, session) {
    const entry = sameSession(session, state.execution) && activityLabels[state.execution.state]
      ? state.execution : state.completedChats?.find(item => sameSession(session, item));
    const label = activityLabels[entry?.state];
    if (!label) return false;
    const badge = document.createElement('span');
    badge.className = 'chat-state';
    badge.dataset.state = entry.state;
    badge.title = label;
    badge.setAttribute('aria-hidden', 'true');
    row.setAttribute('aria-label', `${session.title} · ${label}`);
    row.title += `\n${label}`;
    row.append(badge);
    return true;
  }

  function renderActivity() {
    const execution = state.execution;
    const label = activityLabels[execution?.state];
    activity.hidden = !label || !execution.folder || !execution.sessionId;
    if (activity.hidden) return;
    const sessions = projectSessions.get(execution.folder.toLowerCase())?.sessions;
    const session = sessions?.find(item => item.id === execution.sessionId)
      ?? pinnedSessions.find(item => sameSession(item, execution));
    const title = session?.title || execution.folder.split(/[\\/]/).filter(Boolean).at(-1) || t("Current chat");
    activity.dataset.state = execution.state;
    activity.title = `${title} · ${label}`;
    if (activityTitle.textContent !== title) activityTitle.textContent = title;
    if (activityStatus.textContent !== label) activityStatus.textContent = label;
    activity.onclick = () => {
      if (sameSession({ folder: state.folder ?? '', id: state.sessionId }, execution)) {
        const confirmation = document.getElementById('show-confirmation');
        if (confirmation && !confirmation.hidden) confirmation.click();
        else showChat();
      } else if (!switchProject(execution.folder, execution.sessionId)) return;
      if (narrow.matches) showSidebar(false);
    };
  }

  async function updateSession(session, changes) {
    if (savingSession) return false;
    savingSession = true;
    setPinStatus('');
    const suspended = [...sessionsResults.querySelectorAll('button:not(:disabled)')];
    for (const button of suspended) button.disabled = true;
    try {
      await window.desktop.updateSession({ folder: session.folder, id: session.id, ...changes });
      editingSession = undefined;
      await Promise.all([loadProjectSessions(session.folder), refreshPins(), sessionsDialog.open && loadSessions()]);
      if (sessionsDialog.open && document.activeElement === document.body) sessionsSearch.focus();
      return true;
    } catch {
      const error = t("Could not save changes. Try again.");
      if (sessionsDialog.open) setSessionsStatus(error);
      else setPinStatus(error);
      return false;
    } finally {
      savingSession = false;
      for (const button of suspended) button.disabled = false;
      renderProjects();
    }
  }

  function renameForm(session) {
    const form = document.createElement('form');
    form.className = 'session-rename';
    const title = document.createElement('input');
    title.setAttribute('aria-label', t("Chat name"));
    title.value = session.title;
    title.maxLength = 160;
    title.placeholder = t("Chat name");
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = t("Save");
    const cancel = sessionAction(t("Cancel renaming"), 'close', () => {
      editingSession = undefined;
      renderSessions();
      sessionsResults.querySelector('[data-action="rename"]')?.focus();
    });
    form.onsubmit = event => {
      event.preventDefault();
      void updateSession(session, { title: title.value });
    };
    form.onkeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel.click();
      }
    };
    form.append(title, save, cancel);
    return form;
  }

  function renderSessionRows() {
    const list = document.createDocumentFragment();
    for (const session of searchScope === 'all' ? allSessions.slice(0, 8) : allSessions) {
      const group = document.createElement('div');
      group.className = 'session-manager-row';
      const row = makeRow(session.title, session.pinned ? 'pin' : 'chat', 'saved-session search-result');
      row.title = session.title;
      const active = sameSession(session, state);
      row.disabled = !active && !canOpenSession(session);
      const meta = document.createElement('small');
      meta.textContent = `${session.folder.split(/[\\/]/).filter(Boolean).at(-1)} · ${dateFormat.format(new Date(session.modified))}`;
      if (missingSessionFolder(session)) meta.textContent += ` · ${t("Folder unavailable")}`;
      meta.title = session.folder;
      row.lastElementChild.append(meta);
      if (session.snippet) {
        const excerpt = document.createElement('small');
        excerpt.className = 'session-snippet';
        excerpt.textContent = session.snippet;
        excerpt.title = session.snippet;
        row.lastElementChild.append(excerpt);
      }
      appendChatState(row, session);
      row.onclick = () => {
        const current = session.id === state.sessionId && session.folder.toLowerCase() === state.folder?.toLowerCase();
        if (!current && !openSavedChat(session)) {
          setSessionsStatus(t("Wait for the current free-pi action to finish."));
          return;
        }
        sessionsDialog.close();
        if (current) showChat();
        if (narrow.matches) showSidebar(false);
      };
      if (session.archived) {
        group.append(row, sessionAction(t("Restore chat from archive"), 'history', () => void updateSession(session, { archived: false })));
      } else if (editingSession === sessionKey(session)) {
        group.append(renameForm(session));
      } else {
        const rename = sessionAction(t("Rename chat"), 'rename', () => {
          editingSession = sessionKey(session);
          renderSessions();
          const input = sessionsResults.querySelector('.session-rename input');
          input?.focus();
          input?.select();
        });
        rename.dataset.action = 'rename';
        const pin = sessionAction(session.pinned ? t("Unpin chat") : t("Pin chat"), 'pin', () => {
          void updateSession(session, { pinned: !session.pinned });
        });
        pin.setAttribute('aria-pressed', String(session.pinned));
        if (session.id === state.sessionId && session.folder.toLowerCase() === state.folder?.toLowerCase()) {
          row.setAttribute('aria-current', 'true');
        }
        group.append(row, rename, pin);
      }
      list.append(group);
    }
    return list;
  }

  function renderFileRows() {
    const list = document.createDocumentFragment();
    for (const file of searchScope === 'all' ? fileMatches.slice(0, 8) : fileMatches) {
      const row = makeRow(file.path, file.kind === 'directory' ? 'folder' : 'file', 'search-result');
      row.title = file.path;
      row.onclick = () => {
        if (file.kind === 'directory') {
          setScope('files');
          sessionsSearch.value = file.path;
          sessionsSearch.focus();
          void loadSessions();
          return;
        }
        if (!window.freepiWorkbench) return;
        sessionsDialog.close();
        void window.freepiWorkbench.openFile(file.path);
      };
      list.append(row);
    }
    return list;
  }

  function renderActionRows() {
    const list = document.createDocumentFragment();
    const query = sessionsSearch.value.trim().replace(/^\//, '').toLocaleLowerCase();
    const link = messageLink();
    if (link && link !== noMessageLink) {
      const row = makeRow(t("Go to message"), 'link', 'search-result');
      row.onclick = () => {
        sessionsDialog.close();
        if (!document.dispatchEvent(new CustomEvent('freepi:message-link', { detail: link, cancelable: true }))) return;
        openSessions('all');
        sessionsSearch.value = '#' + link;
        noMessageLink = link;
        void loadSessions();
      };
      list.append(row);
    }
    for (const [label, keywords, icon, selector] of searchActions) {
      if (!`${label} ${keywords}`.toLocaleLowerCase().includes(query)) continue;
      const initialTarget = document.querySelector(selector);
      if (!initialTarget) continue;
      const row = makeRow(label, icon, 'search-result');
      row.disabled = initialTarget.disabled;
      row.onclick = () => {
        const target = document.querySelector(selector);
        if (!target || target.disabled) {
          setSessionsStatus(t("This action is unavailable right now."));
          return;
        }
        sessionsDialog.close();
        if (target.id === 'context-meter') document.dispatchEvent(new Event('freepi:open-context'));
        else target.click();
      };
      list.append(row);
    }
    return list;
  }

  function renderSessions() {
    const list = document.createDocumentFragment();
    const chats = ['chats', t("Chats"), renderSessionRows];
    const archive = ['archive', t("Archived chats"), renderSessionRows];
    const files = ['files', t("Project files"), renderFileRows];
    const actions = ['actions', t("Actions"), renderActionRows];
    const groups = searchScope === 'archive' ? [archive]
      : sessionsSearch.value.trim() ? [actions, files, chats] : [chats, files, actions];
    for (const [scope, heading, render] of groups) {
      if (searchScope !== 'all' && searchScope !== scope) continue;
      const rows = render();
      if (!rows.childElementCount) continue;
      const section = document.createElement('section');
      section.className = 'search-result-section';
      const title = document.createElement('h3');
      title.textContent = heading;
      section.append(title, rows);
      list.append(section);
    }
    const found = list.childElementCount > 0;
    sessionsResults.replaceChildren(list);
    searchRows = [...sessionsResults.querySelectorAll('.search-result:not(:disabled)')];
    selectSearchRow(searchRows.length ? 0 : -1);
    setSessionsStatus(noMessageLink && noMessageLink === messageLink() ? t("This message is not in the open chat.")
      : searchFailures ? (found ? t("Some results could not be loaded.") : t("Could not load search results."))
      : found ? '' : searchScope === 'files' && !state.folder ? t("Open a project to search its files.")
        : searchScope === 'archive' && !sessionsSearch.value.trim() ? t("No archived chats.") : t("No results found."));
  }

  function messageLink() {
    return /^(?:file:\/\/\/[^\r\n#]+)?#(message-[\w.:%-]+)$/u.exec(sessionsSearch.value.trim())?.[1];
  }

  function selectSearchRow(index, scroll = false) {
    selectedRow = index;
    for (const [offset, row] of searchRows.entries()) row.toggleAttribute('data-search-active', offset === index);
    const row = searchRows[index];
    selectionStatus.textContent = row ? t("{0} of {1}: {2}", index + 1, searchRows.length, row.textContent) : '';
    if (scroll && row) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function loadSessions() {
    const id = ++searchId;
    const query = sessionsSearch.value;
    setSessionsStatus(query.trim() ? t("Searching…") : t("Loading…"));
    const isMessageLink = messageLink() && (searchScope === 'all' || searchScope === 'actions');
    const [chats, files] = await Promise.allSettled([
      !isMessageLink && ['all', 'chats', 'archive'].includes(searchScope) ? window.desktop.listAllSessions(query, searchScope === 'archive') : [],
      !isMessageLink && (searchScope === 'all' || searchScope === 'files') && state.folder ? window.desktop.findProjectFiles(query) : [],
    ]);
    if (!sessionsDialog.open || id !== searchId || query !== sessionsSearch.value) return;
    allSessions = chats.status === 'fulfilled' ? chats.value : [];
    fileMatches = files.status === 'fulfilled' ? files.value : [];
    searchFailures = Number(chats.status === 'rejected') + Number(files.status === 'rejected');
    renderSessions();
  }

  function openSessions(scope) {
    if (sessionsDialog.open) {
      sessionsSearch.focus();
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    setScope(scope);
    noMessageLink = undefined;
    sessionsSearch.value = '';
    sessionsResults.replaceChildren();
    sessionsDialog.showModal();
    sessionsSearch.focus();
    void loadSessions();
  }

  resume.onclick = () => openSessions('all');
  sessionsSearch.oninput = () => {
    clearTimeout(searchTimer);
    noMessageLink = undefined;
    editingSession = undefined;
    sessionsResults.replaceChildren();
    searchRows = [];
    selectSearchRow(-1);
    setSessionsStatus(t("Searching…"));
    searchTimer = setTimeout(() => void loadSessions(), 180);
  };
  sessionsDialog.addEventListener('close', () => {
    clearTimeout(searchTimer);
    searchId++;
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey
      || !(event.ctrlKey || event.metaKey) || event.code !== 'KeyK') return;
    event.preventDefault();
    event.stopPropagation();
    openSessions('all');
  }, true);
  sessionsSearch.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && searchRows.length) {
      event.preventDefault();
      selectSearchRow((selectedRow + searchRows.length + (event.key === 'ArrowDown' ? 1 : -1)) % searchRows.length, true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      searchRows[selectedRow]?.click();
    }
  });

  document.addEventListener('freepi:state', ({ detail }) => {
    const folderChanged = detail.folder !== state.folder;
    const scopeChanged = folderChanged || detail.viewingHistory !== state.viewingHistory;
    const canOpenChanged = detail.canSwitch !== state.canSwitch || detail.canBrowse !== state.canBrowse;
    const executionChanged = detail.execution?.sessionId !== state.execution?.sessionId
      || detail.execution?.state !== state.execution?.state;
    const needsRefresh = folderChanged || detail.sessionId !== state.sessionId || (detail.ready && !state.ready);
    state = detail;
    const key = state.folder?.toLowerCase();
    if (key && !expandedProjects.has(key)) expandedProjects.set(key, true);
    renderProjects();
    if (folderChanged) void refreshProjects();
    if (sessionsDialog.open) {
      if (scopeChanged) void loadSessions();
      else if ((canOpenChanged || executionChanged) && !editingSession && !savingSession) renderSessions();
    }
    if (key && needsRefresh) void loadProjectSessions(state.folder);
    if (executionChanged && detail.execution?.folder) {
      const executionKey = detail.execution.folder.toLowerCase();
      const sessions = projectSessions.get(executionKey)?.sessions;
      if ((executionKey !== key || !needsRefresh) && !sessions?.some(item => sameSession(item, detail.execution))) {
        void loadProjectSessions(detail.execution.folder);
      }
    }
  });
  document.addEventListener('freepi:projects', () => void refreshProjects());
  window.addEventListener('focus', () => void refreshProjects());
  void refreshProjects();
  void refreshPins();
  resume.disabled = false;
})();
