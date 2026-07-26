import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './errors.js';

export const DEFAULT_CONFIG = Object.freeze({
  apiUrl: 'https://ai-unchained.ink/v1',
  model: 'nova-x1',
  maxTokens: 2000,
});

export function configDirectory(env = process.env) {
  if (env.EMPER_CONFIG_DIR) return path.resolve(env.EMPER_CONFIG_DIR);
  const root = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config');
  return path.join(root, 'emper');
}

export function configPath(env = process.env) {
  return path.join(configDirectory(env), 'config.json');
}

export function normalizeApiUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new CliError('API URL must be a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new CliError('API URL must use HTTP or HTTPS.');
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHost) throw new CliError('API URL must use HTTPS unless it points to localhost.');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function validateModel(value) {
  const model = String(value || '').trim().toLowerCase();
  if (!/^nova-x\d{1,3}$/.test(model)) throw new CliError('Model must be a public Nova model ID, for example nova-x1.');
  return model;
}

function validateMaxTokens(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100000) {
    throw new CliError('maxTokens must be an integer between 1 and 100000.');
  }
  return parsed;
}

export function validateConfig(value = {}) {
  return {
    apiUrl: normalizeApiUrl(value.apiUrl ?? DEFAULT_CONFIG.apiUrl),
    model: validateModel(value.model ?? DEFAULT_CONFIG.model),
    maxTokens: validateMaxTokens(value.maxTokens ?? DEFAULT_CONFIG.maxTokens),
    ...(value.apiKey ? { apiKey: String(value.apiKey).trim() } : {}),
  };
}

export async function readConfig(env = process.env) {
  const filename = configPath(env);
  try {
    const contents = await fs.readFile(filename, 'utf8');
    const parsed = JSON.parse(contents);
    return validateConfig({ ...DEFAULT_CONFIG, ...parsed });
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG };
    if (error instanceof SyntaxError) throw new CliError(`Config file is not valid JSON: ${filename}`);
    throw error;
  }
}

export async function writeConfig(config, env = process.env) {
  const validated = validateConfig(config);
  const directory = configDirectory(env);
  const filename = configPath(env);
  await fs.mkdir(directory, { recursive:true, mode:0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode:0o600 });
  await fs.chmod(temporary, 0o600).catch(() => {});
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600).catch(() => {});
  return validated;
}

export async function updateConfig(changes, env = process.env) {
  const current = await readConfig(env);
  return writeConfig({ ...current, ...changes }, env);
}

export async function clearStoredApiKey(env = process.env) {
  const current = await readConfig(env);
  delete current.apiKey;
  return writeConfig(current, env);
}

export function resolveCredentials(config, env = process.env) {
  const environmentKey = String(env.EMPER_API_KEY || '').trim();
  const storedKey = String(config.apiKey || '').trim();
  return {
    apiKey: environmentKey || storedKey || null,
    source: environmentKey ? 'environment' : storedKey ? 'config' : null,
  };
}

export function maskApiKey(value) {
  const key = String(value || '');
  if (!key) return '(not set)';
  if (key.length <= 12) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

export function assertApiKey(value) {
  const key = String(value || '').trim();
  if (!/^ask-[A-Za-z0-9_-]{8,196}$/.test(key)) throw new CliError('API key must start with "ask-".');
  return key;
}
