# claude-tui-bot

A Telegram bot that gives you a mobile-friendly interface to Claude Code CLI. Claude runs in a persistent tmux session — plan mode, tool use, and all interactive prompts are handled natively. Responses stream live to Telegram; interactive menus surface as inline buttons.

## Features

- **Streaming responses** — a placeholder message appears immediately and is edited in-place with HTML formatting as Claude generates output
- **Interactive prompt support** — plan mode confirmations, tool permissions, model selection, and checkpoints all work via Telegram inline keyboard buttons
- **Persistent sessions** — Claude runs in a tmux window that survives bot restarts; conversation context is never lost on redeploy
- **Startup validation** — verifies the Claude CLI exists and is executable before the bot starts

## Requirements

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- tmux
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- systemd (user session) for process management

## Setup

Source lives in the git repo (`~/projects/claude-tui-bot/`). The running bot lives in `~/tools/claude-tui-bot/` — a clean deployment directory separate from the working tree.

**1. Clone**

```bash
git clone https://github.com/deanjstone/claude-tui-bot ~/projects/claude-tui-bot
```

**2. Create your Telegram bot**

Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. Copy the token it gives you.

**3. Configure**

```bash
mkdir -p ~/tools/claude-tui-bot
cp ~/projects/claude-tui-bot/.env.example ~/tools/claude-tui-bot/.env
```

Edit `~/tools/claude-tui-bot/.env`:

```env
BOT_TOKEN=7123456789:AAF...your-token-here
CLAUDE_PATH=/home/youruser/.local/bin/claude   # optional, auto-detected if omitted
```

**4. Install the systemd user service**

Edit the service template to replace `YOUR_USER` with your username, then install it:

```bash
sed "s/YOUR_USER/$USER/g" ~/projects/claude-tui-bot/claude-tui-bot.service \
  > ~/.config/systemd/user/claude-tui-bot.service
systemctl --user daemon-reload
systemctl --user enable claude-tui-bot
```

**5. Deploy and start**

```bash
cd ~/projects/claude-tui-bot
chmod +x deploy.sh
./deploy.sh
```

`deploy.sh` copies `bot.js`, `tmux.js`, and dependencies to `~/tools/claude-tui-bot/`, installs production packages, and restarts the service. Run it after every change.

**Useful commands:**

```bash
./deploy.sh                                    # deploy latest working tree and restart
journalctl --user -u claude-tui-bot -f         # tail logs
systemctl --user status claude-tui-bot         # check process health
tmux attach -t claude-tui-bot                  # attach to the Claude tmux session
```

For quick local testing without deploying:

```bash
cd ~/tools/claude-tui-bot && node bot.js
```

## Usage

Send any message to start a conversation with Claude. Claude runs interactively in a tmux window with access to your filesystem and shell.

| Command | Description |
|---|---|
| `/start` | Show help |
| `/help` | Show help |
| `/new` | Start a fresh conversation (kills the tmux window) |
| `/session` | Show current session status |
| `/cancel` | Interrupt the current in-flight request (sends Ctrl+C) |
| `/restart` | Restart the bot via systemd |

When Claude enters an interactive prompt (plan mode, tool permission, model selection), inline buttons appear automatically for navigation.

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
