const { t } = require('./locale.js');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const maxFiles = 3500;
const maxFileBytes = 512 * 1024;
const maxSnapshotBytes = 48 * 1024 * 1024;
const maxPatches = 70;
const maxPatchBytes = 384 * 1024;
const maxTotalPatchBytes = 3 * 1024 * 1024;
const ignoredFolders = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const gitEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
gitEnvironment.GIT_OPTIONAL_LOCKS = '0';

async function git(folder, args, diff = false) {
  try {
    const { stdout } = await exec('git', args, {
      cwd: folder, env: gitEnvironment, windowsHide: true,
      maxBuffer: diff ? maxPatchBytes : 6 * 1024 * 1024, timeout: 5000,
    });
    return stdout;
  } catch (error) {
    if (diff && error.code === 1) return error.stdout;
    if (!diff || error.code === 'ENOENT' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return;
    throw error;
  }
}

function projectContains(folder, file) {
  const relative = path.relative(folder, file);
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function projectFiles(folder) {
  const listing = await git(folder, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.']);
  if (listing !== undefined) {
    const names = [...new Set(listing.split('\0').filter(Boolean))];
    return { names: names.slice(0, maxFiles), limited: names.length > maxFiles };
  }
  const folders = [''];
  const names = [];
  let limited = false;
  for (let index = 0; index < folders.length; index++) {
    if (index >= maxFiles || names.length >= maxFiles) return { names, limited: true };
    let entries;
    try {
      entries = await fs.readdir(path.join(folder, folders[index]), { withFileTypes: true });
    } catch {
      limited = true;
      continue;
    }
    for (const entry of entries) {
      const relative = path.posix.join(folders[index], entry.name);
      if (entry.isDirectory() && !ignoredFolders.has(entry.name)) folders.push(relative);
      if (entry.isFile()) {
        if (names.length >= maxFiles) return { names, limited: true };
        names.push(relative);
      }
    }
  }
  return { names, limited };
}

async function snapshot(folder) {
  const { names, limited } = await projectFiles(folder);
  const files = new Map();
  let skipped = limited;
  let remaining = maxSnapshotBytes;
  for (let index = 0; index < names.length; index += 16) {
    const entries = await Promise.all(names.slice(index, index + 16).map(async name => {
      const absolute = path.resolve(folder, name);
      if (!projectContains(folder, absolute)) return;
      try {
        const info = await fs.lstat(absolute);
        if (!info.isFile() || !projectContains(folder, await fs.realpath(absolute))) return;
        const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        if (info.size > maxFileBytes || info.size > remaining) return { name, stamp };
        // Read at most the configured limit, even if another process appends concurrently.
        const handle = await fs.open(absolute, 'r');
        try {
          const buffer = Buffer.allocUnsafe(info.size + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          return { name, stamp, body: length === info.size ? buffer.subarray(0, length) : undefined };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return { name };
      }
    }));
    for (const entry of entries) {
      if (!entry) continue;
      if (entry.body && entry.body.length > remaining) entry.body = undefined;
      if (entry.body) remaining -= entry.body.length;
      else skipped = true;
      files.set(entry.name, entry);
    }
  }
  return { files, limited: skipped, incompleteListing: limited };
}

async function makePatch(directory, before, after) {
  const previous = before?.body;
  const current = after?.body;
  if ((before && !previous) || (after && !current)) return { note: t("The file is too large or unavailable for comparison.") };
  if (previous?.includes(0) || current?.includes(0)) return { note: t("Binary file.") };
  if (!previous?.length && !current?.length) return { note: t("Empty file.") };
  await Promise.all([
    fs.writeFile(path.join(directory, 'before'), previous ?? ''),
    fs.writeFile(path.join(directory, 'after'), current ?? ''),
  ]);
  const output = await git(directory, ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', 'before', 'after'], true);
  if (output === undefined) return { note: t("The text diff is unavailable or exceeds the preview limit.") };
  return patchDetails(output);
}

function patchDetails(output) {
  const start = output?.search(/^@@ /m) ?? -1;
  const patch = start < 0 ? '' : output.slice(start);
  if (!patch) return { note: t("The file changed, but there are no text lines to preview.") };
  const lines = patch.split('\n');
  return {
    patch,
    additions: lines.filter(line => line.startsWith('+')).length,
    deletions: lines.filter(line => line.startsWith('-')).length,
  };
}

async function projectBranch(folder) {
  if (!folder) return '';
  const branch = await git(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch?.trim()) return branch.trim();
  const revision = await git(folder, ['rev-parse', '--short', 'HEAD']);
  return revision?.trim() ?? '';
}

async function workingChanges(folder) {
  const unavailable = { status: 'unsupported', files: [], message: t("The working folder must be a Git repository.") };
  if (!folder || !await projectBranch(folder)) return unavailable;
  const head = await git(folder, ['rev-parse', '--verify', 'HEAD']);
  const tracked = head ? await git(folder, ['diff', '--relative', '--no-renames', '--name-status', '-z', 'HEAD', '--', '.'])
    : '';
  const untracked = await git(folder, ['ls-files', '-z', ...(head ? [] : ['--cached']), '--others', '--exclude-standard', '--', '.']);
  if (tracked === undefined || untracked === undefined) {
    return { status: 'error', files: [], message: t("Could not read Git changes.") };
  }
  const fields = tracked.split('\0').filter(Boolean);
  const candidates = new Map();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    candidates.set(fields[i + 1], { status: fields[i] === 'A' ? 'added' : fields[i] === 'D' ? 'deleted' : 'modified', tracked: true });
  }
  for (const name of untracked.split('\0').filter(Boolean)) {
    if (!candidates.has(name)) candidates.set(name, { status: 'added', tracked: false });
  }
  const root = await fs.realpath(folder);
  const files = [];
  let remaining = maxTotalPatchBytes;
  let directory;
  try {
    for (const [name, { status, tracked }] of [...candidates].slice(0, maxFiles)) {
      let diff = { note: t("Diff preview limit reached.") };
      if (files.length < maxPatches && remaining > 0) {
        try {
          if (tracked) {
            const raw = await git(folder, ['--literal-pathspecs', 'diff', '--relative', '--no-renames', '--no-ext-diff',
              '--no-textconv', '--no-color', '--unified=3', 'HEAD', '--', name], true);
            diff = raw === undefined ? { note: t("Text diff unavailable.") } : patchDetails(raw);
          } else {
            const absolute = path.resolve(root, name);
            const stat = await fs.lstat(absolute);
            if (!stat.isFile() || stat.size > maxFileBytes || !projectContains(root, await fs.realpath(absolute))) {
              diff = { note: t("The file is too large or unavailable for comparison.") };
            } else {
              directory ??= await fs.mkdtemp(path.join(tmpdir(), 'freepi-working-diff-'));
              const handle = await fs.open(absolute, 'r');
              try {
                const buffer = Buffer.alloc(stat.size + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                diff = await makePatch(directory, undefined, { body: buffer.subarray(0, bytesRead) });
              } finally {
                await handle.close();
              }
            }
          }
        } catch {
          diff = { note: t("The file is unavailable for comparison.") };
        }
        remaining -= Buffer.byteLength(diff.patch ?? '');
        if (remaining < 0) diff = { note: t("Diff preview limit reached.") };
      }
      files.push({ path: name, status, ...diff });
    }
    return { status: 'ready', files, limited: candidates.size > maxPatches || remaining <= 0 };
  } finally {
    if (directory) {
      await Promise.allSettled(['before', 'after'].map(name => fs.unlink(path.join(directory, name))));
      await fs.rmdir(directory).catch(() => {});
    }
  }
}

function createChanges() {
  let baseline;
  let comparing = Promise.resolve();

  async function compare({ folder, before }) {
    let directory;
    try {
      const after = await snapshot(folder);
      const names = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
      const files = [];
      let patches = 0;
      let remaining = maxTotalPatchBytes;
      for (const name of names) {
        const previous = before.files.get(name);
        const current = after.files.get(name);
        if ((!previous && before.incompleteListing) || (!current && after.incompleteListing)) continue;
        if (previous && current) {
          if (previous.body && current.body ? previous.body.equals(current.body) : previous.stamp === current.stamp) continue;
        }
        const status = !previous ? 'added' : !current ? 'deleted' : 'modified';
        let diff = { note: t("Diff preview limit reached.") };
        if (patches++ < maxPatches && remaining > 0) {
          if (!directory) directory = await fs.mkdtemp(path.join(tmpdir(), 'freepi-changes-'));
          const preview = await makePatch(directory, previous, current);
          remaining -= Buffer.byteLength(preview.patch ?? '');
          if (remaining >= 0) diff = preview;
        }
        files.push({ path: name, status, ...diff });
      }
      return { status: 'ready', files, limited: before.limited || after.limited || patches > maxPatches || remaining <= 0 };
    } catch {
      return { status: 'error', files: [], message: t("Could not compare project files.") };
    } finally {
      if (directory) {
        await Promise.allSettled(['before', 'after'].map(name => fs.unlink(path.join(directory, name))));
        await fs.rmdir(directory).catch(() => {});
      }
    }
  }

  return {
    async begin(folder) {
      await comparing;
      baseline = undefined;
      if (!folder) return null;
      try {
        const root = await fs.realpath(folder);
        if (!(await fs.stat(root)).isDirectory()) return null;
        const token = randomUUID();
        baseline = { token, folder: root, before: await snapshot(root) };
        return token;
      } catch {
        return null;
      }
    },
    async finish(token) {
      if (!baseline || baseline.token !== token) return { status: 'unsupported', files: [] };
      comparing = compare(baseline);
      baseline = undefined;
      return comparing;
    },
  };
}

module.exports = { createChanges, workingChanges, projectBranch };
