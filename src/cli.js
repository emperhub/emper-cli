import process from 'node:process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { confirm, password } from '@inquirer/prompts';
import { createApiClient } from './api.js';
import { createAgentSession, runAgent } from './agent.js';
import {
  assertApiKey,
  clearStoredApiKey,
  configPath,
  maskApiKey,
  readConfig,
  resolveCredentials,
  updateConfig,
  validateConfig,
  writeConfig,
} from './config.js';
import { CliError, publicError } from './errors.js';
import { printAccount, printModels, printUsage } from './format.js';
import { launchTui } from './tui.js';
import { createWorkspace } from './workspace.js';

const require = createRequire(import.meta.url);
const { version:CLI_VERSION } = require('../package.json');

async function configuredApi(options = {}) {
  const config = await readConfig();
  const credentials = resolveCredentials(config);
  if (!credentials.apiKey) throw new CliError('No API key configured. Run "emper login" first.');
  const apiUrl = options.apiUrl || config.apiUrl;
  return {
    api:createApiClient({ apiKey:credentials.apiKey, baseURL:apiUrl }),
    config:{ ...config, apiUrl },
    credentials,
  };
}

async function streamAnswer(api, request, write = chunk => process.stdout.write(chunk)) {
  const stream = await api.streamChat(request);
  let answer = '';
  for await (const chunk of stream) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === 'string') {
      answer += content;
      write(content);
    }
  }
  return answer;
}

function validateAgentOptions(options) {
  if (options.yes && !options.apply) throw new CliError('--yes requires --apply.');
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 30) {
    throw new CliError('max-turns must be an integer between 1 and 30.');
  }
}

async function agentWorkspace(options) {
  return createWorkspace(process.cwd(), {
    allowWrite:options.apply,
    autoApprove:options.yes,
    writeOutput:diff => console.log(`\n${diff}`),
    approve:async ({ path }) => confirm({ message:`Apply this change to ${path}?`, default:false }),
  });
}

export async function runInteractiveAgent({ session, read, write = console.log, initialTask = '' }) {
  const handleTask = async task => {
    await session.ask(task);
  };
  if (String(initialTask).trim()) await handleTask(initialTask);

  while (true) {
    const input = String(await read()).trim();
    if (!input) continue;
    if (input === '/exit' || input === '/quit') return;
    if (input === '/clear') {
      session.clear();
      write('Agent context cleared.');
      continue;
    }
    if (input === '/status') {
      write(`Model: ${session.model} | Mode: ${session.workspace.allowWrite ? 'apply' : 'read-only'} | Context messages: ${Math.max(0, session.messages.length - 1)}`);
      continue;
    }
    if (input === '/help') {
      write('/clear  Clear agent context');
      write('/status Show model, mode, and context size');
      write('/exit   End the agent session');
      continue;
    }
    await handleTask(input);
  }
}

export function createProgram() {
  const program = new Command();
  program
    .name('emper')
    .description('Emper CLI for Nova chat and safe project assistance')
    .version(CLI_VERSION)
    .showSuggestionAfterError()
    .showHelpAfterError()
    .action(async () => launchTui());

  program.command('login')
    .description('Validate and save an Emper API key')
    .option('--key <api-key>', 'API key for non-interactive setup; interactive input is safer')
    .option('--api-url <url>', 'OpenAI-compatible API base URL')
    .action(async options => {
      const current = await readConfig();
      let apiKey = options.key || '';
      if (!apiKey) {
        if (!process.stdin.isTTY) throw new CliError('Interactive login needs a terminal. Use EMPER_API_KEY for automation.');
        apiKey = await password({ message:'Emper API key', mask:'*' });
      }
      apiKey = assertApiKey(apiKey);
      const apiUrl = options.apiUrl || current.apiUrl;
      const api = createApiClient({ apiKey, baseURL:apiUrl });
      const account = await api.me();
      await writeConfig({ ...current, apiKey, apiUrl });
      console.log(`Logged in as ${account.username}. Key saved as ${maskApiKey(apiKey)}.`);
      console.log(`Config: ${configPath()}`);
    });

  program.command('logout')
    .description('Remove the locally saved API key')
    .action(async () => {
      await clearStoredApiKey();
      console.log('Stored API key removed.');
      if (process.env.EMPER_API_KEY) console.log('EMPER_API_KEY is still set and will continue to be used.');
    });

  program.command('whoami')
    .description('Show the account connected to the active API key')
    .option('--api-url <url>', 'Override the configured API base URL')
    .action(async options => {
      const { api } = await configuredApi(options);
      printAccount(await api.me());
    });

  program.command('models')
    .description('List Nova models available to this account')
    .option('--api-url <url>', 'Override the configured API base URL')
    .action(async options => {
      const { api } = await configuredApi(options);
      printModels(await api.models());
    });

  program.command('usage')
    .description('Show recent API usage and remaining points')
    .option('-n, --limit <count>', 'Number of entries (1-200)', value => Number(value), 20)
    .option('--api-url <url>', 'Override the configured API base URL')
    .action(async options => {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
        throw new CliError('Usage limit must be an integer between 1 and 200.');
      }
      const { api } = await configuredApi(options);
      printUsage(await api.usage(options.limit));
    });

  program.command('chat')
    .description('Start a streaming Nova chat session')
    .option('-m, --model <model>', 'Public Nova model ID')
    .option('--max-tokens <count>', 'Maximum response tokens', value => Number(value))
    .option('--api-url <url>', 'Override the configured API base URL')
    .action(async options => {
      const { api, config } = await configuredApi(options);
      const selected = validateConfig({
        ...config,
        model:options.model || config.model,
        maxTokens:options.maxTokens || config.maxTokens,
      });
      const { model, maxTokens } = selected;
      const messages = [];
      const terminal = createInterface({ input:process.stdin, output:process.stdout });
      console.log(`Emper chat (${model}). Use /clear or /exit.`);
      try {
        while (true) {
          const line = (await terminal.question('You> ')).trim();
          if (!line) continue;
          if (line === '/exit' || line === '/quit') break;
          if (line === '/clear') {
            messages.length = 0;
            console.log('Conversation cleared.');
            continue;
          }
          messages.push({ role:'user', content:line });
          process.stdout.write('Emper> ');
          const answer = await streamAnswer(api, { model, messages, maxTokens });
          process.stdout.write('\n');
          messages.push({ role:'assistant', content:answer });
        }
      } finally {
        terminal.close();
      }
    });

  program.command('run')
    .description('Inspect the current project and complete a coding task')
    .argument('<task...>', 'Task for Emper')
    .option('-m, --model <model>', 'Public Nova model ID')
    .option('--max-turns <count>', 'Maximum agent turns (1-30)', value => Number(value), 12)
    .option('--apply', 'Allow proposed file changes with per-action approval')
    .option('-y, --yes', 'Approve all file changes; requires --apply')
    .option('--api-url <url>', 'Override the configured API base URL')
    .action(async (taskParts, options) => {
      validateAgentOptions(options);
      const { api, config } = await configuredApi(options);
      const selected = validateConfig({ ...config, model:options.model || config.model });
      const workspace = await agentWorkspace(options);
      if (!options.apply) console.log('Read-only mode. Use --apply to allow reviewed file changes.');
      await runAgent({
        client:api.openai,
        workspace,
        task:taskParts.join(' '),
        model:selected.model,
        maxTurns:options.maxTurns,
      });
    });

  program.command('agent')
    .description('Start an interactive AI coding agent in the current project')
    .argument('[task...]', 'Optional first task')
    .option('-m, --model <model>', 'Public Nova model ID')
    .option('--max-turns <count>', 'Maximum model turns per task (1-30)', value => Number(value), 12)
    .option('--apply', 'Allow proposed file changes with per-action approval')
    .option('-y, --yes', 'Approve all file changes; requires --apply')
    .option('--api-url <url>', 'Override the configured API base URL')
    .action(async (taskParts = [], options) => {
      validateAgentOptions(options);
      const { api, config } = await configuredApi(options);
      const selected = validateConfig({ ...config, model:options.model || config.model });
      const workspace = await agentWorkspace(options);
      const output = value => {
        const text = String(value);
        console.log(text.startsWith('[tool]') ? text : `Emper> ${text}`);
      };
      const session = createAgentSession({
        client:api.openai,
        workspace,
        model:selected.model,
        maxTurns:options.maxTurns,
        write:output,
      });
      const terminal = createInterface({ input:process.stdin, output:process.stdout });
      console.log(`Emper agent (${selected.model}, ${options.apply ? 'apply' : 'read-only'}). Use /help or /exit.`);
      try {
        await runInteractiveAgent({
          session,
          initialTask:taskParts.join(' '),
          read:() => terminal.question('You> '),
        });
      } finally {
        terminal.close();
      }
    });

  program.command('config')
    .description('Show or update CLI defaults')
    .option('--api-url <url>', 'Set the API base URL')
    .option('--model <model>', 'Set the default public Nova model ID')
    .option('--max-tokens <count>', 'Set default maximum response tokens', value => Number(value))
    .action(async options => {
      const changes = {};
      if (options.apiUrl !== undefined) changes.apiUrl = options.apiUrl;
      if (options.model !== undefined) changes.model = options.model;
      if (options.maxTokens !== undefined) changes.maxTokens = options.maxTokens;
      const config = Object.keys(changes).length ? await updateConfig(changes) : await readConfig();
      const credentials = resolveCredentials(config);
      console.log(`API URL: ${config.apiUrl}`);
      console.log(`Model: ${config.model}`);
      console.log(`Max tokens: ${config.maxTokens}`);
      console.log(`API key: ${maskApiKey(credentials.apiKey)}${credentials.source ? ` (${credentials.source})` : ''}`);
      console.log(`Config: ${configPath()}`);
    });

  return program;
}

export async function main(argv = process.argv) {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    const safe = publicError(error);
    console.error(`Error: ${safe.message}`);
    process.exitCode = safe.exitCode || 1;
  }
}

export { streamAnswer };
