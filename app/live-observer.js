import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPackageDir } from '@earendil-works/pi-coding-agent';

// Substituted only in the private copy installed for this desktop run.
const run = '__FREEPI_DESKTOP_RUN__';
const capability = '__FREEPI_DESKTOP_CAPABILITY__';

let builtins;

function readBuiltinCommands() {
  // The host API exposes runtime extensions but keeps interactive built-ins in this module.
  builtins ??= import(pathToFileURL(join(getPackageDir(), 'dist', 'core', 'slash-commands.js')).href)
    .then(module => module.BUILTIN_SLASH_COMMANDS.map(command => ({ ...command, source: 'builtin' })))
    .catch(() => []);
  return builtins;
}

async function commandCatalog(pi) {
  const builtinCommands = await readBuiltinCommands();
  const seen = new Set();
  return [...builtinCommands, ...pi.getCommands()].flatMap(command => {
    const { name, description, source, argumentHint, sourceInfo } = command;
    if (typeof name !== 'string' || !name || seen.has(name)) return [];
    seen.add(name);
    return [{
      name,
      description: typeof description === 'string' ? description.slice(0, 1000) : '',
      source,
      argumentHint,
      scope: sourceInfo?.scope,
    }];
  });
}

export default function observe(pi) {
  const pipe = process.env.FREEPI_DESKTOP_PIPE;
  if (!pipe || process.env.FREEPI_DESKTOP_RUN !== run) return;

  let socket;
  let activeSession;
  let latest;
  let timer;
  let userTimestamp;
  let catalogRequest = 0;
  let lastContext;
  let initialPromptPending = false;
  let preferences = {};
  try { preferences = JSON.parse(process.env.FREEPI_DESKTOP_PROFILE || '{}'); } catch {}

  function send(event) {
    if (!socket || socket.destroyed) return;
    try {
      const line = JSON.stringify(event);
      if (Buffer.byteLength(line) <= 1024 * 1024) socket.write(line + '\n');
    } catch {
      // Observing must never interrupt the agent or change the event.
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (latest) send(latest);
    latest = undefined;
  }

  function reportContext(ctx) {
    if (!activeSession) return;
    const usage = ctx.getContextUsage?.();
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
    const context = contextWindow > 0 ? { tokens: usage?.tokens ?? null, contextWindow } : undefined;
    const next = JSON.stringify(context ?? null);
    if (next === lastContext) return;
    lastContext = next;
    send({ type: 'context', sessionId: activeSession, context });
  }

  function reportContextContent(ctx) {
    if (!activeSession) return;
    const messages = ctx.sessionManager.buildSessionProjection?.()?.messages;
    if (!Array.isArray(messages)) return;
    const systemPrompt = ctx.getSystemPrompt?.();
    const entries = [];
    for (const message of messages.slice(-100)) {
      const parts = typeof message.content === 'string' ? [message.content] : Array.isArray(message.content)
        ? message.content.flatMap(block => {
          if (block.type === 'text' && typeof block.text === 'string') return [block.text];
          if (block.type === 'toolCall') return [`Tool: ${block.name}`];
          if (block.type === 'image') return ['[Image]'];
          return [];
        }) : [];
      const text = (typeof message.summary === 'string' ? message.summary : parts.join('\n'));
      if (message.role !== 'system' && text) {
        const initial = message.role === 'custom' && message.customType === 'freepi-desktop-initial-prompt';
        entries.push({ role: initial ? 'initialPrompt' : message.role,
          text: !initial && text.length > 2500 ? text.slice(0, 2500) + '\n…' : text });
      }
    }
    const instructions = typeof systemPrompt === 'string' ? systemPrompt : '';
    if (instructions) entries.unshift({ role: 'system', text: instructions.length > 32000 ? instructions.slice(0, 32000) + '\n…' : instructions });
    const tools = pi.getActiveTools?.() ?? [];
    send({ type: 'context-content', sessionId: activeSession, entries, tools, limited: messages.length > 100 });
  }

  function assistant(message, complete, update) {
    if (!activeSession || message?.role !== 'assistant' || !Number.isFinite(message.timestamp)) return;
    const content = [];
    for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text });
      } else if (block?.type === 'thinking' && !block.redacted && typeof block.thinking === 'string') {
        content.push({ type: 'thinking', thinking: block.thinking,
          streaming: (update?.type === 'thinking_start' || update?.type === 'thinking_delta')
            && index === update.contentIndex });
      } else if (block?.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
        content.push({ type: 'toolCall', id: block.id, name: block.name });
      }
    }
    if (!content.length) return;
    latest = { type: 'assistant', sessionId: activeSession, timestamp: message.timestamp, content, complete };
    if (complete) flush();
    else if (!timer) {
      timer = setTimeout(flush, 40);
      timer.unref();
    }
  }

  pi.on('session_start', async (event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== 'tui') return;
    flush();
    activeSession = ctx.sessionManager.getSessionId();
    userTimestamp = undefined;
    lastContext = undefined;
    if (!socket || socket.destroyed) {
      socket = createConnection(pipe);
      socket.on('error', () => {});
      socket.unref();
      send({ type: 'hello', capability });
    }
    let preferenceError;
    let model = ctx.model;
    let available = [];
    try { available = await ctx.modelRegistry.getAvailable(); } catch {}
    const isNew = event.reason === 'new' || (event.reason === 'startup' && !ctx.sessionManager.getBranch().some(entry => entry.type === 'message'));
    initialPromptPending = event.reason === 'new' || (event.reason === 'startup' && isNew && preferences.newSession === true);
    if (isNew) {
      try {
        if (preferences.model) {
          const matching = available.find(item => (item.id === preferences.model || `${item.provider}/${item.id}` === preferences.model)
            && /^free-pi(?:-|$)/.test(item.provider));
          if (matching && await pi.setModel(matching)) model = matching;
          else preferenceError = "The preferred model for this project is unavailable in FreePi.";
        }
        if (preferences.thinking) pi.setThinkingLevel(preferences.thinking);
      } catch {
        preferenceError = "The CLI could not apply the new chat preferences.";
      }
    }
    send({ type: 'session', sessionId: activeSession, folder: ctx.cwd, trust: ctx.isProjectTrusted?.(),
      model: model && { id: model.id, name: model.name, provider: model.provider },
      thinking: pi.getThinkingLevel?.(), preferenceError });
    reportContext(ctx);
    reportContextContent(ctx);
    send({ type: 'models', sessionId: activeSession, models: available.filter(item => /^free-pi(?:-|$)/.test(item.provider))
      .map(({ id, name, provider }) => ({ id, name, provider })) });
    const request = ++catalogRequest;
    const sessionId = activeSession;
    void commandCatalog(pi).then(commands => {
      if (request === catalogRequest && activeSession === sessionId) send({ type: 'commands', sessionId, commands });
    }).catch(() => {});
  });

  pi.on('model_select', (event, ctx) => {
    const model = event.model;
    if (activeSession && model) send({ type: 'model', sessionId: activeSession,
      model: { id: model.id, name: model.name, provider: model.provider }, thinking: pi.getThinkingLevel?.() });
    reportContext(ctx);
  });

  pi.on('session_compact', (event, ctx) => {
    reportContext(ctx);
    reportContextContent(ctx);
    if (activeSession && event.reason === 'manual') send({ type: 'compaction', sessionId: activeSession, state: 'done' });
  });
  pi.on('session_compact_failed', (event, ctx) => {
    reportContext(ctx);
    if (activeSession && event.reason === 'manual') send({ type: 'compaction', sessionId: activeSession,
      state: event.aborted ? 'cancelled' : /nothing to compact/i.test(event.errorMessage ?? '') ? 'small' : 'failed' });
  });
  pi.on('session_tree', (_event, ctx) => { reportContext(ctx); reportContextContent(ctx); });

  pi.on('before_agent_start', (event, ctx) => {
    if (!activeSession || !initialPromptPending || event.messageType !== 'user') return;
    initialPromptPending = false;
    if (ctx.sessionManager.getBranch().some(entry => entry.type === 'custom_message' && entry.customType === 'freepi-desktop-initial-prompt')) return;
    let content;
    try {
      content = JSON.parse(readFileSync(process.env.FREEPI_DESKTOP_WORKSPACE, 'utf8')).desktopSettings?.initialPrompt;
    } catch { return; }
    if (typeof content !== 'string' || !content.trim()) return;
    return { message: { customType: 'freepi-desktop-initial-prompt', content: content.trim().slice(0, 8000), display: false } };
  });

  pi.registerCommand('desktop-fork', {
    description: 'Fork from a message in PiLoft',
    argumentHint: '<message-id>',
    handler: async (args, ctx) => {
      const entry = ctx.sessionManager.getBranch().find(item => item.id === args.trim() && item.type === 'message'
        && (item.message.role === 'user' || item.message.role === 'assistant'));
      if (entry) await ctx.fork(entry.id, { position: 'at' });
    },
  });

  pi.on('thinking_level_select', (event, ctx) => {
    if (!activeSession || !ctx.model) return;
    const { id, name, provider } = ctx.model;
    send({ type: 'model', sessionId: activeSession, model: { id, name, provider }, thinking: event.level });
  });

  pi.on('agent_start', () => {
    userTimestamp = undefined;
    if (activeSession) send({ type: 'started', sessionId: activeSession });
  });

  pi.on('ui_prompt_start', ({ kind, title }) => {
    if (activeSession) send({ type: 'confirmation', sessionId: activeSession, open: true, kind,
      title: typeof title === 'string' ? title.slice(0, 500) : undefined });
  });
  pi.on('ui_prompt_end', () => {
    if (activeSession) send({ type: 'confirmation', sessionId: activeSession, open: false });
  });

  pi.on('message_update', event => {
    const update = event.assistantMessageEvent;
    if (['text_delta', 'thinking_start', 'thinking_delta', 'thinking_end'].includes(update.type)) {
      assistant(event.message, false, update);
    }
  });

  pi.on('message_end', (event, ctx) => {
    if (event.message.role === 'user' && userTimestamp === undefined) userTimestamp = event.message.timestamp;
    assistant(event.message, true);
    if (event.message.role === 'assistant') reportContext(ctx);
  });

  pi.on('tool_execution_start', ({ toolCallId, toolName, args }) => {
    if (!activeSession) return;
    flush();
    const event = { type: 'tool', sessionId: activeSession, toolCallId, toolName, state: 'running' };
    try {
      if (Buffer.byteLength(JSON.stringify(args) ?? '') <= 32 * 1024) event.args = args;
    } catch {}
    send(event);
  });

  pi.on('tool_execution_end', ({ toolCallId, toolName, isError }) => {
    if (activeSession) send({
      type: 'tool', sessionId: activeSession, toolCallId, toolName, state: isError ? 'error' : 'done',
    });
  });

  pi.on('agent_settled', ({ aborted }, ctx) => {
    if (!activeSession) return;
    flush();
    reportContext(ctx);
    reportContextContent(ctx);
    const user = userTimestamp === undefined ? undefined : ctx.sessionManager.getBranch().find(entry =>
      entry.type === 'message' && entry.message.role === 'user' && entry.message.timestamp === userTimestamp);
    if (user) send({ type: 'user', sessionId: activeSession, messageId: user.id, timestamp: userTimestamp });
    const last = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
    const reply = last && (userTimestamp === undefined || last.message.timestamp >= userTimestamp) ? last.message : undefined;
    const failed = reply?.stopReason === 'error';
    const preview = !aborted && !failed && Array.isArray(reply?.content)
      ? reply.content.find(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())?.text.trim().slice(0, 900)
      : undefined;
    send({ type: 'settled', sessionId: activeSession, aborted: Boolean(aborted), failed, preview });
    userTimestamp = undefined;
  });

  pi.on('session_shutdown', () => {
    flush();
    activeSession = undefined;
    socket?.end();
    socket = undefined;
  });
}
