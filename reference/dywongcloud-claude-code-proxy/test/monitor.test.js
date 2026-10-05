import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMonitorStore, readRecentLogEntries } from '../src/monitor-store.js';
import { renderDashboard } from '../src/tui.js';

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-monitor-'));
  return {
    root,
    monitorFile: path.join(root, 'monitor.jsonl'),
    monitorMaxBytes: 1024 * 1024,
    monitorHistoryRequests: 100,
    monitorHistorySessions: 100,
    logFile: path.join(root, 'proxy.log'),
  };
}

test('persistent monitor aggregates requests and reconstructs sessions from disk', () => {
  const config = tempConfig();
  const store = createMonitorStore(config, { instanceId: 'instance-a' });
  store.processStarted({ version: '1.2.0', bindAddress: '127.0.0.1', port: 18765 });
  store.requestStarted({
    requestId: 'req-1',
    sessionId: 'session-one',
    agentId: 'agent-a',
    provider: 'openai',
    requestedModel: 'openai/gpt-5.6-sol',
    upstreamModel: 'gpt-5.6-sol',
    stream: true,
    messageCount: 4,
    toolCount: 3,
  });
  store.requestFinished('req-1', {
    outcome: 'ok',
    status: 200,
    durationMs: 1250,
    stopReason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 75, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 },
  });
  store.processStopped('test');

  const fresh = createMonitorStore(config, { readOnly: true });
  const snapshot = fresh.snapshot();
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.totals.completed, 1);
  assert.equal(snapshot.totals.inputTokens, 1200);
  assert.equal(snapshot.totals.outputTokens, 75);
  assert.equal(snapshot.totals.cacheCreationTokens, 200);
  assert.equal(snapshot.sessions[0].sessionId, 'session-one');
  assert.equal(snapshot.sessions[0].requests, 1);
  assert.equal(snapshot.sessions[0].inputTokens, 1200);
  assert.equal(snapshot.recent[0].durationMs, 1250);
  assert.equal(snapshot.recent[0].provider, 'openai');
  assert.equal(snapshot.process.live, false);
  assert.ok(fs.statSync(config.monitorFile).size > 0);
});

test('new proxy process marks dangling requests from a previous instance interrupted', () => {
  const config = tempConfig();
  const first = createMonitorStore(config, { instanceId: 'instance-old' });
  first.processStarted({ version: '1.2.0', bindAddress: '127.0.0.1', port: 18765 });
  first.requestStarted({ requestId: 'req-dangling', sessionId: 'session-old', provider: 'moonshot', upstreamModel: 'kimi-k3' });

  const second = createMonitorStore(config, { instanceId: 'instance-new' });
  second.processStarted({ version: '1.2.0', bindAddress: '127.0.0.1', port: 18765 });
  const snapshot = second.snapshot();
  assert.equal(snapshot.active.length, 0);
  assert.equal(snapshot.recent[0].outcome, 'interrupted');
  assert.equal(snapshot.sessions.find((item) => item.sessionId === 'session-old').aborted, 1);
});

test('dashboard renders sessions, recent requests and logs within terminal height', () => {
  const snapshot = {
    process: { live: true, version: '1.2.0', startedAt: new Date(Date.now() - 5000).toISOString(), bindAddress: '127.0.0.1', port: 18765 },
    totals: { requests: 2, active: 1, completed: 1, failed: 0, aborted: 0, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 500, cacheCreationTokens: 100 },
    sessions: [{
      sessionId: 'session-1234567890', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), requests: 2, active: 1,
      completed: 1, failed: 0, aborted: 0, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 500, cacheCreationTokens: 100, totalLatencyMs: 900,
      providers: ['openai'], models: ['gpt-5.6-sol'], agents: ['agent-1'], lastOutcome: 'ok',
    }],
    active: [{ requestId: 'req-2', time: new Date().toISOString(), sessionId: 'session-1234567890', provider: 'moonshot', upstreamModel: 'kimi-k3' }],
    recent: [{ requestId: 'req-1', time: new Date().toISOString(), endedAt: new Date().toISOString(), sessionId: 'session-1234567890', provider: 'openai', upstreamModel: 'gpt-5.6-sol', outcome: 'ok', durationMs: 900, usage: { input_tokens: 1000, output_tokens: 50 } }],
    file: '/tmp/monitor.jsonl',
  };
  const dashboard = renderDashboard(snapshot, [{ time: new Date().toISOString(), level: 'info', message: 'request completed', meta: { provider: 'openai' } }], {
    width: 100,
    height: 30,
    version: '1.2.0',
    address: '127.0.0.1:18765',
    color: false,
  });
  assert.match(dashboard, /SESSIONS/);
  assert.match(dashboard, /RECENT REQUESTS/);
  assert.match(dashboard, /EVENT LOG/);
  assert.match(dashboard, /session-1234567890/);
  assert.ok(dashboard.split('\n').length <= 30);
});

test('log reader returns structured JSONL from current and rotated logs', () => {
  const config = tempConfig();
  fs.writeFileSync(`${config.logFile}.1`, `${JSON.stringify({ time: '2026-01-01T00:00:00Z', level: 'info', message: 'old' })}\n`);
  fs.writeFileSync(config.logFile, `${JSON.stringify({ time: '2026-01-01T00:00:01Z', level: 'warn', message: 'new' })}\n`);
  const logs = readRecentLogEntries(config.logFile, 10);
  assert.deepEqual(logs.map((item) => item.message), ['old', 'new']);
});

