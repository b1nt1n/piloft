const { execFile } = require('node:child_process');
const { access, lstat, readdir, realpath } = require('node:fs/promises');
const { homedir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const maximumEntries = 5000;
const maximumSuggestions = 40;
const cacheDuration = 4000;
const invalidPath = /[\x00-\x1f\x7f-\x9f"]/u;
const separator = /[\s，．：；！？（）［］｛｝“”‘’…—]/u;
const gitEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
gitEnvironment.GIT_OPTIONAL_LOCKS = '0';
let index;
let fdExecutable;

async function findFd() {
  const executable = process.platform === 'win32' ? 'fd.exe' : 'fd';
  for (const agent of ['.free-pi', '.pi']) {
    const candidate = path.join(homedir(), agent, 'agent', 'bin', executable);
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return executable;
}

async function listCommand(command, args, cwd, env) {
  try {
    const { stdout } = await exec(command, args, { cwd, env, windowsHide: true, timeout: 1800, maxBuffer: 2 * 1024 * 1024 });
    return stdout.split('\0').filter(Boolean).slice(0, maximumEntries);
  } catch {
    return undefined;
  }
}

async function walk(folder) {
  const stack = [''];
  const paths = [];
  for (let cursor = 0; cursor < stack.length && cursor < maximumEntries && paths.length < maximumEntries; cursor++) {
    const relative = stack[cursor];
    const items = await readdir(path.join(folder, relative), { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (invalidPath.test(item.name) || ignored.has(item.name.toLowerCase())) continue;
      if (!item.isDirectory() && !item.isFile()) continue;
      const itemPath = path.posix.join(relative, item.name);
      paths.push(item.isDirectory() ? itemPath + '/' : itemPath);
      if (item.isDirectory()) stack.push(itemPath);
      if (paths.length >= maximumEntries) break;
    }
  }
  return paths;
}

async function buildIndex(folder) {
  const fd = await (fdExecutable ??= findFd());
  const fdPaths = await listCommand(fd, [
    '--print0', '--hidden', '--no-require-git', '--type', 'f', '--type', 'd',
    '--max-results', String(maximumEntries), ...[...ignored].flatMap(name => ['--exclude', name]),
  ], folder);
  const gitPaths = fdPaths === undefined
    ? await listCommand('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], folder, gitEnvironment)
    : undefined;
  const entries = new Map();
  for (const candidate of fdPaths ?? gitPaths ?? await walk(folder)) {
    const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    const pathname = normalized.replace(/\/$/, '');
    if (!pathname || path.isAbsolute(pathname) || invalidPath.test(pathname)
      || pathname.split('/').some(segment => segment === '..' || ignored.has(segment.toLowerCase()))) continue;
    entries.set(pathname, normalized.endsWith('/') ? 'directory' : 'file');
    let slash = pathname.lastIndexOf('/');
    while (slash > 0) {
      const parent = pathname.slice(0, slash);
      if (entries.has(parent)) break;
      entries.set(parent, 'directory');
      slash = parent.lastIndexOf('/');
    }
  }
  return entries;
}

function score(pathname, query) {
  const lower = pathname.toLowerCase();
  const name = path.posix.basename(lower);
  if (!query) return lower.includes('/') ? 2 : 1;
  if (lower === query || name === query) return 0;
  if (name.startsWith(query) || lower.startsWith(query)) return 1;
  if (lower.includes(query)) return 2;
  let cursor = -1;
  for (const char of query) {
    cursor = lower.indexOf(char, cursor + 1);
    if (cursor < 0) return Infinity;
  }
  return 3;
}

async function findProjectFiles(folder, query = '') {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || typeof query !== 'string' || query.length > 400) return [];
  const root = await realpath(folder).catch(() => null);
  if (!root) return [];
  const normalizedQuery = query.replace(/^@?"/, '').replace(/^@/, '').replace(/"$/, '').replace(/\\/g, '/').toLowerCase();
  const now = Date.now();
  if (index?.root !== root || index.expires < now) index = { root, expires: now + cacheDuration, entries: buildIndex(root) };
  const matches = [...await index.entries].map(([pathname, kind]) => ({
    pathname, kind, rank: score(pathname, normalizedQuery),
  })).filter(entry => Number.isFinite(entry.rank));
  matches.sort((left, right) => left.rank - right.rank || left.pathname.length - right.pathname.length
    || left.pathname.localeCompare(right.pathname));

  const results = [];
  // A file may disappear or be replaced by a junction between indexing and lookup.
  for (let start = 0; start < Math.min(matches.length, 160) && results.length < maximumSuggestions; start += 12) {
    const batch = await Promise.all(matches.slice(start, start + 12).map(async ({ pathname, kind }) => {
      const absolute = path.join(root, pathname);
      try {
        const [stat, canonical] = await Promise.all([lstat(absolute), realpath(absolute)]);
        if (path.relative(absolute, canonical) !== '' || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) return;
      } catch {
        return;
      }
      const displayPath = pathname + (kind === 'directory' ? '/' : '');
      return { path: displayPath, kind, value: separator.test(displayPath) || displayPath.startsWith('@')
        ? `@"${displayPath}"` : `@${displayPath}` };
    }));
    results.push(...batch.filter(Boolean));
  }
  return results.slice(0, maximumSuggestions);
}

module.exports = { findProjectFiles };
