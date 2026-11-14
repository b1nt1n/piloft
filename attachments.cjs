const { t } = require('./locale.js');
const { randomUUID } = require('node:crypto');
const { lstat, mkdir, open, realpath, unlink } = require('node:fs/promises');
const path = require('node:path');

const directoryName = 'freepi-attachments';
const maxBytes = 25 * 1024 * 1024;
const maxPreviewBytes = 5 * 1024 * 1024;
const maxTextBytes = 256 * 1024;
const maxFiles = 6;
const relativePattern = /^freepi-attachments\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}(?:\.(?:png|jpg|webp)|--[\p{L}\p{N} ._()\-]{1,100})$/u;
const formats = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function imageExtension(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
}

async function attachmentDirectory(folder, create) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error(t("No FreePi project is open."));
  const root = await realpath(folder);
  const directory = path.join(root, directoryName);
  if (create) await mkdir(directory).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || path.relative(root, await realpath(directory)) !== directoryName) {
    throw new Error(t("The attachment directory must be inside the project."));
  }
  return directory;
}

async function resolveAttachment(folder, relativePath) {
  if (typeof relativePath !== 'string' || !relativePattern.test(relativePath)) return null;
  try {
    const directory = await attachmentDirectory(folder, false);
    const name = path.basename(relativePath);
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || path.relative(directory, await realpath(file)) !== name) return null;
    return { file, info };
  } catch {
    return null;
  }
}

async function readBytes(handle, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (!bytesRead) return null;
    offset += bytesRead;
  }
  return bytes;
}

function imageSource(bytes, extension) {
  return `data:${formats[extension]};base64,${bytes.toString('base64')}`;
}

function createAttachments() {
  return {
    async stage(folder, attachments) {
      if (!Array.isArray(attachments) || !attachments.length || attachments.length > maxFiles) throw new Error(t("Attach 1 to 6 files."));
      const files = attachments.map(({ data, name }) => {
        if (!(data instanceof Uint8Array) || data.byteLength > maxBytes) {
          throw new Error(t("Each file can be up to 25 MB."));
        }
        const original = typeof name === 'string' ? name.replace(/[^\p{L}\p{N} ._()\-]/gu, '_') : '';
        const characters = Array.from(original);
        const safe = characters.length > 100 ? `${characters.slice(0, 72).join('')}_${characters.slice(-24).join('')}` : original;
        return { bytes: Buffer.from(data.buffer, data.byteOffset, data.byteLength), name: `${randomUUID()}--${safe.replace(/[. ]+$/, '') || 'attachment'}` };
      });
      const directory = await attachmentDirectory(folder, true);
      const created = [];
      try {
        for (const { bytes, name } of files) {
          const destination = path.join(directory, name);
          const handle = await open(destination, 'wx');
          created.push(destination);
          try {
            await handle.writeFile(bytes);
          } finally {
            await handle.close();
          }
        }
      } catch (error) {
        await Promise.allSettled(created.map(file => unlink(file)));
        throw error;
      }
      return files.map(file => `${directoryName}/${file.name}`);
    },
    resolve: resolveAttachment,
    async read(folder, relativePath, mode) {
      const entry = await resolveAttachment(folder, relativePath);
      if (!entry) return null;
      const { file, info } = entry;
      if ((mode === true && info.size > maxPreviewBytes) || (!mode && info.size > maxBytes)) return null;
      let handle;
      try {
        handle = await open(file, 'r');
        const after = await handle.stat();
        if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size) return null;
        const inspect = mode === 'inspect';
        const bytes = await readBytes(handle, inspect ? Math.min(after.size, maxTextBytes) : after.size);
        if (!bytes || !mode) return bytes;
        const extension = imageExtension(bytes);
        if (!inspect) return extension ? imageSource(bytes, extension) : null;
        if (extension && after.size <= maxPreviewBytes) {
          const image = after.size === bytes.length ? bytes : await readBytes(handle, after.size);
          return image && { kind: 'image', source: imageSource(image, extension) };
        }
        if (!extension && !bytes.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
          try {
            const truncated = after.size > bytes.length;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
            return { kind: 'text', text, truncated };
          } catch { /* Binary files can still be shown in Explorer. */ }
        }
        return { kind: 'file' };
      } catch {
        return null;
      } finally {
        if (handle) await handle.close();
      }
    },
  };
}

module.exports = { createAttachments };
