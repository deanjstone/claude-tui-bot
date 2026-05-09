require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN env var is required');

const CLAUDE_PATH = process.env.CLAUDE_PATH || '/home/deanj/.local/bin/claude';

function checkClaude() {
  try {
    fs.accessSync(CLAUDE_PATH, fs.constants.X_OK);
  } catch {
    console.error(`Claude CLI not found or not executable at: ${CLAUDE_PATH}`);
    console.error('Set CLAUDE_PATH env var to the correct path.');
    process.exit(1);
  }
  try {
    const version = execSync(`"${CLAUDE_PATH}" --version`, { encoding: 'utf8' }).trim();
    console.log(`Claude CLI: ${version}`);
    const match = version.match(/(\d+)\./);
    if (match && parseInt(match[1]) < 2) {
      console.warn('Warning: Claude CLI version < 2.0 detected. stream-json output may not be supported.');
    }
  } catch (err) {
    console.error('Claude CLI version check failed:', err.message);
    process.exit(1);
  }
}

checkClaude();

const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const CLAUDE_TIMEOUT_MS = 120_000;
const EDIT_INTERVAL_MS = 1500;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

// Per-user lock: prevents concurrent claude spawns from the same user
const inFlight = new Set();
const pendingPermissions = new Map(); // permId -> { resolve, timer, chatId, msgId, toolName, preview }

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

async function requestPermission(ctx, permId, toolName, input) {
  const preview = JSON.stringify(input).slice(0, 200);
  const msg = await ctx.reply(
    `Tool request: ${toolName}\n\`${preview}\``,
    {
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Allow', `allow_${permId}`),
        Markup.button.callback('❌ Deny', `deny_${permId}`)
      ]),
      parse_mode: 'Markdown'
    }
  );
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(permId);
      ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `Tool request: ${toolName}\n\`${preview}\`\n\n_Auto-denied after timeout_`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      resolve(false);
    }, PERMISSION_TIMEOUT_MS);
    pendingPermissions.set(permId, { resolve, timer, chatId: ctx.chat.id, msgId: msg.message_id, toolName, preview });
  });
}

function streamClaude(message, sessionId, chatId, msgId, telegram, ctx) {
  return new Promise((resolve, reject) => {
    const args = ['-p', message, '--output-format', 'stream-json'];
    if (sessionId) args.push('--resume', sessionId);

    const proc = spawn(CLAUDE_PATH, args, { cwd: process.env.HOME });

    let lineBuffer = '';
    let textBuffer = '';
    let lastEditedText = '...';
    let resolvedSessionId = null;
    let editTimer = null;
    let denied = false;

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
              if (block.type === 'tool_use' && ctx) {
                const { id, name, input } = block;
                requestPermission(ctx, id, name, input).then(allowed => {
                  if (!allowed && !denied) {
                    denied = true;
                    proc.kill();
                  }
                }).catch(() => {});
              }
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

      if (code !== 0 && !denied) {
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

async function askClaude(message, sessionId, chatId, msgId, telegram, ctx) {
  try {
    return await streamClaude(message, sessionId, chatId, msgId, telegram, ctx);
  } catch (err) {
    // Retry as fresh conversation on any failure when a session was active
    if (sessionId) {
      return streamClaude(message, null, chatId, msgId, telegram, ctx);
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

bot.action(/^allow_(.+)$/, async ctx => {
  const permId = ctx.match[1];
  const pending = pendingPermissions.get(permId);
  if (!pending) return ctx.answerCbQuery('Already resolved');
  clearTimeout(pending.timer);
  pendingPermissions.delete(permId);
  await ctx.editMessageText(`Tool request: ${pending.toolName}\n\`${pending.preview}\`\n\n_Allowed_`, { parse_mode: 'Markdown' });
  await ctx.answerCbQuery('Allowed');
  pending.resolve(true);
});

bot.action(/^deny_(.+)$/, async ctx => {
  const permId = ctx.match[1];
  const pending = pendingPermissions.get(permId);
  if (!pending) return ctx.answerCbQuery('Already resolved');
  clearTimeout(pending.timer);
  pendingPermissions.delete(permId);
  await ctx.editMessageText(`Tool request: ${pending.toolName}\n\`${pending.preview}\`\n\n_Denied_`, { parse_mode: 'Markdown' });
  await ctx.answerCbQuery('Denied');
  pending.resolve(false);
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
      ctx.telegram,
      ctx
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

process.once('SIGINT', () => {
  pendingPermissions.forEach(p => { clearTimeout(p.timer); p.resolve(false); });
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  pendingPermissions.forEach(p => { clearTimeout(p.timer); p.resolve(false); });
  bot.stop('SIGTERM');
});
