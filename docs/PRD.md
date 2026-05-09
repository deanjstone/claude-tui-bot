# Product Requirements Document — telegram-claude-bot

## Overview

A personal Telegram bot that surfaces Claude Code CLI as a conversational mobile interface. The primary user is a developer who has Claude Code installed on a server or workstation and wants to interact with it from anywhere via Telegram — without being tied to a terminal.

## Problem

Claude Code is a powerful agentic coding assistant, but it requires a terminal session. If you're away from your desk, on mobile, or want to kick off a long-running task without staying in a terminal window, there's no good interface for it.

## Goals

- Access Claude Code from any device via Telegram
- See responses as they're generated, not after a 30–120 second wait
- Maintain safety: explicitly approve before Claude runs shell commands or modifies files
- Simple enough that one developer can run it on a single machine in under 10 minutes
- Resilient: survives restarts, bad sessions, and network hiccups without losing state

## Non-Goals

- Multi-user / team deployment (single-user personal tool)
- Web interface or other IM platforms
- Direct Anthropic API integration (delegates entirely to the local Claude CLI)
- Message history search or archival beyond what the CLI session provides

## User Stories

**As a developer away from my desk:**
- I want to send a message to Claude from my phone and get a response, so I can unblock myself without opening a laptop
- I want to see Claude's response appearing live rather than waiting a minute for it to appear all at once
- I want to be notified when Claude wants to run a shell command, and approve or deny it before it executes

**As someone running Claude on a shared machine:**
- I want the bot to validate that Claude CLI is present and authenticated before it starts, so I get a clear error at startup rather than a cryptic failure mid-conversation
- I want conversation sessions to persist across bot restarts, so I don't lose context when the process is restarted

## Functional Requirements

### FR-1: Message Relay
- The bot MUST forward text messages from Telegram to Claude Code CLI as prompts
- The bot MUST relay Claude's response back to the Telegram chat
- Responses exceeding 4096 characters MUST be split into sequential messages

### FR-2: Streaming Responses
- The bot MUST send a placeholder message immediately upon receiving a user message
- The placeholder MUST be edited in-place as Claude generates output, at most once per 1.5 seconds
- The user MUST see the final complete response in the same message (or as a continuation) when Claude finishes

### FR-3: Permission Gateway
- When Claude requests to use a tool (Bash, file operations, etc.), the bot MUST pause and send a permission request to the user with inline Allow / Deny buttons
- The bot MUST wait up to 5 minutes for a response before auto-denying
- On denial, Claude's process MUST be terminated and any partial response MUST be delivered
- The permission message MUST be updated to show the resolution (Allowed / Denied / Auto-denied)

### FR-4: Session Persistence
- The bot MUST persist Claude session IDs across restarts using a local JSON file
- Session state MUST be written atomically (write to temp file, rename) to prevent corruption on crash
- On session failure, the bot MUST automatically retry with a fresh session

### FR-5: Startup Validation
- The bot MUST verify the Claude CLI binary exists and is executable at startup
- The bot MUST log the detected Claude CLI version at startup
- The bot MUST exit with a clear error message if the CLI is missing, not executable, or fails a version check

### FR-6: Concurrency Safety
- The bot MUST reject duplicate requests from the same user while a request is in-flight

## Non-Functional Requirements

- **Latency**: Placeholder message appears within 1 second of receiving a user message
- **Reliability**: Bot process managed by PM2 with automatic restart on crash
- **Security**: Bot token stored in `.env`, never committed; no multi-user access controls needed for single-user deployment
- **Footprint**: No external database; all state in local JSON files

## Out of Scope for v1

- Message editing / deletion handling
- Image or file attachment support
- Voice message transcription
- Rate limiting per user
- Admin commands
