# telegram-claude-bot

A Telegram bot that gives you a mobile-friendly interface to Claude Code CLI. Send messages from Telegram, get streaming responses edited live in the chat, and approve or deny Claude's tool use (shell commands, file edits) directly from your phone.

## Features

- **Streaming responses** — a placeholder message appears immediately and is edited in-place with HTML formatting (code blocks, bold, inline code) as Claude generates output
- **Permission gateway** — tool requests show a readable preview (`$ command`, file path, query) with Allow / Deny buttons; after execution the message updates to show the result output; auto-denies after 5 minutes if unanswered
- **Persistent sessions** — conversation context survives bot restarts via atomic-write-safe `sessions.json` in the deploy directory; session expiry is surfaced to the user before retry
- **Startup validation** — verifies the Claude CLI exists and is executable before the bot starts; logs the detected version
- **Categorized errors** — timeouts, process failures, and session expiry each produce a distinct, actionable error message

## Requirements

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) v2.x installed and authenticated
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- systemd (user session) for process management

## Setup

Source lives in the git repo (`~/projects/telegram-claude-bot/`). The running bot lives in `~/tools/telegram-claude-bot/` — a clean deployment directory separate from the working tree.

**1. Clone**

```bash
git clone https://github.com/deanjstone/telegram-claude-bot ~/projects/telegram-claude-bot
```

**2. Create your Telegram bot**

Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. Copy the token it gives you.

**3. Configure**

```bash
mkdir -p ~/tools/telegram-claude-bot
cp ~/projects/telegram-claude-bot/.env.example ~/tools/telegram-claude-bot/.env
```

Edit `~/tools/telegram-claude-bot/.env`:

```env
BOT_TOKEN=7123456789:AAF...your-token-here
CLAUDE_PATH=/home/youruser/.local/bin/claude   # optional, auto-detected if omitted
```

**4. Install the systemd user service**

Edit the service template to replace `YOUR_USER` with your username, then install it:

```bash
sed "s/YOUR_USER/$USER/g" ~/projects/telegram-claude-bot/telegram-claude-bot.service \
  > ~/.config/systemd/user/telegram-claude-bot.service
systemctl --user daemon-reload
systemctl --user enable telegram-claude-bot
```

**5. Deploy and start**

```bash
cd ~/projects/telegram-claude-bot
chmod +x deploy.sh
./deploy.sh
```

`deploy.sh` copies `bot.js` and dependencies to `~/tools/telegram-claude-bot/`, installs production packages, and restarts the service. Run it after every change.

**Useful commands:**

```bash
./deploy.sh                                         # deploy latest working tree and restart
journalctl --user -u telegram-claude-bot -f         # tail logs
systemctl --user status telegram-claude-bot         # check process health
```

For quick local testing without deploying:

```bash
cd ~/tools/telegram-claude-bot && node bot.js
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
| `/restart` | Restart the bot via systemd |

When Claude requests to run a tool, you'll receive a formatted message like:

```
🔧 Bash
$ ls -la /home/user/project
```

with **✅ Allow** and **❌ Deny** buttons. Tap Allow to let it proceed, Deny to cancel. After execution the message updates to show a snippet of the tool's output. Unanswered requests auto-deny after 5 minutes.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_TOKEN` | Yes | — | Telegram bot token from BotFather |
| `CLAUDE_PATH` | No | `/home/$USER/.local/bin/claude` | Path to Claude CLI binary |
| `ALLOWED_USER_IDS` | No | — | Comma-separated Telegram user IDs allowed to use the bot; if unset, all users are permitted |
| `OWNER_CHAT_ID` | No | — | Telegram user ID to message on startup ("Bot online.") |

## Architecture

See [docs/ADR.md](docs/ADR.md) for architecture decisions.

## License

MIT
