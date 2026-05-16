# TODO — claude-tui-bot

## Calibration (post-deploy)

- [ ] **Completion detection** — verify ╭/╰ heuristic fires correctly against real Claude TUI output; tune the 1.5s stability threshold if needed
- [ ] **Prompt detection** — verify `❯` (U+276F) matching fires on actual Claude permission/choice prompts and not on false positives (e.g. shell prompts in the pane)
- [ ] **Key sequences** — confirm that sending `1`, `2`, `3` for confirm buttons and arrow keys for nav match what Claude actually expects in its menus

## Pending Features

- [ ] **Scrollback for long responses** — `tmux capture-pane -S -` + pre-send line count diff; required when Claude output exceeds terminal height
- [ ] **Message chunking** — Telegram messages > 4096 chars are silently truncated; need to split long pane captures
- [ ] **Session list command** — a `/sessions` command to list and switch between active tmux windows

## Known Issues

- [ ] **ANSI stripping** — `stripAnsi` regex may miss some escape sequences; visual artifacts possible in long tool-use outputs
- [ ] **Old bot coexistence** — `telegram-claude-bot` (stream-json, legacy) runs alongside on the same machine with a different bot token; verify they don't share tmux session names

## Future Work

- [ ] **Multi-user support** — currently ALLOWED_USER_IDS is a flat allowlist; no per-user permission scoping
- [ ] **iOS shortcut integration** — trigger common Claude prompts from iOS Shortcuts via Telegram bot commands
