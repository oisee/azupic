import fs from 'node:fs';
import path from 'node:path';
import { configFile, defaultLogFile, defaultMonitorFile } from './paths.js';
import { normalizeBaseUrl, parseBoolean, parseInteger } from './util.js';
import { ProxyError } from './errors.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';
const TOKENHUB_BASE_URL = 'https://tokenhub-intl.tencentcloudmaas.com/v1';

/**
 * @param {{env?: NodeJS.ProcessEnv | Record<string, string | undefined>, overrides?: Record<string, unknown>}} [options]
 */
export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const location = configFile(env);
  const file = readConfigFile(location);
  const overrides = options.overrides ?? {};

  const bindAddress = String(
    overrides.bindAddress ?? env.CCP_BIND_ADDRESS ?? file.bindAddress ?? '127.0.0.1',
  );
  const port = parseInteger(overrides.port ?? env.PORT ?? file.port, 18765, { min: 1, max: 65535 });
  const defaultProvider = normalizeProvider(
    String(overrides.defaultProvider ?? env.CCP_DEFAULT_PROVIDER ?? file.defaultProvider ?? 'openai'),
    'defaultProvider',
  );
  const aliasProvider = normalizeProvider(
    String(overrides.aliasProvider ?? env.CCP_ALIAS_PROVIDER ?? file.aliasProvider ?? defaultProvider),
    'aliasProvider',
  );

  const openaiFile = objectOrEmpty(file.openai);
  const moonshotFile = objectOrEmpty(file.moonshot);
  const tokenhubFile = objectOrEmpty(file.tokenhub);
  const logFileConfig = objectOrEmpty(file.log);

  const config = {
    bindAddress,
    port,
    defaultProvider,
    aliasProvider,
    configFile: location,
    requestTimeoutMs: parseInteger(
      overrides.requestTimeoutMs ?? env.CCP_REQUEST_TIMEOUT_MS ?? file.requestTimeoutMs,
      120_000,
      { min: 1_000, max: 3_600_000 },
    ),
    streamIdleTimeoutMs: parseInteger(
      env.CCP_STREAM_IDLE_TIMEOUT_MS ?? file.streamIdleTimeoutMs,
      300_000,
      { min: 10_000, max: 3_600_000 },
    ),
    maxRequestBytes: parseInteger(
      env.CCP_MAX_REQUEST_BYTES ?? file.maxRequestBytes,
      20 * 1024 * 1024,
      { min: 1_024, max: 256 * 1024 * 1024 },
    ),
    maxResponseBytes: parseInteger(
      env.CCP_MAX_RESPONSE_BYTES ?? file.maxResponseBytes,
      64 * 1024 * 1024,
      { min: 1_024, max: 512 * 1024 * 1024 },
    ),
    maxRetries: parseInteger(env.CCP_MAX_RETRIES ?? file.maxRetries, 2, { min: 0, max: 8 }),
    retryBaseMs: parseInteger(env.CCP_RETRY_BASE_MS ?? file.retryBaseMs, 500, { min: 10, max: 60_000 }),
    pingIntervalMs: parseInteger(env.CCP_PING_INTERVAL_MS ?? file.pingIntervalMs, 15_000, {
      min: 1_000,
      max: 120_000,
    }),
    proxyAuthToken: stringOrUndefined(env.CCP_PROXY_AUTH_TOKEN ?? file.proxyAuthToken),
    corsOrigin: normalizeCorsOrigin(env.CCP_CORS_ORIGIN ?? file.corsOrigin),
    logVerbose: parseBoolean(env.CCP_LOG_VERBOSE ?? logFileConfig.verbose, false),
    logStderr: parseBoolean(env.CCP_LOG_STDERR ?? logFileConfig.stderr, true),
    logFile: stringOrUndefined(env.CCP_LOG_FILE ?? logFileConfig.file) ?? defaultLogFile(env),
    logMaxBytes: parseInteger(env.CCP_LOG_MAX_BYTES ?? logFileConfig.maxBytes, 20 * 1024 * 1024, {
      min: 64 * 1024,
      max: 1024 * 1024 * 1024,
    }),
    monitorFile: stringOrUndefined(env.CCP_MONITOR_FILE ?? file.monitorFile) ?? defaultMonitorFile(env),
    monitorMaxBytes: parseInteger(env.CCP_MONITOR_MAX_BYTES ?? file.monitorMaxBytes, 8 * 1024 * 1024, {
      min: 64 * 1024,
      max: 1024 * 1024 * 1024,
    }),
    monitorHistoryRequests: parseInteger(env.CCP_MONITOR_HISTORY_REQUESTS ?? file.monitorHistoryRequests, 300, {
      min: 25,
      max: 10_000,
    }),
    monitorHistorySessions: parseInteger(env.CCP_MONITOR_HISTORY_SESSIONS ?? file.monitorHistorySessions, 200, {
      min: 10,
      max: 5_000,
    }),
    monitorRefreshMs: parseInteger(env.CCP_MONITOR_REFRESH_MS ?? file.monitorRefreshMs, 500, {
      min: 100,
      max: 10_000,
    }),
    openai: {
      baseUrl: normalizeBaseUrl(env.CCP_OPENAI_BASE_URL ?? openaiFile.baseUrl, OPENAI_BASE_URL),
      apiKeyFromConfig: stringOrUndefined(openaiFile.apiKey),
      defaultModel: String(
        env.CCP_OPENAI_DEFAULT_MODEL ?? openaiFile.defaultModel ?? 'gpt-5.6-sol',
      ),
      organization: stringOrUndefined(env.CCP_OPENAI_ORG_ID ?? env.OPENAI_ORG_ID ?? env.OPENAI_ORGANIZATION ?? openaiFile.organization),
      project: stringOrUndefined(env.CCP_OPENAI_PROJECT_ID ?? env.OPENAI_PROJECT_ID ?? openaiFile.project),
      reasoningEffort: normalizeEffort(
        env.CCP_OPENAI_REASONING_EFFORT ?? openaiFile.reasoningEffort,
        ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      ),
      reasoningSummary: normalizeOptionalEnum(
        env.CCP_OPENAI_REASONING_SUMMARY ?? openaiFile.reasoningSummary,
        ['auto', 'concise', 'detailed'],
        'OpenAI reasoning summary',
      ),
      serviceTier: normalizeOptionalEnum(
        env.CCP_OPENAI_SERVICE_TIER ?? openaiFile.serviceTier,
        ['auto', 'default', 'flex', 'priority'],
        'OpenAI service tier',
      ),
      store: parseBoolean(env.CCP_OPENAI_STORE ?? openaiFile.store, false),
      encryptedReasoning: parseBoolean(
        env.CCP_OPENAI_ENCRYPTED_REASONING ?? openaiFile.encryptedReasoning,
        true,
      ),
    },
    moonshot: {
      baseUrl: normalizeBaseUrl(env.CCP_MOONSHOT_BASE_URL ?? moonshotFile.baseUrl, MOONSHOT_BASE_URL),
      apiKeyFromConfig: stringOrUndefined(moonshotFile.apiKey),
      defaultModel: String(
        env.CCP_MOONSHOT_DEFAULT_MODEL ?? moonshotFile.defaultModel ?? 'kimi-k3',
      ),
      reasoningEffort: normalizeEffort(
        env.CCP_MOONSHOT_REASONING_EFFORT ?? moonshotFile.reasoningEffort,
        ['low', 'medium', 'high', 'max'],
      ),
      mergeSystemIntoUserForK3: parseBoolean(
        env.CCP_MOONSHOT_MERGE_SYSTEM ?? moonshotFile.mergeSystemIntoUserForK3,
        false,
      ),
    },
    tokenhub: {
      baseUrl: normalizeBaseUrl(
        env.CCP_TOKENHUB_BASE_URL ?? env.TOKENHUB_BASE_URL ?? tokenhubFile.baseUrl,
        TOKENHUB_BASE_URL,
      ),
      apiKeyFromConfig: stringOrUndefined(tokenhubFile.apiKey),
      defaultModel: String(
        env.CCP_TOKENHUB_DEFAULT_MODEL ?? tokenhubFile.defaultModel ?? 'deepseek-v4-flash',
      ),
      anthropicVersion: String(
        env.CCP_TOKENHUB_ANTHROPIC_VERSION ?? tokenhubFile.anthropicVersion ?? '2023-06-01',
      ),
      hunyuanBeta: stringOrUndefined(
        env.CCP_TOKENHUB_HUNYUAN_BETA ?? tokenhubFile.hunyuanBeta,
      ),
      requestTimeoutMs: parseInteger(
        env.CCP_TOKENHUB_REQUEST_TIMEOUT_MS ?? tokenhubFile.requestTimeoutMs,
        600_000,
        { min: 1_000, max: 3_600_000 },
      ),
      streamIdleTimeoutMs: parseInteger(
        env.CCP_TOKENHUB_STREAM_IDLE_TIMEOUT_MS ?? tokenhubFile.streamIdleTimeoutMs,
        600_000,
        { min: 10_000, max: 3_600_000 },
      ),
      defaultMaxTokens: parseInteger(
        env.CCP_TOKENHUB_DEFAULT_MAX_TOKENS ?? tokenhubFile.defaultMaxTokens,
        131_072,
        { min: 1, max: 1_048_576 },
      ),
    },
  };

  validateBindSecurity(config);
  return config;
}

function readConfigFile(location) {
  try {
    const raw = fs.readFileSync(location, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('root must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new ProxyError(`Invalid configuration file ${location}: ${error.message}`, {
        status: 400,
        type: 'invalid_request_error',
        cause: error,
      });
    }
    throw error;
  }
}

function validateBindSecurity(config) {
  const address = config.bindAddress.toLowerCase();
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(address);
  if (!loopback && !config.proxyAuthToken) {
    throw new ProxyError(
      `Refusing to bind to ${config.bindAddress} without CCP_PROXY_AUTH_TOKEN. ` +
        'Set an inbound proxy token or bind to loopback.',
      { status: 400, type: 'invalid_request_error' },
    );
  }
  if (config.corsOrigin && !config.proxyAuthToken) {
    throw new ProxyError(
      'CCP_CORS_ORIGIN requires CCP_PROXY_AUTH_TOKEN so browser requests cannot spend provider quota anonymously.',
      { status: 400, type: 'invalid_request_error' },
    );
  }
}

function normalizeProvider(value, field) {
  const normalized = value.toLowerCase();
  if (!['openai', 'moonshot', 'tokenhub'].includes(normalized)) {
    throw new ProxyError(`${field} must be "openai", "moonshot", or "tokenhub"`, {
      status: 400,
      type: 'invalid_request_error',
    });
  }
  return normalized;
}

function normalizeEffort(value, allowed) {
  if (value == null || String(value).trim() === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new ProxyError(`Unsupported reasoning effort ${JSON.stringify(value)}; expected ${allowed.join(', ')}`, {
      status: 400,
      type: 'invalid_request_error',
    });
  }
  return normalized;
}

function normalizeOptionalEnum(value, allowed, label) {
  if (value == null || String(value).trim() === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new ProxyError(`${label} must be one of: ${allowed.join(', ')}`, {
      status: 400,
      type: 'invalid_request_error',
    });
  }
  return normalized;
}

function normalizeCorsOrigin(value) {
  if (value == null || String(value).trim() === '') return undefined;
  const normalized = String(value).trim();
  if (normalized === '*') return normalized;
  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') throw new Error('not an HTTP(S) origin');
    return parsed.origin;
  } catch (error) {
    throw new ProxyError(`CCP_CORS_ORIGIN must be * or an HTTP(S) origin: ${error.message}`, {
      status: 400,
      type: 'invalid_request_error',
      cause: error,
    });
  }
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringOrUndefined(value) {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized === '' ? undefined : normalized;
}

export function writeConfigTemplate(destination, { force = false } = {}) {
  if (!force && fs.existsSync(destination)) {
    throw new ProxyError(`Configuration file already exists: ${destination}`, {
      status: 409,
      type: 'invalid_request_error',
    });
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const template = {
    bindAddress: '127.0.0.1',
    port: 18765,
    defaultProvider: 'openai',
    aliasProvider: 'openai',
    openai: {
      baseUrl: OPENAI_BASE_URL,
      defaultModel: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      encryptedReasoning: true,
    },
    moonshot: {
      baseUrl: MOONSHOT_BASE_URL,
      defaultModel: 'kimi-k3',
      reasoningEffort: 'max',
      mergeSystemIntoUserForK3: false,
    },
    tokenhub: {
      baseUrl: TOKENHUB_BASE_URL,
      defaultModel: 'deepseek-v4-flash',
      anthropicVersion: '2023-06-01',
      requestTimeoutMs: 600000,
      streamIdleTimeoutMs: 600000,
      defaultMaxTokens: 131072,
    },
    log: { stderr: true, verbose: false },
    monitorHistoryRequests: 300,
    monitorHistorySessions: 200,
    monitorRefreshMs: 500,
  };
  fs.writeFileSync(destination, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
}

