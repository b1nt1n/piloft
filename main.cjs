const { t, setLanguage } = require('./locale.js');
const { app, BrowserWindow, dialog, ipcMain, Notification, screen, session, shell } = require('electron');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { createReadStream, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');
const { mkdir, readdir, rmdir, stat } = require('node:fs/promises');
const { homedir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const pty = require('node-pty');
const { createTranscript, readSavedTranscript } = require('./transcript.cjs');
const { openLiveChannel } = require('./live-channel.cjs');
const { createHistory } = require('./history.cjs');
const { createChanges, workingChanges, projectBranch } = require('./changes.cjs');
const { createDiffHistory } = require('./diff-history.cjs');
const { findProjectFiles } = require('./project-files.cjs');
const { previewProjectFile, openProjectEditor } = require('./project-preview.cjs');
const { createAttachments } = require('./attachments.cjs');
const { createProjectCommands } = require('./desktop-tools.cjs');
const { createJobs } = require('./desktop-jobs.cjs');

const productName = 'free-pi-cli Desktop';
const testedCli = '0.6.21';
if (!app.commandLine.hasSwitch('user-data-dir')
  && (app.isPackaged || path.basename(app.getPath('userData')) === productName)) {
  app.setPath('userData', path.join(app.getPath('appData'), 'free-pi-desktop'));
}
const agentDir = path.join(homedir(), '.free-pi', 'agent');
const sessionsRoot = path.join(agentDir, 'sessions');
const sessionIdPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const modelPattern = /^[a-z0-9][a-z0-9_.:/-]*$/i;
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const notificationAppId = 'FreePi.Desktop';
const windowIconPath = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'assets', 'freepi-icon.ico');
const notificationActivator = '{36EC765C-4694-490D-95C3-49094961F90F}';
let window;
let previewWindow;
const execGit = promisify(execFile);
let cli;
let cliFolder;
let historyFolder;
let transcriptFolder;
let historyRequest = 0;
let historySelected = false;
let liveChannel;
let launching = false;
let closing = false;
const notifications = new Set();
const commands = createProjectCommands(value => send('actions:changed', value));
const jobs = createJobs({ read: readWorkspace, save: saveWorkspace, validFolder: isFolder,
  schedulesEnabled: () => desktopSettings().experimentalSchedules,
  validSession: value => typeof value === 'string' && sessionIdPattern.test(value) });
const changes = createChanges();
const attachments = createAttachments();
const diffHistory = createDiffHistory({ directory: () => path.join(app.getPath('userData'), 'diff-history') });
const history = createHistory({
  metadataDir: () => path.join(app.getPath('userData'), 'session-history'),
  sessionDirectory,
});

function workspaceFile() {
  return path.join(app.getPath('userData'), 'workspace.json');
}

function readWorkspace() {
  try {
    const saved = JSON.parse(readFileSync(workspaceFile(), 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

function saveWorkspace(patch) {
  try {
    const file = workspaceFile();
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...readWorkspace(), ...patch }));
    renameSync(temporary, file);
    return true;
  } catch (error) {
    console.warn('Could not save free-pi workspace:', error.message);
    return false;
  }
}

function initialWindow() {
  const { bounds } = readWorkspace();
  if (bounds && ['x', 'y', 'width', 'height'].every(key => Number.isInteger(bounds[key]))
    && bounds.width >= 710 && bounds.height >= 650
    && screen.getAllDisplays().some(({ workArea }) =>
      bounds.x < workArea.x + workArea.width - 48 && bounds.x + bounds.width > workArea.x + 48
      && bounds.y >= workArea.y - 8 && bounds.y < workArea.y + workArea.height - 48)) {
    const { x, y, width, height } = bounds;
    return { x, y, width, height };
  }
  return { width: 1280, height: 840 };
}

function saveWindowBounds() {
  if (window && !window.isDestroyed()) {
    saveWorkspace({ bounds: window.getNormalBounds(), maximized: window.isMaximized() });
  }
}

function folderKey(folder) {
  return path.resolve(folder).toLowerCase();
}

function sameFolder(left, right) {
  return folderKey(left) === folderKey(right);
}

function isFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return false;
  try {
    return statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

function desktopSettings() {
  return {
    editor: 'notepad', actionShell: 'powershell', restoreChat: true, confirmClose: false, model: '', thinking: '',
    cliChannel: 'stable', experimentalSchedules: false,
    language: 'en', onboardingComplete: false, initialPrompt: '',
    notifications: { done: true, confirmation: true, failed: true },
    ...readWorkspace().desktopSettings,
  };
}

function projectProfile(folder) {
  return readWorkspace().projectProfiles?.[folderKey(folder)] ?? {};
}

function modelPreferences(input) {
  const model = typeof input?.model === 'string' ? input.model.trim() : '';
  const thinking = input?.thinking || '';
  if (model.length > 130 || (model && !modelPattern.test(model)) || (thinking && !thinkingLevels.includes(thinking))) {
    throw new Error(t("Check the model ID and reasoning level."));
  }
  return { model, thinking };
}

ipcMain.handle('settings:read', () => desktopSettings());
ipcMain.handle('desktop:version', () => app.getVersion());
ipcMain.handle('settings:save', (_event, input) => {
  const startFolder = input?.startFolder;
  if (startFolder && startFolder !== desktopSettings().startFolder && !isFolder(startFolder)) {
    throw new Error(t("Startup folder unavailable."));
  }
  const settings = {
    ...modelPreferences(input),
    editor: input?.editor === 'default' ? 'default' : 'notepad',
    actionShell: input?.actionShell === 'cmd' ? 'cmd' : 'powershell',
    startFolder: startFolder ? path.resolve(startFolder) : undefined,
    restoreChat: input?.restoreChat !== false,
    confirmClose: input?.confirmClose === true,
    cliChannel: input?.cliChannel === 'latest' ? 'latest' : 'stable',
    experimentalSchedules: input?.experimentalSchedules === true,
    initialPrompt: typeof input?.initialPrompt === 'string' ? input.initialPrompt.replace(/\r\n?/g, '\n').trim().slice(0, 8000) : '',
    language: input?.language === 'ru' ? 'ru' : 'en',
    onboardingComplete: desktopSettings().onboardingComplete,
    notifications: Object.fromEntries(['done', 'confirmation', 'failed'].map(key => [key, input?.notifications?.[key] === true])),
  };
  if (!saveWorkspace({ desktopSettings: settings })) throw new Error(t("Could not save settings."));
  setLanguage(settings.language);
  return settings;
});

ipcMain.handle('settings:finish-onboarding', (_event, language) => {
  const settings = { ...desktopSettings(), language: language === 'ru' ? 'ru' : 'en', onboardingComplete: true };
  if (!saveWorkspace({ desktopSettings: settings })) throw new Error(t("Could not save settings."));
  setLanguage(settings.language);
  return settings;
});

ipcMain.handle('project:profile', async (_event, folder) => {
  if (!isFolder(folder)) throw new Error(t("Project folder unavailable."));
  const instructions = path.join(folder, 'AGENTS.md');
  const exists = (await stat(instructions).catch(() => null))?.isFile();
  return { ...projectProfile(folder), branch: await projectBranch(folder), instructions: exists ? 'AGENTS.md' : '' };
});

ipcMain.handle('project:save-profile', (_event, folder, input) => {
  if (!isFolder(folder)) throw new Error(t("Project folder unavailable."));
  const preferences = modelPreferences(input);
  const actions = Array.isArray(input?.actions) && input.actions.length <= 20 ? input.actions : [];
  if (actions.some(item => typeof item?.name !== 'string' || !item.name.trim() || item.name.length > 70
    || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4000 || item.text.includes('\0'))) {
    throw new Error(t("Each command needs a name and command text."));
  }
  const profile = { ...preferences, actions: actions.map(({ name, text }) => ({ name: name.trim(), text })) };
  if (!saveWorkspace({ projectProfiles: { ...readWorkspace().projectProfiles, [folderKey(folder)]: profile } })) {
    throw new Error(t("Could not save project settings."));
  }
  return profile;
});

ipcMain.handle('actions:list', () => commands.list());
ipcMain.handle('actions:run', (_event, folder, index) => {
  if (!isFolder(folder) || !Number.isInteger(index)) throw new Error(t("The folder or command is unavailable."));
  return commands.run(folder, projectProfile(folder).actions?.[index], desktopSettings().actionShell);
});
ipcMain.handle('actions:stop', (_event, id) => commands.stop(id));
ipcMain.handle('tasks:update', (_event, action, input) => jobs.update(action, input));

ipcMain.handle('desktop:notification-shortcut', () => {
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const link = path.join(programs, 'FreePi Desktop.lnk');
  const icon = windowIconPath;
  if (!shell.writeShortcutLink(link, { target: process.execPath, args: app.isPackaged ? '' : `"${__dirname}"`,
    cwd: app.isPackaged ? path.dirname(process.execPath) : __dirname, description: productName, icon, iconIndex: 0, appUserModelId: notificationAppId,
    toastActivatorClsid: notificationActivator })) throw new Error(t("Could not create the Start menu shortcut."));
});

ipcMain.handle('desktop:notify', (_event, { kind, folder, sessionId, otherChat } = {}) => {
  const titles = { done: t("Reply ready"), failed: t("Request interrupted or failed"), confirmation: t("Confirmation needed") };
  if (!Object.hasOwn(titles, kind) || !desktopSettings().notifications?.[kind] || !Notification.isSupported()
    || !isFolder(folder) || typeof sessionId !== 'string' || !sessionIdPattern.test(sessionId)
    || (window?.isFocused() && otherChat !== true)) return;
  const notification = new Notification({ title: titles[kind], body: path.basename(folder), silent: false,
    icon: windowIconPath });
  notifications.add(notification);
  const forget = () => notifications.delete(notification);
  notification.once('close', forget);
  notification.once('failed', (_event, error) => {
    forget();
    send('desktop:notification-error', error || t("Windows rejected the notification."));
  });
  notification.once('click', () => {
    forget();
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
    send('desktop:notification-click', { folder, sessionId, kind });
  });
  notification.show();
});

function recentProjectsPath() {
  return path.join(app.getPath('userData'), 'recent-projects.json');
}

function readRecentFolders() {
  try {
    const saved = JSON.parse(readFileSync(recentProjectsPath(), 'utf8'));
    return Array.isArray(saved) ? saved.filter(folder => typeof folder === 'string' && path.isAbsolute(folder)) : [];
  } catch {
    return [];
  }
}

function readPinnedProjects() {
  const { pinnedProjects } = readWorkspace();
  return Array.isArray(pinnedProjects)
    ? pinnedProjects.filter(folder => typeof folder === 'string' && path.isAbsolute(folder))
    : [];
}

function readRegisteredProjects() {
  const { projects } = readWorkspace();
  return Array.isArray(projects) ? projects.filter(project => typeof project?.folder === 'string'
    && path.isAbsolute(project.folder) && typeof project.name === 'string' && project.name.trim()) : [];
}

function readHiddenProjects() {
  const { hiddenProjects } = readWorkspace();
  return Array.isArray(hiddenProjects) ? hiddenProjects.filter(folder => typeof folder === 'string' && path.isAbsolute(folder)) : [];
}

function projectName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 120 ? name : undefined;
}

function rememberFolder(folder) {
  const folders = [folder, ...readRecentFolders().filter(previous => !sameFolder(previous, folder))];
  try {
    writeFileSync(recentProjectsPath(), JSON.stringify(folders.slice(0, 20)));
  } catch (error) {
    console.warn('Could not save recent free-pi projects:', error.message);
  }
}

function sessionDirectory(folder) {
  // Same working-directory encoding as free-pi 0.6.20.
  const key = path.resolve(folder).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return path.join(sessionsRoot, `--${key}--`);
}

async function readSession(file, folder, onlyId, headerOnly = false) {
  const stream = createReadStream(file, {
    encoding: 'utf8',
    ...(headerOnly ? { highWaterMark: 2048, end: 128 * 1024 - 1 } : {}),
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let id;
    let title;
    let firstMessage;
    for await (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!id) {
        if (entry?.type !== 'session' || typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd)
          || (folder ? !sameFolder(entry.cwd, folder) : !sameFolder(sessionDirectory(entry.cwd), path.dirname(file)))
          || typeof entry.id !== 'string' || !sessionIdPattern.test(entry.id)) return;
        id = entry.id;
        folder = entry.cwd;
        if (headerOnly) return { folder, id, file };
        if (onlyId) return id === onlyId ? { id } : undefined;
      } else if (entry?.type === 'session_info') {
        title = typeof entry.name === 'string' ? entry.name : undefined;
      } else if (!firstMessage && entry?.type === 'message' && entry.message?.role === 'user') {
        const content = entry.message.content;
        firstMessage = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter(block => block?.type === 'text' && typeof block.text === 'string')
            .map(block => block.text).join(' ')
          : undefined;
      }
    }
    if (!id) return;
    const displayName = title?.trim() || firstMessage?.trim() || t("Untitled");
    return { id, folder, title: displayName.replace(/\s+/g, ' ').slice(0, 160), modified: (await stat(file)).mtime.toISOString() };
  } catch {
    // A session can disappear or become unreadable while the list is open.
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function readSessions(directory, folder, onlyId, headerOnly = false) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'));
  const sessions = [];
  for (let offset = 0; offset < files.length; offset += 8) {
    const batch = await Promise.all(files.slice(offset, offset + 8)
      .map(entry => readSession(path.join(directory, entry.name), folder, onlyId, headerOnly)));
    sessions.push(...batch.filter(Boolean));
    if (onlyId && sessions.length) break;
  }
  return onlyId || headerOnly ? sessions : sessions.sort((left, right) => right.modified.localeCompare(left.modified));
}

async function sessionDirectories() {
  const entries = await readdir(sessionsRoot, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter(entry => entry.isDirectory() && entry.name.startsWith('--') && entry.name.endsWith('--'))
    .map(entry => path.join(sessionsRoot, entry.name));
}

function findSessions(folder, onlyId) {
  return readSessions(sessionDirectory(folder), folder, onlyId);
}

ipcMain.handle('workspace:restore', async () => {
  const saved = readWorkspace();
  const preferences = desktopSettings();
  const homeFolder = isFolder(preferences.startFolder) ? preferences.startFolder : undefined;
  if (!preferences.restoreChat || typeof saved.folder !== 'string' || !path.isAbsolute(saved.folder)) return { folder: homeFolder };
  const available = isFolder(saved.folder);
  if (!available && homeFolder) return { folder: homeFolder };
  const sessionId = typeof saved.sessionId === 'string' && sessionIdPattern.test(saved.sessionId)
    && (await findSessions(saved.folder, saved.sessionId)).length ? saved.sessionId : undefined;
  return available ? { folder: saved.folder, sessionId } : { unavailableFolder: saved.folder, sessionId };
});

ipcMain.handle('changes:begin', () => cliFolder ? changes.begin(cliFolder) : null);
ipcMain.handle('changes:finish', (_event, token) => changes.finish(token));
ipcMain.handle('changes:save-turn', (_event, scope) => diffHistory.save(scope));
ipcMain.handle('changes:list-turns', (_event, scope) => diffHistory.list(scope));
ipcMain.handle('changes:read-turn', (_event, scope) => diffHistory.read(scope));
ipcMain.handle('changes:working', () => workingChanges(historySelected ? historyFolder : cliFolder));
ipcMain.handle('project:branch', () => projectBranch(historySelected ? historyFolder : cliFolder));

ipcMain.handle('project:worktree', async (_event, folder, base) => {
  if (!isFolder(folder) || typeof base !== 'string' || !base || base.length > 180 || /[\x00-\x20]/u.test(base)) {
    return { error: t("Enter a Git branch name or commit.") };
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const options = { cwd: folder, env, windowsHide: true, timeout: 60_000 };
  let revision;
  try {
    const root = await execGit('git', ['rev-parse', '--show-toplevel'], options);
    if (!sameFolder(root.stdout.trim(), folder)) return { error: t("Open the repository root to create a worktree.") };
    revision = (await execGit('git', ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], options)).stdout.trim();
  } catch {
    return { error: t("Git could not find that branch or commit in this project.") };
  }
  const root = path.join(app.getPath('userData'), 'worktrees');
  const name = `${path.basename(folder)} · Worktree ${randomUUID().slice(0, 8)}`;
  const target = path.join(root, randomUUID());
  try {
    await mkdir(root, { recursive: true });
    await execGit('git', ['-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), 'worktree', 'add', '--detach', '--', target, revision], options);
    if (!saveWorkspace({ projects: [{ folder: target, name }, ...readRegisteredProjects()] })) {
      await execGit('git', ['worktree', 'remove', '--', target], options);
      return { error: t("Could not save the project.") };
    }
    return { folder: target };
  } catch { return { error: t("Could not create a Git worktree.") }; }
});

function localPreviewUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password) return url.href;
  } catch {}
}

ipcMain.handle('preview:open', async (_event, value) => {
  const url = localPreviewUrl(value);
  if (!url) return false;
  if (!previewWindow || previewWindow.isDestroyed()) {
    const previewSession = session.fromPartition('freepi-local-preview');
    previewSession.setPermissionRequestHandler((_webContents, _permission, respond) => respond(false));
    previewSession.setPermissionCheckHandler(() => false);
    previewWindow = new BrowserWindow({ parent: window, show: false, width: 1060, height: 760, title: t("Local preview"),
      autoHideMenuBar: true, icon: windowIconPath, webPreferences: { sandbox: true, session: previewSession } });
    previewWindow.removeMenu();
    previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-redirect']) previewWindow.webContents.on(name, (event, target) => {
      if (!localPreviewUrl(target)) event.preventDefault();
    });
  }
  await previewWindow.loadURL(url);
  previewWindow.show();
  return true;
});

ipcMain.handle('preview:capture', async () => {
  if (!previewWindow || previewWindow.isDestroyed() || !localPreviewUrl(previewWindow.webContents.getURL())) return null;
  const image = await previewWindow.webContents.capturePage();
  return image.isEmpty() ? null : image.resize({ width: Math.min(image.getSize().width, 1440) }).toPNG().toString('base64');
});

ipcMain.handle('project:integrations', async (_event, folder) => {
  const entries = new Map();
  const configFiles = [['personal', path.join(agentDir, 'mcp.json')]];
  if (isFolder(folder)) configFiles.push(['project', path.join(folder, '.pi', 'mcp.json')]);
  for (const [scope, file] of configFiles) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      for (const [name, config] of Object.entries(data.mcpServers ?? {})) {
        if (config && typeof config === 'object') entries.set(`${scope}:${name}`, { name, scope, enabled: config.enabled !== false });
      }
    } catch (error) { if (error.code !== 'ENOENT') entries.set(`${scope}:error`, { scope, invalid: true }); }
  }
  return [...entries.values()];
});

function send(channel, value) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(channel, value);
  }
}

const transcript = createTranscript({
  root: sessionsRoot,
  directoryFor: sessionDirectory,
  publish: value => {
    transcriptFolder = value.folder;
    if (value.folder) {
      cliFolder = value.folder;
      const saved = readWorkspace();
      if (saved.folder !== value.folder || saved.sessionId !== value.sessionId) {
        saveWorkspace({ folder: value.folder, sessionId: value.sessionId });
      }
    }
    send('session:transcript', value);
  },
});

function size(value, max) {
  return Number.isInteger(value) ? Math.max(2, Math.min(max, value)) : 80;
}

async function startCli({ folder, cols, rows, sessionId }) {
  if (!isFolder(folder)) throw new Error(t("Folder unavailable: {0}", folder));
  folder = path.resolve(folder);
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionIdPattern.test(sessionId)
    || !(await findSessions(folder, sessionId)).length)) {
    throw new Error(t("The session was not found in the selected folder."));
  }
  let child;
  let currentSession;
  let observer;
  try {
    observer = await openLiveChannel(agentDir, event => {
      if (!child || cli !== child || liveChannel !== observer || !sessionIdPattern.test(event.sessionId)) return;
      if (event.type === 'session') {
        if (typeof event.folder !== 'string' || !path.isAbsolute(event.folder)) return;
        currentSession = event.sessionId;
        cliFolder = path.resolve(event.folder);
        saveWorkspace({ folder: cliFolder, sessionId: currentSession });
        transcript.bind(currentSession, cliFolder);
        send('session:live', { type: 'session', sessionId: currentSession, folder: cliFolder, trust: event.trust, model: event.model, thinking: event.thinking, preferenceError: event.preferenceError });
      } else if (event.sessionId === currentSession && ['started', 'user', 'assistant', 'tool', 'settled', 'commands', 'model', 'models', 'confirmation', 'context', 'context-content', 'compaction'].includes(event.type)) {
        send('session:live', event);
      }
    });
  } catch (error) {
    console.warn('Could not start the free-pi live observer:', error.message);
  }
  if (!window || window.isDestroyed()) {
    observer?.close();
    throw new Error(t("The free-pi window is closed."));
  }
  const sessionArgs = sessionId === undefined ? ['--new'] : ['--session', sessionId];
  const profile = projectProfile(folder);
  const preferences = desktopSettings();
  const cliPackage = `free-pi-cli@${preferences.cliChannel === 'latest' ? 'latest' : testedCli}`;
  const bundledNode = app.isPackaged ? path.join(process.resourcesPath, 'node-runtime') : undefined;
  const executable = bundledNode ? path.join(bundledNode, 'node.exe') : process.env.ComSpec || 'cmd.exe';
  const args = bundledNode ? [path.join(bundledNode, 'node_modules', 'npm', 'bin', 'npx-cli.js'), '--yes',
    cliPackage, ...sessionArgs] : ['/d', '/v:off', '/c', ['npx.cmd', '--yes', cliPackage, ...sessionArgs].join(' ')];
  const env = { ...process.env, PI_PROGRAM_STATUS: '1', ...observer?.env,
    FREEPI_DESKTOP_WORKSPACE: workspaceFile(),
    FREEPI_DESKTOP_PROFILE: JSON.stringify({ model: profile.model || preferences.model, thinking: profile.thinking || preferences.thinking,
      newSession: sessionId === undefined }) };
  if (bundledNode) {
    const key = Object.keys(env).find(name => name.toLowerCase() === 'path') || 'Path';
    env[key] = [bundledNode, env[key]].filter(Boolean).join(path.delimiter);
  }
  try {
    child = pty.spawn(executable, args, {
      cwd: folder,
      cols: size(cols, 500),
      rows: size(rows, 300),
      env,
      name: 'xterm-256color',
    });
  } catch (error) {
    observer?.close();
    throw error;
  }
  cli = child;
  liveChannel = observer;
  cliFolder = folder;
  saveWorkspace({ folder, sessionId: sessionId ?? null });
  transcript.bind(sessionId, folder);
  rememberFolder(folder);
  child.onData(data => send('cli:data', data));
  child.onExit(({ exitCode }) => {
    if (cli !== child) return;
    cli = undefined;
    cliFolder = undefined;
    liveChannel?.close();
    liveChannel = undefined;
    // Keep the rendered history available after an ordinary process exit.
    transcript.stop();
    if (closing) window?.destroy();
    else send('cli:exit', exitCode);
  });
  return folder;
}

ipcMain.handle('cli:start', async (_event, options) => {
  if (cli || launching) throw new Error(t("Stop the current free-pi process first."));
  launching = true;
  try {
    return await startCli(options);
  } finally {
    launching = false;
  }
});

ipcMain.on('cli:write', (_event, data) => {
  if (typeof data === 'string') cli?.write(data);
});

ipcMain.on('cli:resize', (_event, cols, rows) => {
  cli?.resize(size(cols, 500), size(rows, 300));
});

ipcMain.handle('session:read-history', async (_event, folder, sessionId) => {
  const request = ++historyRequest;
  historySelected = true;
  historyFolder = undefined;
  const snapshot = await readSavedTranscript({ folder, sessionId, directoryFor: sessionDirectory, root: sessionsRoot });
  if (request === historyRequest && snapshot) historyFolder = snapshot.folder;
  return snapshot && { ...snapshot, folderAvailable: isFolder(snapshot.folder) };
});
ipcMain.on('session:clear-history', () => {
  historyRequest++;
  historySelected = false;
  historyFolder = undefined;
});

ipcMain.handle('project:files', (_event, query) => {
  const project = historySelected ? historyFolder : cliFolder;
  return project ? findProjectFiles(project, query) : [];
});
ipcMain.handle('project:preview', (_event, file) => previewProjectFile(historySelected ? historyFolder : cliFolder, file));
ipcMain.handle('project:editor', (_event, file) => openProjectEditor(historySelected ? historyFolder : cliFolder, file,
  desktopSettings().editor === 'default' ? path => shell.openPath(path) : undefined));

ipcMain.handle('attachments:stage', (_event, files, folder) => {
  if (typeof folder !== 'string' || !cliFolder || !sameFolder(cliFolder, folder)) {
    throw new Error(t("The project changed. Attach the files again."));
  }
  return attachments.stage(cliFolder, files);
});

function attachmentFolder(folder) {
  const project = historySelected ? historyFolder : cliFolder ?? transcriptFolder;
  return project && typeof folder === 'string' && path.isAbsolute(folder) && sameFolder(project, folder) ? project : undefined;
}

ipcMain.handle('attachments:read', (_event, folder, relativePath, mode) => {
  const project = attachmentFolder(folder);
  return project ? attachments.read(project, relativePath, mode === 'inspect' ? mode : mode === true) : null;
});

ipcMain.handle('attachments:reveal', async (_event, folder, relativePath) => {
  const project = attachmentFolder(folder);
  const entry = project && await attachments.resolve(project, relativePath);
  if (!entry || project !== attachmentFolder(folder)) return false;
  shell.showItemInFolder(entry.file);
  return true;
});

ipcMain.handle('project:list', async () => {
  const projects = new Map();
  const hidden = new Set(readHiddenProjects().map(folderKey));
  const add = (folder, name) => {
    const normalized = path.resolve(folder);
    const key = folderKey(normalized);
    if (!hidden.has(key) && !projects.has(key)) {
      projects.set(key, { folder: normalized, name: name || path.basename(normalized) || normalized, available: isFolder(normalized) });
    }
  };
  for (const project of readRegisteredProjects()) add(project.folder, project.name);
  for (const folder of [...readRecentFolders(), ...readPinnedProjects()]) add(folder);
  const { folder: lastFolder } = readWorkspace();
  if (typeof lastFolder === 'string' && path.isAbsolute(lastFolder)) add(lastFolder);
  for (const directory of await sessionDirectories()) {
    const sessions = await readSessions(directory, undefined, undefined, true);
    for (const { folder } of sessions) add(folder);
  }
  return Array.from(projects.values());
});

ipcMain.handle('project:register', async (_event, options) => {
  const { location, createFolder } = options ?? {};
  if (!isFolder(location)) return { error: t("The selected folder is unavailable.") };
  const selected = path.resolve(location);
  const name = projectName(options.name);
  if (!name) return { error: t("Enter a project name of up to 120 characters.") };
  let folder = selected;
  if (createFolder === true) {
    const invalidName = /[<>:"/\\|?*\x00-\x1f]|\.$/u.test(name)
      || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])\s*(?:\.|$)/iu.test(name);
    if (invalidName) return { error: t("Enter a valid Windows folder name.") };
    folder = path.join(selected, name);
    try {
      await mkdir(folder);
    } catch (error) {
      return { error: error.code === 'EEXIST' ? t("This folder already exists. Use “Choose folder” to select it.")
        : t("Could not create a folder in the selected location.") };
    }
  }
  const projects = readRegisteredProjects().filter(project => !sameFolder(project.folder, folder));
  const hiddenProjects = readHiddenProjects().filter(hidden => !sameFolder(hidden, folder));
  if (!saveWorkspace({ projects: [{ name, folder }, ...projects], hiddenProjects })) {
    if (createFolder === true) await rmdir(folder).catch(() => {});
    return { error: t("Could not save the project.") };
  }
  return { folder, name };
});

ipcMain.handle('project:rename', (_event, folder, value) => {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return { error: t("Project folder unavailable.") };
  const name = projectName(value);
  if (!name) return { error: t("Enter a project name of up to 120 characters.") };
  const projects = readRegisteredProjects();
  const index = projects.findIndex(project => sameFolder(project.folder, folder));
  if (index < 0) projects.push({ folder: path.resolve(folder), name });
  else projects[index] = { ...projects[index], name };
  return saveWorkspace({ projects }) ? {} : { error: t("Could not save the project name.") };
});

ipcMain.handle('project:open-folder', async (_event, folder) => {
  if (!isFolder(folder)) return { error: t("Project folder unavailable.") };
  const error = await shell.openPath(path.resolve(folder));
  return error ? { error: t("Could not open the folder in File Explorer.") } : {};
});

ipcMain.handle('project:hide', (_event, folder) => {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return { error: t("Project folder path unavailable.") };
  const hiddenProjects = readHiddenProjects();
  if (hiddenProjects.some(hidden => sameFolder(hidden, folder))) return {};
  return saveWorkspace({ hiddenProjects: [...hiddenProjects, path.resolve(folder)] })
    ? {} : { error: t("Could not remove the project from the list.") };
});

ipcMain.handle('session:list', async (_event, folder) => {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return [];
  const available = isFolder(folder);
  const sessions = await history.decorate(await findSessions(folder));
  return sessions.map(session => ({ ...session, folderAvailable: available }));
});

ipcMain.handle('session:list-pinned', async () => {
  const sessions = [];
  for (const directory of await sessionDirectories()) {
    const headers = await readSessions(directory, undefined, undefined, true);
    const pinned = await history.pinned(headers);
    for (const { folder, file, id, title } of pinned) {
      const session = await readSession(file, folder);
      if (session?.id === id) sessions.push({ ...session, title: title || session.title, pinned: true, folderAvailable: isFolder(folder) });
    }
  }
  return sessions.sort((left, right) => right.modified.localeCompare(left.modified));
});

ipcMain.handle('session:list-all', async (_event, query, archived) => {
  const sessions = [];
  for (const directory of await sessionDirectories()) sessions.push(...await readSessions(directory));
  const found = await history.search(sessions, query, archived === true);
  const folders = new Map();
  return found.map(session => {
    const key = folderKey(session.folder);
    if (!folders.has(key)) folders.set(key, isFolder(session.folder));
    return { ...session, folderAvailable: folders.get(key) };
  });
});

ipcMain.handle('session:update', async (_event, patch) => {
  if (!patch || typeof patch.folder !== 'string' || !path.isAbsolute(patch.folder) || typeof patch.id !== 'string'
    || !sessionIdPattern.test(patch.id) || !(await findSessions(patch.folder, patch.id)).length) {
    throw new Error(t("Saved session not found."));
  }
  return history.update(patch.folder, patch.id, patch);
});

ipcMain.on('session:bind-transcript', (_event, id, includeOtherFolders) => {
  if (!cli) return;
  if (id === null || (typeof id === 'string' && sessionIdPattern.test(id))) {
    transcript.bind(id, cliFolder, includeOtherFolders === true);
  }
});

ipcMain.handle('project:pick', async (_event, folder, chooseParent) => {
  const result = await dialog.showOpenDialog(window, {
    title: chooseParent ? t("Choose where to create the project folder") : t("Choose a project folder"),
    defaultPath: isFolder(folder) ? folder : app.getPath('documents'),
    properties: ['openDirectory'],
  });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.on('link:open', (_event, url) => {
  if (typeof url !== 'string') return;
  try {
    const target = new URL(url);
    if (target.protocol === 'https:' || target.protocol === 'http:') void shell.openExternal(target.href);
  } catch {
    // Terminal output can contain malformed URLs.
  }
});

ipcMain.on('window:quit', () => {
  if (!cli || closing) return;
  saveWindowBounds();
  closing = true;
  cli.write('/quit\r');
  const fallback = setTimeout(() => window?.destroy(), 3500);
  fallback.unref();
});

ipcMain.on('window:restart', () => {
  app.relaunch();
  if (!cli) {
    window?.close();
    return;
  }
  saveWindowBounds();
  closing = true;
  cli.write('/quit\r');
  const fallback = setTimeout(() => window?.destroy(), 3500);
  fallback.unref();
});

app.whenReady().then(() => {
  setLanguage(desktopSettings().language);
  app.setAppUserModelId(notificationAppId);
  try { jobs.initialize(); } catch (error) { console.warn(error.message); }
  window = new BrowserWindow({
    title: productName,
    icon: windowIconPath,
    ...initialWindow(),
    minWidth: 710,
    minHeight: 650,
    backgroundColor: '#141414',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.setAppDetails({
    appId: notificationAppId,
    appIconPath: windowIconPath,
    relaunchDisplayName: productName,
    relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${__dirname}"`,
  });
  if (readWorkspace().maximized === true) window.maximize();
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    saveWindowBounds();
    if (!cli || closing || window.webContents.isCrashed()) return;
    event.preventDefault();
    send('window:closing');
  });
  window.on('closed', () => {
    commands.close();
    const child = cli;
    cli = undefined;
    cliFolder = undefined;
    liveChannel?.close();
    liveChannel = undefined;
    transcript.stop();
    window = undefined;
    child?.kill();
  });
  void window.loadFile('index.html');
});

ipcMain.on('window:close-now', () => {
  saveWindowBounds();
  window?.destroy();
});
app.on('window-all-closed', () => app.quit());
