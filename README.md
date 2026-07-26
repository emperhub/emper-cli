# Emper Code

Emper Code is the full OpenCode terminal experience connected to Emper accounts,
points, and the public Nova model catalog. It includes project agents, shell and
file tools, permission review, sessions, diffs, LSP, MCP, subagents, image input,
and the slash command palette.

## Requirements

- Node.js 20.17 or newer
- An Emper API key beginning with `ask-`

## Install

```powershell
npm install --global @emperhub/cli
emper
```

The first launch asks for an API key in a masked field, validates it, then saves
it under the current user's Emper config directory. For automation, set
`EMPER_API_KEY`; environment credentials take priority over the saved key.

## Usage

```text
emper                         Open the full terminal UI
emper run "fix the tests"     Run an agent task
emper models emper            List available Nova models
emper session list            List saved sessions
emper mcp                     Manage MCP servers
emper agent                   Manage agents

emper login                   Save and validate an Emper API key
emper logout                  Remove the saved key
emper whoami                  Show the connected account and points
emper usage --limit 20        Show recent point usage
emper config                  Show or update Emper defaults
```

Inside the terminal UI, type `/` to open the command palette. Use `/models` to
change Nova models, `/sessions` to reopen previous work, and `/points` to refresh
the Emper point balance. The remaining and used point totals are also shown next
to the prompt.

Only the public model IDs `nova-x1`, `nova-x3`, and `nova-x5` are exposed. Nova
X5 accepts image input. The selected model and subagents still consume points
through the normal Emper API billing rules.

File edits, shell commands, and access outside the active project use OpenCode's
permission review. Session sharing is disabled by the Emper wrapper.

## Configuration

The default API base is `https://ai-unchained.ink/v1`. Local development may use
HTTP on localhost; remote API URLs must use HTTPS.

```powershell
emper config --model nova-x1
emper config --api-url http://127.0.0.1:3001/v1
```

The wrapper creates OpenCode provider configuration in memory for each launch.
The API key is passed through the child process environment and is never written
into OpenCode configuration or session files.

## Branding and theme

OpenCode is used as the agent runtime only. Emper's visible terminal branding,
logo, account status, and footer live in `runtime/emper-plugin.tsx`; the SORU
color palette lives in `runtime/soru.json`. `runtime/tui.json` selects that
theme, so the interface can be redesigned without changing the agent engine.

At launch, Emper copies the bundled theme into its isolated user configuration.
It does not create `.opencode` files inside user projects.

## OpenCode

Emper Code includes OpenCode 1.18.5 under the MIT License. See
`THIRD_PARTY_NOTICES.md` for attribution.
