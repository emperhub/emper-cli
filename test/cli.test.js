import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CLI exposes the interactive agent command and safety options', () => {
  const result = spawnSync(process.execPath, ['bin/emper.js', 'agent', '--help'], {
    cwd:root,
    encoding:'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /interactive AI coding agent/);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /--yes/);
  assert.match(result.stdout, /--max-turns/);
});
