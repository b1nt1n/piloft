const { createHash, randomUUID } = require('node:crypto');
const { mkdir, open, readdir, rename, unlink, writeFile } = require('node:fs/promises');
const path = require('node:path');

const idPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const statuses = new Set(['added', 'deleted', 'modified']);
const maxSummaryBytes = 4 * 1024 * 1024;
const maxRecordBytes = 16 * 1024 * 1024;
const maxFiles = 7000;

function validId(id) {
  return typeof id === 'string' && idPattern.test(id);
}

function fileSummary(file) {
  const result = { path: file.path, status: file.status };
  for (const key of ['additions', 'deletions']) {
    if (Number.isSafeInteger(file[key]) && file[key] >= 0) result[key] = file[key];
  }
  return result;
}

// The first line holds the summary so loading a chat doesn't load every patch.
async function readSummary(file) {
  const handle = await open(file, 'r');
  const chunk = Buffer.alloc(16 * 1024);
  const parts = [];
  let size = 0;
  try {
    while (size <= maxSummaryBytes) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) return null;
      const data = chunk.subarray(0, bytesRead);
      const end = data.indexOf(10);
      size += end < 0 ? bytesRead : end;
      if (size > maxSummaryBytes) return null;
      parts.push(Buffer.from(end < 0 ? data : data.subarray(0, end)));
      if (end >= 0) return JSON.parse(Buffer.concat(parts).toString('utf8'));
    }
  } finally {
    await handle.close();
  }
  return null;
}

function createDiffHistory({ directory }) {
  function sessionDirectory(scope) {
    if (typeof scope?.folder !== 'string' || scope.folder.length > 32767 || !path.isAbsolute(scope.folder)
      || !validId(scope.sessionId)) return;
    const cwd = path.resolve(scope.folder);
    const identity = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
    const key = createHash('sha256').update(identity + '\0' + scope.sessionId).digest('hex');
    return path.join(directory(), key);
  }

  async function save(scope) {
    const folder = sessionDirectory(scope);
    if (!folder || !validId(scope.messageId)) return null;
    const { result } = scope;
    if (result?.status !== 'ready' || !Array.isArray(result.files) || !result.files.length
      || result.files.length > maxFiles) return null;

    const files = result.files.filter(file => typeof file?.path === 'string'
      && file.path.length > 0 && file.path.length <= 32767 && statuses.has(file.status)).map(file => {
      const summary = fileSummary(file);
      if (typeof file.patch === 'string') summary.patch = file.patch;
      if (typeof file.note === 'string') summary.note = file.note.slice(0, 1000);
      return summary;
    });
    if (!files.length) return null;
    const summary = {
      messageId: scope.messageId,
      createdAt: new Date().toISOString(),
      files: files.map(fileSummary),
      limited: result.limited === true || files.length !== result.files.length,
    };
    const firstLine = JSON.stringify(summary);
    const body = firstLine + '\n' + JSON.stringify({ status: 'ready', files, limited: summary.limited });
    if (Buffer.byteLength(firstLine) > maxSummaryBytes || Buffer.byteLength(body) > maxRecordBytes) return null;

    const file = path.join(folder, scope.messageId + '.jsonl');
    const temporary = file + '.' + randomUUID() + '.tmp';
    await mkdir(folder, { recursive: true });
    try {
      await writeFile(temporary, body, { flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return summary;
  }

  async function list(scope) {
    const folder = sessionDirectory(scope);
    if (!folder) return [];
    const entries = await readdir(folder, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')
      && validId(entry.name.slice(0, -6)));
    const summaries = [];
    for (let offset = 0; offset < files.length; offset += 8) {
      const batch = await Promise.all(files.slice(offset, offset + 8).map(async ({ name }) => {
        try {
          const summary = await readSummary(path.join(folder, name));
          if (summary?.messageId === name.slice(0, -6) && typeof summary.createdAt === 'string'
            && Array.isArray(summary.files)) return summary;
        } catch {
          // Skip missing or incomplete records without blocking the rest of the chat.
        }
      }));
      summaries.push(...batch.filter(Boolean));
    }
    return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async function read(scope) {
    const folder = sessionDirectory(scope);
    if (!folder || !validId(scope.messageId)) return null;
    let handle;
    try {
      handle = await open(path.join(folder, scope.messageId + '.jsonl'), 'r');
      if ((await handle.stat()).size > maxRecordBytes) return null;
      const text = await handle.readFile('utf8');
      const end = text.indexOf('\n');
      if (end < 0 || JSON.parse(text.slice(0, end)).messageId !== scope.messageId) return null;
      const result = JSON.parse(text.slice(end + 1));
      return result?.status === 'ready' && Array.isArray(result.files) ? result : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  return { save, list, read };
}

module.exports = { createDiffHistory };
