require('dotenv').config();
const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN env var is required');

const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const CLAUDE_TIMEOUT_MS = 120_000;

// Per-user lock: prevents concurrent claude spawns from the same user
const inFlight = new Set();

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function runClaude(message, sessionId) {
  return new Promise((resolve, reject) => {
    const args = ['-p', message, '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);

    const proc = spawn('/home/deanj/.local/bin/claude', args, { cwd: process.env.HOME });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
    }, CLAUDE_TIMEOUT_MS);

    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `Claude exited with code ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ result: stdout.trim(), session_id: null });
      }
    });
  });
}

async function askClaude(message, sessionId) {
  try {
    return await runClaude(message, sessionId);
  } catch (err) {
    // Retry as fresh conversation on any failure when a session was active
    if (sessionId) {
      return runClaude(message, null);
    }
    throw err;
  }
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

  try {
    const res = await askClaude(ctx.message.text, sessionId);

    if (res.session_id && res.session_id !== sessionId) {
      sessions[userId] = res.session_id;
      saveSessions(sessions);
    }

    const text = res.result ?? '(no response)';
    for (const chunk of splitMessage(text)) {
      await ctx.reply(chunk);
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
