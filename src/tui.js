import process from 'node:process';
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
import { createWorkspace } from './workspace.js';

const h = React.createElement;
const LOGO = [
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
});

function terminalText(value) {
  return redactSecrets(value)
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function Brand({ caption }) {
  return h(Box, { flexDirection:'column', alignItems:'center', marginBottom:1 },
    ...LOGO.map((line, index) => h(Text, { key:index, bold:true, color:index < 2 ? 'cyan' : 'blue' }, line)),
    h(Text, { color:'gray' }, caption),
  );
}

function Shell({ children }) {
  return h(Box, { flexDirection:'column', paddingX:1, paddingY:1 },
    h(Box, {
      flexDirection:'column',
      borderStyle:'round',
      borderColor:'cyan',
      paddingX:2,
      paddingY:1,
      minWidth:58,
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
      borderStyle:'round',
      borderColor:error ? 'red' : busy ? 'yellow' : 'green',
      paddingX:1,
      marginTop:1,
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

function TranscriptLine({ entry }) {
  const labels = {
    user:{ label:'YOU', color:'green' },
    assistant:{ label:'EMPER', color:'cyan' },
    tool:{ label:'TOOL', color:'yellow' },
    system:{ label:'INFO', color:'gray' },
    error:{ label:'ERROR', color:'red' },
  };
  const style = labels[entry.type] || labels.system;
  return h(Box, { key:entry.id, flexDirection:'column', marginBottom:1 },
    h(Text, { bold:true, color:style.color }, style.label),
    h(Text, { wrap:'wrap' }, terminalText(entry.text)),
  );
}

export function AgentScreen({ api, account:initialAccount, config, services, onLogout }) {
  const { exit } = useApp();
  const [account, setAccount] = useState(initialAccount);
  const [entries, setEntries] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(null);
  const [allowWrite, setAllowWrite] = useState(false);
  const [approval, setApproval] = useState(null);
  const nextId = useRef(1);
  const approvalRef = useRef(null);

  const append = useCallback((type, text) => {
    setEntries(current => [...current, { id:nextId.current++, type, text:terminalText(text) }].slice(-16));
  }, []);

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
          model:config.model,
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
  }, [allowWrite, api, append, config.model, requestApproval, services]);

  useInput((rawInput, key) => {
    if (approval && ['y', 'Y', 'n', 'N'].includes(rawInput)) {
      const accepted = rawInput.toLowerCase() === 'y';
      approval.resolve(accepted);
      approvalRef.current = null;
      setApproval(null);
      return;
    }
    if (key.ctrl && rawInput === 'c') exit();
  }, { isActive:Boolean(approval) || !busy });

  const command = async value => {
    if (value === '/exit' || value === '/quit') {
      exit();
      return true;
    }
    if (value === '/clear') {
      session?.clear();
      setEntries([]);
      append('system', 'Agent context cleared.');
      return true;
    }
    if (value === '/status') {
      append('system', `Model ${config.model} | ${allowWrite ? 'REVIEW EDITS' : 'READ ONLY'} | ${Math.max(0, (session?.messages.length || 1) - 1)} context messages`);
      return true;
    }
    if (value === '/apply' || value === '/readonly') {
      const nextMode = value === '/apply';
      if (nextMode === allowWrite) {
        append('system', nextMode ? 'Review-edits mode is already active.' : 'Read-only mode is already active.');
        return true;
      }
      session?.clear();
      setAllowWrite(nextMode);
      append('system', nextMode
        ? 'Review-edits mode enabled. Every file change still requires Y/N approval.'
        : 'Read-only mode enabled. Agent context was reset.');
      return true;
    }
    if (value === '/help') {
      append('system', '/apply review edits | /readonly inspect only | /clear reset context | /logout change key | /exit close');
      return true;
    }
    if (value === '/logout') {
      await onLogout();
      return true;
    }
    return false;
  };

  const submit = async rawValue => {
    const value = String(rawValue || '').trim();
    if (!value || busy) return;
    setInput('');
    if (await command(value)) return;
    if (!session) {
      append('error', 'Agent is still connecting.');
      return;
    }
    append('user', value);
    setBusy(true);
    try {
      await session.ask(value);
      setAccount(await api.me());
    } catch (error) {
      append('error', publicError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return h(Box, { flexDirection:'column', paddingX:1 },
    h(Box, {
      borderStyle:'round', borderColor:'cyan', paddingX:1, justifyContent:'space-between',
    },
      h(Text, { bold:true, color:'cyan' }, 'EMPER AGENT'),
      h(Text, { color:allowWrite ? 'yellow' : 'gray' }, `${config.model}  |  ${allowWrite ? 'REVIEW EDITS' : 'READ ONLY'}  |  ${number(account.points)} pts`),
    ),
    h(Box, { flexDirection:'column', paddingX:1, paddingY:1 },
      entries.length
        ? entries.map(entry => h(TranscriptLine, { key:entry.id, entry }))
        : h(Box, { paddingY:1 }, h(Text, { color:'gray' }, `Ready in ${services.cwd}`)),
    ),
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
        onChange:setInput,
        onSubmit:submit,
        placeholder:approval ? 'Review the diff above' : busy ? 'Agent is working...' : 'Ask Emper to inspect this project',
        focus:!approval && !busy && Boolean(session),
        highlightPastedText:true,
      }),
    ),
    h(Box, { justifyContent:'space-between', paddingX:1 },
      h(Text, { color:approval || busy ? 'yellow' : 'gray' }, approval ? 'Waiting for approval' : busy ? 'Working with project tools...' : '/help commands'),
      h(Text, { color:'gray' }, account.username),
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
