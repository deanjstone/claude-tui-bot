# Decisions — claude-tui-bot

See `ADR.md` for the full record. Key decisions summarised here.

---

## ADR-015: tmux interactive session (current architecture)

**Decision:** Replace the original stream-json subprocess approach with a tmux-based interactive session.

**Why:** Claude Code's interactive TUI (permission prompts, multi-choice menus, inline diffs) could not be captured via `--output-format stream-json`. The stream-json approach exposed only text output and required reimplementing permission interception in the bot. Running Claude interactively inside tmux exposes the full TUI — the bot becomes a relay rather than a protocol adapter.

**Trade-offs:** Polling is less efficient than event-driven streaming; pane content requires ANSI stripping; completion detection is heuristic (╭/╰) rather than protocol-level.

---

## ADR-001: Claude Code CLI rather than Anthropic SDK

Delegate to the Claude Code CLI entirely. The bot is a Telegram adapter — not an AI framework. This inherits MCP tools, memory, file system access, and multi-turn context without reimplementation.

---

## ADR-003: Permission gateway (original stream-json era)

In the original architecture, `tool_use` content blocks were intercepted mid-stream and paused with Allow/Deny buttons. Superseded by tmux interactive mode, where Claude's own permission prompts appear in the pane and are detected via the `❯` heuristic.

---

## ADR-005: Atomic writes for session persistence

Sessions are written to `sessions.json.tmp` then renamed — POSIX rename is atomic, preventing corrupt state if the process is killed mid-write.

---

## ADR-006: Single-file architecture

`bot.js` is intentionally a single file. The project is a personal tool with no external contributors; splitting into modules adds navigation overhead without benefit at this scale.

---

## Why systemd user service, not PM2

PM2 adds a process manager layer with its own config format and restart semantics. `systemd --user` is already present on Ubuntu 22+, integrates with the system journal (`journalctl`), and requires no additional install.

---

## Why fnm, not global Node

fnm allows per-project Node version pinning without touching system Node. The service ExecStart uses the absolute fnm path to avoid PATH issues in a non-login shell context.
