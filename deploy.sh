#!/usr/bin/env bash
set -euo pipefail
DEPLOY_DIR="$HOME/tools/claude-tui-bot"
mkdir -p "$DEPLOY_DIR"
cp bot.js tmux.js package.json package-lock.json "$DEPLOY_DIR/"
cd "$DEPLOY_DIR"
npm ci --omit=dev --silent
systemctl --user restart claude-tui-bot
echo "Deployed and restarted."
