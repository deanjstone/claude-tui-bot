# Architecture — claude-tui-bot

## Overview

A Telegram bot that interfaces with Claude Code CLI via tmux. Claude runs interactively in a tmux window; the bot relays terminal output to Telegram and routes user input back into the session.

## Component Map

```
Telegram ──► bot.js (Telegraf)
                │
                ├── tmux.js (thin tmux CLI wrapper)
                │       │
                │       └── tmux session: claude-tui-bot
                │               └── window: user-<userId>
                │                       └── claude (interactive CLI)
                │
                └── capturePane polling (500ms interval)
                        ├── hash-diff → stream to Telegram
                        ├── completion: pane stable 1.5s + ╭/╰ present
                        └── interactive prompt: ❯ detected → inline keyboard
```

## Key Files

| File | Purpose |
|---|---|
| `bot.js` | Main Telegraf bot, tmux session management, polling loop, prompt detection |
| `tmux.js` | Async wrapper for tmux CLI: hasSession, newSession, ensureSession, newWindow, killWindow, capturePane, sendKeys, stripAnsi |
| `deploy.sh` | Copies source to `~/tools/claude-tui-bot/`, restarts the systemd service |
| `.env` | Secrets: BOT_TOKEN, CLAUDE_PATH, ALLOWED_USER_IDS, OWNER_CHAT_ID |

## Session Model

- One tmux session named `claude-tui-bot` per machine
- One tmux window per Telegram user: `user-<userId>`
- Sessions persist across bot restarts — reconnecting to an existing window resumes context
- `tmux.js` exposes `ensureSession` / `ensureWindow` — idempotent, safe to call on every message

## Polling and Completion Detection

```
Every 500ms:
  capturePane → strip ANSI → hash
  if hash changed → send update to Telegram

Completion:
  pane hash stable for 1.5s AND pane contains ╭ or ╰

Interactive prompt:
  ❯ (U+276F) detected in stable pane → awaitNavButton()
```

## Interactive Button Sets

| Set | Trigger | Buttons |
|---|---|---|
| `confirm` | Yes/No/Edit prompt | Yes (1) / No (2) / Edit (3) |
| `permission` | Allow/Deny prompt | Allow (1) / Deny (2) |
| `continue` | Pause prompt | Enter / Escape |
| `nav` | General ❯ prompt | ↑ / ↓ / ↵ / Esc |

## Deployment

- Source repo: `~/projects/claude-tui-bot/`
- Runtime: `~/tools/claude-tui-bot/`
- Deploy: `cd ~/projects/claude-tui-bot && ./deploy.sh`
- Service: `systemd --user` unit `claude-tui-bot`
- Logs: `journalctl --user -u claude-tui-bot -f`
- Node: v22 via fnm (`~/.local/share/fnm/node-versions/v22.22.2/`)
