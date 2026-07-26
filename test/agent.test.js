import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentTools, createAgentSession, runAgent } from '../src/agent.js';
import { runInteractiveAgent } from '../src/cli.js';
import { createWorkspace } from '../src/workspace.js';

function fakeClient(responses, requests) {
  return {
    chat:{ completions:{ create:async request => {
      requests.push(structuredClone(request));
      return responses.shift();
    } } },
  };
}

test('read-only agent does not expose write tools', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emper-agent-read-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.writeFile(path.join(root, 'app.js'), 'console.log("ok");\n');
  const workspace = await createWorkspace(root);
  const requests = [];
  const client = fakeClient([{ choices:[{ message:{ role:'assistant', content:'No changes needed.' } }] }], requests);
  const output = [];
  await runAgent({ client, workspace, task:'inspect', model:'nova-x1', write:value => output.push(value) });
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['list_files', 'find_files', 'read_file', 'read_files', 'search_text']);
  assert.deepEqual(agentTools(false).map(tool => tool.function.name), ['list_files', 'find_files', 'read_file', 'read_files', 'search_text']);
  assert.deepEqual(agentTools(true).slice(-3).map(tool => tool.function.name), ['write_file', 'apply_patch', 'replace_text']);
  assert.equal(output.at(-1), 'No changes needed.');
});

test('agent write remains unchanged when per-action approval is denied', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emper-agent-write-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.writeFile(path.join(root, 'app.js'), 'before\n');
  const workspace = await createWorkspace(root, {
    allowWrite:true,
    backupRoot:path.join(root, '..', 'backups'),
    approve:async () => false,
  });
  const requests = [];
  const client = fakeClient([
    { choices:[{ message:{ role:'assistant', content:null, tool_calls:[{
      id:'call-write', type:'function', function:{ name:'write_file', arguments:JSON.stringify({ path:'app.js', content:'after\n' }) },
    }] } }] },
    { choices:[{ message:{ role:'assistant', content:'The proposed edit was not approved.' } }] },
  ], requests);
  await runAgent({ client, workspace, task:'change app', model:'nova-x1', write:() => {} });
  assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'before\n');
  assert.equal(requests[0].tools.some(tool => tool.function.name === 'write_file'), true);
  const toolMessage = requests[1].messages.find(message => message.role === 'tool');
  assert.match(toolMessage.content, /"approved": false/);
});

test('interactive agent session preserves context and can clear it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emper-agent-session-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const workspace = await createWorkspace(root);
  const requests = [];
  const client = fakeClient([
    { choices:[{ message:{ role:'assistant', content:'First answer' } }] },
    { choices:[{ message:{ role:'assistant', content:'Second answer' } }] },
    { choices:[{ message:{ role:'assistant', content:'Fresh answer' } }] },
  ], requests);
  const session = createAgentSession({ client, workspace, model:'nova-x1', write:() => {} });

  await session.ask('first task');
  await session.ask('follow-up task');
  assert.equal(requests[1].messages.some(message => message.content === 'first task'), true);
  assert.equal(requests[1].messages.some(message => message.content === 'First answer'), true);
  assert.equal(requests[1].messages.at(-1).content, 'follow-up task');

  session.clear();
  await session.ask('fresh task');
  assert.deepEqual(requests[2].messages.map(message => message.role), ['system', 'user']);
  assert.equal(requests[2].messages[1].content, 'fresh task');
});

test('interactive agent handles session commands without sending them to the model', async () => {
  const tasks = [];
  let clears = 0;
  const session = {
    model:'nova-x1',
    workspace:{ allowWrite:false },
    messages:[{ role:'system' }],
    ask:async task => { tasks.push(task); session.messages.push({ role:'user', content:task }); },
    clear:() => { clears += 1; session.messages.splice(1); },
  };
  const inputs = ['/status', 'inspect files', '/clear', 'find bug', '/help', '/exit'];
  const output = [];
  await runInteractiveAgent({
    session,
    read:async () => inputs.shift(),
    write:value => output.push(value),
  });
  assert.deepEqual(tasks, ['inspect files', 'find bug']);
  assert.equal(clears, 1);
  assert.equal(output.some(line => line.includes('Mode: read-only')), true);
  assert.equal(output.some(line => line.includes('/exit')), true);
});

test('agent emits detailed tool lifecycle events and restores saved context', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emper-agent-events-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.writeFile(path.join(root, 'one.js'), 'one\n');
  await fs.writeFile(path.join(root, 'two.js'), 'two\n');
  const workspace = await createWorkspace(root);
  const requests = [];
  const client = fakeClient([
    { choices:[{ message:{ role:'assistant', content:null, tool_calls:[{
      id:'call-read-many', type:'function', function:{
        name:'read_files',
        arguments:JSON.stringify({ files:[{ path:'one.js' }, { path:'two.js' }] }),
      },
    }] } }] },
    { choices:[{ message:{ role:'assistant', content:'Both files were inspected.' } }] },
  ], requests);
  const events = [];
  const session = createAgentSession({
    client,
    workspace,
    model:'nova-x1',
    initialMessages:[{ role:'user', content:'Earlier question' }, { role:'assistant', content:'Earlier answer' }],
    onEvent:event => events.push(event),
  });
  await session.ask('inspect both files');
  assert.equal(requests[0].messages.some(message => message.content === 'Earlier question'), true);
  assert.deepEqual(events.map(event => event.type), ['tool_start', 'tool_end', 'assistant']);
  assert.match(events[0].label, /Read 2 related files/);
  assert.equal(events[1].ok, true);
  assert.match(events[1].summary, /2 files read/);
});
