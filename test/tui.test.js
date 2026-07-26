import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { EmperTui, terminalText } from '../src/tui.js';

const waitForRender = () => new Promise(resolve => setTimeout(resolve, 60));
const baseConfig = { apiUrl:'https://example.test/v1', model:'nova-x1', maxTokens:2000 };

function services(overrides = {}) {
  return {
    env:{},
    cwd:'C:/demo-project',
    loadConfig:async () => ({ ...baseConfig }),
    saveConfig:async config => config,
    clearApiKey:async () => ({ ...baseConfig }),
    clientFactory:() => ({
      me:async () => ({ username:'demo-user', points:42, total_points_used:0, api_billing_mode:'points' }),
      openai:{},
    }),
    workspaceFactory:async (root, options) => ({ root, allowWrite:Boolean(options.allowWrite) }),
    sessionFactory:({ workspace, model }) => ({
      workspace,
      model,
      messages:[{ role:'system' }],
      clear() { this.messages.splice(1); },
      async ask() {},
    }),
    ...overrides,
  };
}

test('TUI masks and validates an API key before opening the agent', async t => {
  let savedConfig;
  const ui = render(React.createElement(EmperTui, {
    services:services({ saveConfig:async config => (savedConfig = config) }),
  }));
  t.after(() => ui.unmount());
  await waitForRender();
  assert.match(ui.lastFrame(), /CONNECT YOUR NOVA ACCOUNT/);
  assert.match(ui.lastFrame(), /ask-\.\.\./);

  const key = 'ask-1234567890123456';
  ui.stdin.write(key);
  await waitForRender();
  assert.doesNotMatch(ui.lastFrame(), new RegExp(key));
  assert.match(ui.lastFrame(), /\*{16}/);

  ui.stdin.write('\r');
  await waitForRender();
  assert.equal(savedConfig.apiKey, key);
  assert.match(ui.lastFrame(), /EMPER AGENT/);
  assert.match(ui.lastFrame(), /nova-x1\s+\|\s+READ ONLY\s+\|\s+42 pts/);
  assert.match(ui.lastFrame(), /demo-user/);
});

test('TUI rejects invalid credentials without exposing the key', async t => {
  const ui = render(React.createElement(EmperTui, {
    services:services({
      clientFactory:() => ({ me:async () => { throw Object.assign(new Error('bad ask-secret-123456789'), { status:401 }); } }),
    }),
  }));
  t.after(() => ui.unmount());
  await waitForRender();
  ui.stdin.write('ask-invalid-12345678');
  await waitForRender();
  ui.stdin.write('\r');
  await waitForRender();
  assert.match(ui.lastFrame(), /Authentication failed/);
  assert.doesNotMatch(ui.lastFrame(), /invalid-12345678|secret-123456789/);
});

test('TUI switches between read-only and reviewed edit modes', async t => {
  const modes = [];
  const ui = render(React.createElement(EmperTui, {
    services:services({
      loadConfig:async () => ({ ...baseConfig, apiKey:'ask-existing-12345678' }),
      workspaceFactory:async (root, options) => {
        modes.push(Boolean(options.allowWrite));
        return { root, allowWrite:Boolean(options.allowWrite) };
      },
    }),
  }));
  t.after(() => ui.unmount());
  await waitForRender();
  await waitForRender();
  assert.match(ui.lastFrame(), /READ ONLY/);
  ui.stdin.write('/apply');
  await waitForRender();
  ui.stdin.write('\r');
  await waitForRender();
  await waitForRender();
  assert.deepEqual(modes, [false, true]);
  assert.match(ui.lastFrame(), /REVIEW EDITS/);
  assert.match(ui.lastFrame(), /Every file change still requires Y\/N approval/);
});

test('TUI pauses an agent write until the displayed diff is approved', async t => {
  const decisions = [];
  const ui = render(React.createElement(EmperTui, {
    services:services({
      loadConfig:async () => ({ ...baseConfig, apiKey:'ask-existing-12345678' }),
      workspaceFactory:async (root, options) => ({
        root,
        allowWrite:Boolean(options.allowWrite),
        approve:options.approve,
      }),
      sessionFactory:({ workspace, model, write }) => ({
        workspace,
        model,
        messages:[{ role:'system' }],
        clear() { this.messages.splice(1); },
        async ask() {
          if (!workspace.allowWrite) return;
          const approved = await workspace.approve({
            path:'app.js',
            diff:'--- a/app.js\n+++ b/app.js\n-old\n+new',
          });
          decisions.push(approved);
          write(approved ? 'Applied app.js' : 'Skipped app.js');
        },
      }),
    }),
  }));
  t.after(() => ui.unmount());
  await waitForRender();
  await waitForRender();
  ui.stdin.write('/apply');
  await waitForRender();
  ui.stdin.write('\r');
  await waitForRender();
  await waitForRender();
  ui.stdin.write('change app');
  await waitForRender();
  ui.stdin.write('\r');
  await waitForRender();
  assert.match(ui.lastFrame(), /REVIEW  app\.js/);
  assert.match(ui.lastFrame(), /--- a\/app\.js/);
  assert.deepEqual(decisions, []);
  ui.stdin.write('y');
  await waitForRender();
  assert.deepEqual(decisions, [true]);
  assert.match(ui.lastFrame(), /Applied app\.js/);
});

test('terminal output strips control sequences and redacts credentials', () => {
  const output = terminalText('\u001b[31mhello ask-12345678901234567890\u001b[0m');
  assert.equal(output, 'hello [redacted]');
  assert.equal(output.includes('\u001b'), false);
});
