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
      name:'search_text',
      description:'Search literal text across safe files inside the current working directory.',
      parameters:{
        type:'object', required:['query'], additionalProperties:false,
        properties:{ query:{ type:'string' }, path:{ type:'string' } },
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
];

export function agentTools(allowWrite = false) {
  return allowWrite ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS];
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
      case 'read_file': return { ok:true, ...(await workspace.readFile(args.path, { startLine:args.start_line, endLine:args.end_line })) };
      case 'search_text': return { ok:true, matches:await workspace.searchText(args.query, args.path || '.') };
      case 'write_file': {
        const result = await workspace.writeFile(args.path, args.content);
        return { ok:true, changed:result.changed, approved:result.approved, path:result.path, backup_created:Boolean(result.backupPath) };
      }
      case 'apply_patch': {
        const result = await workspace.applyPatch(args.path, args.patch);
        return { ok:true, changed:result.changed, approved:result.approved, path:result.path, backup_created:Boolean(result.backupPath) };
      }
      default: return { ok:false, error:`Unknown tool: ${call.function.name}` };
    }
  } catch (error) {
    return { ok:false, error:publicError(error).message };
  }
}

export async function runAgent({ client, workspace, task, model, maxTurns = 12, write = console.log }) {
  const tools = agentTools(workspace.allowWrite);
  const messages = [
    {
      role:'system',
      content:[
        'You are Emper, a coding assistant operating only through the supplied file tools.',
        'The workspace root is the current working directory. Never claim access outside it.',
        'There is no shell tool. Do not ask to run shell commands as if you ran them.',
        workspace.allowWrite
          ? 'File writes are available, but the CLI shows a diff and obtains approval for each action.'
          : 'This run is read-only. Inspect files and explain proposed changes; do not claim to have edited anything.',
        'Never request, reveal, copy, or write credentials, API keys, .env contents, databases, or private keys.',
        'Keep the final answer concise and list files actually changed.',
      ].join('\n'),
    },
    { role:'user', content:String(task) },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    let completion;
    try {
      completion = await client.chat.completions.create({ model, messages, tools, tool_choice:'auto' });
    } catch (error) {
      throw publicError(error);
    }
    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error('Model returned no message.');
    messages.push(message);
    const calls = message.tool_calls || [];
    if (!calls.length) {
      const content = String(message.content || '').trim();
      if (content) write(content);
      return { content, turns:turn + 1, messages };
    }
    for (const call of calls) {
      write(`[tool] ${call.function.name}`);
      const result = await executeTool(workspace, call);
      messages.push({ role:'tool', tool_call_id:call.id, content:toolResult(result) });
    }
  }
  throw new Error(`Agent stopped after ${maxTurns} turns without a final answer.`);
}
