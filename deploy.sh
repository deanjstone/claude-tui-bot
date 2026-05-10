#!/usr/bin/env bash
set -euo pipefail
DEPLOY_DIR="$HOME/tools/telegram-claude-bot"
mkdir -p "$DEPLOY_DIR"
cp bot.js package.json package-lock.json "$DEPLOY_DIR/"
cd "$DEPLOY_DIR"
npm ci --omit=dev --silent
systemctl --user restart telegram-claude-bot
echo "Deployed and restarted."
