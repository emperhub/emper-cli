import { publicError } from './errors.js';

const READ_TOOLS = [
  {
    type:'function',
    function:{
      name:'list_files',
      description:'List non-secret, non-ignored files inside the current working directory.',
      parameters:{ type:'object', properties:{ path:{ type:'string', description:'Relative directory path.' } }, additionalProperties:false },
    },
  },
  {
    type:'function',
    function:{
      name:'find_files',
      description:'Find safe workspace files with a glob such as **/*.js or src/**/*.test.js. Prefer this over listing the entire workspace.',
      parameters:{
        type:'object', required:['pattern'], additionalProperties:false,
        properties:{ pattern:{ type:'string' }, path:{ type:'string', description:'Optional relative directory path.' } },
      },
    },
  },
  {
    type:'function',
    function:{
      name:'read_file',
      description:'Read a safe text file inside the current working directory with line numbers.',
      parameters:{
        type:'object', required:['path'], additionalProperties:false,
        properties:{ path:{ type:'string' }, start_line:{ type:'integer' }, end_line:{ type:'integer' } },
      },
    },
  },
  {
    type:'function',
    function:{
      name:'read_files',
      description:'Read up to 10 safe text files or line ranges in one tool call. Prefer this when inspecting related files.',
      parameters:{
        type:'object', required:['files'], additionalProperties:false,
        properties:{
          files:{
            type:'array', minItems:1, maxItems:10,
            items:{
              type:'object', required:['path'], additionalProperties:false,
              properties:{ path:{ type:'string' }, start_line:{ type:'integer' }, end_line:{ type:'integer' } },
            },
          },
        },
      },
    },
  },
  {
    type:'function',
    function:{
      name:'search_text',
      description:'Search literal text across safe files inside the current working directory.',
      parameters:{
        type:'object', required:['query'], additionalProperties:false,
        properties:{
          query:{ type:'string' },
          path:{ type:'string' },
          file_pattern:{ type:'string', description:'Optional glob filter such as **/*.js.' },
        },
      },
    },
  },
];

const WRITE_TOOLS = [
  {
    type:'function',
    function:{
      name:'write_file',
      description:'Create or replace one safe text file. A diff is shown and user approval is required.',
      parameters:{
        type:'object', required:['path', 'content'], additionalProperties:false,
        properties:{ path:{ type:'string' }, content:{ type:'string' } },
      },
    },
  },
  {
    type:'function',
    function:{
      name:'apply_patch',
      description:'Apply one unified diff to one existing safe file. A final diff is shown and user approval is required.',
      parameters:{
        type:'object', required:['path', 'patch'], additionalProperties:false,
        properties:{ path:{ type:'string' }, patch:{ type:'string' } },
      },
    },
  },
  {
    type:'function',
    function:{
      name:'replace_text',
      description:'Replace exact text in one safe file. The old text must be unique unless replace_all is true. A diff is shown and user approval is required.',
      parameters:{
        type:'object', required:['path', 'old_text', 'new_text'], additionalProperties:false,
        properties:{
          path:{ type:'string' },
          old_text:{ type:'string' },
          new_text:{ type:'string' },
          replace_all:{ type:'boolean' },
        },
      },
    },
  },
];

export function agentTools(allowWrite = false) {
  return allowWrite ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS];
}

function agentSystemMessage(workspace) {
  return {
    role:'system',
    content:[
      'You are Emper, a coding assistant operating only through the supplied file tools.',
      'The workspace root is the current working directory. Never claim access outside it.',
      'There is no shell tool. Do not ask to run shell commands as if you ran them.',
      workspace.allowWrite
        ? 'File writes are available, but the CLI shows a diff and obtains approval for each action.'
        : 'This session is read-only. Inspect files and explain proposed changes; do not claim to have edited anything.',
      'Inspect the project before proposing changes. Prefer read_files for related files and search_text before guessing locations.',
      'Use replace_text for small exact edits, apply_patch for localized multi-line edits, and write_file only for new files or full rewrites.',
      'Never request, reveal, copy, or write credentials, API keys, .env contents, databases, or private keys.',
      'Keep the final answer concise and list files actually changed.',
    ].join('\n'),
  };
}

function toolResult(value) {
  return JSON.stringify(value, null, 2).slice(0, 60000);
}

async function executeTool(workspace, call) {
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); }
  catch { return { ok:false, error:'Tool arguments were not valid JSON.' }; }
  try {
    switch (call.function.name) {
      case 'list_files': return { ok:true, files:await workspace.listFiles(args.path || '.') };
      case 'find_files': return { ok:true, files:await workspace.findFiles(args.pattern, args.path || '.') };
      case 'read_file': return { ok:true, ...(await workspace.readFile(args.path, { startLine:args.start_line, endLine:args.end_line })) };
      case 'read_files': return { ok:true, files:await workspace.readFiles((args.files || []).map(file => ({
        path:file.path, startLine:file.start_line, endLine:file.end_line,
      }))) };
      case 'search_text': return {
        ok:true,
        matches:await workspace.searchText(args.query, args.path || '.', { filePattern:args.file_pattern }),
      };
      case 'write_file': {
        const result = await workspace.writeFile(args.path, args.content);
        return { ok:true, changed:result.changed, approved:result.approved, path:result.path, backup_created:Boolean(result.backupPath) };
      }
      case 'apply_patch': {
        const result = await workspace.applyPatch(args.path, args.patch);
        return { ok:true, changed:result.changed, approved:result.approved, path:result.path, backup_created:Boolean(result.backupPath) };
      }
      case 'replace_text': {
        const result = await workspace.replaceText(args.path, args.old_text, args.new_text, { replaceAll:Boolean(args.replace_all) });
        return {
          ok:true, changed:result.changed, approved:result.approved, path:result.path,
          occurrences:result.occurrences, backup_created:Boolean(result.backupPath),
        };
      }
      default: return { ok:false, error:`Unknown tool: ${call.function.name}` };
    }
  } catch (error) {
    return { ok:false, error:publicError(error).message };
  }
}

function parsedArguments(call) {
  try { return JSON.parse(call.function.arguments || '{}'); }
  catch { return {}; }
}

function toolLabel(name, args) {
  const path = String(args.path || '.');
  switch (name) {
    case 'list_files': return `List files in ${path}`;
    case 'find_files': return `Find ${String(args.pattern || '').slice(0, 80)} in ${path}`;
    case 'read_file': return `Read ${path}${args.start_line ? `:${args.start_line}-${args.end_line || ''}` : ''}`;
    case 'read_files': return `Read ${(args.files || []).length} related files`;
    case 'search_text': return `Search "${String(args.query || '').slice(0, 60)}" in ${path}`;
    case 'write_file': return `Write ${path}`;
    case 'apply_patch': return `Patch ${path}`;
    case 'replace_text': return `Edit ${path}`;
    default: return name;
  }
}

function toolSummary(name, result) {
  if (!result.ok) return result.error || 'Tool failed';
  switch (name) {
    case 'list_files': return `${result.files?.length || 0} files found`;
    case 'find_files': return `${result.files?.length || 0} files matched`;
    case 'read_file': return `lines ${result.startLine || 0}-${result.endLine || 0} of ${result.totalLines || 0}`;
    case 'read_files': return `${result.files?.length || 0} files read`;
    case 'search_text': return `${result.matches?.length || 0} matches`;
    case 'write_file':
    case 'apply_patch':
    case 'replace_text':
      return result.changed ? 'change applied' : result.approved === false ? 'change skipped' : 'no change';
    default: return 'done';
  }
}

function restoredMessages(initialMessages) {
  if (!Array.isArray(initialMessages)) return [];
  const allowed = new Set(['user', 'assistant', 'tool']);
  return structuredClone(initialMessages.filter(message => allowed.has(message?.role)).slice(-120));
}

export function createAgentSession({
  client,
  workspace,
  model,
  maxTurns = 12,
  maxTokens,
  initialMessages = [],
  write = console.log,
  onEvent,
}) {
  const tools = agentTools(workspace.allowWrite);
  const messages = [agentSystemMessage(workspace), ...restoredMessages(initialMessages)];
  const emit = (event, fallback) => {
    if (typeof onEvent === 'function') onEvent(event);
    else if (fallback) write(fallback);
  };

  return {
    messages,
    model,
    workspace,
    clear() {
      messages.splice(0, messages.length, agentSystemMessage(workspace));
    },
    async ask(task) {
      const prompt = String(task || '').trim();
      if (!prompt) throw new Error('Agent task cannot be empty.');
      const taskStart = messages.length;
      messages.push({ role:'user', content:prompt });

      for (let turn = 0; turn < maxTurns; turn++) {
        let completion;
        try {
          completion = await client.chat.completions.create({
            model,
            messages,
            tools,
            tool_choice:'auto',
            ...(maxTokens ? { max_tokens:maxTokens } : {}),
          });
        } catch (error) {
          messages.splice(taskStart);
          throw publicError(error);
        }
        const message = completion.choices?.[0]?.message;
        if (!message) {
          messages.splice(taskStart);
          throw new Error('Model returned no message.');
        }
        messages.push(message);
        const calls = message.tool_calls || [];
        if (!calls.length) {
          const content = String(message.content || '').trim();
          if (content) emit({ type:'assistant', content }, content);
          return { content, turns:turn + 1, messages };
        }
        for (const call of calls) {
          const name = call.function.name;
          const args = parsedArguments(call);
          const label = toolLabel(name, args);
          const startedAt = Date.now();
          emit({ type:'tool_start', callId:call.id, name, args, label }, `[tool] ${label}`);
          const result = await executeTool(workspace, call);
          emit({
            type:'tool_end', callId:call.id, name, label, ok:Boolean(result.ok),
            summary:toolSummary(name, result), elapsedMs:Date.now() - startedAt,
          });
          messages.push({ role:'tool', tool_call_id:call.id, content:toolResult(result) });
        }
      }
      messages.splice(taskStart);
      throw new Error(`Agent stopped after ${maxTurns} turns without a final answer.`);
    }
  };
}

export async function runAgent(options) {
  const session = createAgentSession(options);
  return session.ask(options.task);
}
