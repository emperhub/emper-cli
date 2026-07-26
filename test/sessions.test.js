import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionRecord, listSessions, loadSession, saveSession } from '../src/sessions.js';

test('workspace sessions persist context without storing credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emper-sessions-'));
  const workspace = path.join(root, 'project');
  const configRoot = path.join(root, 'config');
  const env = { EMPER_CONFIG_DIR:configRoot };
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive:true, force:true }));

  const record = createSessionRecord({
    cwd:workspace,
    model:'nova-x3',
    id:'session-test-123',
    now:new Date('2026-07-26T00:00:00.000Z'),
  });
  record.title = 'Inspect ask-secret-12345678';
  record.messages = [
    { role:'system', content:'old system prompt' },
    { role:'user', content:'Use Bearer private-token-value' },
    { role:'assistant', content:'api_key="sk-secret-123456789"' },
  ];
  record.entries = [{ type:'user', text:'Inspect the app' }, { type:'assistant', text:'Done' }];
  await saveSession(record, workspace, env);

  const [summary] = await listSessions(workspace, env);
  assert.equal(summary.id, record.id);
  assert.equal(summary.model, 'nova-x3');
  assert.doesNotMatch(JSON.stringify(summary), /private-token-value|sk-secret|ask-secret/);
  assert.deepEqual(summary.messages.map(message => message.role), ['user', 'assistant']);

  const loaded = await loadSession(record.id, workspace, env);
  assert.deepEqual(loaded.entries.map(entry => entry.text), ['Inspect the app', 'Done']);
  const storedFiles = await fs.readdir(path.join(configRoot, 'sessions'), { recursive:true });
  const filename = storedFiles.find(file => String(file).endsWith('.json'));
  assert.ok(filename);
});

test('sessions cannot be loaded from another workspace', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emper-sessions-scope-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const env = { EMPER_CONFIG_DIR:path.join(root, 'config') };
  await fs.mkdir(first);
  await fs.mkdir(second);
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const record = createSessionRecord({ cwd:first, model:'nova-x1', id:'session-scope-123' });
  record.entries = [{ type:'user', text:'hello' }];
  await saveSession(record, first, env);
  assert.deepEqual(await listSessions(second, env), []);
  await assert.rejects(loadSession(record.id, second, env), /not found/i);
});
