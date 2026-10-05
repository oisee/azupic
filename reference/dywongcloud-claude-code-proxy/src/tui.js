import fs from 'node:fs';
import process from 'node:process';
import { readRecentLogEntries } from './monitor-store.js';

const ESC = '\u001b[';

export class MonitorTui {
  constructor(options) {
    this.store = options.store;
    this.logger = options.logger;
    this.config = options.config;
    this.version = options.version;
    this.address = options.address;
    this.standalone = options.standalone === true;
    this.pollStore = options.pollStore === true;
    this.onQuit = options.onQuit;
    this.onInterrupt = options.onInterrupt;
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.refreshMs = options.refreshMs ?? this.config.monitorRefreshMs ?? 500;
    this.timer = null;
    this.startedAt = Date.now();
    this.running = false;
    this.lastLogSignature = '';
    this.logs = [];
    this.boundData = (chunk) => this.handleKey(chunk);
    this.boundResize = () => this.render();
    this.unsubscribe = null;
  }

  start() {
    if (this.running) return;
    if (!this.stdout.isTTY) throw new Error('monitor requires a TTY');
    this.running = true;
    this.logger?.setStderrEnabled?.(false);
    this.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`);
    if (this.stdin.isTTY) {
      this.stdin.setRawMode?.(true);
      this.stdin.setEncoding('utf8');
      this.stdin.resume();
      this.stdin.on('data', this.boundData);
    }
    this.stdout.on?.('resize', this.boundResize);
    this.unsubscribe = this.store.subscribe?.(() => this.render());
    this.timer = setInterval(() => this.render(), this.refreshMs);
    this.timer.unref?.();
    this.render();
  }

  stop({ restoreLogger = true } = {}) {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stdout.off?.('resize', this.boundResize);
    if (this.stdin.isTTY) {
      this.stdin.off('data', this.boundData);
      this.stdin.setRawMode?.(false);
      this.stdin.pause();
    }
    this.stdout.write(`${ESC}?25h${ESC}?1049l`);
    if (restoreLogger) this.logger?.setStderrEnabled?.(this.config.logStderr);
  }

  handleKey(chunk) {
    const key = String(chunk);
    if (key === '\u0003') {
      this.stop({ restoreLogger: false });
      this.onInterrupt?.();
      return;
    }
    if (key.toLowerCase() === 'q') {
      this.stop();
      this.onQuit?.();
      return;
    }
    if (key.toLowerCase() === 'r') this.render(true);
  }

  render(force = false) {
    if (!this.running) return;
    if (this.pollStore) this.store.refreshIfChanged?.();
    this.refreshLogs(force);
    const snapshot = this.store.snapshot();
    const width = Math.max(72, this.stdout.columns || 120);
    const height = Math.max(24, this.stdout.rows || 40);
    const view = renderDashboard(snapshot, this.logs, {
      width,
      height,
      version: this.version,
      address: this.address,
      standalone: this.standalone,
      now: Date.now(),
      startedAt: this.startedAt,
      color: true,
      logFile: this.config.logFile,
    });
    this.stdout.write(`${ESC}H${view}${ESC}J`);
  }

  refreshLogs(force) {
    const file = this.config.logFile;
    const signature = logSignature(file);
    if (!force && signature === this.lastLogSignature) return;
    this.lastLogSignature = signature;
    this.logs = readRecentLogEntries(file, 200);
  }
}

export function renderDashboard(snapshot, logs, options = {}) {
  const width = Math.max(72, options.width ?? 120);
  const height = Math.max(24, options.height ?? 40);
  const color = options.color !== false;
  const c = palette(color);
  const processInfo = snapshot.process;
  const live = processInfo?.live;
  const status = live ? `${c.green}LIVE${c.reset}` : `${c.yellow}HISTORY${c.reset}`;
  const endpoint = options.address ?? formatProcessAddress(processInfo) ?? 'not connected';
  const uptime = processInfo?.startedAt && live
    ? formatDuration((options.now ?? Date.now()) - Date.parse(processInfo.startedAt))
    : '-';
  const totals = snapshot.totals;
  const title = `${c.bold}claude-code-proxy ${options.version ?? processInfo?.version ?? ''}${c.reset}  ${status}`;
  const summary = `listen ${endpoint}  uptime ${uptime}  req ${totals.requests}  active ${totals.active}  ok ${totals.completed}  err ${totals.failed}  abort ${totals.aborted}  tokens ${formatTokens(totals.inputTokens)}↓ ${formatTokens(totals.outputTokens)}↑ cache ${formatTokens(totals.cacheReadTokens)}/${formatTokens(totals.cacheCreationTokens)} R/C`;
  const lines = [fit(title, width), fit(summary, width), divider(width)];

  const remaining = height - lines.length - 1;
  const sessionRows = Math.max(3, Math.min(8, Math.floor(remaining * 0.28)));
  const requestRows = Math.max(3, Math.min(8, Math.floor(remaining * 0.28)));
  const logRows = Math.max(3, remaining - sessionRows - requestRows - 4);

  lines.push(`${c.bold}SESSIONS${c.reset}`);
  lines.push(fit('LAST      SESSION                 REQ ACT   IN      OUT     CACHE R/C      AVG     PROVIDER / MODEL', width));
  const sessions = snapshot.sessions.slice(0, sessionRows);
  if (!sessions.length) lines.push(dim('No recorded Claude Code sessions yet.', c));
  for (const session of sessions) {
    const avg = session.completed + session.failed + session.aborted > 0
      ? session.totalLatencyMs / (session.completed + session.failed + session.aborted)
      : 0;
    const provider = session.providers.at(-1) ?? '-';
    const model = session.models.at(-1) ?? '-';
    lines.push(fit(
      `${clock(session.lastSeen).padEnd(9)} ${compactId(session.sessionId, 22).padEnd(23)} ${String(session.requests).padStart(3)} ${String(session.active).padStart(3)} ${formatTokens(session.inputTokens).padStart(7)} ${formatTokens(session.outputTokens).padStart(7)} ${`${formatTokens(session.cacheReadTokens)}/${formatTokens(session.cacheCreationTokens)}`.padStart(12)} ${formatDuration(avg).padStart(7)}  ${provider} / ${model}`,
      width,
    ));
  }

  lines.push(divider(width));
  lines.push(`${c.bold}RECENT REQUESTS${c.reset}`);
  lines.push(fit('TIME      SESSION              PROVIDER  MODEL                         STATE   LATENCY    TOKENS', width));
  const combined = [
    ...snapshot.active.map((request) => ({ ...request, outcome: 'active', durationMs: (options.now ?? Date.now()) - Date.parse(request.time), usage: {} })),
    ...snapshot.recent,
  ].sort((a, b) => Date.parse(b.endedAt ?? b.time) - Date.parse(a.endedAt ?? a.time)).slice(0, requestRows);
  if (!combined.length) lines.push(dim('No model requests recorded yet.', c));
  for (const request of combined) {
    const state = request.outcome === 'active'
      ? `${c.cyan}RUN${c.reset}`
      : request.outcome === 'ok'
        ? `${c.green}OK${c.reset}`
        : request.outcome === 'error'
          ? `${c.red}ERR${c.reset}`
          : `${c.yellow}ABRT${c.reset}`;
    const usage = request.usage ?? {};
    const tokenText = `${formatTokens(usage.input_tokens ?? 0)}↓/${formatTokens(usage.output_tokens ?? 0)}↑`;
    const plainState = request.outcome === 'active' ? 'RUN' : request.outcome === 'ok' ? 'OK' : request.outcome === 'error' ? 'ERR' : 'ABRT';
    const raw = `${clock(request.endedAt ?? request.time).padEnd(9)} ${compactId(request.sessionId, 19).padEnd(20)} ${(request.provider ?? '-').padEnd(9)} ${compactText(request.upstreamModel ?? request.requestedModel ?? '-', 29).padEnd(29)} ${plainState.padEnd(7)} ${formatDuration(request.durationMs).padStart(8)}  ${tokenText}`;
    const styled = raw.replace(plainState.padEnd(7), `${state}${' '.repeat(Math.max(0, 7 - plainState.length))}`);
    lines.push(fit(styled, width));
  }

  lines.push(divider(width));
  lines.push(`${c.bold}EVENT LOG${c.reset} ${c.dim}${options.logFile ?? ''}${c.reset}`);
  const logSlice = logs.slice(-logRows);
  if (!logSlice.length) lines.push(dim('No log events yet.', c));
  for (const entry of logSlice) {
    const level = String(entry.level ?? 'info').toUpperCase().slice(0, 5);
    const levelColor = level === 'ERROR' ? c.red : level === 'WARN' ? c.yellow : level === 'DEBUG' ? c.dim : c.cyan;
    const meta = compactLogMeta(entry.meta);
    lines.push(fit(`${clock(entry.time)} ${levelColor}${level.padEnd(5)}${c.reset} ${entry.message ?? ''}${meta ? `  ${c.dim}${meta}${c.reset}` : ''}`, width));
  }

  while (visibleLines(lines) < height - 1) lines.push('');
  const footer = options.standalone
    ? 'q quit monitor  r refresh  Ctrl-C quit'
    : 'q detach monitor (proxy keeps running)  r refresh  Ctrl-C stop proxy';
  lines.push(fit(`${c.inverse} ${footer.padEnd(Math.max(0, width - 2))} ${c.reset}`, width));
  return lines.slice(0, height).join('\n');
}

function compactLogMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const keep = ['requestId', 'sessionId', 'agentId', 'provider', 'requestedModel', 'upstreamModel', 'model', 'status', 'durationMs', 'error', 'attempt'];
  return keep
    .filter((key) => meta[key] != null)
    .map((key) => `${key}=${compactText(String(meta[key]), key === 'error' ? 60 : 30)}`)
    .join(' ');
}

function formatProcessAddress(info) {
  if (!info?.bindAddress || !info?.port) return null;
  return `${info.bindAddress}:${info.port}`;
}

function compactId(value, max) {
  const text = String(value ?? '-');
  if (text.length <= max) return text;
  const left = Math.max(4, Math.floor((max - 1) * 0.55));
  return `${text.slice(0, left)}…${text.slice(-(max - left - 1))}`;
}

function compactText(value, max) {
  const text = String(value ?? '-').replace(/[\u0000-\u001f\u007f]/g, ' ');
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(number));
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m${Math.floor((value % 60_000) / 1000)}s`;
  return `${Math.floor(value / 3_600_000)}h${Math.floor((value % 3_600_000) / 60_000)}m`;
}

function clock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function divider(width) {
  return '─'.repeat(width);
}

function fit(text, width) {
  const visible = stripAnsi(text);
  if (visible.length <= width) return text;
  let output = '';
  let count = 0;
  for (let index = 0; index < text.length && count < width - 1;) {
    if (text[index] === '\u001b' && text[index + 1] === '[') {
      const end = text.indexOf('m', index);
      if (end !== -1) {
        output += text.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    output += text[index++];
    count += 1;
  }
  return `${output}…\u001b[0m`;
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

function visibleLines(lines) {
  return lines.length;
}

function dim(text, c) {
  return `${c.dim}${text}${c.reset}`;
}

function palette(enabled) {
  if (!enabled) return { reset: '', bold: '', dim: '', inverse: '', red: '', green: '', yellow: '', cyan: '' };
  return {
    reset: `${ESC}0m`,
    bold: `${ESC}1m`,
    dim: `${ESC}2m`,
    inverse: `${ESC}7m`,
    red: `${ESC}31m`,
    green: `${ESC}32m`,
    yellow: `${ESC}33m`,
    cyan: `${ESC}36m`,
  };
}

function logSignature(file) {
  if (!file) return '';
  return [`${file}.1`, file].map((candidate) => {
    try {
      const stat = fs.statSync(candidate);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return '-';
    }
  }).join('|');
}

