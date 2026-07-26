import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Ignore from 'ignore';
import { applyPatch as applyUnifiedPatch, createTwoFilesPatch, parsePatch } from 'diff';
import { configDirectory } from './config.js';
import { CliError } from './errors.js';

const PROTECTED_SEGMENTS = new Set([
  '.git', '.hg', '.svn', '.emper', 'node_modules', 'vendor', '__pycache__',
]);
const PROTECTED_BASENAMES = new Set([
  '.npmrc', '.netrc', 'credentials', 'credentials.json', 'secrets.json',
  'id_rsa', 'id_ed25519', 'known_hosts', 'authorized_keys',
]);
const PROTECTED_EXTENSIONS = new Set([
  '.db', '.sqlite', '.sqlite3', '.pem', '.key', '.p12', '.pfx', '.kdbx', '.keystore',
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;

function toPosix(value) {
  return String(value || '.').replaceAll('\\', '/');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateRelativePath(value) {
  const input = toPosix(value).trim() || '.';
  if (input.includes('\0') || path.posix.isAbsolute(input) || /^[A-Za-z]:\//.test(input)) {
    throw new CliError('Only paths inside the current working directory are allowed.');
  }
  const segments = input.split('/').filter(Boolean);
  if (segments.includes('..')) throw new CliError('Path traversal is not allowed.');
  return path.posix.normalize(input).replace(/^\.\//, '');
}

function isProtected(relativePath) {
  const segments = toPosix(relativePath).split('/').filter(Boolean).map(segment => segment.toLowerCase());
  const basename = segments.at(-1) || '';
  if (segments.some(segment => PROTECTED_SEGMENTS.has(segment))) return true;
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (PROTECTED_BASENAMES.has(basename) || PROTECTED_EXTENSIONS.has(path.extname(basename))) return true;
  return /(?:^|[._-])(secret|credential|private[-_]?key)(?:[._-]|$)/i.test(basename);
}

function containsSecret(contents) {
  const value = String(contents || '');
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
    || /\b(?:ask|sk|sk-or-v1)-[A-Za-z0-9_-]{20,}\b/.test(value)
    || /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][^"']{16,}["']/i.test(value);
}

async function nearestExistingParent(target) {
  let current = target;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function loadIgnore(root) {
  const matcher = Ignore();
  try {
    matcher.add(await fs.readFile(path.join(root, '.gitignore'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return matcher;
}

function ignored(matcher, relativePath) {
  if (!relativePath || relativePath === '.') return false;
  const normalized = toPosix(relativePath).replace(/^\.\//, '');
  return matcher.ignores(normalized) || matcher.ignores(`${normalized}/`);
}

export async function createWorkspace(root = process.cwd(), options = {}) {
  const rootReal = await fs.realpath(path.resolve(root));
  const ignoreMatcher = await loadIgnore(rootReal);
  const allowWrite = Boolean(options.allowWrite);
  const autoApprove = Boolean(options.autoApprove);
  const approve = options.approve || (async () => false);
  const writeOutput = options.writeOutput || (() => {});
  const backupBase = options.backupRoot || path.join(
    configDirectory(options.env || process.env),
    'backups',
    crypto.createHash('sha256').update(rootReal).digest('hex').slice(0, 16),
  );

  async function resolveSafe(relativePath, { allowMissing = false } = {}) {
    const relative = validateRelativePath(relativePath);
    if (relative === '.') return { relative, absolute:rootReal };
    if (isProtected(relative)) throw new CliError(`Protected path cannot be accessed: ${relative}`);
    if (ignored(ignoreMatcher, relative)) throw new CliError(`Ignored path cannot be accessed: ${relative}`);
    const absolute = path.resolve(rootReal, ...relative.split('/'));
    if (!isInside(rootReal, absolute)) throw new CliError('Path escapes the current working directory.');
    let realTarget;
    try {
      realTarget = await fs.realpath(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
      const existingParent = await nearestExistingParent(path.dirname(absolute));
      realTarget = path.join(await fs.realpath(existingParent), path.relative(existingParent, absolute));
    }
    if (!isInside(rootReal, realTarget)) throw new CliError('Symlink escapes the current working directory.');
    return { relative, absolute };
  }

  async function listFiles(relativePath = '.', { maxFiles = 500, maxDepth = 8 } = {}) {
    const start = await resolveSafe(relativePath);
    const stat = await fs.lstat(start.absolute);
    if (!stat.isDirectory()) return [start.relative];
    const found = [];
    async function walk(directory, relativeDirectory, depth) {
      if (depth > maxDepth || found.length >= maxFiles) return;
      const entries = await fs.readdir(directory, { withFileTypes:true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (found.length >= maxFiles) break;
        const relative = relativeDirectory === '.' ? entry.name : `${relativeDirectory}/${entry.name}`;
        if (isProtected(relative) || ignored(ignoreMatcher, relative)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative, depth + 1);
        else if (entry.isFile()) found.push(relative);
      }
    }
    await walk(start.absolute, start.relative, 0);
    return found;
  }

  async function readFile(relativePath, { startLine = 1, endLine = 400 } = {}) {
    const target = await resolveSafe(relativePath);
    const stat = await fs.stat(target.absolute);
    if (!stat.isFile()) throw new CliError(`Not a file: ${target.relative}`);
    if (stat.size > MAX_READ_BYTES) throw new CliError(`File is too large to read: ${target.relative}`);
    const contents = await fs.readFile(target.absolute, 'utf8');
    if (contents.includes('\0')) throw new CliError(`Binary file cannot be read: ${target.relative}`);
    if (containsSecret(contents)) throw new CliError(`File may contain secrets and was blocked: ${target.relative}`);
    const lines = contents.split(/\r?\n/);
    const from = Math.max(1, Number(startLine) || 1);
    const to = Math.min(lines.length, Math.max(from, Number(endLine) || from + 399), from + 999);
    return {
      path:target.relative,
      startLine:from,
      endLine:to,
      totalLines:lines.length,
      content:lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join('\n'),
    };
  }

  async function searchText(query, relativePath = '.') {
    const needle = String(query || '');
    if (!needle || needle.length > 200) throw new CliError('Search text must contain 1-200 characters.');
    const files = await listFiles(relativePath, { maxFiles:500, maxDepth:12 });
    const results = [];
    for (const file of files) {
      if (results.length >= 200) break;
      try {
        const target = await resolveSafe(file);
        const stat = await fs.stat(target.absolute);
        if (stat.size > MAX_READ_BYTES) continue;
        const contents = await fs.readFile(target.absolute, 'utf8');
        if (contents.includes('\0') || containsSecret(contents)) continue;
        contents.split(/\r?\n/).forEach((line, index) => {
          if (results.length < 200 && line.toLowerCase().includes(needle.toLowerCase())) {
            results.push({ path:file, line:index + 1, text:line.slice(0, 500) });
          }
        });
      } catch {}
    }
    return results;
  }

  async function backupFile(target) {
    try {
      const stat = await fs.stat(target.absolute);
      if (!stat.isFile()) return null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupBase, timestamp, ...target.relative.split('/'));
    await fs.mkdir(path.dirname(backupPath), { recursive:true, mode:0o700 });
    await fs.copyFile(target.absolute, `${backupPath}.bak`);
    return `${backupPath}.bak`;
  }

  async function writeFile(relativePath, contents) {
    if (!allowWrite) throw new CliError('Writing is disabled. Run again with --apply.');
    const target = await resolveSafe(relativePath, { allowMissing:true });
    const next = String(contents ?? '');
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new CliError('Refusing to write a file larger than 1 MB.');
    if (containsSecret(next)) throw new CliError('Refusing to write content that appears to contain a secret.');
    let previous = '';
    let existed = true;
    try { previous = await fs.readFile(target.absolute, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') existed = false; else throw error; }
    if (previous === next) return { changed:false, path:target.relative, diff:'' };
    const patch = createTwoFilesPatch(`a/${target.relative}`, `b/${target.relative}`, previous, next, 'before', 'after');
    writeOutput(patch);
    if (!autoApprove && !(await approve({ path:target.relative, diff:patch, existed }))) {
      return { changed:false, approved:false, path:target.relative, diff:patch };
    }
    const backupPath = existed ? await backupFile(target) : null;
    await fs.mkdir(path.dirname(target.absolute), { recursive:true });
    const temporary = path.join(path.dirname(target.absolute), `.${path.basename(target.absolute)}.${process.pid}.tmp`);
    await fs.writeFile(temporary, next, 'utf8');
    await fs.rename(temporary, target.absolute);
    return { changed:true, approved:true, path:target.relative, diff:patch, backupPath };
  }

  async function applyPatch(relativePath, patchText) {
    const target = await resolveSafe(relativePath);
    const patch = String(patchText || '');
    if (patch.length > MAX_FILE_BYTES || parsePatch(patch).length !== 1) {
      throw new CliError('Patch must contain exactly one file and be no larger than 1 MB.');
    }
    const previous = await fs.readFile(target.absolute, 'utf8');
    const next = applyUnifiedPatch(previous, patch);
    if (next === false) throw new CliError(`Patch does not apply cleanly: ${target.relative}`);
    return writeFile(target.relative, next);
  }

  return {
    root:rootReal,
    allowWrite,
    listFiles,
    readFile,
    searchText,
    writeFile,
    applyPatch,
    resolveSafe,
  };
}
