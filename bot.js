require('dotenv').config();
const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN env var is required');

const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const CLAUDE_TIMEOUT_MS = 120_000;
const EDIT_INTERVAL_MS = 1500;

// Per-user lock: prevents concurrent claude spawns from the same user
const inFlight = new Set();

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('sessions.json parse error:', err.message);
    return {};
  }
}

function saveSessions(sessions) {
  const tmp = SESSIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, SESSIONS_FILE);
}

// Split on newline or word boundaries to avoid cutting mid-word or mid-formatting
function splitMessage(text, limit = 4096) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function streamClaude(message, sessionId, chatId, msgId, telegram) {
  return new Promise((resolve, reject) => {
    const args = ['-p', message, '--output-format', 'stream-json'];
    if (sessionId) args.push('--resume', sessionId);

    const proc = spawn('/home/deanj/.local/bin/claude', args, { cwd: process.env.HOME });

    let lineBuffer = '';
    let textBuffer = '';
    let lastEditedText = '...';
    let resolvedSessionId = null;
    let editTimer = null;

    const timer = setTimeout(() => {
      proc.kill();
      clearInterval(editTimer);
      reject(new Error(`Claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
    }, CLAUDE_TIMEOUT_MS);

    editTimer = setInterval(async () => {
      const current = textBuffer || '...';
      if (current !== lastEditedText && current.length <= 4096) {
        try {
          await telegram.editMessageText(chatId, msgId, undefined, current);
          lastEditedText = current;
        } catch {}
      }
    }, EDIT_INTERVAL_MS);

    proc.on('error', err => {
      clearTimeout(timer);
      clearInterval(editTimer);
      reject(err);
    });

    proc.stdout.on('data', chunk => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant') {
            for (const block of (event.message?.content ?? [])) {
              if (block.type === 'text') textBuffer += block.text;
            }
          } else if (event.type === 'result') {
            resolvedSessionId = event.session_id ?? null;
          }
        } catch {}
      }
    });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', async code => {
      clearTimeout(timer);
      clearInterval(editTimer);

      if (code !== 0) {
        return reject(new Error(stderr.trim() || `Claude exited with code ${code}`));
      }

      const finalText = textBuffer || '(no response)';
      const chunks = splitMessage(finalText);

      try {
        if (chunks[0] !== lastEditedText) {
          await telegram.editMessageText(chatId, msgId, undefined, chunks[0]);
        }
        for (const chunk of chunks.slice(1)) {
          await telegram.sendMessage(chatId, chunk);
        }
      } catch {}

      resolve({ result: finalText, session_id: resolvedSessionId });
    });
  });
}

async function askClaude(message, sessionId, chatId, msgId, telegram) {
  try {
    return await streamClaude(message, sessionId, chatId, msgId, telegram);
  } catch (err) {
    // Retry as fresh conversation on any failure when a session was active
    if (sessionId) {
      return streamClaude(message, null, chatId, msgId, telegram);
    }
    throw err;
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN, { telegram: { agent: new https.Agent({ family: 4 }) } });

bot.command('start', ctx => {
  ctx.reply('Connected to Claude. Send a message to begin.\n\nCommands:\n/new — start a fresh conversation\n/session — show current session ID');
});

bot.command('new', ctx => {
  const sessions = loadSessions();
  delete sessions[ctx.from.id];
  saveSessions(sessions);
  ctx.reply('New conversation started.');
});

bot.command('session', ctx => {
  const sessions = loadSessions();
  const id = sessions[ctx.from.id];
  ctx.reply(id ? `Active session: ${id}` : 'No active session — next message will start one.');
});

bot.on('text', async ctx => {
  const userId = ctx.from.id;
  if (inFlight.has(userId)) {
    await ctx.reply('Still processing your previous message — please wait.');
    return;
  }

  inFlight.add(userId);

  const sessions = loadSessions();
  const sessionId = sessions[userId] ?? null;

  await ctx.sendChatAction('typing');
  const typingInterval = setInterval(
    () => ctx.sendChatAction('typing').catch(() => {}),
    4000
  );

  let placeholderMsg;
  try {
    placeholderMsg = await ctx.reply('...');
  } catch (err) {
    clearInterval(typingInterval);
    inFlight.delete(userId);
    return;
  }

  try {
    const res = await askClaude(
      ctx.message.text,
      sessionId,
      ctx.chat.id,
      placeholderMsg.message_id,
      ctx.telegram
    );

    if (res.session_id && res.session_id !== sessionId) {
      sessions[userId] = res.session_id;
      saveSessions(sessions);
    }
  } catch (err) {
    await ctx.reply(`Error: ${err.message}`);
  } finally {
    clearInterval(typingInterval);
    inFlight.delete(userId);
  }
});

bot.launch();
console.log('Bot running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
