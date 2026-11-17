(() => {
  const port = window.desktop;
  const byId = id => document.getElementById(id);
  const settings = byId('settings-panel');
  const commandDialog = byId('project-actions-dialog');
  const search = byId('settings-search');
  const workspaceMenu = byId('workspace-menu');
  const workspaceMenuTrigger = byId('workspace-menu-toggle');
  workspaceMenu.addEventListener('toggle', () => {
    workspaceMenuTrigger.setAttribute('aria-expanded', String(workspaceMenu.matches(':popover-open')));
  });
  workspaceMenu.addEventListener('click', event => {
    if (!event.target.closest('button')) return;
    if (workspaceMenu.matches(':popover-open')) workspaceMenu.hidePopover();
    const target = document.activeElement;
    if (workspaceMenu.contains(target) || target === document.body) workspaceMenuTrigger.focus({ preventScroll: true });
  }, true);
  const checks = [...settings.querySelectorAll('[data-notification-kind]')];
  const generalForm = byId('desktop-preferences');
  const generalSave = settings.querySelector('button[form="desktop-preferences"]');
  const generalStatus = byId('desktop-settings-status');
  const toolButtons = [...settings.querySelectorAll('[data-tools]')];
  const toolsStatus = byId('desktop-tools-status');
  const defaults = { editor: 'notepad', actionShell: 'powershell', restoreChat: true, confirmClose: false,
    cliChannel: 'stable', experimentalSchedules: false,
    language: 'en', onboardingComplete: false, initialPrompt: '', toolOutput: 'compact',
    model: '', thinking: '', notifications: { done: true, confirmation: true, failed: true } };
  let prefs = defaults;
  let startFolder;
  let state = {};
  let activeSession;
  let catalog = [];
  let models = [];
  let project;
  let profileRequest = 0;
  let integrationRequest = 0;
  let actionsFolder;
  let processes = [];
  let lastNotification = '';
  let noticeStates = new Map();
  let notificationTarget;
  let savePreferences = Promise.resolve();
  let preferencesLoaded = false;
  let generalSaving = false;
  let toolsSaving = false;
  const customModel = ':custom:';
  const modelDefaults = { 'desktop-model': t("CLI default"), 'profile-model': t("Use general settings") };
  function modelValue(id) {
    return byId(id).value === customModel ? byId(`${id}-custom`).value.trim() : byId(id).value;
  }

  function showCustomModel(id) {
    byId(`${id}-custom-row`).hidden = byId(id).value !== customModel;
    byId(`${id}-custom`).required = byId(id).value === customModel;
  }

  function renderModelOptions(id, saved = '', editing = false) {
    const select = byId(id);
    const choices = new Map(models.map(item => [`${item.provider}/${item.id}`, item.name]));
    if (saved && !choices.has(saved) && !editing) choices.set(saved, saved);
    select.replaceChildren(new Option(modelDefaults[id], ''),
      ...[...choices].map(([value, label]) => new Option(label, value)), new Option(t("Enter model ID…"), customModel));
    select.value = editing ? customModel : saved;
    byId(`${id}-custom`).value = saved;
    showCustomModel(id);
  }

  for (const id of Object.keys(modelDefaults)) {
    renderModelOptions(id);
    byId(id).onchange = () => {
      showCustomModel(id);
      if (byId(id).value === customModel) byId(`${id}-custom`).focus();
    };
  }
  const thinking = { off: t("Off"), minimal: t("Minimal"), low: t("Low"), medium: t("Medium"), high: t("High"), xhigh: t("Very high"), max: t("Maximum") };
  for (const [id, initial] of [['desktop-thinking', t("CLI default")], ['profile-thinking', t("Use general settings")]]) {
    byId(id).add(new Option(initial, ''));
    for (const [value, name] of Object.entries(thinking)) byId(id).add(new Option(name, value));
  }

  function errorText(error) {
    return String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, handler) {
    const node = el('button', text);
    node.type = 'button';
    node.onclick = handler;
    return node;
  }

  function syncPreferences(general = true) {
    if (general) {
      for (const [id, value] of Object.entries({ 'desktop-editor': prefs.editor, 'desktop-shell': prefs.actionShell,
        'desktop-thinking': prefs.thinking })) byId(id).value = value;
      renderModelOptions('desktop-model', prefs.model);
      byId('desktop-restore-chat').checked = prefs.restoreChat;
      byId('desktop-confirm-close').checked = prefs.confirmClose;
      byId('desktop-cli-channel').value = prefs.cliChannel;
      byId('interface-language').value = prefs.language;
      byId('desktop-enable-schedules').checked = prefs.experimentalSchedules;
      byId('desktop-initial-prompt').value = prefs.initialPrompt || '';
      startFolder = prefs.startFolder;
      byId('desktop-start-folder').textContent = startFolder || t("Default folder");
    }
    for (const item of checks) item.checked = prefs.notifications[item.dataset.notificationKind] === true;
    byId('workbench-editor').textContent = prefs.editor === 'notepad' ? t("Open in Notepad") : t("Open in editor");
    byId('schedules-disabled').hidden = Boolean(prefs.experimentalSchedules);
    byId('schedule-editor').hidden = !prefs.experimentalSchedules;
    syncToolButtons();
    document.dispatchEvent(new Event('freepi:desktop-settings'));
  }

  function saveSettings(patch) {
    const saved = savePreferences.then(async () => {
      prefs = await port.saveDesktopSettings({ ...prefs, ...patch });
    });
    savePreferences = saved.catch(() => {});
    return saved;
  }

  function generalValues() {
    return { startFolder, editor: byId('desktop-editor').value, actionShell: byId('desktop-shell').value,
      restoreChat: byId('desktop-restore-chat').checked, confirmClose: byId('desktop-confirm-close').checked,
      cliChannel: byId('desktop-cli-channel').value, experimentalSchedules: byId('desktop-enable-schedules').checked,
      language: byId('interface-language').value, initialPrompt: byId('desktop-initial-prompt').value.trim(),
      model: modelValue('desktop-model'), thinking: byId('desktop-thinking').value };
  }

  function generalChanged(values, baseline) {
    return Object.entries(values).some(([key, value]) => value !== baseline[key]);
  }

  function updateGeneralStatus(kind = '', message = '') {
    const dirty = preferencesLoaded && generalChanged(generalValues(), prefs);
    generalSave.disabled = generalSaving || !dirty;
    generalStatus.dataset.state = kind;
    generalStatus.textContent = generalSaving ? t("Saving…") : message || (dirty ? t("Unsaved changes") : '');
  }

  generalForm.addEventListener('input', () => updateGeneralStatus());
  generalForm.addEventListener('change', () => updateGeneralStatus());
  generalForm.onsubmit = async event => {
    event.preventDefault();
    if (generalSave.disabled) return;
    const values = generalValues();
    generalSaving = true;
    updateGeneralStatus();
    let feedback;
    let kind;
    try {
      await saveSettings(values);
      syncPreferences(!generalChanged(generalValues(), values));
      if (prefs.language !== window.freepiLocale.language) {
        const restarted = await window.freepiOnboarding.changeLanguage(prefs.language);
        if (!restarted) feedback = t("Language saved. Restart when the CLI is idle.");
      } else if (settings.open && !byId('settings-general').hidden && !generalChanged(generalValues(), prefs)) {
        feedback = t("Saved");
      }
      if (feedback) kind = 'saved';
    } catch (error) {
      kind = 'error';
      feedback = errorText(error);
    } finally {
      generalSaving = false;
      updateGeneralStatus(kind, feedback);
    }
  };
  byId('desktop-pick-start').onclick = async () => {
    try {
      const selected = await port.pickFolder(startFolder ?? state.folder);
      if (selected) {
        startFolder = selected;
        byId('desktop-start-folder').textContent = selected;
        updateGeneralStatus();
      }
    } catch (error) { updateGeneralStatus('error', errorText(error)); }
  };
  byId('desktop-reset-start').onclick = () => {
    startFolder = undefined;
    byId('desktop-start-folder').textContent = t("Default folder");
    updateGeneralStatus();
  };
  for (const check of checks) check.onchange = async () => {
    const output = byId('desktop-notification-status');
    try {
      await saveSettings({ notifications: Object.fromEntries(checks.map(item => [item.dataset.notificationKind, item.checked])) });
      syncPreferences(false);
      output.textContent = t("Saved");
    } catch (error) { output.textContent = errorText(error); }
  };

  function syncToolButtons() {
    for (const button of toolButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.tools === prefs.toolOutput));
      button.disabled = !preferencesLoaded || toolsSaving;
    }
  }

  for (const button of toolButtons) button.onclick = async () => {
    if (button.dataset.tools === prefs.toolOutput) return;
    toolsSaving = true;
    syncToolButtons();
    toolsStatus.hidden = true;
    try {
      await saveSettings({ toolOutput: button.dataset.tools });
      syncPreferences(false);
    } catch (error) {
      toolsStatus.textContent = errorText(error);
      toolsStatus.hidden = false;
    } finally {
      toolsSaving = false;
      syncToolButtons();
    }
  };
  byId('desktop-enable-notifications').onclick = async () => {
    const status = byId('desktop-notification-status');
    try {
      await port.registerNotificationShortcut();
      status.textContent = t("Shortcut added to the Start menu.");
    } catch (error) { status.textContent = errorText(error); }
  };

  const pages = [...settings.querySelectorAll('[data-settings-page]')];
  search.oninput = () => {
    const query = search.value.trim().toLowerCase();
    let count = 0;
    for (const page of pages) {
      const content = byId(page.getAttribute('aria-controls'));
      page.hidden = Boolean(query && !`${page.textContent} ${content.textContent}`.toLowerCase().includes(query));
      if (!page.hidden) count++;
    }
    byId('settings-no-results').hidden = count > 0;
  };
  search.onkeydown = event => {
    if (event.key !== 'Enter') return;
    const match = pages.find(page => !page.hidden);
    if (match) match.click();
  };

  function addAction(value = {}) {
    const row = el('div', undefined, 'settings-row project-action-edit');
    const name = el('input');
    name.value = value.name ?? '';
    name.placeholder = t("Name");
    name.setAttribute('aria-label', t("Command name"));
    name.required = true;
    name.maxLength = 70;
    const text = el('textarea');
    text.value = value.text ?? '';
    text.placeholder = 'npm test';
    text.setAttribute('aria-label', t("Command"));
    text.rows = 2;
    text.required = true;
    text.maxLength = 4000;
    row.append(name, text, button(t("Delete"), () => row.remove()));
    byId('profile-actions').append(row);
    return name;
  }

  function samePath(left, right) { return Boolean(left && right && left.toLowerCase() === right.toLowerCase()); }
  function updateTrust() {
    const current = samePath(project, activeSession?.folder);
    byId('profile-trust').textContent = current && typeof activeSession.trust === 'boolean'
      ? activeSession.trust ? t("The CLI trusts this folder") : t("The CLI does not trust this folder")
      : t("Trust status is available for the active project");
    byId('profile-trust-open').disabled = !current || !state.ready || Boolean(state.execution?.state === 'confirmation' || state.busy);
    byId('profile-preference-status').textContent = current && activeSession.preferenceError ? t(activeSession.preferenceError) : '';
    byId('profile-preference-status').hidden = !byId('profile-preference-status').textContent;
  }

  async function loadProfile(folder) {
    project = folder;
    const request = ++profileRequest;
    byId('profile-folder').textContent = folder || '';
    byId('profile-missing').hidden = Boolean(folder);
    byId('profile-form').hidden = true;
    byId('profile-save-bar').hidden = true;
    byId('profile-status').textContent = '';
    if (!folder) return;
    try {
      const profile = await port.projectProfile(folder);
      if (request !== profileRequest) return;
      renderModelOptions('profile-model', profile.model);
      byId('profile-thinking').value = profile.thinking || '';
      byId('profile-branch').textContent = profile.branch || '—';
      byId('profile-instructions').textContent = profile.instructions || t("No AGENTS.md in the project root");
      byId('profile-actions').replaceChildren();
      for (const action of profile.actions ?? []) addAction(action);
      updateTrust();
      byId('profile-form').hidden = false;
      byId('profile-save-bar').hidden = false;
    } catch (error) {
      if (request === profileRequest) {
        byId('profile-missing').textContent = errorText(error);
        byId('profile-missing').hidden = false;
      }
    }
  }
  byId('profile-add-action').onclick = () => {
    if (byId('profile-actions').children.length < 20) addAction().focus();
  };
  byId('profile-form').onsubmit = async event => {
    event.preventDefault();
    const folder = project;
    const actions = [...byId('profile-actions').children].map(row => ({
      name: row.querySelector('input').value, text: row.querySelector('textarea').value,
    }));
    try {
      const profile = await port.saveProjectProfile(folder, { model: modelValue('profile-model'), thinking: byId('profile-thinking').value, actions });
      if (project !== folder) return;
      renderModelOptions('profile-model', profile.model);
      byId('profile-status').textContent = t("Saved");
    } catch (error) { byId('profile-status').textContent = errorText(error); }
  };
  byId('profile-trust-open').onclick = () => {
    if (!command('/trust')) return;
    window.freepiAppearance.show(false);
    openCommandTerminal();
  };

  let explicitProject;
  document.addEventListener('freepi:settings-page', ({ detail }) => {
    if (detail !== 'general' && generalStatus.dataset.state === 'saved') updateGeneralStatus();
    if (detail === 'integrations') void renderIntegrationCatalog(state.folder);
    if (detail !== 'project') return;
    void loadProfile(explicitProject ?? state.folder);
    explicitProject = undefined;
  });
  settings.addEventListener('close', () => {
    if (generalStatus.dataset.state === 'saved') updateGeneralStatus();
    search.value = '';
    search.oninput();
  });

  function renderSkills() {
    const skills = catalog.filter(item => item.source === 'skill' || item.name.startsWith('skill:'));
    const prompts = catalog.filter(item => item.source === 'prompt');
    const scopes = { user: t("Personal"), project: t("Project"), path: t("Path"), temporary: t("Session") };
    const rowFor = item => {
      const row = el('li');
      row.append(el('strong', '/' + item.name), el('small', [scopes[item.scope] ?? item.scope, item.description].filter(Boolean).join(' · ')));
      return row;
    };
    byId('desktop-skills').replaceChildren(...(skills.length ? skills.map(rowFor) : [el('li', t("The CLI has not reported skills for this session yet."))]));
    byId('desktop-prompts').replaceChildren(...(prompts.length ? prompts.map(rowFor) : [el('li', t("No custom prompts reported for this session."))]));
  }

  async function renderIntegrationCatalog(folder) {
    const request = ++integrationRequest;
    const list = byId('desktop-mcp-list');
    const actions = byId('integrations-project-commands');
    const commands = byId('integrations-command-list');
    actions.disabled = !folder;
    actions.onclick = () => window.freepiAppearance.show(true, 'project');
    list.replaceChildren(el('li', t("Loading…")));
    commands.replaceChildren();
    try {
      const [entries, profile] = await Promise.all([port.integrationCatalog(folder), folder ? port.projectProfile(folder) : null]);
      if (request !== integrationRequest) return;
      list.replaceChildren(...(entries.length ? entries.map(entry => {
        const scope = entry.scope === 'project' ? t("Project") : t("Personal");
        const row = el('li');
        row.append(el('strong', entry.invalid ? t("Could not read MCP configuration") : entry.name),
          el('small', entry.invalid ? scope : `${scope} · ${entry.enabled ? t("Configured") : t("Disabled")}`));
        return row;
      }) : [el('li', t("No MCP servers configured."))]));
      commands.replaceChildren(...(profile?.actions ?? []).map(action => el('li', action.name)));
    } catch { if (request === integrationRequest) list.replaceChildren(el('li', t("Could not read MCP configuration"))); }
  }
  byId('integrations-refresh').onclick = () => void renderIntegrationCatalog(state.folder);
  const workflows = {
    docs: t("Identify the relevant dependency and version in this project. Find the matching official documentation, cite its links, and explain how it applies to the code here."),
    github: t("Review the current Git changes. Summarize what changed, point out actionable issues with file and line references, and draft a GitHub pull request description. Leave publishing to me."),
    checks: t("Find the project's documented checks. Run the relevant local tests, lint, or type checks and report the commands and results."),
  };
  for (const item of settings.querySelectorAll('[data-workflow]')) item.onclick = () => {
    const output = byId('integration-workflow-status');
    if (!state.folder || document.dispatchEvent(new CustomEvent('freepi:add-context', {
      detail: workflows[item.dataset.workflow], cancelable: true,
    }))) {
      output.textContent = t("Open the composer to use this template.");
      return;
    }
    output.textContent = '';
    window.freepiAppearance.show(false);
    byId('prompt').focus();
  };
  port.onLive(event => {
    if (event.type === 'session') {
      activeSession = event;
      catalog = [];
      updateTrust();
      renderSkills();
    } else if (event.type === 'commands' && event.sessionId === activeSession?.sessionId) {
      catalog = event.commands;
      renderSkills();
    } else if (event.type === 'models' && event.sessionId === activeSession?.sessionId && Array.isArray(event.models)) {
      models = event.models;
      for (const id of Object.keys(modelDefaults)) renderModelOptions(id, modelValue(id), byId(id).value === customModel);
    }
  });
  port.onExit(() => {
    activeSession = undefined;
    catalog = [];
    updateTrust();
    renderSkills();
  });
  byId('desktop-copy-diagnostics').onclick = async () => {
    const text = [`PiLoft ${byId('desktop-app-version').textContent}`, `CLI: ${byId('desktop-cli-version').textContent}`,
      t("Model: {0}", byId('settings-model').textContent), t("Status: {0}", state.execution?.state ?? (state.ready ? 'ready' : 'unavailable')),
      t("Skills in catalog: {0}", catalog.filter(item => item.source === 'skill').length),
      t("Git branch: {0}", byId('project-context')?.textContent.split(' · ')[1] || '—')].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      byId('desktop-diagnostics-status').textContent = t("Diagnostics copied");
    } catch (error) { byId('desktop-diagnostics-status').textContent = errorText(error); }
  };

  function renderProcesses() {
    const container = byId('project-command-runs');
    for (const job of processes) {
      let card = [...container.children].find(node => node.dataset.id === job.id);
      if (!card) {
        card = el('details', undefined, 'command-run');
        card.dataset.id = job.id;
        card.open = true;
        const pre = el('pre');
        pre.tabIndex = 0;
        card.append(el('summary'), button(t("Stop"), () => void port.stopProjectAction(job.id)), pre);
        container.prepend(card);
      }
      const [title, stop, output] = card.children;
      const labels = { running: t("running"), stopping: t("stopping"), done: t("finished"), failed: t("failed"), stopped: t("stopped") };
      title.textContent = `${job.name} · ${labels[job.state]}${Number.isInteger(job.exitCode) ? t(" · exit code {0}", job.exitCode) : ''}`;
      stop.hidden = job.state !== 'running';
      const atBottom = output.scrollHeight - output.scrollTop <= output.clientHeight + 20;
      if (output.textContent !== job.output) output.textContent = job.output;
      if (atBottom) output.scrollTop = output.scrollHeight;
    }
    for (const card of [...container.children]) {
      if (!processes.some(job => job.id === card.dataset.id)) card.remove();
    }
  }

  byId('project-actions').onclick = async () => {
    actionsFolder = state.folder;
    if (!actionsFolder || commandDialog.open) return;
    byId('project-command-status').textContent = '';
    const list = byId('project-command-list');
    list.replaceChildren();
    commandDialog.show();
    commandDialog.querySelector('button').focus({ preventScroll: true });
    try {
      const folder = actionsFolder;
      const profile = await port.projectProfile(folder);
      if (!commandDialog.open || actionsFolder !== folder) return;
      const savedActions = profile.actions ?? [];
      byId('project-actions-heading').textContent = t("Commands · {0}", folder.split(/[\\/]/).at(-1));
      for (const [index, action] of savedActions.entries()) {
        const run = button(action.name, async () => {
          try { await port.runProjectAction(folder, index); }
          catch (error) { byId('project-command-status').textContent = errorText(error); }
        });
        run.title = action.text;
        list.append(run);
      }
      list.append(button(savedActions.length ? t("Manage commands") : t("Add a command"), () => {
        commandDialog.close();
        window.desktopSettingsUI.openProject(folder);
      }));
      processes = await port.projectActions();
      renderProcesses();
    } catch (error) { byId('project-command-status').textContent = errorText(error); }
  };
  port.onProjectActions(items => {
    processes = items;
    if (commandDialog.open) renderProcesses();
  });
  commandDialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      commandDialog.close();
    }
  });
  commandDialog.addEventListener('close', () => {
      if (!settings.open) byId('workspace-menu-toggle').focus({ preventScroll: true });
  });

  document.addEventListener('freepi:state', ({ detail }) => {
    state = detail;
    byId('project-actions').disabled = !detail.folder;
    updateTrust();
    const work = detail.execution;
    if (work?.state !== 'confirmation') lastNotification = '';
    else if (detail.confirmationUnread) {
      const key = chatKey(work.folder, work.sessionId) + '\0' + work.confirmationSequence;
      if (lastNotification !== key) {
        lastNotification = key;
        notice('confirmation', work);
      }
    }
    const current = new Map();
    for (const item of detail.completedChats) {
      const key = chatKey(item.folder, item.sessionId);
      current.set(key, item.sequence);
      if (!item.restored && noticeStates.get(key) !== item.sequence) notice(item.state, item);
    }
    noticeStates = current;
    if (notificationTarget) queueMicrotask(openNotification);
  });
  function notice(kind, item) {
    if (!prefs.notifications[kind]) return;
    const otherChat = !samePath(item.folder, state.folder) || item.sessionId !== state.sessionId;
    void port.notify({ kind, folder: item.folder, sessionId: item.sessionId, otherChat, preview: item.preview }).catch(() => {});
  }
  function openNotification() {
    const target = notificationTarget;
    if (!target) return;
    const same = samePath(target.folder, state.folder) && target.sessionId === state.sessionId;
    if (!same && !switchProject(target.folder, target.sessionId)) return;
    notificationTarget = undefined;
    if (settings.open) window.freepiAppearance.show(false);
    if (target.kind === 'confirmation' && !byId('show-confirmation').hidden) byId('show-confirmation').click();
    else if (same && !state.viewingHistory && byId('terminal-pane').dataset.open === 'true') showChat();
  }
  port.onNotificationClick(target => {
    notificationTarget = target;
    openNotification();
  });
  port.onNotificationError(() => {
    byId('desktop-notification-status').textContent = t("Windows rejected the notification. Check the shortcut and Windows notification settings.");
  });

  window.desktopSettingsUI = {
    get preferences() { return prefs; },
    async readPreferences() {
      void port.desktopVersion().then(version => { byId('desktop-app-version').textContent = version; }).catch(() => {});
      try {
        prefs = await port.readDesktopSettings();
        preferencesLoaded = true;
        syncPreferences();
        updateGeneralStatus();
      } catch (error) {
        updateGeneralStatus('error', errorText(error));
      }
      return prefs;
    },
    openProject(folder) {
      explicitProject = folder;
      window.freepiAppearance.show(true, 'project');
    },
  };
  renderSkills();
})();
