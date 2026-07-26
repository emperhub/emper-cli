# Emper CLI

Emper CLI connects your terminal to the public Nova API. It supports streaming chat, account and usage checks, and a project-aware coding mode that cannot run shell commands.

## Requirements

- Node.js 20.17 or newer
- An Emper API key beginning with `ask-`

## Install

From npm after the package is published:

```powershell
npm install --global @emperhub/cli
```

From this repository:

```powershell
npm install
npm install --global .
```

Launch the terminal UI. If no key is saved, Emper opens a masked API-key screen and validates the account before entering the Agent:

```powershell
emper
```

`emper login` remains available for a minimal prompt-only login flow.

The Agent header shows the active model, workspace, remaining points, and total points used. Use `/model` to switch between models available to the active API key and `/session` to open saved chats for the current workspace.

Typing `/` opens the command palette immediately. Continue typing to filter it, use the arrow keys to move, press Tab to complete, or press Enter to run the selected command.

For temporary or automated sessions, set `EMPER_API_KEY` instead. Environment credentials override a saved key.

## Commands

```text
emper                         Open the interactive terminal UI
emper login                   Validate and save an API key
emper logout                  Remove the saved API key
emper whoami                  Show account and point balance
emper models                  List models available to the account
emper usage --limit 20        Show recent usage
emper chat                    Start a streaming chat
emper agent                   Start an interactive coding agent
emper agent --apply           Allow reviewed file changes
emper run "inspect this app"  Inspect the current project without writing
emper run "fix the bug" --apply
emper config                  Show current defaults with a masked key
```

Set defaults with:

```powershell
emper config --model nova-x1 --max-tokens 2000
```

The default API base is `https://ai-unchained.ink/v1`. A localhost HTTP URL is accepted for development; remote API URLs must use HTTPS.

## Safe project mode

`emper agent` starts a continuous AI coding session in the current directory. It remembers the conversation, chooses file tools itself, and supports `/clear`, `/status`, `/help`, and `/exit`. You can also provide its first task directly:

```powershell
emper agent "inspect this project and find the likely bug"
```

`emper agent` and `emper run` are read-only by default. They can list, read, and search safe text files beneath the current directory. They cannot execute shell commands.

The no-argument terminal UI also starts in `READ ONLY`. Enter `/apply` to switch to `REVIEW EDITS`; Emper displays the full unified diff and waits for `Y` or `N` before every write. Enter `/readonly` to switch back. Conversation context is preserved when switching modes or models.

Terminal UI commands:

```text
/model       Choose an available Nova model
/session     Open a saved chat for the current workspace
/new         Start a clean session
/apply       Enable reviewed file changes
/readonly    Return to inspection-only mode
/clear       Clear the active conversation context
/status      Show model, mode, context, and point balance
/logout      Remove the saved API key
/exit        Close Emper
```

Agent tools report their live status, target path, result count, and elapsed time in the transcript. The safe tool set can find files with glob patterns, search text with file filters, read one or several files, replace exact text, apply patches, and create or rewrite files. Shell execution remains unavailable.

Use `--apply` to expose file-writing tools. Before each write, Emper prints a unified diff and asks for approval. Existing files are backed up under the user's Emper config directory. `--yes` skips prompts only when it is supplied together with `--apply`.

The project tools reject path traversal and symlink escapes. They exclude ignored files and common secret or generated paths, including `.env*`, credentials, private keys, databases, `.git`, `node_modules`, and `.emper`.

Agent tool loops can make multiple API requests for one task. Every request uses the normal API point billing for the selected Nova model.

Chats are stored per workspace under the Emper config directory. Stored session text is sanitized for API keys and authorization tokens, uses owner-only file permissions where supported, and never stores the active API credential as session metadata.

## Local credential storage

Configuration is stored outside projects at `~/.config/emper/config.json`, or under `EMPER_CONFIG_DIR`/`XDG_CONFIG_HOME` when set. The CLI creates the directory and file with restrictive owner-only modes where the operating system supports POSIX permissions. On Windows, the file additionally remains under the current user's profile ACL.
