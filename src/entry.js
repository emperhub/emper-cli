import process from 'node:process';
import { createRequire } from 'node:module';
import { main as runLocalCommand } from './cli.js';
import { publicError } from './errors.js';
import { launchOpenCode } from './opencode-runtime.js';

const require = createRequire(import.meta.url);
const { version:CLI_VERSION } = require('../package.json');
const LOCAL_COMMANDS = new Set(['login', 'logout', 'whoami', 'usage', 'config']);

export function routeArguments(args = []) {
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return 'version';
  return LOCAL_COMMANDS.has(args[0]) ? 'local' : 'opencode';
}

export async function main(argv = process.argv, dependencies = {}) {
  const args = argv.slice(2);
  const route = routeArguments(args);
  const output = dependencies.output || process.stdout;

  try {
    if (route === 'version') {
      output.write(`${CLI_VERSION}\n`);
      return 0;
    }
    if (route === 'local') {
      await (dependencies.runLocalCommand || runLocalCommand)(argv);
      return process.exitCode || 0;
    }
    const code = await (dependencies.launchOpenCode || launchOpenCode)(args);
    if (code) process.exitCode = code;
    return code;
  } catch (error) {
    const safe = publicError(error);
    (dependencies.errorOutput || process.stderr).write(`Error: ${safe.message}\n`);
    process.exitCode = safe.exitCode || 1;
    return process.exitCode;
  }
}

export { LOCAL_COMMANDS };
