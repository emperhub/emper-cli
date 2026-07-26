import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOpenCodeConfig,
  buildOpenCodeEnvironment,
  installRuntimeTheme,
  normalizeRuntimeModels,
  rebrandOutput,
  resolveOpenCodeBinary,
} from '../src/opencode-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = [
  { id:'nova-x1', name:'Nova X1' },
  { id:'provider/secret-model', name:'Provider Secret' },
  { id:'nova-x5', name:'Nova X5' },
];

test('runtime model normalization only exposes supported public Nova IDs', () => {
  assert.deepEqual(normalizeRuntimeModels({ data:models }), [
    { id:'nova-x1', name:'Nova X1' },
    { id:'nova-x5', name:'Nova X5' },
  ]);
});

test('OpenCode config is restricted to Emper and keeps credentials indirect', () => {
  const secret = 'ask-super-secret-value';
  const env = buildOpenCodeEnvironment({
    apiKey:secret,
    apiUrl:'https://example.test/v1',
    account:{ username:'demo' },
    models,
    config:{ model:'nova-x1' },
    env:{ PATH:'test' },
  });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);

  assert.deepEqual(config.enabled_providers, ['emper']);
  assert.deepEqual(Object.keys(config.provider), ['emper']);
  assert.deepEqual(Object.keys(config.provider.emper.models), ['nova-x1', 'nova-x5']);
  assert.equal('apiKey' in config.provider.emper.options, false);
  assert.equal(config.provider.emper.options.timeout, false);
  assert.equal(config.provider.emper.options.headerTimeout, false);
  assert.equal('chunkTimeout' in config.provider.emper.options, false);
  assert.equal(config.provider.emper.models['nova-x5'].attachment, true);
  assert.deepEqual(config.provider.emper.models['nova-x5'].modalities.input, ['text', 'image']);
  assert.equal(config.share, 'disabled');
  assert.equal(config.permission.edit, 'ask');
  assert.equal(config.permission.bash, 'ask');
  assert.equal(config.permission.external_directory, 'ask');
  assert.equal(env.EMPER_API_KEY, secret);
  assert.equal(env.OPENCODE_CONFIG_CONTENT.includes(secret), false);
  assert.equal(env.OPENCODE_DB, 'emper.db');
  assert.equal(env.EMPER_CLI_VERSION, '0.6.1');
  assert.equal(env.OPENCODE_DISABLE_TERMINAL_TITLE, '1');
  assert.match(env.XDG_DATA_HOME, /emper[\\/]runtime[\\/]data$/);
  assert.deepEqual(config.provider.emper.models['nova-x1'].limit, { context:245000, output:2000 });
  assert.deepEqual(config.provider.emper.models['nova-x5'].limit, { context:64000, output:4000 });
});

test('default model falls back to the first model available to the account', () => {
  const config = buildOpenCodeConfig({
    apiUrl:'https://example.test/v1',
    models:[{ id:'nova-x3', name:'Nova X3' }],
    defaultModel:'nova-x5',
  });
  assert.equal(config.model, 'emper/nova-x3');
  assert.equal(config.small_model, 'emper/nova-x3');
});

test('bundled OpenCode binary and Emper TUI plugin are present', async () => {
  assert.ok(resolveOpenCodeBinary());
  const tui = JSON.parse(await fs.readFile(path.join(root, 'runtime', 'tui.json'), 'utf8'));
  assert.equal(tui.theme, 'soru');
  assert.deepEqual(tui.plugin, ['./emper-plugin.tsx']);
  const theme = JSON.parse(await fs.readFile(path.join(root, 'runtime', 'soru.json'), 'utf8'));
  assert.equal(theme.theme.primary.dark, 'darkPrimary');
  assert.equal(theme.defs.darkPrimary, '#2f806a');
  assert.equal(theme.defs.darkSuccess, '#5ee0b5');
  assert.equal(theme.theme.selectedListItemText.dark, 'darkText');
  assert.equal(theme.defs.darkBg, '#090d0c');
  const plugin = await fs.readFile(path.join(root, 'runtime', 'emper-plugin.tsx'), 'utf8');
  assert.match(plugin, /██████╗  ██████╗ ██████╗ ██╗   ██╗/u);
  assert.match(plugin, /home_logo/);
  assert.match(plugin, /home_prompt_right/);
  assert.match(plugin, /session_prompt_right/);
  assert.match(plugin, /\/points|name:\"points\"/);
});

test('SORU theme installs inside isolated Emper runtime state', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'emper-theme-'));
  t.after(() => fs.rm(temp, { recursive:true, force:true }));
  const target = await installRuntimeTheme({ XDG_CONFIG_HOME:temp });
  assert.equal(target, path.join(temp, 'opencode', 'themes', 'soru.json'));
  const theme = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(theme.defs.darkPrimary, '#2f806a');
  assert.equal(theme.defs.darkSuccess, '#5ee0b5');
});

test('OpenCode help output is rebranded for Emper', () => {
  const output = rebrandOutput('OpenCode uses: opencode run');
  assert.equal(output, 'Emper Code uses: emper run');
  assert.equal(rebrandOutput('old logo\nline two\n\nCommands:\n  opencode run'), 'EMPER CODE\n\nCommands:\n  emper run');
});
