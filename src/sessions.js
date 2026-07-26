import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configDirectory } from './config.js';
import { CliError } from './errors.js';

const SESSION_VERSION = 1;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 120;
const MAX_ENTRIES = 80;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

function redactStoredText(value) {
  return String(value || '')
    .replace(/\b(?:ask|sk|sk-or-v1)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/gi, '$1="[redacted]"')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function sanitize(value, key = '') {
  if (/(?:api.?key|client.?secret|access.?token|authorization)/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactStoredText(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  }
  return value;
}

function trimMessages(messages) {
  const safe = sanitize(Array.isArray(messages) ? messages : []).slice(-MAX_MESSAGES);
  const firstUser = safe.findIndex(message => message?.role === 'user');
  return firstUser < 0 ? [] : safe.slice(firstUser);
}

function normalizeEntries(entries) {
  return sanitize(Array.isArray(entries) ? entries : [])
    .filter(entry => entry && ['user', 'assistant', 'tool', 'system', 'error'].includes(entry.type))
    .slice(-MAX_ENTRIES)
    .map(entry => ({
      type:entry.type,
      text:redactStoredText(entry.text).slice(0, 60000),
      ...(entry.status ? { status:String(entry.status).slice(0, 20) } : {}),
    }));
}

function workspaceKey(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

function sessionsDirectory(cwd, env) {
  return path.join(configDirectory(env), 'sessions', workspaceKey(cwd));
}

function sessionPath(cwd, id, env) {
  if (!SESSION_ID.test(String(id || ''))) throw new CliError('Invalid session ID.');
  return path.join(sessionsDirectory(cwd, env), `${id}.json`);
}

export function createSessionRecord({ cwd, model, now = new Date(), id = crypto.randomUUID() }) {
  const timestamp = now.toISOString();
  return {
    version:SESSION_VERSION,
    id,
    title:'New session',
    workspace:path.resolve(cwd),
    model,
    createdAt:timestamp,
    updatedAt:timestamp,
    messages:[],
    entries:[],
  };
}

function normalizeRecord(record, cwd) {
  if (!record || record.version !== SESSION_VERSION || !SESSION_ID.test(String(record.id || ''))) {
    throw new CliError('Session file is not valid.');
  }
  const workspace = path.resolve(cwd);
  if (path.resolve(record.workspace || '') !== workspace) throw new CliError('Session belongs to another workspace.');
  return {
    version:SESSION_VERSION,
    id:record.id,
    title:redactStoredText(record.title || 'Untitled session').trim().slice(0, 80) || 'Untitled session',
    workspace,
    model:String(record.model || 'nova-x1'),
    createdAt:String(record.createdAt || new Date().toISOString()),
    updatedAt:String(record.updatedAt || new Date().toISOString()),
    messages:trimMessages(record.messages),
    entries:normalizeEntries(record.entries),
  };
}

export async function saveSession(record, cwd, env = process.env) {
  const normalized = normalizeRecord({ ...record, updatedAt:new Date().toISOString() }, cwd);
  const contents = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_SESSION_BYTES) {
    throw new CliError('Session is too large to save. Start a new session with /session.');
  }
  const directory = sessionsDirectory(cwd, env);
  const filename = sessionPath(cwd, normalized.id, env);
  await fs.mkdir(directory, { recursive:true, mode:0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, contents, { mode:0o600 });
  await fs.chmod(temporary, 0o600).catch(() => {});
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600).catch(() => {});
  return normalized;
}

export async function loadSession(id, cwd, env = process.env) {
  let contents;
  try {
    contents = await fs.readFile(sessionPath(cwd, id, env), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new CliError('Session was not found.');
    throw error;
  }
  if (Buffer.byteLength(contents) > MAX_SESSION_BYTES) throw new CliError('Session file is too large.');
  try {
    return normalizeRecord(JSON.parse(contents), cwd);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Session file is not valid JSON.');
  }
}

export async function listSessions(cwd, env = process.env) {
  let files;
  try {
    files = await fs.readdir(sessionsDirectory(cwd, env));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const file of files.filter(name => name.endsWith('.json')).slice(0, 100)) {
    try {
      records.push(await loadSession(file.slice(0, -5), cwd, env));
    } catch {}
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
}
