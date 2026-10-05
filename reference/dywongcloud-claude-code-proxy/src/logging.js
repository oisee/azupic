import fs from 'node:fs';
import path from 'node:path';
import { boundedJson } from './util.js';

const SECRET_KEY = /(?:authorization|api[-_]?key|token|secret|password|cookie)/i;

export function createLogger(config) {
  const file = config.logFile;
  let stderrEnabled = config.logStderr;
  const listeners = new Set();
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  function write(level, message, meta) {
    const entry = {
      time: new Date().toISOString(),
      level,
      message,
      ...(meta === undefined ? {} : { meta: redact(meta) }),
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (file) {
      try {
        rotateIfNeeded(file, config.logMaxBytes);
        fs.appendFileSync(file, line, { mode: 0o600 });
      } catch (error) {
        if (stderrEnabled) console.error(JSON.stringify({ ...entry, logError: String(error) }));
      }
    }
    for (const listener of listeners) {
      try { listener(entry); } catch {}
    }
    if (stderrEnabled) {
      const output = level === 'error' ? console.error : console.log;
      output(config.logVerbose ? line.trimEnd() : `[${entry.time}] ${level}: ${message}`);
    }
  }

  return {
    debug(message, meta) {
      if (config.logVerbose) write('debug', message, meta);
    },
    info(message, meta) {
      write('info', message, meta);
    },
    warn(message, meta) {
      write('warn', message, meta);
    },
    error(message, meta) {
      write('error', message, meta);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setStderrEnabled(value) {
      stderrEnabled = Boolean(value);
    },
    getStderrEnabled() {
      return stderrEnabled;
    },
  };
}

function rotateIfNeeded(file, maxBytes) {
  try {
    if (fs.statSync(file).size < maxBytes) return;
    const rotated = `${file}.1`;
    try {
      fs.rmSync(rotated, { force: true });
    } catch {}
    fs.renameSync(file, rotated);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function redact(value, depth = 0) {
  if (depth > 8) return '[depth limit]';
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 8192 ? boundedJson(value, 8192) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : redact(entry, depth + 1),
    ]),
  );
}

