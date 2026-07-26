import test from 'node:test';
import assert from 'node:assert/strict';
import { main, routeArguments } from '../src/entry.js';

test('bare emper and OpenCode commands route to the bundled runtime', () => {
  assert.equal(routeArguments([]), 'opencode');
  assert.equal(routeArguments(['run', 'inspect this project']), 'opencode');
  assert.equal(routeArguments(['models', 'emper']), 'opencode');
  assert.equal(routeArguments(['session', 'list']), 'opencode');
  assert.equal(routeArguments(['mcp']), 'opencode');
});

test('Emper account commands remain local', () => {
  for (const command of ['login', 'logout', 'whoami', 'usage', 'config']) {
    assert.equal(routeArguments([command]), 'local');
  }
});

test('entry forwards arguments and propagates runtime exit codes', async () => {
  let received;
  const original = process.exitCode;
  process.exitCode = undefined;
  try {
    const code = await main(['node', 'emper', 'run', 'hello'], {
      launchOpenCode:async args => {
        received = args;
        return 7;
      },
    });
    assert.deepEqual(received, ['run', 'hello']);
    assert.equal(code, 7);
    assert.equal(process.exitCode, 7);
  } finally {
    process.exitCode = original;
  }
});

test('entry prints the Emper package version without starting OpenCode', async () => {
  let value = '';
  let launched = false;
  const code = await main(['node', 'emper', '--version'], {
    output:{ write:chunk => { value += chunk; } },
    launchOpenCode:async () => { launched = true; return 0; },
  });
  assert.equal(code, 0);
  assert.equal(value.trim(), '0.5.0');
  assert.equal(launched, false);
});
