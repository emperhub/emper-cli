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

Then log in. The interactive prompt avoids placing the key in terminal history:

```powershell
emper login
```

For temporary or automated sessions, set `EMPER_API_KEY` instead. Environment credentials override a saved key.

## Commands

```text
emper login                   Validate and save an API key
emper logout                  Remove the saved API key
emper whoami                  Show account and point balance
emper models                  List models available to the account
emper usage --limit 20        Show recent usage
emper chat                    Start a streaming chat
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

`emper run` is read-only by default. It can list, read, and search safe text files beneath the current directory. It cannot execute shell commands.

Use `--apply` to expose file-writing tools. Before each write, Emper prints a unified diff and asks for approval. Existing files are backed up under the user's Emper config directory. `--yes` skips prompts only when it is supplied together with `--apply`.

The project tools reject path traversal and symlink escapes. They exclude ignored files and common secret or generated paths, including `.env*`, credentials, private keys, databases, `.git`, `node_modules`, and `.emper`.

## Local credential storage

Configuration is stored outside projects at `~/.config/emper/config.json`, or under `EMPER_CONFIG_DIR`/`XDG_CONFIG_HOME` when set. The CLI creates the directory and file with restrictive owner-only modes where the operating system supports POSIX permissions. On Windows, the file additionally remains under the current user's profile ACL.
