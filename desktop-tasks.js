(() => {
  const port = window.desktop;
  const byId = id => document.getElementById(id);
  const settings = byId('settings-panel');
  const status = byId('desktop-task-status');
  const prompt = byId('prompt');
  const enqueue = byId('queue-other-chat');
  let tasks = { queue: [], schedules: [], runs: [] };
  let view = {};
  let current;
  let processing = false;
  let updating = Promise.resolve();

  const cleanError = error => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': Error: /, '');
  const nameOf = folder => folder.split(/[\\/]/).at(-1) || folder;
  const formatDate = time => new Date(time).toLocaleString(document.documentElement.lang, { dateStyle: 'short', timeStyle: 'short' });
  const stateName = { waiting: t("Queued"), running: t("Running"), done: t("Done"), failed: t("Error"), interrupted: t("Interrupted") };
  const recurrence = { once: t("Once"), daily: t("Daily"), weekly: t("Weekly") };

  function create(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, handler) {
    const node = create('button', text);
    node.type = 'button';
    node.onclick = handler;
    return node;
  }

  function row(label, detail, ...actions) {
    const node = create('div');
    node.className = 'settings-row';
    const copy = create('span');
    copy.className = 'settings-row-copy';
    copy.append(create('strong', label), create('small', detail));
    node.append(copy, ...actions);
    return node;
  }

  function edit(job) {
    const previous = byId('desktop-queue-list').querySelector('textarea');
    if (previous) { previous.focus(); return; }
    const form = create('form');
    form.className = 'settings-row desktop-stacked';
    const input = create('textarea');
    input.value = job.prompt;
    input.setAttribute('aria-label', t("Edit queued request"));
    input.rows = 3;
    input.maxLength = 32000;
    input.required = true;
    const save = create('button', t("Save request"));
    save.type = 'submit';
    form.append(input, save, button(t("Cancel action"), () => form.remove()));
    form.onsubmit = async event => {
      event.preventDefault();
      if (await operation('edit', { id: job.id, prompt: input.value })) {
        form.remove();
        render();
      }
    };
    byId('desktop-queue-list').append(form);
    input.focus();
  }

  function render() {
    const queue = byId('desktop-queue-list');
    if (!queue.querySelector('textarea')) queue.replaceChildren(...(tasks.queue.length ? tasks.queue.map(job => {
      const title = job.name || job.prompt.replace(/\s+/g, ' ').slice(0, 95);
      const actions = job.status === 'waiting' ? [
        button(t("Edit"), () => edit(job)), button(t("Remove"), () => void operation('remove', { id: job.id })),
      ] : [];
      return row(title, `${nameOf(job.folder)} · ${stateName[job.status]}`, ...actions);
    }) : [row(t("Queue is empty"), '')]));
    byId('desktop-schedule-list').replaceChildren(...(tasks.schedules.length ? tasks.schedules.map(item => row(item.name,
      `${nameOf(item.folder)} · ${recurrence[item.repeat]} · ${item.completed ? t("Dispatched on schedule") : item.enabled ? formatDate(item.nextAt) : t("Paused")}`,
      ...(item.completed ? [] : [button(item.enabled ? t("Pause") : t("Enable"), () => void operation('toggle-schedule', { id: item.id }))]),
      button(t("Delete"), () => void operation('remove-schedule', { id: item.id })))) : [row(t("No schedules yet"), '')]));
    byId('desktop-runs').replaceChildren(...(tasks.runs.length ? tasks.runs.slice(0, 30).map(run => row(run.name || nameOf(run.folder),
      [stateName[run.status], formatDate(run.endedAt), run.message].filter(Boolean).join(' · '),
      ...(run.sessionId ? [button(t("Open chat"), () => {
        if (switchProject(run.folder, run.sessionId)) window.freepiAppearance.show(false);
        else status.textContent = t("Wait for free-pi to become ready.");
      })] : []))) : [row(t("No runs yet"), '')]));
    const label = tasks.queue.length ? t("Tasks · {0}", tasks.queue.length) : t("Tasks");
    if (byId('desktop-task-list').lastElementChild.textContent !== label) byId('desktop-task-list').lastElementChild.textContent = label;
    byId('workspace-task-indicator').hidden = !tasks.queue.length;
    const workspaceMenu = byId('workspace-menu-toggle');
    const menuLabel = tasks.queue.length ? t("Project actions, {0} queued tasks", tasks.queue.length) : t("Project actions");
    workspaceMenu.setAttribute('aria-label', menuLabel);
    workspaceMenu.title = menuLabel;
  }

  function operation(action, input) {
    const run = updating.then(async () => {
      try {
        const result = await port.tasks(action, input);
        const next = result.state ?? result;
        if (JSON.stringify(next) !== JSON.stringify(tasks)) {
          tasks = next;
          render();
        }
        return result;
      } catch (error) {
        status.textContent = cleanError(error);
        return null;
      }
    });
    updating = run.catch(() => {});
    return run;
  }

  async function update() {
    if (document.querySelector('dialog[open]:modal') || processing || !view.taskReady || ['sent', 'finishing'].includes(current?.phase)) return;
    const candidate = current?.job ?? tasks.queue.find(job => job.status === 'waiting'
      && (!job.scheduleId || window.desktopSettingsUI?.preferences.experimentalSchedules));
    if (!candidate) return;
    processing = true;
    try {
      if (!current) {
        const claim = await operation('claim', { id: candidate.id });
        if (!claim?.ok) return;
        current = { job: candidate, phase: 'ready' };
      }
      if (!view.taskReady || document.querySelector('dialog[open]:modal')) return;
      const switched = current.phase === 'switching';
      current.phase = 'dispatch';
      const result = await window.runDesktopTask(current.job, switched);
      if (!current) return;
      if (result === 'switching') current.phase = 'switching';
      else if (result === 'wait') current.phase = switched ? 'switching' : 'ready';
      else if (result === true) {
        current.phase = 'sent';
        current.sentAt = Date.now();
        current.sessionId ??= view.sessionId;
      } else await finish('failed', t("The CLI could not open the chat or send the request."));
    } catch (error) {
      await finish('failed', cleanError(error));
    } finally { processing = false; }
  }

  async function finish(result, message) {
    const active = current;
    if (!active || active.phase === 'finishing') return;
    active.phase = 'finishing';
    const saved = await operation('finish', { id: active.job.id, status: result, message, sessionId: active.sessionId });
    if (saved && current === active) current = undefined;
    else if (current === active) active.phase = 'sent';
  }

  function composerState() {
    const available = view.folder && (view.viewingHistory || view.busy || view.execution?.state === 'confirmation');
    const text = prompt.value.trim();
    enqueue.hidden = !available || (!view.viewingHistory && byId('queue-message').hidden === false) || window.desktopDrafts.queued;
    enqueue.disabled = !text || /^[!/]/.test(text) || window.desktopAttachments.hasFiles || window.desktopDrafts.saving || window.desktopDrafts.queued;
    enqueue.title = window.desktopAttachments.hasFiles ? t("Remove attachments before queuing this request") : t("Add request to the queue");
  }
  enqueue.onclick = async () => {
    if (enqueue.disabled) return;
    const original = prompt.value;
    const target = { folder: view.folder, sessionId: view.sessionId ?? undefined, prompt: original };
    enqueue.disabled = true;
    if (await operation('enqueue', target) && view.folder === target.folder
      && (view.sessionId ?? undefined) === target.sessionId && prompt.value === original) {
      prompt.value = '';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }
    composerState();
    void update();
  };
  prompt.addEventListener('input', composerState);
  document.addEventListener('freepi:attachments', composerState);
  document.addEventListener('freepi:draft-state', composerState);
  document.addEventListener('freepi:state', ({ detail }) => {
    view = detail;
    queueMicrotask(composerState);
    if (current && current.phase === 'sent' && detail.execution?.state === 'working') {
      current.sessionId = detail.execution.sessionId;
      current.started = true;
    }
  });
  port.onLive(event => {
    if (!current || !['dispatch', 'sent'].includes(current.phase)) return;
    if (event.type === 'started') {
      current.sessionId = event.sessionId;
      current.started = true;
    } else if (event.type === 'settled' && current.started && current.sessionId === event.sessionId) {
      const settled = current;
      setTimeout(() => {
        if (current !== settled) return;
        const failed = event.aborted || (event.failed ?? view.execution?.state === 'failed');
        void finish(failed ? 'failed' : 'done', failed ? t("The request was interrupted or the CLI reported an error.") : '');
      }, 150);
    }
  });
  port.onExit(code => {
    if (current?.phase === 'sent') void finish('failed', t("The CLI exited with code {0}.", code));
  });

  async function projects() {
    const list = await port.listProjects();
    const selected = byId('schedule-folder').value || view.folder;
    byId('schedule-folder').replaceChildren(...list.filter(item => item.available !== false)
      .map(item => new Option(item.name, item.folder, false, item.folder === selected)));
  }
  byId('desktop-task-list').onclick = () => window.freepiAppearance.show(true, 'tasks');
  settings.addEventListener('close', () => void update());
  document.addEventListener('freepi:settings-page', ({ detail }) => {
    if (detail === 'tasks') {
      render();
      void projects().catch(error => { status.textContent = cleanError(error); });
    }
  });
  byId('desktop-schedule-form').onsubmit = async event => {
    event.preventDefault();
    const nextAt = new Date(byId('schedule-at').value).getTime();
    const result = await operation('schedule', { name: byId('schedule-name').value, folder: byId('schedule-folder').value,
      nextAt, repeat: byId('schedule-repeat').value, prompt: byId('schedule-prompt').value });
    if (result) {
      event.target.reset();
      byId('schedule-editor').open = false;
      byId('schedule-editor').querySelector('summary').focus();
      status.textContent = t("Schedule added.");
    }
  };
  void operation('list');
  let clock = 0;
  setInterval(() => {
    if (++clock % 5 === 0) void operation('tick');
    if (current?.phase === 'sent' && view.taskReady && Date.now() - current.sentAt > 10000) {
      void finish('failed', t("The CLI did not confirm completion. Check the chat before trying again."));
    } else void update();
  }, 1000);
})();
