# Architecture Decision Records — claude-tui-bot

---

## ADR-001: Use Claude Code CLI as a subprocess rather than the Anthropic SDK directly

**Status:** Accepted

**Context:**
The bot could integrate with Claude either by calling the Anthropic SDK directly (managing conversation turns, tool use, and system prompts manually) or by spawning the Claude Code CLI as a subprocess and delegating to it.

**Decision:**
Delegate entirely to the Claude Code CLI via `spawn`. The CLI is invoked with `-p <message>`, `--output-format stream-json --verbose`, and optionally `--resume <session_id>`.

**Consequences:**
- The bot inherits all of Claude Code's capabilities (MCP tools, file system access, multi-turn context, memory) without reimplementing them
- The bot stays thin — it's a Telegram adapter, not an AI framework
- Requires Claude Code CLI to be installed and authenticated on the host; the bot cannot run standalone
- Tied to Claude Code CLI's flag interface; breaking changes in the CLI would require bot updates (mitigated by the startup version check in ADR-004)

---

## ADR-002: Use `--output-format stream-json --verbose` for streaming

**Status:** Accepted

**Context:**
The CLI supports three output formats: `json` (waits for full response), `text` (plain text, no session ID), and `stream-json` (newline-delimited JSON events as they occur). The `--verbose` flag is required when using `stream-json` with `-p`.

**Decision:**
Use `stream-json --verbose`. Parse each stdout line as a JSON event. Accumulate text from `assistant` events (content blocks with `type: "text"`), extract `session_id` from the final `result` event.

**Consequences:**
- Enables live message editing as Claude generates output, improving perceived responsiveness significantly for long responses
- Also enables interception of `tool_use` content blocks mid-stream for the permission gateway (ADR-003)
- Requires a line-buffer accumulator to handle partial JSON lines across `data` events — a small complexity cost
- The `--verbose` requirement is non-obvious; omitting it causes a silent failure (process exits with error code 1 and the placeholder "..." is never updated). Documented in code and covered by the startup check.

---

## ADR-003: Implement permission gateway via in-stream tool_use interception

**Status:** Accepted

**Context:**
Claude Code can execute shell commands, edit files, and use other tools. For a bot running on a machine with real file system access, blindly auto-approving all tool use is unsafe.

**Decision:**
When a `tool_use` content block appears in an `assistant` stream event, pause by sending a Telegram message with inline Allow / Deny buttons. A `pendingPermissions` Map holds the outstanding Promise. If the user taps Allow, the stream continues. If they tap Deny (or 5 minutes elapse), the Claude process is killed and the partial response is delivered.

**Consequences:**
- The user has explicit, per-operation control over what Claude can do on their machine
- Shutdown handlers drain `pendingPermissions` with auto-deny so no operations are left orphaned
- The 5-minute timeout prevents the bot from hanging indefinitely if the user misses a permission request
- Tool use interception happens at the stream level, not via a separate permission prompt tool, because the CLI is a subprocess without bidirectional stdin control in this architecture

---

## ADR-004: Validate Claude CLI at startup rather than at first use

**Status:** Accepted

**Context:**
The Claude CLI path is configurable via `CLAUDE_PATH` env var with a hardcoded default. If the path is wrong or the CLI isn't authenticated, the failure would surface only on the first user message, as an unhelpful error.

**Decision:**
Run `checkClaude()` synchronously at process startup. It verifies the binary exists and is executable (`fs.accessSync` with `X_OK`), runs `--version`, logs the result, and calls `process.exit(1)` with a clear message if anything fails. Warns (but does not exit) if major version < 2, since stream-json requires v2+.

**Consequences:**
- Misconfiguration is caught immediately with a clear error rather than surfacing as a cryptic mid-conversation failure
- The `CLAUDE_PATH` constant replaces the hardcoded path throughout, making deployments to non-standard paths straightforward via a single env var

---

## ADR-005: Atomic writes for session persistence

**Status:** Accepted

**Context:**
Session IDs are persisted to `sessions.json` after each Claude response. A direct `writeFileSync` can produce a corrupt (truncated or empty) file if the process is killed mid-write, causing loss of all session context on next startup.

**Decision:**
Write to `sessions.json.tmp` first, then `renameSync` to `sessions.json`. On POSIX systems, rename is atomic at the filesystem level. On `loadSessions`, distinguish `ENOENT` (file doesn't exist yet — normal on first run) from other errors (parse failure from a prior corrupt write) by logging the latter.

**Consequences:**
- Session file is never in a partially-written state; a crash during write leaves the previous valid file intact
- Negligible performance cost (one extra syscall per save)

---

## ADR-006: Single-file architecture (bot.js)

**Status:** Accepted

**Context:**
The bot could be structured as multiple modules (session store, stream handler, permission gateway, Telegram adapter). For a ~300-line personal tool with no external contributors, this adds navigation overhead without meaningful benefit.

**Decision:**
Keep everything in a single `bot.js`. Functions are ordered by dependency (utilities first, then Claude runner, then Telegram handlers).

**Consequences:**
- Easy to read, copy, and deploy — the entire bot is one file
- If the bot grows significantly (e.g., multi-user support, plugin system), this decision should be revisited

---

## ADR-007: User allowlist via ALLOWED_USER_IDS env var

**Status:** Accepted

**Context:**
The bot spawns Claude Code CLI with full filesystem and shell access on the host machine. Anyone who obtains the Telegram bot token can send messages and trigger tool use. For a personal bot this is an unacceptable security exposure.

**Decision:**
Read an optional `ALLOWED_USER_IDS` env var (comma-separated numeric Telegram user IDs) at startup. If set, install a Telegraf middleware that silently drops any update from a user not in the allowlist — no reply, no log. If unset, all users are permitted (backward compatible).

**Consequences:**
- Unauthorized users get no feedback, which avoids confirming the bot exists
- The check is a single middleware registered before all handlers, so new commands and actions are automatically gated
- If `ALLOWED_USER_IDS` is not configured, the bot behaves exactly as before — no breaking change

---

## ADR-008: /cancel command and inFlight upgraded from Set to Map

**Status:** Accepted

**Context:**
Once a message is sent there was no way to abort a running Claude process. Users were locked out for up to 120 seconds (the hardcoded timeout) if Claude started a long agentic task. The original `inFlight` Set tracked only whether a user had a request in progress, not the underlying subprocess.

**Decision:**
Change `inFlight` from a `Set` to a `Map<userId, { proc }>`. The `proc` field starts as `null` and is populated via an `onProcSpawned` callback passed through `streamClaude` → `askClaude` → the `bot.on('text')` handler. Add a `/cancel` command that looks up the user's entry, calls `proc.kill()`, and deletes the entry.

**Consequences:**
- Users can abort any in-flight request immediately without waiting for the timeout
- The `onProcSpawned` callback introduces a small coupling between the Telegram handler and `streamClaude`, but avoids exposing the process reference as a module-level side effect
- `/cancel` when no request is in progress returns a clear "No request in progress" message

---

## ADR-009: HTML rendering for responses

**Status:** Superseded by ADR-011

**Context:**
Claude's output frequently contains markdown (code fences, bold, headers, inline code). The bot was sending all responses as plain text, losing all formatting. Telegram supports MarkdownV2 and HTML parse modes; HTML was chosen because it requires fewer escape rules and is less likely to cause silent parse failures on Claude's free-form output.

**Decision:**
Add a `toHtml(text)` function that converts Claude's markdown to Telegram HTML (escaping `&`, `<`, `>`; converting ` ``` ` fences to `<pre><code>`, inline backticks to `<code>`, `**` to `<b>`, `*` to `<i>`, `#`–`###` headers to `<b>`). Apply `toHtml` only on the final response (in the `close` handler), with `parse_mode: 'HTML'`. If Telegram rejects the HTML (malformed output from Claude), fall back to the same text without a parse mode. Streaming edits continue to use plain text because partial markdown mid-stream is frequently malformed.

**Consequences:**
- Code blocks, bold, and inline code render correctly in the final message
- Streaming edits remain plain text — there is a brief visual shift when the final HTML edit replaces the last streaming edit, which is acceptable
- The HTML conversion is a best-effort transform; unusual markdown constructs Claude produces may not convert perfectly
- Splitting long responses on `htmlText` can theoretically cut inside an HTML tag; acceptable for a personal tool

---

## ADR-010: Per-user rate limiting and improved error visibility

**Status:** Accepted

**Context:**
Two reliability gaps existed: (1) rapid message sending could queue up multiple Claude spawns per user, and (2) Telegram API errors during streaming (`editMessageText`) were caught by empty `catch {}` blocks, making failures invisible in logs.

**Decision:**
(1) Track `lastMessageTime` per user in a Map. In `bot.on('text')`, reject messages sent within 3 seconds of the previous one with a user-visible reply. Update the timestamp in the `finally` block. (2) Replace empty `catch {}` in the `editTimer` interval with `console.warn`. In the `close` handler, if `editMessageText` fails fall back to `sendMessage` to the same chat and log the warning; wrap each overflow chunk send in try/catch with a warning log.

**Consequences:**
- Accidental double-sends on mobile are gracefully rejected rather than queuing a second Claude spawn
- Failed Telegram edits are now visible in the process log, making debugging network or permission issues tractable
- The 3-second window is intentionally short to avoid frustrating legitimate rapid follow-up messages

---

## ADR-011: HTML formatting applied during streaming (supersedes ADR-009)

**Status:** Accepted

**Context:**
ADR-009 applied `toHtml()` only on the final response, leaving streaming edits as plain text. This caused a jarring visual shift — the message would show unstyled text throughout generation, then snap to formatted HTML when Claude finished. The concern in ADR-009 was that partial markdown mid-stream would produce broken HTML tags.

**Decision:**
Apply `toHtml()` on every streaming edit. The concern about broken HTML is mitigated by the design of the regex patterns: all conversion patterns require matched delimiters (both ` ``` `, both `**`, both backticks), so partial markdown simply doesn't match and the raw characters pass through as escaped plain text until the closing delimiter arrives. No broken `<b>` or `<code>` tags can be produced. The `editTimer` callback now tries `editMessageText` with `parse_mode: 'HTML'` first; if Telegram rejects it (rare), falls back to plain text for that tick. The inline-code and italic regexes were also tightened to reject newlines within delimiters (`[^`\n]`, `[^*\n]`) to prevent cross-paragraph false matches.

**Consequences:**
- Code blocks and formatting appear progressively during streaming — no end-of-response visual shift
- The fallback to plain text on a rejected HTML edit is seamless; the next tick will retry with HTML
- `toHtml()` runs on every edit interval tick (~every 1.5s); negligible CPU cost for a personal tool

---

## ADR-012: Tool-aware permission preview and post-execution result display

**Status:** Accepted

**Context:**
The original permission prompt showed `JSON.stringify(input).slice(0, 200)` — a raw JSON blob that was hard to parse visually, especially on mobile. After a tool ran, the message was updated only to "Allowed" with no indication of what the tool actually did.

**Decision:**
Add `formatToolPreview(toolName, input)` that produces a human-readable preview based on tool type: Bash commands as `$ <command>`, file tools as path + optional content snippet, web tools as URL or query, everything else as pretty-printed JSON up to 300 chars. The permission message is rendered with `parse_mode: 'HTML'`, tool name in `<b>`, preview in `<pre><code>`. Add an `allowedTools` Map (`toolUseId → { chatId, msgId, toolName }`). When the user taps Allow, the entry is stored there. When a `user` event with a `tool_result` block arrives in the stream (emitted by `--verbose`), the corresponding message is edited to show a 200-char excerpt of the tool output.

**Consequences:**
- Shell commands are immediately readable without mentally parsing JSON
- Users can see what a tool actually returned without waiting for Claude's prose summary
- `allowedTools` entries are deleted on consumption; no memory leak for long sessions
- Denied tools never write to `allowedTools`, so their messages are simply updated to "Denied" without a result phase

---

## ADR-013: Categorized error messages and visible session retry

**Status:** Accepted

**Context:**
All errors were surfaced as `Error: ${err.message}` — the raw Node.js error string. Timeouts were indistinguishable from process crashes, and when `askClaude` retried with a fresh session after a failure, it did so silently, leaving the user unaware that context had been lost.

**Decision:**
Attach a `.code` property to errors thrown inside `streamClaude`: `'TIMEOUT'` for the 120-second kill, `'PROCESS_ERROR'` (with `.exitCode`) for non-zero Claude process exits. Add `formatError(err)` that maps these codes to actionable user messages (timeout suggests simplifying the request; process error suggests `/new`; ENOENT points to `CLAUDE_PATH`). In `askClaude`, send `⚠️ Session expired — retrying as new conversation…` before the retry so the user knows context was reset.

**Consequences:**
- Users can act on errors rather than seeing an opaque Node.js message
- Session expiry is no longer a silent internal event — users know when their conversation history restarted
- The `formatError` function is a single switch point; adding new error categories requires one `if` branch

---

## ADR-014: Separate source and deployment directories

**Status:** Accepted

**Context:**
The bot originally ran directly from its git repository (`~/projects/claude-tui-bot/`). This meant the systemd service pointed at the working tree, so any partial edit to `bot.js` was immediately live, `.env` and `sessions.json` sat alongside source files, and `node_modules` lived in the repo directory.

**Decision:**
Introduce a distinct deployment directory at `~/tools/claude-tui-bot/`. A `deploy.sh` script in the repo copies `bot.js`, `package.json`, and `package-lock.json` to the deploy directory, runs `npm ci --omit=dev`, and restarts the service. The systemd service's `WorkingDirectory`, `ExecStart`, and `EnvironmentFile` all point at `~/tools/`. The `.env` file lives only in the deploy directory; `sessions.json` is generated there at runtime. The git repo stays clean of runtime state.

**Consequences:**
- Editing source files in the repo has no effect until `./deploy.sh` is run — no accidental live changes
- `.env` is decoupled from the repo directory; less risk of accidentally committing secrets
- `sessions.json` is stable across source edits and repo operations (e.g., `git clean` can't delete it)
- `npm ci --omit=dev` on each deploy keeps `node_modules` up to date without manual intervention
- The service template in the repo uses `YOUR_USER` as a placeholder; the README documents a `sed` one-liner to install it correctly for any username

---

## ADR-015: Switch from stream-json subprocess to tmux-based interactive session (supersedes ADR-001, ADR-002, ADR-006)

**Status:** Accepted

**Context:**
The stream-json architecture (ADR-001/ADR-002) spawned Claude with `-p <message> --output-format stream-json --verbose` for each message — a one-shot, non-interactive subprocess. This worked well for simple Q&A but was fundamentally incompatible with Claude's interactive terminal UIs: plan mode confirmations, native tool permission prompts, model/mode selection dialogs, and checkpoint/continue prompts. These UIs require a live terminal session with keyboard input.

**Decision:**
Replace the subprocess approach with a tmux-based architecture. A new `tmux.js` module (breaking ADR-006's single-file rule — see below) wraps the tmux CLI with async helpers. The bot maintains one tmux session (`claude-tui-bot`) with one window per user (`user-<userId>`). Claude runs interactively in that window. Messages are sent via `tmux send-keys -l`; responses are captured by polling `tmux capture-pane` every 500ms and hash-diffing to detect changes. Completion is detected when the pane is stable for 1.5s and contains Claude's input box (`╭`/`╰` box-drawing characters).

`tmux.js` is a separate module (superseding ADR-006) because the tmux wrapper is substantial enough to warrant isolation and independent testability; the bot has grown past single-file territory.

The custom permission gateway (`pendingPermissions`, `allowedTools`, inline Allow/Deny buttons) is removed. Tool permissions are handled by Claude's own native terminal UI, surfaced to the user via tmux navigation buttons (Phase 3).

**Consequences:**
- All of Claude's interactive UIs work: plan mode, tool permissions, model selection, checkpoints
- Sessions persist across bot restarts (tmux survives process restarts)
- `sessions.json` is no longer needed — tmux window existence is the session state
- Lost: structured JSON events (thinking blocks, tool_result snippets in permission messages)
- Lost: the rich custom permission preview (tool name + input + result output as distinct Telegram messages)
- Polling adds ~500ms latency before the first Telegram edit vs stream-json's near-instant first event
- Window naming is `user-<userId>`; tmux session is `claude-tui-bot` (hardcoded, not configurable)
