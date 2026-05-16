#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$HOME/tools/claude-tui-bot"

# --- secrets ---
BW_SESSION_FILE="$HOME/.bw_session"
if [[ ! -f "$BW_SESSION_FILE" ]]; then
  echo "Error: ~/.bw_session not found. Run: bw-unlock" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$BW_SESSION_FILE"

BW_STATUS=$(bw status 2>/dev/null | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || true)
if [[ "$BW_STATUS" != "unlocked" ]]; then
  echo "Error: Bitwarden vault is locked or session expired. Run: bw-unlock" >&2
  exit 1
fi

echo "Pulling secrets from Bitwarden..."
mkdir -p "$DEPLOY_DIR"

# Item name → env var key (username field), env var value (password field)
BW_ITEMS=(
  "telegram-claude-tui-bot-token"
  "telegram-allowed-user-ids"
  "telegram-owner-chat-id"
)

ENV_FILE="$DEPLOY_DIR/.env"
: > "$ENV_FILE"
chmod 600 "$ENV_FILE"

for item in "${BW_ITEMS[@]}"; do
  KEY=$(bw get username "$item" 2>/dev/null || true)
  VALUE=$(bw get password "$item" 2>/dev/null || true)
  if [[ -n "$KEY" ]]; then
    echo "$KEY=$VALUE" >> "$ENV_FILE"
  fi
done

# --- deploy ---
cp bot.js tmux.js package.json package-lock.json "$DEPLOY_DIR/"
cd "$DEPLOY_DIR"
npm ci --omit=dev --silent
systemctl --user restart claude-tui-bot
echo "Deployed and restarted."
