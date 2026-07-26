import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearStoredApiKey,
  configPath,
  maskApiKey,
  readConfig,
  resolveCredentials,
  writeConfig,
} from '../src/config.js';

test('config stays outside projects, masks keys, and uses restrictive permissions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emper-config-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const env = { EMPER_CONFIG_DIR:path.join(root, 'private-config') };
  t.after(() => fs.rm(root, { recursive:true, force:true }));

  const apiKey = 'ask-1234567890abcdef1234567890abcdef';
  await writeConfig({
    apiUrl:'https://example.test/v1', model:'nova-x1', maxTokens:1234, apiKey,
  }, env);
  const filename = configPath(env);
  assert.equal(path.relative(project, filename).startsWith('..'), true);
  assert.deepEqual(await readConfig(env), {
    apiUrl:'https://example.test/v1', model:'nova-x1', maxTokens:1234, apiKey,
  });
  assert.equal(maskApiKey(apiKey), 'ask-1234...cdef');
  assert.equal(resolveCredentials(await readConfig(env), { ...env, EMPER_API_KEY:'ask-env-12345678' }).source, 'environment');
  assert.doesNotMatch(JSON.stringify({ masked:maskApiKey(apiKey) }), /1234567890abcdef1234567890abcdef/);

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filename)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.dirname(filename))).mode & 0o077, 0);
  }

  await clearStoredApiKey(env);
  assert.equal((await readConfig(env)).apiKey, undefined);
});

test('remote HTTP API URLs are rejected', async () => {
  await assert.rejects(
    writeConfig({ apiUrl:'http://example.test/v1', model:'nova-x1', maxTokens:100 }, { EMPER_CONFIG_DIR:path.join(os.tmpdir(), 'never-written') }),
    /must use HTTPS/,
  );
});
