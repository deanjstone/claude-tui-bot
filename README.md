# telegram-claude-bot

A Telegram bot that gives you a mobile-friendly interface to Claude Code CLI. Send messages from Telegram, get streaming responses edited live in the chat, and approve or deny Claude's tool use (shell commands, file edits) directly from your phone.

## Features

- **Streaming responses** — a placeholder message appears immediately and is edited in-place as Claude generates output, no waiting for the full response
- **Permission gateway** — when Claude wants to run a tool (Bash, file edit, etc.), you get an inline Allow / Deny button; auto-denies after 5 minutes if unanswered
- **Persistent sessions** — conversation context survives bot restarts via atomic-write-safe `sessions.json`
- **Startup validation** — verifies the Claude CLI exists and is executable before the bot starts; logs the detected version

## Requirements

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) v2.x installed and authenticated
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- PM2 (`npm install -g pm2`) for process management

## Setup

**1. Clone and install**

```bash
git clone https://github.com/deanjstone/telegram-claude-bot
cd telegram-claude-bot
npm install
```

**2. Create your Telegram bot**

Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. Copy the token it gives you.

**3. Configure**

```bash
cp .env.example .env
```

Edit `.env`:

```env
BOT_TOKEN=7123456789:AAF...your-token-here
CLAUDE_PATH=/home/youruser/.local/bin/claude   # optional, auto-detected if omitted
```

**4. Run**

```bash
pm2 start bot.js --name telegram-claude-bot
pm2 save
pm2 startup   # prints a command — run it to enable auto-start on reboot
```

**Useful pm2 commands:**

```bash
pm2 restart telegram-claude-bot   # apply changes after editing bot.js
pm2 logs telegram-claude-bot      # tail logs
pm2 status                        # check process health
```

For quick local testing without pm2:

```bash
node bot.js
```

## Usage

Send any message to start a conversation with Claude. Claude Code runs in your home directory with access to your filesystem and shell.

| Command | Description |
|---|---|
| `/start` | Show help |
| `/help` | Show help |
| `/new` | Start a fresh conversation (clears session) |
| `/session` | Show current session ID |
| `/cancel` | Abort the current in-flight request |

When Claude requests to run a tool, you'll receive a message like:

```
Tool request: Bash
`{"command":"ls -la"}`
```

with **✅ Allow** and **❌ Deny** buttons. Tap Allow to let it proceed, Deny to cancel. Unanswered requests auto-deny after 5 minutes.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_TOKEN` | Yes | — | Telegram bot token from BotFather |
| `CLAUDE_PATH` | No | `/home/$USER/.local/bin/claude` | Path to Claude CLI binary |
| `ALLOWED_USER_IDS` | No | — | Comma-separated Telegram user IDs allowed to use the bot; if unset, all users are permitted |

## Architecture

See [docs/ADR.md](docs/ADR.md) for architecture decisions.

## License

MIT
