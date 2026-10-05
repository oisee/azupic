import os from 'node:os';
import path from 'node:path';

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function configRoot(env = process.env) {
  if (env.CCP_CONFIG_DIR) return path.resolve(env.CCP_CONFIG_DIR);
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-code-proxy');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-code-proxy');
}

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function stateRoot(env = process.env) {
  if (env.CCP_STATE_DIR) return path.resolve(env.CCP_STATE_DIR);
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || env.APPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claude-code-proxy');
  }
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'claude-code-proxy');
}

/** @param {'openai'|'moonshot'} provider @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function authFile(provider, env = process.env) {
  return path.join(configRoot(env), provider, 'auth.json');
}

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function configFile(env = process.env) {
  return env.CCP_CONFIG_FILE ? path.resolve(env.CCP_CONFIG_FILE) : path.join(configRoot(env), 'config.json');
}

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function defaultLogFile(env = process.env) {
  return path.join(stateRoot(env), 'proxy.log');
}

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function defaultMonitorFile(env = process.env) {
  return path.join(stateRoot(env), 'monitor.jsonl');
}

