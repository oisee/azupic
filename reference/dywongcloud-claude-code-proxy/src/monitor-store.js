import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const EVENT_VERSION = 1;

export function createMonitorStore(config, options = {}) {
  return new MonitorStore(config, options);
}

export class MonitorStore {
  constructor(config, options = {}) {
    this.file = config.monitorFile;
    this.maxBytes = config.monitorMaxBytes ?? 8 * 1024 * 1024;
    this.requestLimit = config.monitorHistoryRequests ?? 300;
    this.sessionLimit = config.monitorHistorySessions ?? 200;
    this.readOnly = options.readOnly === true;
    this.instanceId = options.instanceId ?? randomUUID();
    this.listeners = new Set();
    this.process = null;
    this.active = new Map();
    this.recent = [];
    this.sessions = new Map();
    this.totals = emptyTotals();
    this.fileSignature = '';
    this.started = false;
    this.stopped = false;
    this.reload();
    if (!this.readOnly && this.file) fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
  }

  processStarted(meta = {}) {
    if (this.readOnly || this.started) return;
    this.started = true;
    this.stopped = false;
    this.record({
      type: 'process_start',
      instanceId: this.instanceId,
      pid: process.pid,
      time: new Date().toISOString(),
      ...pick(meta, ['version', 'bindAddress', 'port']),
    });
  }

  processStopped(reason = 'shutdown') {
    if (this.readOnly || !this.started || this.stopped) return;
    this.stopped = true;
    this.record({
      type: 'process_stop',
      instanceId: this.instanceId,
      pid: process.pid,
      time: new Date().toISOString(),
      reason: String(reason).slice(0, 120),
    });
  }

  requestStarted(data) {
    if (this.readOnly) return;
    this.record({
      type: 'request_start',
      instanceId: this.instanceId,
      time: new Date().toISOString(),
      requestId: String(data.requestId),
      sessionId: normalizeIdentity(data.sessionId, 'unattributed'),
      agentId: normalizeIdentity(data.agentId, undefined),
      provider: cleanText(data.provider, 40),
      requestedModel: cleanText(data.requestedModel, 160),
      upstreamModel: cleanText(data.upstreamModel, 160),
      stream: data.stream === true,
      endpoint: cleanText(data.endpoint ?? '/v1/messages', 120),
      messageCount: integer(data.messageCount),
      toolCount: integer(data.toolCount),
    });
  }

  requestFinished(requestId, data = {}) {
    if (this.readOnly) return;
    const active = this.active.get(String(requestId));
    const startedAt = active ? Date.parse(active.time) : NaN;
    const durationMs = Number.isFinite(data.durationMs)
      ? Math.max(0, Math.round(data.durationMs))
      : Number.isFinite(startedAt)
        ? Math.max(0, Date.now() - startedAt)
        : 0;
    this.record({
      type: 'request_end',
      instanceId: this.instanceId,
      time: new Date().toISOString(),
      requestId: String(requestId),
      outcome: normalizeOutcome(data.outcome),
      status: integer(data.status),
      durationMs,
      stopReason: cleanText(data.stopReason, 80),
      error: cleanText(data.error, 500),
      usage: normalizeUsage(data.usage),
    });
  }

  snapshot() {
    const sessions = [...this.sessions.values()]
      .map((session) => ({
        ...session,
        providers: [...session.providers],
        models: [...session.models],
        agents: [...session.agents],
      }))
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
      .slice(0, this.sessionLimit);
    const active = [...this.active.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const recent = this.recent.slice(0, this.requestLimit);
    const live = this.process ? isProcessAlive(this.process.pid) && !this.process.stopped : false;
    return {
      process: this.process ? { ...this.process, live } : null,
      totals: { ...this.totals, active: active.length },
      sessions,
      active,
      recent,
      file: this.file,
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refreshIfChanged() {
    const signature = telemetrySignature(this.file);
    if (signature === this.fileSignature) return false;
    this.reload();
    return true;
  }

  reload() {
    this.process = null;
    this.active.clear();
    this.recent = [];
    this.sessions.clear();
    this.totals = emptyTotals();
    for (const event of readTelemetryEvents(this.file)) this.apply(event, { replay: true });
    this.fileSignature = telemetrySignature(this.file);
    return this.snapshot();
  }

  record(event) {
    this.apply(event, { replay: false });
    if (this.file) {
      try {
        rotateIfNeeded(this.file, this.maxBytes);
        fs.appendFileSync(this.file, `${JSON.stringify({ v: EVENT_VERSION, ...event })}\n`, { mode: 0o600 });
        this.fileSignature = telemetrySignature(this.file);
      } catch {
        // Monitoring must never take down the proxy. The regular logger will
        // still capture the request even if this optional history file fails.
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  apply(event, { replay = false } = {}) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'process_start') {
      this.closeStaleActive(event.time, event.instanceId);
      this.process = {
        instanceId: event.instanceId,
        pid: integer(event.pid),
        startedAt: event.time,
        stopped: false,
        version: event.version,
        bindAddress: event.bindAddress,
        port: event.port,
      };
      return;
    }
    if (event.type === 'process_stop') {
      if (this.process?.instanceId === event.instanceId) {
        this.process = { ...this.process, stopped: true, stoppedAt: event.time, stopReason: event.reason };
        this.closeInstanceActive(event.instanceId, event.time, 'aborted');
      }
      return;
    }
    if (event.type === 'request_start') {
      const request = {
        requestId: String(event.requestId),
        instanceId: event.instanceId,
        time: event.time,
        sessionId: normalizeIdentity(event.sessionId, 'unattributed'),
        agentId: normalizeIdentity(event.agentId, undefined),
        provider: event.provider,
        requestedModel: event.requestedModel,
        upstreamModel: event.upstreamModel,
        stream: event.stream === true,
        endpoint: event.endpoint,
        messageCount: integer(event.messageCount),
        toolCount: integer(event.toolCount),
      };
      this.active.set(request.requestId, request);
      this.totals.requests += 1;
      const session = this.getSession(request.sessionId, request.time);
      session.requests += 1;
      session.active += 1;
      session.lastSeen = request.time;
      if (request.provider) session.providers.add(request.provider);
      if (request.upstreamModel) session.models.add(request.upstreamModel);
      if (request.agentId) session.agents.add(request.agentId);
      this.trimSessions();
      return;
    }
    if (event.type === 'request_end') {
      const request = this.active.get(String(event.requestId));
      if (!request) return;
      this.active.delete(request.requestId);
      const usage = normalizeUsage(event.usage);
      const outcome = normalizeOutcome(event.outcome);
      const ended = {
        ...request,
        endedAt: event.time,
        outcome,
        status: integer(event.status),
        durationMs: integer(event.durationMs),
        stopReason: event.stopReason,
        error: event.error,
        usage,
      };
      this.recent.unshift(ended);
      if (this.recent.length > this.requestLimit) this.recent.length = this.requestLimit;
      this.applyCompletedToAggregates(ended);
      return;
    }
    if (!replay) return;
  }

  getSession(sessionId, time) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        firstSeen: time,
        lastSeen: time,
        requests: 0,
        active: 0,
        completed: 0,
        failed: 0,
        aborted: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalLatencyMs: 0,
        providers: new Set(),
        models: new Set(),
        agents: new Set(),
        lastOutcome: null,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  applyCompletedToAggregates(request) {
    const session = this.getSession(request.sessionId, request.time);
    session.active = Math.max(0, session.active - 1);
    session.lastSeen = request.endedAt ?? request.time;
    session.lastOutcome = request.outcome;
    session.inputTokens += request.usage.input_tokens;
    session.outputTokens += request.usage.output_tokens;
    session.cacheReadTokens += request.usage.cache_read_input_tokens;
    session.cacheCreationTokens += request.usage.cache_creation_input_tokens;
    session.totalLatencyMs += request.durationMs;
    if (request.outcome === 'ok') {
      session.completed += 1;
      this.totals.completed += 1;
    } else if (request.outcome === 'aborted' || request.outcome === 'interrupted') {
      session.aborted += 1;
      this.totals.aborted += 1;
    } else {
      session.failed += 1;
      this.totals.failed += 1;
    }
    this.totals.inputTokens += request.usage.input_tokens;
    this.totals.outputTokens += request.usage.output_tokens;
    this.totals.cacheReadTokens += request.usage.cache_read_input_tokens;
    this.totals.cacheCreationTokens += request.usage.cache_creation_input_tokens;
  }

  closeStaleActive(time, nextInstanceId) {
    for (const request of [...this.active.values()]) {
      if (request.instanceId !== nextInstanceId) this.finishInMemory(request, time, 'interrupted');
    }
  }

  closeInstanceActive(instanceId, time, outcome) {
    for (const request of [...this.active.values()]) {
      if (request.instanceId === instanceId) this.finishInMemory(request, time, outcome);
    }
  }

  finishInMemory(request, time, outcome) {
    this.active.delete(request.requestId);
    const ended = {
      ...request,
      endedAt: time,
      outcome,
      status: 0,
      durationMs: Math.max(0, Date.parse(time) - Date.parse(request.time)) || 0,
      usage: normalizeUsage(),
      error: outcome === 'interrupted' ? 'proxy process restarted before request completion' : undefined,
    };
    this.recent.unshift(ended);
    if (this.recent.length > this.requestLimit) this.recent.length = this.requestLimit;
    this.applyCompletedToAggregates(ended);
  }

  trimSessions() {
    if (this.sessions.size <= this.sessionLimit * 2) return;
    const keep = [...this.sessions.values()]
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
      .slice(0, this.sessionLimit);
    this.sessions = new Map(keep.map((session) => [session.sessionId, session]));
  }
}

export function readRecentLogEntries(file, limit = 100, maxBytes = 256 * 1024) {
  if (!file || limit <= 0) return [];
  const entries = [];
  for (const candidate of [`${file}.1`, file]) {
    for (const line of readTailLines(candidate, maxBytes)) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object') entries.push(entry);
      } catch {}
    }
  }
  return entries.slice(-limit);
}

function readTelemetryEvents(file) {
  if (!file) return [];
  const events = [];
  for (const candidate of [`${file}.1`, file]) {
    let content;
    try {
      content = fs.readFileSync(candidate, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.v === EVENT_VERSION || event?.type) events.push(event);
      } catch {}
    }
  }
  return events;
}

function readTailLines(file, maxBytes) {
  let handle;
  try {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (handle != null) {
      try { fs.closeSync(handle); } catch {}
    }
  }
}

function telemetrySignature(file) {
  if (!file) return '';
  return [`${file}.1`, file]
    .map((candidate) => {
      try {
        const stat = fs.statSync(candidate);
        return `${stat.size}:${stat.mtimeMs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

function rotateIfNeeded(file, maxBytes) {
  try {
    if (fs.statSync(file).size < maxBytes) return;
    const rotated = `${file}.1`;
    fs.rmSync(rotated, { force: true });
    fs.renameSync(file, rotated);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: integer(usage?.input_tokens),
    output_tokens: integer(usage?.output_tokens),
    cache_read_input_tokens: integer(usage?.cache_read_input_tokens),
    cache_creation_input_tokens: integer(usage?.cache_creation_input_tokens),
  };
}

function normalizeOutcome(value) {
  return ['ok', 'error', 'aborted', 'interrupted'].includes(value) ? value : 'ok';
}

function normalizeIdentity(value, fallback) {
  if (value == null || value === '') return fallback;
  return cleanText(value, 160) ?? fallback;
}

function cleanText(value, max) {
  if (value == null) return undefined;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || undefined;
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function pick(object, keys) {
  const out = {};
  for (const key of keys) if (object[key] != null) out[key] = object[key];
  return out;
}

function emptyTotals() {
  return { requests: 0, completed: 0, failed: 0, aborted: 0, active: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

