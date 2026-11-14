const { t } = require('./locale.js');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

function createJobs({ read, save, validFolder, validSession, schedulesEnabled = () => true }) {
  const interrupted = t("The app closed before this run finished. Check the chat before trying again.");
  const nowState = () => {
    const data = read().tasks;
    return Object.fromEntries(['queue', 'schedules', 'runs'].map(key => [key, Array.isArray(data?.[key]) ? data[key] : []]));
  };

  function store(state) {
    if (!save({ tasks: state })) throw new Error(t("Could not save tasks."));
    return state;
  }

  function text(value, limit) {
    return typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : '';
  }

  function prompt(value) {
    const result = text(value, 32000);
    if (!result || /^[!/]/.test(result) || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(result)) {
      throw new Error(t("Enter a plain-text request without CLI commands."));
    }
    return result;
  }

  function target(input) {
    if (!validFolder(input.folder)) throw new Error(t("Project folder unavailable."));
    if (input.sessionId && !validSession(input.sessionId)) throw new Error(t("Invalid chat ID."));
    return { folder: path.resolve(input.folder), sessionId: input.sessionId || undefined };
  }

  function finish(state, job, status, message, sessionId) {
    state.runs.unshift({ ...job, prompt: undefined, status, message, sessionId: sessionId || job.sessionId, endedAt: Date.now() });
    state.runs.length = Math.min(state.runs.length, 100);
    state.queue = state.queue.filter(item => item.id !== job.id);
  }

  return {
    initialize() {
      const state = nowState();
      const unfinished = state.queue.filter(job => job.status === 'running');
      if (!unfinished.length) return;
      for (const job of unfinished) finish(state, job, 'interrupted', interrupted);
      store(state);
    },
    update(action, input = {}) {
      const state = nowState();
      const job = state.queue.find(item => item.id === input.id);
      const schedule = state.schedules.find(item => item.id === input.id);
      const clock = Date.now();
      switch (action) {
        case 'list': return state;
        case 'enqueue': {
          state.queue.push({ id: randomUUID(), ...target(input), prompt: prompt(input.prompt), status: 'waiting', createdAt: clock });
          break;
        }
        case 'edit':
          if (!job || job.status !== 'waiting') throw new Error(t("This request has already started."));
          job.prompt = prompt(input.prompt);
          break;
        case 'remove':
          if (!job || job.status !== 'waiting') throw new Error(t("This request has already started."));
          state.queue = state.queue.filter(item => item !== job);
          break;
        case 'claim':
          if (!job || job.status !== 'waiting' || (job.scheduleId && !schedulesEnabled())
            || state.queue.some(item => item.status === 'running')) return { ok: false, state };
          job.status = 'running';
          job.startedAt = clock;
          break;
        case 'finish':
          if (!job || job.status !== 'running') return state;
          finish(state, job, input.status === 'done' ? 'done' : 'failed', text(input.message, 300),
            validSession(input.sessionId) ? input.sessionId : undefined);
          break;
        case 'schedule': {
          if (!schedulesEnabled()) throw new Error(t("Enable experimental schedules in General settings."));
          const name = text(input.name, 90);
          const nextAt = Number(input.nextAt);
          if (!name || !Number.isFinite(nextAt) || nextAt <= clock || nextAt > 8.64e15 - 86400000 * 8) {
            throw new Error(t("Enter a name and a future start time."));
          }
          if (!['once', 'daily', 'weekly'].includes(input.repeat)) throw new Error(t("Invalid repeat interval."));
          state.schedules.push({ id: randomUUID(), ...target({ folder: input.folder }), name, prompt: prompt(input.prompt),
            nextAt, repeat: input.repeat, enabled: true });
          break;
        }
        case 'toggle-schedule':
          if (!schedule || schedule.completed) return state;
          schedule.enabled = !schedule.enabled;
          break;
        case 'remove-schedule':
          if (!schedule) return state;
          state.schedules = state.schedules.filter(item => item !== schedule);
          break;
        case 'tick': {
          if (!schedulesEnabled()) return state;
          const due = state.schedules.filter(item => item.enabled && item.nextAt <= clock);
          if (!due.length) return state;
          for (const item of due) {
            if (!state.queue.some(job => job.scheduleId === item.id)) {
              state.queue.push({ id: randomUUID(), scheduleId: item.id, folder: item.folder, name: item.name,
                prompt: item.prompt, status: 'waiting', createdAt: clock });
            }
            if (item.repeat === 'once') {
              item.enabled = false;
              item.completed = true;
            }
            else {
              const next = new Date(item.nextAt);
              const days = item.repeat === 'daily' ? 1 : 7;
              const elapsedDays = Math.floor((clock - item.nextAt) / 86400000);
              next.setDate(next.getDate() + Math.max(1, Math.floor(elapsedDays / days)) * days);
              if (next.getTime() <= clock) next.setDate(next.getDate() + days);
              item.nextAt = next.getTime();
            }
          }
          break;
        }
        default: throw new Error(t("Unknown task action."));
      }
      store(state);
      return action === 'claim' ? { ok: true, state } : state;
    },
  };
}

module.exports = { createJobs };
