const { t } = require('./locale.js');
const { spawn } = require('node:child_process');
const { open, realpath } = require('node:fs/promises');
const path = require('node:path');

const maxBytes = 256 * 1024;

function withinProject(relative) {
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    && !relative.split(path.sep).some(part => part.toLowerCase() === '.git' || part.includes(':'));
}

async function projectFile(folder, requested) {
  if (!folder || typeof requested !== 'string' || !requested
    || requested.length > 1024 || /[\x00-\x1f\x7f]/u.test(requested)) {
    throw new Error(t("File unavailable."));
  }
  const prefix = path.basename(folder) + '/';
  const portable = requested.replaceAll('\\', '/');
  let candidate = path.resolve(folder, requested);
  if (portable.toLowerCase().startsWith(prefix.toLowerCase())) {
    try {
      await realpath(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      candidate = path.resolve(folder, portable.slice(prefix.length));
    }
  }
  if (!withinProject(path.relative(folder, candidate))) throw new Error(t("You can only preview files in the current project."));
  const root = await realpath(folder);
  const file = await realpath(candidate);
  const relative = path.relative(root, file);
  if (!withinProject(relative)) {
    throw new Error(t("You can only preview files in the current project."));
  }
  return { file, relative: relative.split(path.sep).join('/') };
}

async function previewProjectFile(folder, requested) {
  const { file, relative } = await projectFile(folder, requested);
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(t("Choose a file."));
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, Math.min(length, maxBytes));
    if (bytes.includes(0)) throw new Error(t("Preview is available for text files."));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text;
    try {
      text = decoder.decode(bytes, { stream: length > maxBytes });
    } catch {
      throw new Error(t("Preview is available for UTF-8 files."));
    }
    return { path: relative, text, truncated: length > maxBytes };
  } finally {
    await handle.close();
  }
}

async function openProjectEditor(folder, requested, openDefault) {
  const { path: relative } = await previewProjectFile(folder, requested);
  const { file } = await projectFile(folder, relative);
  if (openDefault) {
    const error = await openDefault(file);
    if (error) throw new Error(t("Could not open the file in the default editor."));
    return;
  }
  const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(notepad, [file], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

module.exports = { previewProjectFile, openProjectEditor };
