const { t } = require('./locale.js');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { mkdir, readFile, readdir, rename, unlink, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');

function normalize(text) {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
}

function messageText(entry) {
  const message = entry?.message;
  if (entry?.type !== 'message' || !['user', 'assistant'].includes(message?.role)) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join(' ');
}

function snippet(text, query) {
  const line = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  const index = normalize(line).indexOf(query);
  if (index < 0) return undefined;
  const start = Math.max(0, index - 42);
  const end = Math.min(line.length, index + query.length + 92);
  return `${start ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

async function matchSession(file, session, query) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let first = true;
    let leaf;
    const entries = new Map();
    for await (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        if (first) return;
        continue;
      }
      if (first) {
        if (entry?.type !== 'session' || entry.id !== session.id || typeof entry.cwd !== 'string'
          || path.resolve(entry.cwd).toLowerCase() !== path.resolve(session.folder).toLowerCase()) return;
        first = false;
      } else if (typeof entry?.id === 'string') {
        leaf = entry.id;
        entries.set(leaf, { parent: entry.parentId, match: snippet(messageText(entry), query) });
      }
    }
    const visited = new Set();
    while (leaf && !visited.has(leaf)) {
      const entry = entries.get(leaf);
      if (!entry || entry.match) return entry?.match;
      visited.add(leaf);
      leaf = entry.parent;
    }
  } catch {
    // Saved sessions can be moved while the search is running.
  } finally {
    lines.close();
    stream.destroy();
  }
}

function createHistory({ metadataDir, sessionDirectory }) {
  let writes = Promise.resolve();

  function fileFor(folder, id) {
    const key = createHash('sha256').update(path.resolve(folder).toLowerCase() + '\0' + id).digest('hex');
    return path.join(metadataDir(), key + '.json');
  }

  async function readMetadata(file) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      const title = typeof value?.title === 'string' ? value.title.trim().slice(0, 160) : '';
      return { title, pinned: value?.pinned === true, archived: value?.archived === true };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return { title: '', pinned: false, archived: false };
    }
  }

  function update(folder, id, patch) {
    if (patch.title !== undefined && typeof patch.title !== 'string') throw new TypeError(t("Invalid session name."));
    if (patch.pinned !== undefined && typeof patch.pinned !== 'boolean') throw new TypeError(t("Invalid pinned state."));
    if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw new TypeError(t("Invalid archive state."));
    const file = fileFor(folder, id);
    const pending = writes.then(async () => {
      const metadata = await readMetadata(file);
      if (patch.title !== undefined) metadata.title = patch.title.replace(/\s+/g, ' ').trim().slice(0, 160);
      if (patch.pinned !== undefined) metadata.pinned = patch.pinned;
      if (patch.archived !== undefined) metadata.archived = patch.archived;
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(metadata));
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return metadata;
    });
    writes = pending.catch(() => {});
    return pending;
  }

  async function decorate(sessions) {
    const decorated = await Promise.all(sessions.map(async session => {
      const metadata = await readMetadata(fileFor(session.folder, session.id));
      return { ...session, title: metadata.title || session.title, pinned: metadata.pinned, archived: metadata.archived };
    }));
    return decorated.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modified.localeCompare(a.modified));
  }

  async function pinned(headers) {
    const sessions = [];
    for (let offset = 0; offset < headers.length; offset += 8) {
      const batch = await Promise.all(headers.slice(offset, offset + 8).map(async header => {
        const metadata = await readMetadata(fileFor(header.folder, header.id));
        return metadata.pinned && !metadata.archived ? { ...header, title: metadata.title } : undefined;
      }));
      sessions.push(...batch.filter(Boolean));
    }
    return sessions;
  }

  async function search(sessions, text, archived = false) {
    const sorted = (await decorate(sessions)).filter(session => session.archived === archived);
    const query = typeof text === 'string' ? normalize(text.slice(0, 256)) : '';
    if (!query) return sorted;
    const directories = new Map();
    async function searchOne(session) {
      if (normalize(`${session.title} ${session.folder}`).includes(query)) return session;
      const directory = sessionDirectory(session.folder);
      if (!directories.has(directory)) directories.set(directory, readdir(directory, { withFileTypes: true }).catch(() => []));
      const files = await directories.get(directory);
      const entry = files.find(file => file.isFile() && (file.name === `${session.id}.jsonl`
        || file.name.endsWith(`_${session.id}.jsonl`)));
      if (!entry) return;
      const match = await matchSession(path.join(directory, entry.name), session, query);
      if (match) return { ...session, snippet: match };
    }
    const found = [];
    for (let i = 0; i < sorted.length; i += 8) {
      const batch = await Promise.all(sorted.slice(i, i + 8).map(searchOne));
      found.push(...batch.filter(Boolean));
    }
    return found;
  }

  return { decorate, pinned, search, update };
}

module.exports = { createHistory };
