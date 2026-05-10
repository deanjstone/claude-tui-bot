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

const inFlight = new Map(); // userId -> { proc }
const pendingPermissions = new Map(); // permId -> { resolve, timer, chatId, msgId, toolName, preview }
const allowedTools = new Map(); // toolUseId -> { chatId, msgId, toolName }
const lastMessageTime = new Map(); // userId -> timestamp ms

const allowedUserIds = process.env.ALLOWED_USER_IDS
  ? new Set(process.env.ALLOWED_USER_IDS.split(',').map(id => parseInt(id.trim())))
  : null;

const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID ? parseInt(process.env.OWNER_CHAT_ID) : null;

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

function formatToolPreview(toolName, input) {
  if (input.command) return `$ ${input.command}`.slice(0, 300);
  if (input.file_path || input.path) {
    const p = input.file_path || input.path;
    const snippet = input.content ? '\n' + String(input.content).slice(0, 150) : '';
    return (p + snippet).slice(0, 300);
  }
  if (input.query) return input.query.slice(0, 300);
  if (input.url) return input.url.slice(0, 300);
  const s = JSON.stringify(input, null, 2);
  return s.length > 300 ? s.slice(0, 300) + '\n…' : s;
}

function formatError(err) {
  if (err.code === 'TIMEOUT')
    return `⏱ Request timed out after ${CLAUDE_TIMEOUT_MS / 1000}s. Try a simpler request, or /cancel and resend.`;
  if (err.code === 'PROCESS_ERROR')
    return `Claude exited with error (code ${err.exitCode}).\n${err.message}\n\nTry /new to start a fresh conversation.`;
  if (err.message?.includes('ENOENT'))
    return 'Claude CLI not found. Check that CLAUDE_PATH is set correctly.';
  return `Error: ${err.message}`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => `<pre><code>${code.trimEnd()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
    .replace(/^#{1,3} (.+)$/gm, '<b>$1</b>');
}

async function requestPermission(ctx, permId, toolName, input) {
  const preview = formatToolPreview(toolName, input);
  const msgText = `🔧 <b>${escapeHtml(toolName)}</b>\n<pre><code>${escapeHtml(preview)}</code></pre>`;
  const msg = await ctx.reply(msgText, {
    ...Markup.inlineKeyboard([
      Markup.button.callback('✅ Allow', `allow_${permId}`),
      Markup.button.callback('❌ Deny', `deny_${permId}`)
    ]),
    parse_mode: 'HTML'
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(permId);
      ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `🔧 <b>${escapeHtml(toolName)}</b>\n<pre><code>${escapeHtml(preview)}</code></pre>\n\n⏱ <i>Auto-denied after timeout</i>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      resolve(false);
    }, PERMISSION_TIMEOUT_MS);
    pendingPermissions.set(permId, { resolve, timer, chatId: ctx.chat.id, msgId: msg.message_id, toolName, preview });
  });
}

function streamClaude(message, sessionId, chatId, msgId, telegram, ctx, onProcSpawned) {
  return new Promise((resolve, reject) => {
    const args = ['-p', message, '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);

    const proc = spawn(CLAUDE_PATH, args, { cwd: __dirname });
    onProcSpawned?.(proc);

    let lineBuffer = '';
    let textBuffer = '';
    let thinkingHtml = '';
    let lastEditedText = '...';
    let resolvedSessionId = null;
    let editTimer = null;
    let denied = false;

    const timer = setTimeout(() => {
      proc.kill();
      clearInterval(editTimer);
      const err = new Error(`Claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`);
      err.code = 'TIMEOUT';
      reject(err);
    }, CLAUDE_TIMEOUT_MS);

    editTimer = setInterval(async () => {
      const rawCurrent = textBuffer || '...';
      const htmlCurrent = thinkingHtml + toHtml(rawCurrent);
      if (htmlCurrent !== lastEditedText && rawCurrent.length <= 4096) {
        try {
          await telegram.editMessageText(chatId, msgId, undefined, htmlCurrent, { parse_mode: 'HTML' });
          lastEditedText = htmlCurrent;
        } catch {
          if (rawCurrent !== lastEditedText) {
            try {
              await telegram.editMessageText(chatId, msgId, undefined, rawCurrent);
              lastEditedText = rawCurrent;
            } catch (e) { console.warn('edit failed:', e.message); }
          }
        }
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
              if (block.type === 'thinking') {
                const raw = block.thinking || '';
                const excerpt = escapeHtml(raw.slice(0, 500)) + (raw.length > 500 ? '…' : '');
                thinkingHtml = `<i>∴ Thinking…</i>\n<blockquote>${excerpt}</blockquote>\n\n`;
              }
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
          } else if (event.type === 'user') {
            for (const block of (event.message?.content ?? [])) {
              if (block.type === 'tool_result') {
                const entry = allowedTools.get(block.tool_use_id);
                if (entry) {
                  allowedTools.delete(block.tool_use_id);
                  const text = Array.isArray(block.content)
                    ? block.content.filter(c => c.type === 'text').map(c => c.text).join('')
                    : String(block.content ?? '');
                  const excerpt = text.slice(0, 200) + (text.length > 200 ? '…' : '');
                  telegram.editMessageText(
                    entry.chatId, entry.msgId, undefined,
                    `🔧 <b>${escapeHtml(entry.toolName)}</b>\n✅ Allowed\n<code>${escapeHtml(excerpt || '(no output)')}</code>`,
                    { parse_mode: 'HTML' }
                  ).catch(() => {});
                }
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
        const err = new Error(stderr.trim() || `Claude exited with code ${code}`);
        err.code = 'PROCESS_ERROR';
        err.exitCode = code;
        return reject(err);
      }

      const finalText = textBuffer || '(no response)';
      const htmlText = thinkingHtml + toHtml(finalText);
      const chunks = splitMessage(htmlText);
      const labeled = chunks.length > 1
        ? chunks.map((c, i) => `[${i + 1}/${chunks.length}]\n${c}`)
        : chunks;

      try {
        if (labeled[0] !== lastEditedText) {
          try {
            await telegram.editMessageText(chatId, msgId, undefined, labeled[0], { parse_mode: 'HTML' });
          } catch {
            await telegram.editMessageText(chatId, msgId, undefined, labeled[0]);
          }
        }
      } catch (err) {
        console.warn('edit failed:', err.message);
        try {
          await telegram.sendMessage(chatId, labeled[0]);
        } catch (e) {
          console.warn('sendMessage failed:', e.message);
        }
      }

      for (const chunk of labeled.slice(1)) {
        try {
          await telegram.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
        } catch {
          try {
            await telegram.sendMessage(chatId, chunk);
          } catch (err) {
            console.warn('sendMessage failed:', err.message);
          }
        }
      }

      resolve({ result: finalText, session_id: resolvedSessionId });
    });
  });
}

async function askClaude(message, sessionId, chatId, msgId, telegram, ctx, onProcSpawned) {
  try {
    return await streamClaude(message, sessionId, chatId, msgId, telegram, ctx, onProcSpawned);
  } catch (err) {
    if (sessionId) {
      await telegram.sendMessage(chatId, '⚠️ Session expired — retrying as new conversation…').catch(() => {});
      return streamClaude(message, null, chatId, msgId, telegram, ctx, onProcSpawned);
    }
    throw err;
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN, { telegram: { agent: new https.Agent({ family: 4 }) } });

if (allowedUserIds) {
  bot.use((ctx, next) => {
    if (!allowedUserIds.has(ctx.from?.id)) return;
    return next();
  });
}

const HELP_TEXT = 'Connected to Claude. Send a message to begin.\n\nThe bot can execute tools with your approval — you will see an inline permission prompt. Note: tools may access your filesystem and run commands.\n\nCommands:\n/new — start a fresh conversation\n/session — show current session ID\n/cancel — abort the current request\n/restart — restart the bot service\n/help — show this message\n\nAny other /command is forwarded to Claude as a message.';

bot.command('start', ctx => ctx.reply(HELP_TEXT));
bot.command('help', ctx => ctx.reply(HELP_TEXT));

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

bot.command('restart', async ctx => {
  await ctx.reply('Restarting...');
  setTimeout(() => {
    spawn('systemctl', ['--user', 'restart', 'telegram-claude-bot'], { detached: true, stdio: 'ignore' }).unref();
  }, 500);
});

bot.command('cancel', async ctx => {
  const userId = ctx.from.id;
  const entry = inFlight.get(userId);
  if (!entry) {
    await ctx.reply('No request in progress.');
    return;
  }
  if (entry.proc) entry.proc.kill();
  inFlight.delete(userId);
  await ctx.reply('Request cancelled.');
});

bot.action(/^allow_(.+)$/, async ctx => {
  const permId = ctx.match[1];
  const pending = pendingPermissions.get(permId);
  if (!pending) return ctx.answerCbQuery('Already resolved');
  clearTimeout(pending.timer);
  pendingPermissions.delete(permId);
  allowedTools.set(permId, { chatId: pending.chatId, msgId: pending.msgId, toolName: pending.toolName });
  await ctx.editMessageText(
    `🔧 <b>${escapeHtml(pending.toolName)}</b>\n<pre><code>${escapeHtml(pending.preview)}</code></pre>\n\n✅ <i>Allowed</i>`,
    { parse_mode: 'HTML' }
  );
  await ctx.answerCbQuery('Allowed');
  pending.resolve(true);
});

bot.action(/^deny_(.+)$/, async ctx => {
  const permId = ctx.match[1];
  const pending = pendingPermissions.get(permId);
  if (!pending) return ctx.answerCbQuery('Already resolved');
  clearTimeout(pending.timer);
  pendingPermissions.delete(permId);
  await ctx.editMessageText(
    `🔧 <b>${escapeHtml(pending.toolName)}</b>\n<pre><code>${escapeHtml(pending.preview)}</code></pre>\n\n❌ <i>Denied</i>`,
    { parse_mode: 'HTML' }
  );
  await ctx.answerCbQuery('Denied');
  pending.resolve(false);
});

bot.on('text', async ctx => {
  const userId = ctx.from.id;
  if (inFlight.has(userId)) {
    await ctx.reply('Still processing your previous message — please wait.');
    return;
  }

  const now = Date.now();
  const lastTime = lastMessageTime.get(userId);
  if (lastTime && now - lastTime < 3000) {
    await ctx.reply('Please wait a moment before sending another message.');
    return;
  }

  inFlight.set(userId, { proc: null });

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
      ctx,
      (proc) => {
        const entry = inFlight.get(userId);
        if (entry) entry.proc = proc;
      }
    );

    if (res.session_id && res.session_id !== sessionId) {
      sessions[userId] = res.session_id;
      saveSessions(sessions);
    }
  } catch (err) {
    await ctx.reply(formatError(err));
  } finally {
    clearInterval(typingInterval);
    inFlight.delete(userId);
    lastMessageTime.set(userId, Date.now());
  }
});

for (const type of ['photo', 'sticker', 'video', 'voice', 'audio', 'document', 'animation', 'video_note']) {
  bot.on(type, ctx => ctx.reply('Unsupported media — send text to chat with Claude.'));
}

bot.launch();
console.log('Bot running.');
if (OWNER_CHAT_ID) {
  bot.telegram.sendMessage(OWNER_CHAT_ID, 'Bot online.').catch(err => console.warn('startup notify failed:', err.message));
}

process.once('SIGINT', () => {
  pendingPermissions.forEach(p => { clearTimeout(p.timer); p.resolve(false); });
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  pendingPermissions.forEach(p => { clearTimeout(p.timer); p.resolve(false); });
  bot.stop('SIGTERM');
});
