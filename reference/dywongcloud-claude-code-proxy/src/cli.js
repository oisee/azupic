import process from 'node:process';
import { stdin, stdout } from 'node:process';
import { authStatus, providerKeyNames, removeStoredApiKey, resolveApiKey, storeApiKey } from './auth-store.js';
import { loadConfig, writeConfigTemplate } from './config.js';
import { normalizeError, ProxyError } from './errors.js';
import { createLogger } from './logging.js';
import { createMonitorStore } from './monitor-store.js';
import { MonitorTui } from './tui.js';
import { configFile } from './paths.js';
import { modelCatalog, TOKENHUB_DOCUMENTED_MODELS } from './router.js';
import { createProxyServer, listen } from './server.js';
import { VERSION } from './version.js';

export { VERSION };

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command = 'help', ...args] = argv;
  try {
    if (['help', '--help', '-h'].includes(command)) {
      printHelp();
      return 0;
    }
    if (['version', '--version', '-V'].includes(command)) {
      console.log(`claude-code-proxy ${VERSION}`);
      return 0;
    }
    if (command === 'serve') return await serveCommand(args, env);
    if (command === 'models') return modelsCommand(env);
    if (command === 'monitor') return await monitorCommand(args, env);
    if (command === 'config') return configCommand(args, env);
    if (command === 'openai' || command === 'moonshot' || command === 'tokenhub') return await providerCommand(command, args, env);
    throw new ProxyError(`Unknown command ${JSON.stringify(command)}`, { status: 400 });
  } catch (error) {
    const normalized = normalizeError(error);
    console.error(`Error: ${normalized.message}`);
    return 1;
  }
}

async function serveCommand(args, env) {
  const overrides = {};
  let monitorMode = 'auto';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') overrides.port = requiredOptionValue(args, ++index, '--port');
    else if (arg === '--bind') overrides.bindAddress = requiredOptionValue(args, ++index, '--bind');
    else if (arg === '--provider') overrides.defaultProvider = requiredOptionValue(args, ++index, '--provider');
    else if (arg === '--no-monitor') monitorMode = false;
    else if (arg === '--monitor') monitorMode = true;
    else throw new ProxyError(`Unknown serve option ${arg}`, { status: 400 });
  }

  const config = loadConfig({ env, overrides });
  const monitorEnabled = monitorMode === true || (monitorMode === 'auto' && stdin.isTTY && stdout.isTTY);
  if (monitorMode === true && (!stdin.isTTY || !stdout.isTTY)) {
    throw new ProxyError('--monitor requires an interactive TTY; use `claude-code-proxy monitor` from a terminal', { status: 400 });
  }
  const logger = createLogger(config);
  if (monitorEnabled) logger.setStderrEnabled(false);
  const proxy = createProxyServer({ config, env, logger });
  const address = await listen(proxy);
  const formattedAddress = formatAddress(address);
  let tui;
  let stopping = false;

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    tui?.stop({ restoreLogger: false });
    if (!monitorEnabled || !tui?.running) console.log(`\nReceived ${signal}; shutting down.`);
    await new Promise((resolve) => proxy.server.close(resolve));
  };

  if (monitorEnabled) {
    tui = new MonitorTui({
      store: proxy.telemetry,
      logger,
      config,
      version: VERSION,
      address: formattedAddress,
      standalone: false,
      onQuit: () => {
        console.log(`Monitor detached. Proxy is still listening on http://${formattedAddress}.`);
        console.log(`Reattach with: claude-code-proxy monitor`);
      },
      onInterrupt: () => void stop('SIGINT'),
    });
    tui.start();
  } else {
    printServeBanner(config, formattedAddress);
  }

  const sigint = () => void stop('SIGINT');
  const sigterm = () => void stop('SIGTERM');
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  try {
    return await new Promise((resolve, reject) => {
      proxy.server.once('error', reject);
      proxy.server.once('close', () => resolve(0));
    });
  } finally {
    tui?.stop({ restoreLogger: false });
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
}

async function monitorCommand(args, env) {
  let refreshMs;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--refresh') refreshMs = Number(requiredOptionValue(args, ++index, '--refresh'));
    else throw new ProxyError(`Unknown monitor option ${arg}`, { status: 400 });
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new ProxyError('monitor requires an interactive TTY', { status: 400 });
  if (refreshMs != null && (!Number.isFinite(refreshMs) || refreshMs < 100 || refreshMs > 10_000)) {
    throw new ProxyError('--refresh must be between 100 and 10000 milliseconds', { status: 400 });
  }
  const config = loadConfig({ env });
  const logger = createLogger(config);
  logger.setStderrEnabled(false);
  const store = createMonitorStore(config, { readOnly: true });
  return await new Promise((resolve) => {
    const tui = new MonitorTui({
      store,
      logger,
      config,
      version: VERSION,
      standalone: true,
      pollStore: true,
      refreshMs: refreshMs ?? config.monitorRefreshMs,
      onQuit: () => resolve(0),
      onInterrupt: () => resolve(0),
    });
    tui.start();
  });
}

function printServeBanner(config, formattedAddress) {
  console.log(`claude-code-proxy ${VERSION}`);
  console.log(`Listening on http://${formattedAddress}`);
  console.log(`Persistent monitor history: ${config.monitorFile}`);
  console.log(`Attach TUI: claude-code-proxy monitor`);
  for (const model of modelCatalog(config)) {
    console.log(`  ${model.route} -> ${model.provider} (${model.protocol})`);
  }
}

function modelsCommand(env) {
  const config = loadConfig({ env });
  console.log('ROUTE\tPROVIDER\tUPSTREAM MODEL\tAUTH');
  for (const item of modelCatalog(config)) {
    console.log(`${item.route}\t${item.provider}\t${item.upstreamModel}\t${item.auth}`);
  }
  console.log('\nBare routing: gpt-* -> OpenAI; kimi-* / k3 -> Moonshot; deepseek-*, glm-*, minimax-*, hy3, hy-* -> TokenHub.');
  console.log('\nDOCUMENTED TOKENHUB ANTHROPIC MODELS (2026-08-14 snapshot; activation/availability varies)');
  for (const model of TOKENHUB_DOCUMENTED_MODELS) console.log(`tokenhub/${model}`);
  console.log('Use `claude-code-proxy tokenhub auth test` to query the current upstream /v1/models catalog.');
  return 0;
}

function configCommand(args, env) {
  const [action = 'path', ...rest] = args;
  const destination = configFile(env);
  if (action === 'path') {
    console.log(destination);
    return 0;
  }
  if (action === 'init') {
    writeConfigTemplate(destination, { force: rest.includes('--force') });
    console.log(`Wrote ${destination}`);
    return 0;
  }
  if (action === 'show') {
    const config = loadConfig({ env });
    const safe = {
      ...config,
      openai: { ...config.openai, apiKeyFromConfig: config.openai.apiKeyFromConfig ? '[REDACTED]' : undefined },
      moonshot: { ...config.moonshot, apiKeyFromConfig: config.moonshot.apiKeyFromConfig ? '[REDACTED]' : undefined },
      tokenhub: { ...config.tokenhub, apiKeyFromConfig: config.tokenhub.apiKeyFromConfig ? '[REDACTED]' : undefined },
      proxyAuthToken: config.proxyAuthToken ? '[REDACTED]' : undefined,
    };
    console.log(JSON.stringify(safe, null, 2));
    return 0;
  }
  throw new ProxyError(`Unknown config action ${action}`, { status: 400 });
}

async function providerCommand(provider, args, env) {
  if (args[0] !== 'auth') throw new ProxyError(`Expected: ${provider} auth <login|status|test|logout>`, { status: 400 });
  const action = args[1] ?? 'status';
  const config = loadConfig({ env });

  if (action === 'login') {
    const key = await readSecret(`${providerLabel(provider)} API key: `);
    const location = storeApiKey(provider, key, env);
    console.log(`Stored ${provider} API key in ${location}`);
    if (!location.startsWith('macOS Keychain')) {
      console.log('The key file is stored with mode 0600 where POSIX file permissions are available.');
    }
    if (args.includes('--check')) await testCredential(provider, config, env, key);
    return 0;
  }
  if (action === 'status') {
    const status = authStatus(provider, config, env);
    if (!status.authenticated) {
      console.log(`${provider}: not configured`);
      console.log(`Set ${providerKeyNames(provider).join(' or ')}, or run ${provider} auth login.`);
      return 1;
    }
    console.log(`${provider}: configured`);
    console.log(`Key: ${status.key}`);
    console.log(`Source: ${status.source}`);
    return 0;
  }
  if (action === 'test') {
    const resolved = resolveApiKey(provider, config, env);
    if (!resolved) throw new ProxyError(`${provider} API key is not configured`, { status: 401 });
    await testCredential(provider, config, env, resolved.key);
    return 0;
  }
  if (action === 'logout') {
    const location = removeStoredApiKey(provider, env);
    console.log(`Removed stored ${provider} credentials from ${location}`);
    const envKey = providerKeyNames(provider).find((name) => env[name]);
    if (envKey) console.log(`Note: ${envKey} is still set and continues to take precedence.`);
    return 0;
  }
  throw new ProxyError(`Unknown ${provider} auth action ${action}`, { status: 400 });
}

async function testCredential(provider, config, env, key) {
  const baseUrl = config[provider].baseUrl;
  const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
  const response = await fetch(providerModelsUrl(provider, baseUrl), {
    headers,
    signal: AbortSignal.timeout(config[provider].requestTimeoutMs ?? config.requestTimeoutMs),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 1000);
    throw new ProxyError(`${provider} credential check failed with HTTP ${response.status}: ${text}`, {
      status: response.status,
    });
  }
  const parsed = await response.json();
  const count = Array.isArray(parsed?.data) ? parsed.data.length : Array.isArray(parsed?.models) ? parsed.models.length : null;
  console.log(`${provider} credential check succeeded${count == null ? '' : `; ${count} models visible`}.`);
}

function providerModelsUrl(provider, baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (provider === 'tokenhub') {
    if (/\/plan\/anthropic(?:\/v1)?$/i.test(base)) {
      return `${base.replace(/\/plan\/anthropic(?:\/v1)?$/i, '/plan/v3')}/models`;
    }
    if (/\/messages$/i.test(base)) return `${base.replace(/\/messages$/i, '')}/models`;
  }
  return `${base}/models`;
}

function providerLabel(provider) {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'moonshot') return 'Moonshot';
  if (provider === 'tokenhub') return 'Tencent Cloud TokenHub';
  return provider;
}

async function readSecret(prompt) {
  if (!stdin.isTTY) {
    let value = '';
    for await (const chunk of stdin) value += chunk;
    return value.trim();
  }

  stdout.write(prompt);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return await new Promise((resolve, reject) => {
    let value = '';
    const onData = (char) => {
      if (char === '\u0003') {
        cleanup();
        reject(new Error('Cancelled'));
      } else if (char === '\r' || char === '\n') {
        cleanup();
        stdout.write('\n');
        resolve(value.trim());
      } else if (char === '\u007f' || char === '\b') {
        if (value) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
      } else if (char >= ' ') {
        value += char;
        stdout.write('*');
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

function requiredOptionValue(args, index, option) {
  const value = args[index];
  if (value == null || value === '' || value.startsWith('--')) {
    throw new ProxyError(`${option} requires a value`, { status: 400 });
  }
  return value;
}

function formatAddress(address) {
  if (!address || typeof address === 'string') return String(address);
  return `${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
}

function printHelp() {
  console.log(`claude-code-proxy ${VERSION}\n
Use Claude Code with OpenAI Platform, Moonshot/Kimi, or Tencent Cloud TokenHub API keys.\n
USAGE:
  claude-code-proxy serve [--port PORT] [--bind ADDRESS] [--monitor|--no-monitor]
  claude-code-proxy monitor [--refresh MS]
  claude-code-proxy models
  claude-code-proxy openai auth login [--check]
  claude-code-proxy openai auth status|test|logout
  claude-code-proxy moonshot auth login [--check]
  claude-code-proxy moonshot auth status|test|logout
  claude-code-proxy tokenhub auth login [--check]
  claude-code-proxy tokenhub auth status|test|logout
  claude-code-proxy config init [--force]
  claude-code-proxy config path|show

KEY ENVIRONMENT VARIABLES:
  CCP_OPENAI_API_KEY / OPENAI_API_KEY
  CCP_MOONSHOT_API_KEY / MOONSHOT_API_KEY
  CCP_TOKENHUB_API_KEY / TOKENHUB_API_KEY
  CCP_OPENAI_BASE_URL (default https://api.openai.com/v1)
  CCP_MOONSHOT_BASE_URL (default https://api.moonshot.ai/v1)
  CCP_TOKENHUB_BASE_URL (default https://tokenhub-intl.tencentcloudmaas.com/v1)
  PORT (default 18765)
  CCP_MONITOR_FILE (persistent session/request history)
  CCP_MONITOR_REFRESH_MS (default 500)

MODEL ROUTING:
  openai/gpt-5.6-sol     -> OpenAI Responses API
  moonshot/kimi-k3       -> Moonshot Chat Completions
  tokenhub/deepseek-v4-flash -> TokenHub Anthropic Messages
  bare gpt-*             -> OpenAI
  bare kimi-* or k3      -> Moonshot
  bare deepseek-*, glm-*, minimax-*, hy3, or hy-* -> TokenHub
`);
}

