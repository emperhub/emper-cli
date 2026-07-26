import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { createApiClient } from './api.js';
import { createAgentSession } from './agent.js';
import {
  assertApiKey,
  clearStoredApiKey,
  readConfig,
  resolveCredentials,
  writeConfig,
} from './config.js';
import { publicError, redactSecrets } from './errors.js';
import { number } from './format.js';
import { createSessionRecord, listSessions, loadSession, saveSession } from './sessions.js';
import { createWorkspace } from './workspace.js';

const require = createRequire(import.meta.url);
const { version:CLI_VERSION } = require('../package.json');
const h = React.createElement;
const LOGIN_LOGO = [
  ' _____ __  __ ____  _____ ____  ',
  '| ____|  \\/  |  _ \\| ____|  _ \\ ',
  '|  _| | |\\/| | |_) |  _| | |_) |',
  '| |___| |  | |  __/| |___|  _ < ',
  '|_____|_|  |_|_|   |_____|_| \\_\\',
];

const defaultServices = Object.freeze({
  env:process.env,
  cwd:process.cwd(),
  loadConfig:readConfig,
  saveConfig:writeConfig,
  clearApiKey:clearStoredApiKey,
  clientFactory:createApiClient,
  workspaceFactory:createWorkspace,
  sessionFactory:createAgentSession,
  newSession:createSessionRecord,
  listSessions,
  loadSession,
  saveSession,
});

const SLASH_COMMANDS = Object.freeze([
  { command:'/model', description:'Choose an available Nova model' },
  { command:'/session', description:'Open chat history for this workspace' },
  { command:'/new', description:'Start a clean session' },
  { command:'/apply', description:'Enable reviewed file edits' },
  { command:'/readonly', description:'Return to inspection-only mode' },
  { command:'/clear', description:'Clear the active conversation context' },
  { command:'/status', description:'Show model, context, and point balance' },
  { command:'/help', description:'Show all commands' },
  { command:'/logout', description:'Remove the saved API key' },
  { command:'/exit', description:'Close Emper' },
]);

function terminalText(value) {
  return redactSecrets(value)
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function Brand({ caption }) {
  return h(Box, { flexDirection:'column', alignItems:'center', marginBottom:1 },
    ...LOGIN_LOGO.map((line, index) => h(Text, { key:index, bold:true, color:index < 2 ? 'cyan' : 'blue' }, line)),
    h(Text, { color:'gray' }, caption),
  );
}

function Shell({ children }) {
  return h(Box, { flexDirection:'column', paddingX:1, paddingY:1 },
    h(Box, {
      flexDirection:'column', borderStyle:'round', borderColor:'cyan',
      paddingX:2, paddingY:1, minWidth:58,
    }, children),
  );
}

function LoadingScreen() {
  return h(Shell, null,
    h(Brand, { caption:'NOVA AGENT CLI' }),
    h(Box, { justifyContent:'center' }, h(Text, { color:'yellow' }, 'Connecting...')),
  );
}

export function ApiKeyScreen({ config, initialError = '', onAuthenticate, onExit }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape) onExit();
  });

  const submit = async rawValue => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onAuthenticate(rawValue);
    } catch (reason) {
      setError(publicError(reason).message);
      setBusy(false);
    }
  };

  return h(Shell, null,
    h(Brand, { caption:'CONNECT YOUR NOVA ACCOUNT' }),
    h(Text, { bold:true }, 'API key'),
    h(Box, {
      borderStyle:'round', borderColor:error ? 'red' : busy ? 'yellow' : 'green',
      paddingX:1, marginTop:1,
    },
    h(Text, { color:'green', bold:true }, '> '),
    h(TextInput, {
      value,
      onChange:setValue,
      onSubmit:submit,
      placeholder:'ask-...',
      mask:'*',
      focus:!busy,
      highlightPastedText:true,
    })),
    h(Box, { marginTop:1 },
      h(Text, { color:busy ? 'yellow' : 'gray' }, busy ? 'Validating account...' : `Endpoint  ${config.apiUrl}`),
    ),
    error ? h(Box, { marginTop:1 }, h(Text, { color:'red' }, terminalText(error))) : null,
    h(Box, { marginTop:1, justifyContent:'space-between' },
      h(Text, { color:'gray' }, 'ENTER connect'),
      h(Text, { color:'gray' }, 'ESC exit'),
    ),
  );
}

function WelcomeHeader({ account, cwd, model, allowWrite }) {
  const project = path.basename(path.resolve(cwd)) || cwd;
  return h(Box, {
    flexDirection:'column', borderStyle:'round', borderColor:'magenta',
    paddingX:2, paddingY:1, marginBottom:1,
  },
    h(Box, { justifyContent:'space-between' },
      h(Text, { bold:true, color:'magenta' }, `EMPER CODE  v${CLI_VERSION}`),
      h(Text, { color:allowWrite ? 'yellow' : 'green', bold:true }, allowWrite ? 'REVIEW EDITS' : 'READ ONLY'),
    ),
    h(Box, { justifyContent:'space-between', marginTop:1 },
      h(Box, { flexDirection:'column', flexGrow:1 },
        h(Text, { bold:true }, `Welcome back, ${terminalText(account.username)}`),
        h(Text, { color:'cyan', bold:true }, model),
        h(Text, { color:'gray' }, `${project}  ${cwd}`),
      ),
      h(Box, { flexDirection:'column', alignItems:'flex-end', marginLeft:4 },
        h(Text, { color:'gray', bold:true }, 'POINT BALANCE'),
        h(Text, { color:'green', bold:true }, `${number(account.points)} remaining`),
        h(Text, { color:'yellow' }, `${number(account.total_points_used)} used`),
      ),
    ),
    h(Box, { marginTop:1 },
      h(Text, { color:'gray' }, '/model switch model   /session chat history   /apply review edits   /help commands'),
    ),
  );
}

function TranscriptLine({ entry }) {
  if (entry.type === 'tool') {
    const color = entry.status === 'running' ? 'yellow' : entry.status === 'failed' ? 'red' : 'green';
    const marker = entry.status === 'running' ? '>' : entry.status === 'failed' ? 'x' : '+';
    return h(Box, { marginBottom:1 },
      h(Text, { color, bold:true }, `${marker} TOOL  `),
      h(Text, { color:entry.status === 'running' ? 'yellow' : 'gray', wrap:'wrap' }, terminalText(entry.text)),
    );
  }
  const labels = {
    user:{ label:'YOU', color:'green' },
    assistant:{ label:'EMPER', color:'cyan' },
    system:{ label:'INFO', color:'gray' },
    error:{ label:'ERROR', color:'red' },
  };
  const style = labels[entry.type] || labels.system;
  return h(Box, { flexDirection:'column', marginBottom:1 },
    h(Text, { bold:true, color:style.color }, style.label),
    h(Text, { wrap:'wrap' }, terminalText(entry.text)),
  );
}

function Picker({ picker }) {
  const start = Math.max(0, Math.min(picker.index - 3, Math.max(0, picker.items.length - 7)));
  const visible = picker.items.slice(start, start + 7);
  return h(Box, {
    flexDirection:'column', borderStyle:'double', borderColor:'cyan',
    paddingX:1, paddingY:1, marginBottom:1,
  },
    h(Text, { bold:true, color:'cyan' }, picker.title),
    h(Text, { color:'gray' }, picker.subtitle),
    h(Box, { flexDirection:'column', marginTop:1 },
      ...visible.map((item, offset) => {
        const selected = start + offset === picker.index;
        return h(Box, { key:item.id },
          h(Text, { bold:selected, color:selected ? 'green' : 'white' }, selected ? '> ' : '  '),
          h(Text, { bold:selected, color:selected ? 'green' : 'white' }, item.label),
          item.meta ? h(Text, { color:'gray' }, `  ${item.meta}`) : null,
        );
      }),
    ),
    h(Text, { color:'gray' }, 'UP/DOWN move   ENTER select   ESC close'),
  );
}

function CommandMenu({ items, index }) {
  const start = Math.max(0, Math.min(index - 3, Math.max(0, items.length - 7)));
  return h(Box, {
    flexDirection:'column', borderStyle:'round', borderColor:'cyan',
    paddingX:1, marginBottom:1,
  },
    h(Text, { bold:true, color:'cyan' }, 'COMMANDS'),
    ...items.slice(start, start + 7).map((item, offset) => {
      const selected = start + offset === index;
      return h(Box, { key:item.command },
        h(Text, { bold:selected, color:selected ? 'green' : 'white' }, selected ? '> ' : '  '),
        h(Text, { bold:true, color:selected ? 'green' : 'white' }, item.command.padEnd(11)),
        h(Text, { color:'gray' }, item.description),
      );
    }),
    h(Text, { color:'gray' }, 'TYPE to filter   UP/DOWN select   TAB complete   ENTER run'),
  );
}

function sessionTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(undefined, {
    month:'short', day:'numeric', hour:'2-digit', minute:'2-digit',
  });
}

function sessionEntries(record, nextId) {
  return (record.entries || []).map(entry => ({ ...entry, id:nextId.current++ }));
}

export function AgentScreen({ api, account:initialAccount, config, services, onLogout }) {
  const { exit } = useApp();
  const initialRecord = useRef(services.newSession({ cwd:services.cwd, model:config.model })).current;
  const [account, setAccount] = useState(initialAccount);
  const [entries, setEntries] = useState([]);
  const [input, setInput] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(null);
  const [selectedModel, setSelectedModel] = useState(config.model);
  const [activeSessionId, setActiveSessionId] = useState(initialRecord.id);
  const [allowWrite, setAllowWrite] = useState(false);
  const [approval, setApproval] = useState(null);
  const [picker, setPicker] = useState(null);
  const nextId = useRef(1);
  const entriesRef = useRef([]);
  const recordRef = useRef(initialRecord);
  const approvalRef = useRef(null);
  const commandQuery = input.trim().toLowerCase();
  const commandItems = /^\/[^\s]*$/.test(commandQuery)
    ? SLASH_COMMANDS.filter(item => item.command.startsWith(commandQuery))
    : [];

  const changeEntries = useCallback(update => {
    const next = typeof update === 'function' ? update(entriesRef.current) : update;
    entriesRef.current = next.slice(-24);
    setEntries(entriesRef.current);
  }, []);

  const append = useCallback((type, text, extra = {}) => {
    changeEntries(current => [...current, {
      id:nextId.current++, type, text:terminalText(text), ...extra,
    }]);
  }, [changeEntries]);

  const handleAgentEvent = useCallback(event => {
    if (event.type === 'assistant') {
      append('assistant', event.content);
      return;
    }
    if (event.type === 'tool_start') {
      changeEntries(current => [...current.filter(entry => entry.id !== `tool:${event.callId}`), {
        id:`tool:${event.callId}`, type:'tool', status:'running', text:event.label,
      }]);
      return;
    }
    if (event.type === 'tool_end') {
      changeEntries(current => current.map(entry => entry.id === `tool:${event.callId}` ? {
        ...entry,
        status:event.ok ? 'done' : 'failed',
        text:`${event.label}  ${event.summary}  ${event.elapsedMs}ms`,
      } : entry));
    }
  }, [append, changeEntries]);

  const requestApproval = useCallback(request => new Promise(resolve => {
    const pending = { ...request, resolve };
    approvalRef.current = pending;
    setApproval(pending);
  }), []);

  useEffect(() => {
    let active = true;
    setSession(null);
    (async () => {
      try {
        const workspace = await services.workspaceFactory(services.cwd, {
          allowWrite,
          autoApprove:false,
          approve:requestApproval,
          writeOutput:() => {},
          env:services.env,
        });
        const created = services.sessionFactory({
          client:api.openai,
          workspace,
          model:selectedModel,
          maxTokens:config.maxTokens,
          initialMessages:recordRef.current.messages,
          onEvent:handleAgentEvent,
          write:value => append(String(value).startsWith('[tool]') ? 'tool' : 'assistant', value),
        });
        if (active) setSession(created);
      } catch (error) {
        if (active) append('error', publicError(error).message);
      }
    })();
    return () => {
      active = false;
      if (approvalRef.current) {
        approvalRef.current.resolve(false);
        approvalRef.current = null;
      }
    };
  }, [activeSessionId, allowWrite, api, append, config.maxTokens, handleAgentEvent, requestApproval, selectedModel, services]);

  const persistCurrent = async ({ titlePrompt = '', model = selectedModel, messages, force = false } = {}) => {
    const hasConversation = entriesRef.current.some(entry => entry.type === 'user');
    const record = {
      ...recordRef.current,
      model,
      title:recordRef.current.title === 'New session' && titlePrompt
        ? terminalText(titlePrompt).replace(/\s+/g, ' ').slice(0, 64)
        : recordRef.current.title,
      messages:messages || session?.messages || recordRef.current.messages,
      entries:entriesRef.current.map(({ type, text, status }) => ({ type, text, ...(status ? { status } : {}) })),
    };
    recordRef.current = record;
    if (!hasConversation && !force) return record;
    const saved = await services.saveSession(record, services.cwd, services.env);
    recordRef.current = saved;
    return saved;
  };

  const choosePicker = async current => {
    const item = current.items[current.index];
    setPicker(null);
    if (!item) return;
    if (current.type === 'model') {
      if (item.id === selectedModel) return;
      try {
        await persistCurrent({ model:item.id, messages:session?.messages });
        await services.saveConfig({ ...config, model:item.id }, services.env);
        setSelectedModel(item.id);
        append('system', `Model changed to ${item.label}. Conversation context was preserved.`);
      } catch (error) {
        append('error', publicError(error).message);
      }
      return;
    }
    if (item.id === '__new__') {
      const record = services.newSession({ cwd:services.cwd, model:selectedModel });
      recordRef.current = record;
      changeEntries([]);
      setActiveSessionId(record.id);
      return;
    }
    try {
      const record = await services.loadSession(item.id, services.cwd, services.env);
      recordRef.current = record;
      const restored = sessionEntries(record, nextId);
      changeEntries(restored);
      setSelectedModel(record.model);
      setActiveSessionId(record.id);
    } catch (error) {
      append('error', publicError(error).message);
    }
  };

  useInput((rawInput, key) => {
    if (picker) {
      if (key.escape) {
        setPicker(null);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setPicker(current => {
          const direction = key.upArrow ? -1 : 1;
          return { ...current, index:(current.index + direction + current.items.length) % current.items.length };
        });
        return;
      }
      if (key.return) void choosePicker(picker);
      return;
    }
    if (approval && ['y', 'Y', 'n', 'N'].includes(rawInput)) {
      const accepted = rawInput.toLowerCase() === 'y';
      approval.resolve(accepted);
      approvalRef.current = null;
      setApproval(null);
      return;
    }
    if (!busy && commandItems.length) {
      if (key.upArrow || key.downArrow) {
        setCommandIndex(current => {
          const direction = key.upArrow ? -1 : 1;
          return (current + direction + commandItems.length) % commandItems.length;
        });
        return;
      }
      if (key.tab) {
        setInput(commandItems[Math.min(commandIndex, commandItems.length - 1)].command);
        setCommandIndex(0);
        return;
      }
      if (key.escape) {
        setInput('');
        setCommandIndex(0);
        return;
      }
    }
    if (key.ctrl && rawInput === 'c') exit();
  });

  const openModelPicker = async () => {
    try {
      const payload = await api.models();
      const items = (payload.data || [])
        .filter(model => /^nova-x\d{1,3}$/.test(String(model.id || '')))
        .map(model => ({ id:model.id, label:model.name || model.id, meta:model.id }));
      if (!items.length) throw new Error('No models are available for this account.');
      const index = Math.max(0, items.findIndex(item => item.id === selectedModel));
      setPicker({
        type:'model', title:'SELECT MODEL', subtitle:'Models available to this API key', items, index,
      });
    } catch (error) {
      append('error', publicError(error).message);
    }
  };

  const openSessionPicker = async () => {
    try {
      const stored = await services.listSessions(services.cwd, services.env);
      const items = [
        { id:'__new__', label:'New session', meta:'start with a clean context' },
        ...stored.map(record => ({
          id:record.id,
          label:record.id === activeSessionId ? `${record.title} (current)` : record.title,
          meta:`${record.model}  ${sessionTime(record.updatedAt)}`,
        })),
      ];
      setPicker({ type:'session', title:'SESSION HISTORY', subtitle:`Saved for ${services.cwd}`, items, index:0 });
    } catch (error) {
      append('error', publicError(error).message);
    }
  };

  const command = async value => {
    if (value === '/exit' || value === '/quit') {
      exit();
      return true;
    }
    if (value === '/clear') {
      session?.clear();
      changeEntries([]);
      append('system', 'Agent context cleared.');
      await persistCurrent({ messages:session?.messages, force:true }).catch(error => append('error', publicError(error).message));
      return true;
    }
    if (value === '/status') {
      append('system', `Model ${selectedModel} | ${allowWrite ? 'REVIEW EDITS' : 'READ ONLY'} | ${Math.max(0, (session?.messages.length || 1) - 1)} context messages | ${number(account.points)} points left`);
      return true;
    }
    if (value === '/model') {
      await openModelPicker();
      return true;
    }
    if (value === '/session' || value === '/sessions' || value === '/new') {
      if (value === '/new') {
        const record = services.newSession({ cwd:services.cwd, model:selectedModel });
        recordRef.current = record;
        changeEntries([]);
        setActiveSessionId(record.id);
      } else await openSessionPicker();
      return true;
    }
    if (value === '/apply' || value === '/readonly') {
      const nextMode = value === '/apply';
      if (nextMode === allowWrite) {
        append('system', nextMode ? 'Review-edits mode is already active.' : 'Read-only mode is already active.');
        return true;
      }
      recordRef.current = { ...recordRef.current, messages:session?.messages || recordRef.current.messages };
      setAllowWrite(nextMode);
      append('system', nextMode
        ? 'Review-edits mode enabled. Every file change still requires Y/N approval.'
        : 'Read-only mode enabled. Conversation context was preserved.');
      return true;
    }
    if (value === '/help') {
      append('system', '/model choose model | /session open history | /new new chat | /apply review edits | /readonly inspect only | /clear reset context | /logout change key | /exit close');
      return true;
    }
    if (value === '/logout') {
      await onLogout();
      return true;
    }
    if (value.startsWith('/')) {
      append('error', `Unknown command: ${value}. Type / to see available commands.`);
      return true;
    }
    return false;
  };

  const submit = async rawValue => {
    let value = String(rawValue || '').trim();
    const matchingCommands = /^\/[^\s]*$/.test(value.toLowerCase())
      ? SLASH_COMMANDS.filter(item => item.command.startsWith(value.toLowerCase()))
      : [];
    if (matchingCommands.length) {
      value = matchingCommands[Math.min(commandIndex, matchingCommands.length - 1)].command;
    }
    if (!value || busy || picker) return;
    setInput('');
    setCommandIndex(0);
    if (await command(value)) return;
    if (!session) {
      append('error', 'Agent is still connecting.');
      return;
    }
    append('user', value);
    setBusy(true);
    try {
      await session.ask(value);
      await persistCurrent({ titlePrompt:value, messages:session.messages });
      try { setAccount(await api.me()); }
      catch (error) { append('error', `Point balance could not refresh: ${publicError(error).message}`); }
    } catch (error) {
      append('error', publicError(error).message);
      await persistCurrent({ titlePrompt:value, messages:session.messages }).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const workingTool = [...entries].reverse().find(entry => entry.type === 'tool' && entry.status === 'running');
  return h(Box, { flexDirection:'column', paddingX:1 },
    h(WelcomeHeader, { account, cwd:services.cwd, model:selectedModel, allowWrite }),
    h(Box, { flexDirection:'column', paddingX:1, minHeight:4 },
      entries.length
        ? entries.map(entry => h(TranscriptLine, { key:entry.id, entry }))
        : h(Box, { paddingY:1, flexDirection:'column' },
          h(Text, { bold:true }, 'What are we building?'),
          h(Text, { color:'gray' }, 'Ask Emper to inspect, explain, or update this project.'),
        ),
    ),
    commandItems.length && !picker && !approval && !busy
      ? h(CommandMenu, { items:commandItems, index:Math.min(commandIndex, commandItems.length - 1) })
      : null,
    picker ? h(Picker, { picker }) : null,
    approval ? h(Box, {
      flexDirection:'column', borderStyle:'double', borderColor:'yellow', paddingX:1, marginBottom:1,
    },
      h(Text, { bold:true, color:'yellow' }, `REVIEW  ${approval.path}`),
      h(Text, null, terminalText(approval.diff)),
      h(Text, { bold:true }, 'Y apply   N skip'),
    ) : null,
    h(Box, {
      borderStyle:'round', borderColor:approval || busy ? 'yellow' : 'green', paddingX:1,
    },
      h(Text, { bold:true, color:'green' }, '> '),
      h(TextInput, {
        value:input,
        onChange:value => {
          setInput(value);
          setCommandIndex(0);
        },
        onSubmit:submit,
        placeholder:picker ? 'Choose an item above' : approval ? 'Review the diff above' : busy ? 'Agent is working...' : 'Ask Emper about this project',
        focus:!picker && !approval && !busy && Boolean(session),
        highlightPastedText:true,
      }),
    ),
    h(Box, { justifyContent:'space-between', paddingX:1 },
      h(Text, { color:approval || busy ? 'yellow' : 'gray' },
        approval ? 'Waiting for approval' : workingTool ? workingTool.text : busy ? 'Thinking and choosing tools...' : `${selectedModel}  /model  /session`,
      ),
      h(Text, { color:allowWrite ? 'yellow' : 'gray' }, allowWrite ? 'review edits' : 'read only'),
    ),
  );
}

export function EmperTui({ services:providedServices = {} }) {
  const services = useRef({ ...defaultServices, ...providedServices }).current;
  const { exit } = useApp();
  const [state, setState] = useState({ phase:'loading', config:null, api:null, account:null, error:'' });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const config = await services.loadConfig(services.env);
        const credentials = resolveCredentials(config, services.env);
        if (!credentials.apiKey) {
          if (active) setState({ phase:'login', config, api:null, account:null, error:'' });
          return;
        }
        const api = services.clientFactory({ apiKey:credentials.apiKey, baseURL:config.apiUrl });
        const account = await api.me();
        if (active) setState({ phase:'agent', config, api, account, error:'' });
      } catch (error) {
        const config = await services.loadConfig(services.env).catch(() => ({ apiUrl:'https://ai-unchained.ink/v1', model:'nova-x1', maxTokens:2000 }));
        if (active) setState({ phase:'login', config, api:null, account:null, error:publicError(error).message });
      }
    })();
    return () => { active = false; };
  }, [services]);

  const authenticate = async rawKey => {
    const apiKey = assertApiKey(rawKey);
    const api = services.clientFactory({ apiKey, baseURL:state.config.apiUrl });
    const account = await api.me();
    const config = await services.saveConfig({ ...state.config, apiKey }, services.env);
    setState({ phase:'agent', config, api, account, error:'' });
  };

  const logout = async () => {
    const config = await services.clearApiKey(services.env);
    setState({ phase:'login', config, api:null, account:null, error:'' });
  };

  if (state.phase === 'loading') return h(LoadingScreen);
  if (state.phase === 'login') {
    return h(ApiKeyScreen, {
      config:state.config,
      initialError:state.error,
      onAuthenticate:authenticate,
      onExit:exit,
    });
  }
  return h(AgentScreen, {
    api:state.api,
    account:state.account,
    config:state.config,
    services,
    onLogout:logout,
  });
}

export async function launchTui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The Emper terminal UI requires an interactive terminal.');
  }
  const instance = render(h(EmperTui), { exitOnCtrlC:false });
  await instance.waitUntilExit();
}

export { terminalText };
