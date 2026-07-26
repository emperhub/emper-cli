import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../src/workspace.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emper-workspace-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  const backups = path.join(root, 'backups');
  await fs.mkdir(project);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(project, '.gitignore'), 'ignored.txt\nignored-dir/\n');
  await fs.writeFile(path.join(project, 'safe.txt'), 'before\n');
  await fs.writeFile(path.join(project, '.env'), 'TOKEN=secret\n');
  await fs.writeFile(path.join(project, 'credentials.json'), '{}\n');
  await fs.writeFile(path.join(project, 'ignored.txt'), 'ignored\n');
  await fs.writeFile(path.join(project, 'notes.txt'), 'api_key = "sk-123456789012345678901234"\n');
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside\n');
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  return { root, project, outside, backups };
}

test('workspace excludes secrets and ignored files and blocks traversal', async t => {
  const { project, backups } = await fixture(t);
  const workspace = await createWorkspace(project, { backupRoot:backups });
  const files = await workspace.listFiles();
  assert.equal(files.includes('safe.txt'), true);
  assert.equal(files.includes('.env'), false);
  assert.equal(files.includes('credentials.json'), false);
  assert.equal(files.includes('ignored.txt'), false);
  await assert.rejects(workspace.readFile('../outside/outside.txt'), /traversal|current working directory/i);
  await assert.rejects(workspace.readFile('.env'), /Protected path/i);
  await assert.rejects(workspace.readFile('ignored.txt'), /Ignored path/i);
  await assert.rejects(workspace.readFile('notes.txt'), /contain secrets/i);
});

test('workspace blocks symlinks that escape the project', async t => {
  const { project, outside, backups } = await fixture(t);
  const link = path.join(project, 'outside-link');
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('This host does not allow test symlinks.');
    throw error;
  }
  const workspace = await createWorkspace(project, { backupRoot:backups });
  await assert.rejects(workspace.readFile('outside-link/outside.txt'), /Symlink escapes/i);
  assert.equal((await workspace.listFiles()).some(file => file.startsWith('outside-link')), false);
});

test('writes require approval and approved writes create a backup and diff', async t => {
  const { project, backups } = await fixture(t);
  const rejectedDiffs = [];
  const rejected = await createWorkspace(project, {
    allowWrite:true,
    backupRoot:backups,
    writeOutput:value => rejectedDiffs.push(value),
    approve:async () => false,
  });
  const rejectedResult = await rejected.writeFile('safe.txt', 'after\n');
  assert.equal(rejectedResult.approved, false);
  assert.equal(await fs.readFile(path.join(project, 'safe.txt'), 'utf8'), 'before\n');
  assert.match(rejectedDiffs.join(''), /-before/);
  assert.match(rejectedDiffs.join(''), /\+after/);

  const approved = await createWorkspace(project, {
    allowWrite:true,
    backupRoot:backups,
    approve:async () => true,
  });
  const approvedResult = await approved.writeFile('safe.txt', 'after\n');
  assert.equal(approvedResult.changed, true);
  assert.equal(await fs.readFile(path.join(project, 'safe.txt'), 'utf8'), 'after\n');
  assert.equal(await fs.readFile(approvedResult.backupPath, 'utf8'), 'before\n');

  const patch = [
    'Index: safe.txt',
    '===================================================================',
    '--- safe.txt\tbefore',
    '+++ safe.txt\tafter',
    '@@ -1,1 +1,1 @@',
    '-after',
    '+patched',
    '',
  ].join('\n');
  const patchResult = await approved.applyPatch('safe.txt', patch);
  assert.equal(patchResult.changed, true);
  assert.equal(await fs.readFile(path.join(project, 'safe.txt'), 'utf8'), 'patched\n');
});

test('read-only workspace rejects direct writes', async t => {
  const { project, backups } = await fixture(t);
  const workspace = await createWorkspace(project, { backupRoot:backups });
  await assert.rejects(workspace.writeFile('safe.txt', 'changed\n'), /--apply/);
});

test('workspace reads related files and applies exact reviewed replacements', async t => {
  const { project, backups } = await fixture(t);
  await fs.writeFile(path.join(project, 'second.txt'), 'second\n');
  const workspace = await createWorkspace(project, {
    allowWrite:true,
    backupRoot:backups,
    approve:async () => true,
  });
  const files = await workspace.readFiles([{ path:'safe.txt' }, { path:'second.txt' }]);
  assert.deepEqual(files.map(file => file.path), ['safe.txt', 'second.txt']);
  assert.deepEqual(await workspace.findFiles('**/*.txt'), ['notes.txt', 'safe.txt', 'second.txt']);
  const filteredMatches = await workspace.searchText('second', '.', { filePattern:'**/second.*' });
  assert.deepEqual(filteredMatches.map(match => match.path), ['second.txt']);

  const result = await workspace.replaceText('safe.txt', 'before', 'after');
  assert.equal(result.changed, true);
  assert.equal(result.occurrences, 1);
  assert.equal(await fs.readFile(path.join(project, 'safe.txt'), 'utf8'), 'after\n');

  await fs.writeFile(path.join(project, 'repeated.txt'), 'same same\n');
  await assert.rejects(workspace.replaceText('repeated.txt', 'same', 'next'), /appears 2 times/i);
});
