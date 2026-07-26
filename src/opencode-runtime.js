import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { password } from '@inquirer/prompts';
import { createApiClient } from './api.js';
import {
  assertApiKey,
  configDirectory,
  readConfig,
  resolveCredentials,
  writeConfig,
} from './config.js';
import { CliError, publicError } from './errors.js';

const require = createRequire(import.meta.url);
const PUBLIC_MODEL_IDS = Object.freeze(['nova-x1', 'nova-x3', 'nova-x5']);
const PUBLIC_MODEL_SET = new Set(PUBLIC_MODEL_IDS);
const FALLBACK_MODELS = Object.freeze([
  { id:'nova-x1', name:'Nova X1' },
  { id:'nova-x3', name:'Nova X3' },
  { id:'nova-x5', name:'Nova X5' },
]);
const MODEL_LIMITS = Object.freeze({
  'nova-x1':Object.freeze({ context:245000, output:2000 }),
  'nova-x3':Object.freeze({ context:32000, output:4000 }),
  'nova-x5':Object.freeze({ context:64000, output:4000 }),
});

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function resolveOpenCodeBinary() {
  const manifestPath = require.resolve('opencode-ai/package.json');
  const manifest = require(manifestPath);
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.opencode;
  if (!relative) throw new CliError('The bundled OpenCode runtime is missing its executable entry.');
  const executable = path.resolve(path.dirname(manifestPath), relative);
  if (!fs.existsSync(executable)) throw new CliError('The bundled OpenCode runtime is not installed correctly.');
  return executable;
}

export function normalizeRuntimeModels(payload) {
  const source = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(source)) throw new CliError('The model list returned by Emper is invalid.');

  const models = [];
  const seen = new Set();
  for (const item of source) {
    const id = String(item?.id || '').trim().toLowerCase();
    if (!PUBLIC_MODEL_SET.has(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name:String(item?.name || id).trim() || id });
  }
  if (!models.length) throw new CliError('No Nova models are available for this account.');
  return models;
}

export function buildOpenCodeConfig({ apiUrl, models, defaultModel = 'nova-x1', username } = {}) {
  const available = normalizeRuntimeModels(models);
  const ids = new Set(available.map(model => model.id));
  const selected = ids.has(defaultModel) ? defaultModel : available[0].id;
  const configuredModels = Object.fromEntries(available.map(model => [model.id, {
    id:model.id,
    name:model.name,
    family:'nova',
    attachment:model.id === 'nova-x5',
    reasoning:false,
    temperature:true,
    tool_call:true,
    modalities:{
      input:model.id === 'nova-x5' ? ['text', 'image'] : ['text'],
      output:['text'],
    },
    limit:MODEL_LIMITS[model.id],
    cost:{ input:0, output:0 },
  }]));

  return {
    $schema:'https://opencode.ai/config.json',
    autoupdate:false,
    share:'disabled',
    enabled_providers:['emper'],
    model:`emper/${selected}`,
    small_model:`emper/${ids.has('nova-x1') ? 'nova-x1' : selected}`,
    ...(username ? { username:String(username) } : {}),
    permission:{
      edit:'ask',
      bash:'ask',
      external_directory:'ask',
    },
    provider:{
      emper:{
        id:'emper',
        name:'Emper',
        env:['EMPER_API_KEY'],
        npm:'@ai-sdk/openai-compatible',
        options:{
          baseURL:apiUrl,
          timeout:30000,
          headerTimeout:30000,
          chunkTimeout:30000,
        },
        models:configuredModels,
      },
    },
  };
}

export function buildOpenCodeEnvironment({ apiKey, apiUrl, account, models, config, env = process.env }) {
  const inlineConfig = buildOpenCodeConfig({
    apiUrl,
    models,
    defaultModel:config?.model,
    username:account?.username,
  });
  const tuiConfig = path.join(packageRoot(), 'runtime', 'tui.json');
  const runtimeState = path.join(configDirectory(env), 'runtime');

  return {
    ...env,
    EMPER_API_KEY:apiKey,
    EMPER_API_URL:apiUrl,
    OPENCODE_CONFIG_CONTENT:JSON.stringify(inlineConfig),
    OPENCODE_TUI_CONFIG:tuiConfig,
    OPENCODE_DISABLE_AUTOUPDATE:'1',
    OPENCODE_DISABLE_MODELS_FETCH:'1',
    OPENCODE_DB:'emper.db',
    XDG_CONFIG_HOME:path.join(runtimeState, 'config'),
    XDG_DATA_HOME:path.join(runtimeState, 'data'),
    XDG_CACHE_HOME:path.join(runtimeState, 'cache'),
    XDG_STATE_HOME:path.join(runtimeState, 'state'),
  };
}

async function runtimeIdentity({ env, input, output, promptForKey }) {
  let config = await readConfig(env);
  let { apiKey } = resolveCredentials(config, env);

  if (!apiKey) {
    if (!input.isTTY) throw new CliError('No API key configured. Run "emper login" first.');
    const ask = promptForKey || (options => password(options));
    apiKey = assertApiKey(await ask({ message:'Emper API key', mask:'*' }));
  }

  const api = createApiClient({ apiKey, baseURL:config.apiUrl });
  const [account, modelPayload] = await Promise.all([api.me(), api.models()]);
  const models = normalizeRuntimeModels(modelPayload);

  if (!config.apiKey && !String(env.EMPER_API_KEY || '').trim()) {
    config = await writeConfig({ ...config, apiKey }, env);
    output.write(`Logged in as ${account.username}.\n`);
  }

  return { apiKey, apiUrl:config.apiUrl, account, models, config };
}

function needsIdentity(args) {
  if (args.some(arg => arg === '--help' || arg === '-h')) return false;
  const command = args.find(arg => !arg.startsWith('-'));
  return !['completion', 'upgrade', 'uninstall'].includes(command);
}

function rebrandOutput(value) {
  const branded = String(value)
    .replaceAll('OpenCode', 'Emper Code')
    .replaceAll('opencode', 'emper');
  return branded.replace(/^[\s\S]*?(?:\r?\n){2}(Commands:)/, 'EMPER CODE\n\n$1');
}

function spawnRuntime(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) return resolve(1);
      resolve(code ?? 1);
    });
  });
}

export async function launchOpenCode(args = [], dependencies = {}) {
  const env = dependencies.env || process.env;
  const input = dependencies.input || process.stdin;
  const output = dependencies.output || process.stdout;
  const errorOutput = dependencies.errorOutput || process.stderr;
  const executable = dependencies.executable || resolveOpenCodeBinary();
  let context;

  try {
    context = needsIdentity(args)
      ? await runtimeIdentity({ env, input, output, promptForKey:dependencies.promptForKey })
      : {
          apiKey:String(env.EMPER_API_KEY || 'ask-not-configured'),
          apiUrl:'https://ai-unchained.ink/v1',
          account:null,
          models:FALLBACK_MODELS,
          config:{ model:'nova-x1' },
        };
  } catch (error) {
    throw publicError(error);
  }

  const childEnv = buildOpenCodeEnvironment({ ...context, env });
  const capture = args.some(arg => arg === '--help' || arg === '-h');
  const options = {
    cwd:dependencies.cwd || process.cwd(),
    env:childEnv,
    windowsHide:true,
    stdio:capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  };

  if (!capture) return (dependencies.spawnRuntime || spawnRuntime)(executable, args, options);

  return new Promise((resolve, reject) => {
    const child = (dependencies.spawn || spawn)(executable, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (stdout) output.write(rebrandOutput(stdout));
      if (stderr) errorOutput.write(rebrandOutput(stderr));
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

export { FALLBACK_MODELS, MODEL_LIMITS, PUBLIC_MODEL_IDS, rebrandOutput };
