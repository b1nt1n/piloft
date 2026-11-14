const { lstat, open, readdir, realpath, stat } = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const interval = 350;
const chunkSize = 64 * 1024;
const maxResultLength = 100_000;
const allowedRoles = new Set(['user', 'assistant', 'toolResult']);

function sessionFileName(name, id) {
  return name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`);
}

async function list(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function findFile(directory, id) {
  const files = await list(directory);
  const match = files.find(entry => entry.isFile() && sessionFileName(entry.name, id));
  return match && path.join(directory, match.name);
}

function projectMessage(entry) {
  const message = entry.message;
  if (entry.type !== 'message' || !allowedRoles.has(message?.role)) return undefined;
  const role = message.role;
  const content = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  const blocks = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const text = role === 'toolResult' && block.text.length > maxResultLength
        ? block.text.slice(0, maxResultLength) + '\n…'
        : block.text;
      blocks.push({ type: 'text', text });
    } else if (role === 'assistant' && block?.type === 'thinking' && !block.redacted && typeof block.thinking === 'string') {
      blocks.push({ type: 'thinking', thinking: block.thinking });
    } else if (role === 'assistant' && block?.type === 'toolCall' && typeof block.id === 'string'
      && typeof block.name === 'string') {
      blocks.push({ type: 'toolCall', id: block.id, name: block.name, arguments: block.arguments });
    }
  }
  const errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
  if (!blocks.length && !errorMessage && message.stopReason !== 'aborted' && role !== 'toolResult') return undefined;
  return {
    id: entry.id,
    role,
    content: blocks,
    timestamp: message.timestamp ?? entry.timestamp,
    ...(role === 'toolResult' ? {
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      isError: Boolean(message.isError),
      durationMs: message.durationMs,
    } : {}),
    ...(role === 'assistant' ? { errorMessage, stopReason: message.stopReason } : {}),
  };
}

function resetReader(state) {
  state.offset = 0;
  state.rest = '';
  state.decoder = new StringDecoder('utf8');
  state.entries = new Map();
  state.leafId = undefined;
  state.header = undefined;
}

function readLines(state, text) {
  const lines = (state.rest + text).split('\n');
  state.rest = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      if (!state.header) return false;
      continue;
    }
    if (!state.header) {
      if (entry?.type !== 'session' || entry.id !== state.id || typeof entry.cwd !== 'string'
        || path.resolve(state.directoryFor(entry.cwd)).toLowerCase() !== path.dirname(state.file).toLowerCase()) return false;
      state.header = entry;
    } else if (typeof entry?.id === 'string') {
      const snapshot = entry.type === 'custom' && entry.customType === 'free-pi-todo' ? entry.data
        : entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolName === 'todo' ? entry.message.details : undefined;
      const todos = Array.isArray(snapshot?.todos) && typeof snapshot.nextId === 'number'
        ? snapshot.todos.filter(item => typeof item?.text === 'string').map(item => ({ text: item.text, done: item.done === true }))
        : undefined;
      state.entries.set(entry.id, { parentId: entry.parentId, message: projectMessage(entry), todos });
      state.leafId = entry.id;
    }
  }
  return true;
}

function conversation(state) {
  const messages = [];
  let todos;
  const visited = new Set();
  let id = state.leafId;
  while (id && !visited.has(id)) {
    const entry = state.entries.get(id);
    if (!entry) break;
    visited.add(id);
    if (entry.message) messages.push(entry.message);
    todos ??= entry.todos;
    id = entry.parentId;
  }
  return { messages: messages.reverse(), todos };
}

async function readSavedTranscript({ folder, sessionId, directoryFor, root }) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)
    || typeof sessionId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(sessionId)) return null;
  const directory = directoryFor(folder);
  const rootPath = await realpath(root).catch(() => undefined);
  const directoryPath = await realpath(directory).catch(() => undefined);
  if (!rootPath || !directoryPath
    || path.relative(rootPath, directoryPath).toLowerCase() !== path.basename(directory).toLowerCase()) return null;

  for (const entry of await list(directoryPath)) {
    if (!entry.isFile() || !sessionFileName(entry.name, sessionId)) continue;
    const file = path.join(directoryPath, entry.name);
    const before = await lstat(file).catch(() => undefined);
    if (!before?.isFile() || before.isSymbolicLink()) continue;
    if (path.relative(file, await realpath(file).catch(() => directoryPath))) continue;
    const handle = await open(file, 'r').catch(() => undefined);
    if (!handle) continue;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) continue;
      const state = { id: sessionId, directoryFor, file: path.join(directory, entry.name) };
      resetReader(state);
      const buffer = Buffer.alloc(chunkSize);
      while (state.offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - state.offset), state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        if (!readLines(state, state.decoder.write(buffer.subarray(0, bytesRead)))) break;
        if (state.header && (!path.isAbsolute(state.header.cwd)
          || path.resolve(state.header.cwd).toLowerCase() !== path.resolve(folder).toLowerCase())) {
          state.header = undefined;
          break;
        }
      }
      if (state.header) return { sessionId, folder: state.header.cwd, ...conversation(state) };
    } finally {
      await handle.close();
    }
  }
  return null;
}

function createTranscript({ root, directoryFor, publish }) {
  let active;
  let timer;

  async function poll(state) {
    try {
      if (!state.file) {
        const projectDirectory = directoryFor(state.folder);
        state.file = await findFile(projectDirectory, state.id);
        // /resume can also open a session from another folder.
        if (!state.file && state.includeOtherFolders && Date.now() >= state.searchAgainAt) {
          state.searchAgainAt = Date.now() + 2500;
          for (const dir of await list(root)) {
            if (active !== state) return;
            if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
            const directory = path.join(root, dir.name);
            if (directory.toLowerCase() === projectDirectory.toLowerCase()) continue;
            state.file = await findFile(directory, state.id);
            if (state.file) break;
          }
        }
      }
      if (!state.file || active !== state) return;
      const info = await stat(state.file);
      if (info.size === state.offset && info.mtimeMs === state.modified) return;
      const file = await open(state.file, 'r');
      const buffer = Buffer.alloc(chunkSize);
      const oldLeaf = state.leafId;
      const rebuilt = info.size <= state.offset || (state.ino !== undefined && info.ino !== state.ino);
      try {
        if (rebuilt) resetReader(state);
        while (state.offset < info.size && active === state) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - state.offset), state.offset);
          if (!bytesRead) break;
          state.offset += bytesRead;
          if (!readLines(state, state.decoder.write(buffer.subarray(0, bytesRead)))) {
            // A mismatched or corrupt header must never expose messages.
            state.rejected = true;
            return;
          }
        }
      } finally {
        await file.close();
      }
      state.modified = info.mtimeMs;
      state.ino = info.ino;
      if (active === state && state.header && (rebuilt || oldLeaf !== state.leafId || !state.sent)) {
        state.sent = true;
        publish({ sessionId: state.id, folder: state.header.cwd, ...conversation(state) });
      }
    } catch (error) {
      if (error.code === 'ENOENT') state.file = undefined;
    } finally {
      if (active === state && !state.rejected) timer = setTimeout(() => void poll(state), interval);
    }
  }

  function stop() {
    active = undefined;
    clearTimeout(timer);
  }

  function bind(id, folder, includeOtherFolders = false) {
    if (id && active?.id === id) return;
    stop();
    publish({ sessionId: id ?? null, messages: [] });
    if (!id || !folder) return;
    const state = { id, folder, includeOtherFolders, searchAgainAt: 0, directoryFor };
    resetReader(state);
    active = state;
    void poll(state);
  }

  return { bind, stop };
}

module.exports = { createTranscript, readSavedTranscript };
