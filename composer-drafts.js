(() => {
  const prompt = document.getElementById('prompt');
  const attachments = window.desktopAttachments;
  const queueButton = document.getElementById('queue-message');
  const queueRow = document.getElementById('composer-queue');
  const queueLabel = document.getElementById('composer-queue-label');
  const queueCancel = document.getElementById('composer-queue-cancel');
  const persistenceStatus = document.getElementById('composer-draft-status');
  const memory = new Map();
  let database;
  let writes = Promise.resolve();
  let identity;
  let loading = false;
  let replacing = false;
  let saveTimer;
  let build = 0;
  let busy = false;
  let working = false;
  let ready = false;
  let blocked = false;
  let queued;
  let restoringUnsaved = true;
  let queueScheduled = false;

  function notify() {
    document.dispatchEvent(new Event('freepi:draft-state'));
  }

  function showPersistenceError() {
    if (!persistenceStatus) return;
    persistenceStatus.textContent = t("Could not save the draft to disk. It is still available in this window.");
    persistenceStatus.hidden = false;
  }

  function getDatabase() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('freepi-composer', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }

  function folderKey(folder) {
    return folder?.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  }

  function keyFor(folder, sessionId) {
    return `${folderKey(folder)}\0${sessionId || 'unsent'}`;
  }

  function snapshot() {
    return { text: prompt.value, files: attachments.draftFiles() };
  }

  function saveEntries(entries) {
    for (const [key, value] of entries) memory.set(key, value);
    const write = writes.then(async () => {
      const db = await getDatabase();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('drafts', 'readwrite');
        const store = transaction.objectStore('drafts');
        for (const [key, value] of entries) {
          if (value && (value.text || value.files.length)) store.put(value, key);
          else store.delete(key);
        }
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
      if (persistenceStatus) persistenceStatus.hidden = true;
    });
    writes = write.catch(showPersistenceError);
    return writes;
  }

  function flush() {
    clearTimeout(saveTimer);
    if (!identity?.folder || loading || replacing) return writes;
    const data = snapshot();
    return saveEntries([[identity.key, data],
      ...(identity.provisional && identity.id ? [[keyFor(identity.folder), data]] : [])]);
  }

  async function read(key) {
    await writes;
    if (memory.has(key)) return memory.get(key);
    try {
      const db = await getDatabase();
      return await new Promise((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch {
      showPersistenceError();
    }
  }

  function apply(draft) {
    replacing = true;
    prompt.value = typeof draft?.text === 'string' ? draft.text : '';
    attachments.restoreDraft(draft?.files);
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    replacing = false;
  }

  function canQueue() {
    return busy && !blocked && !loading && !queued && Boolean(identity?.id)
      && !/^\s*[!\/]/u.test(prompt.value) && (Boolean(prompt.value.trim()) || attachments.hasFiles);
  }

  function renderQueue() {
    queueButton.hidden = !busy || Boolean(queued);
    queueButton.disabled = !canQueue();
    queueRow.hidden = !queued;
    if (queued) {
      const label = blocked ? t("Queued · FreePi needs confirmation") : t("Queued · sends after the reply");
      if (queueLabel.textContent !== label) queueLabel.textContent = label;
    } else if (queueLabel.textContent) queueLabel.textContent = '';
    prompt.readOnly = loading || Boolean(queued);
    attachments.setDraftLocked(prompt.readOnly);
  }

  function cancelQueue(announce = true) {
    if (!queued) return;
    queued = undefined;
    renderQueue();
    if (announce) notify();
  }

  queueButton.onclick = () => {
    if (!canQueue()) return;
    queued = { key: identity.key, text: prompt.value, revision: attachments.revision, observedRun: working };
    renderQueue();
    notify();
    queueCancel.focus();
  };
  queueCancel.onclick = () => {
    cancelQueue();
    prompt.focus();
  };

  async function start(folder, savedSession, { restoreUnsaved = false } = {}) {
    void flush();
    cancelQueue(false);
    const revision = ++build;
    restoringUnsaved = restoreUnsaved;
    identity = folder ? { folder, id: savedSession, key: keyFor(folder, savedSession), provisional: !savedSession } : undefined;
    loading = Boolean(savedSession || restoreUnsaved);
    apply();
    renderQueue();
    notify();
    if (!folder || !loading) return;
    const data = await read(identity.key);
    if (revision !== build) return;
    apply(data);
    loading = false;
    renderQueue();
    notify();
  }

  async function bind(folder, id) {
    if (!folder || !id) return;
    if (identity?.key === keyFor(folder, id)) return;
    if (identity?.id) {
      await start(folder, id);
      return;
    }
    const previous = identity;
    if (!previous || folderKey(previous.folder) !== folderKey(folder)) {
      const restore = restoringUnsaved;
      void flush();
      const revision = ++build;
      identity = { folder, id, key: keyFor(folder, id), provisional: true };
      loading = restore;
      renderQueue();
      notify();
      if (restore) {
        const data = await read(keyFor(folder));
        if (revision !== build) return;
        apply(data);
        loading = false;
        renderQueue();
        notify();
      }
      return;
    }
    const revision = ++build;
    const established = { folder, id, key: keyFor(folder, id), provisional: true };
    identity = established;
    if (!loading) {
      void flush();
      return;
    }
    const data = await read(previous.key);
    if (revision !== build) return;
    apply(data);
    loading = false;
    renderQueue();
    notify();
  }

  function inputChanged() {
    if (replacing || loading) return;
    clearTimeout(saveTimer);
    if (identity) saveTimer = setTimeout(() => void flush(), 150);
    renderQueue();
  }
  prompt.addEventListener('input', inputChanged);
  document.addEventListener('freepi:attachments', inputChanged);

  window.desktopDrafts = {
    get saving() { return loading; },
    get queued() { return Boolean(queued); },
    start,
    bind,
    flush,
    cancelQueue,
    onSettled(aborted) {
      if (!queued) return;
      if (aborted) cancelQueue();
      else queued.observedRun = true;
    },
    noteSent({ established = true } = {}) {
      if (established && identity?.provisional) {
        const alias = keyFor(identity.folder);
        identity.provisional = false;
        if (identity.key !== alias) void saveEntries([[alias, undefined]]);
      }
      void flush();
    },
    tick(state, sendPrompt) {
      busy = state.busy;
      working = state.working ?? busy;
      blocked = state.blocked;
      ready = state.ready;
      renderQueue();
      if (!queued) return;
      if (working) queued.observedRun = true;
      if (!queued.observedRun || !ready || blocked || queueScheduled) return;
      queueScheduled = true;
      const job = queued;
      queueMicrotask(() => {
        queueScheduled = false;
        if (job !== queued || job.key !== identity?.key || !ready || busy || blocked) return;
        if (job.text !== prompt.value || job.revision !== attachments.revision) {
          cancelQueue();
          return;
        }
        cancelQueue();
        void sendPrompt();
      });
    },
  };
})();
