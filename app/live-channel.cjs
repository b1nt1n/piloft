const { randomBytes } = require('node:crypto');
const { rmdirSync, unlinkSync } = require('node:fs');
const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const path = require('node:path');

async function openLiveChannel(agentDir, onEvent) {
  const run = randomBytes(16).toString('hex');
  const capability = randomBytes(24).toString('hex');
  const pipe = '\\\\.\\pipe\\free-pi-desktop-' + randomBytes(16).toString('hex');
  const extensions = path.join(agentDir, 'extensions');
  const directory = path.join(extensions, 'free-pi-desktop-' + run);
  const extension = path.join(directory, 'index.ts');
  const staging = path.join(directory, 'index.tmp');
  const connections = new Set();
  let ownsDirectory = false;
  let madeExtensions = false;
  let closed = false;

  const server = createServer(socket => {
    if (closed || connections.size >= 8) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    socket.setTimeout(2500, () => socket.destroy());
    let pending = '';
    let authenticated = false;
    socket.on('data', chunk => {
      if (closed) return;
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        if (end > 1024 * 1024) return socket.destroy();
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { return socket.destroy(); }
        if (!authenticated) {
          if (event?.type !== 'hello' || event.capability !== capability) return socket.destroy();
          authenticated = true;
          socket.setTimeout(0);
        } else if (event && typeof event.sessionId === 'string') {
          onEvent(event);
        }
      }
      if (pending.length > 1024 * 1024) socket.destroy();
    });
  });
  server.on('error', () => {});

  function close() {
    if (closed) return;
    closed = true;
    for (const socket of connections) socket.destroy();
    server.close();
    if (ownsDirectory) {
      for (const file of [extension, staging]) {
        try { unlinkSync(file); } catch {}
      }
      try { rmdirSync(directory); } catch {}
    }
    if (madeExtensions) {
      try { rmdirSync(extensions); } catch {}
    }
  }

  try {
    const source = await readFile(path.join(__dirname, 'live-observer.js'), 'utf8');
    madeExtensions = Boolean(await mkdir(extensions, { recursive: true }));
    await mkdir(directory);
    ownsDirectory = true;
    const configured = source.replace('__FREEPI_DESKTOP_RUN__', run)
      .replace('__FREEPI_DESKTOP_CAPABILITY__', capability);
    await writeFile(staging, configured, { flag: 'wx' });
    await rename(staging, extension);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.unref();
    return { env: { FREEPI_DESKTOP_RUN: run, FREEPI_DESKTOP_PIPE: pipe }, close };
  } catch (error) {
    close();
    throw error;
  }
}

module.exports = { openLiveChannel };
