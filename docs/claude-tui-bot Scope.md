# Scope — claude-tui-bot

## Purpose

A personal Telegram bot that provides a mobile interface to Claude Code CLI. Allows sending prompts to Claude and receiving responses via Telegram, including full support for Claude's interactive permission prompts and selection menus.

## In Scope

- Relaying Telegram messages into Claude Code interactive sessions (tmux)
- Streaming Claude terminal output back to Telegram as it appears
- Detecting and surfacing Claude's interactive prompts (permission requests, Yes/No/Edit choices) as Telegram inline keyboard buttons
- Session persistence across bot restarts
- Single-user or small-group access control via `ALLOWED_USER_IDS`

## Out of Scope

- Multi-tenant or public-facing deployment
- Replacing the Claude Code terminal interface (tmux sessions remain accessible directly via SSH)
- Managing Claude Code configuration (that belongs in `claude-stack`)
- The legacy `telegram-claude-bot` (stream-json based, different bot token, runs separately)

## Environments

Runs on **WSL2** as a systemd user service. The Oracle VM runs the legacy bot only (for now).

## User Workflow

1. Open Telegram, message the bot
2. Bot routes the message into Claude Code running in a tmux window
3. Claude's TUI output streams back to Telegram in real time
4. If Claude presents a permission prompt or choice, Telegram inline buttons appear
5. Tap a button → the key is sent to the tmux window → Claude proceeds
6. Session persists; next message continues the same Claude context
