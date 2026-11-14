const { t } = require('./locale.js');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

function createProjectCommands(publish) {
  const jobs = new Map();
  const print = () => [...jobs.values()].map(({ child, ...job }) => job);

  function stop(id) {
    const job = jobs.get(id);
    if (!job?.child?.pid || job.state !== 'running') return;
    job.state = 'stopping';
    const close = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/pid', String(job.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    const failed = () => {
      if (job.state !== 'stopping') return;
      job.state = 'running';
      job.output += t("\nCould not stop the process tree.\n");
      publish(print());
    };
    close.once('error', failed);
    close.once('exit', code => { if (code) failed(); });
    publish(print());
  }

  function run(folder, command, shell) {
    if (jobs.size >= 16) {
      const old = [...jobs.values()].find(job => !job.child);
      if (!old) throw new Error(t("Too many commands are running."));
      jobs.delete(old.id);
    }
    const label = typeof command?.name === 'string' ? command.name : '';
    if (!label || typeof command.text !== 'string' || !command.text.trim()) throw new Error(t("No command provided."));
    const env = { ...process.env };
    const executable = shell === 'cmd' ? env.ComSpec || 'cmd.exe'
      : path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); ${command.text}`, 'utf16le').toString('base64');
    const child = spawn(executable, shell === 'cmd' ? ['/u', '/d', '/v:off', '/s', '/c', `"${command.text}"`]
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { cwd: folder, windowsHide: true, windowsVerbatimArguments: shell === 'cmd', stdio: ['ignore', 'pipe', 'pipe'] });
    const job = { id: randomUUID(), folder, name: label, output: '', state: 'running', child };
    const append = text => { job.output = (job.output + text).slice(-64000); publish(print()); };
    const end = (state, exitCode) => {
      if (!job.child) return;
      job.state = job.state === 'stopping' ? 'stopped' : state;
      job.exitCode = exitCode;
      job.child = undefined;
      publish(print());
    };
    jobs.set(job.id, job);
    for (const stream of [child.stdout, child.stderr]) {
      if (shell !== 'cmd') {
        stream.setEncoding('utf8').on('data', append);
        continue;
      }
      // CMD's built-ins use UTF-16LE with /u. Child programs may still write UTF-8.
      let decoder;
      stream.on('data', bytes => {
        decoder ??= new StringDecoder(bytes.includes(0) ? 'utf16le' : 'utf8');
        append(decoder.write(bytes));
      });
      stream.on('end', () => { if (decoder) append(decoder.end()); });
    }
    child.once('error', error => { append(error.message); end('failed'); });
    child.once('close', code => end(code === 0 ? 'done' : 'failed', code));
    publish(print());
    return job.id;
  }

  return { run, stop, list: print, close: () => { for (const id of jobs.keys()) stop(id); } };
}

module.exports = { createProjectCommands };
