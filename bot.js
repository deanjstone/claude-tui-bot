require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { execSync, spawn } = require('child_process');
const https = require('https');
const tmux = require('./tmux');

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN env var is required');

const CLAUDE_PATH = process.env.CLAUDE_PATH || '/home/deanj/.local/bin/claude';

function checkClaude() {
  try {
    const version = execSync(`"${CLAUDE_PATH}" --version`, { encoding: 'utf8' }).trim();
    console.log(`Claude CLI: ${version}`);
  } catch (err) {
    console.error('Claude CLI check failed:', err.message);
    process.exit(1);
  }
}

checkClaude();

const POLL_MS = 500;
const STABLE_POLLS = 3;             // 3 unchanged polls = 1.5s stable
const READY_TIMEOUT_MS = 30_000;
const CLAUDE_TIMEOUT_MS = 120_000;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

const inFlight = new Map();          // userId -> { window, ctl }
const lastMessageTime = new Map();   // userId -> timestamp ms
let navCounter = 0;
const pendingNavPrompts = new Map(); // navId -> { resolve, timer, buttons }

const allowedUserIds = process.env.ALLOWED_USER_IDS
  ? new Set(process.env.ALLOWED_USER_IDS.split(',').map(id => parseInt(id.trim())))
  : null;

const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID ? parseInt(process.env.OWNER_CHAT_ID) : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Button sets: each entry is [label, [key, ...]]
// Keys: single chars sent literally; named keys (Enter, Up, Down, Escape) sent via sendKey
const NAV_SETS = {
  confirm:    [['✅ Yes', ['1']], ['❌ No', ['2']], ['✏️ Edit', ['3']]],
  permission: [['✅ Allow', ['1']], ['❌ Deny', ['2']]],
  continue:   [['▶ Continue', ['Enter']], ['✖ Cancel', ['Escape']]],
  nav:        [['↑', ['Up']], ['↓', ['Down']], ['↵', ['Enter']], ['✖ Esc', ['Escape']]],
};

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return h;
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

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatError(err) {
  if (err.code === 'TIMEOUT')
    return `⏱ Request timed out after ${CLAUDE_TIMEOUT_MS / 1000}s. Try a simpler request, or /cancel and resend.`;
  if (err.code === 'READY_TIMEOUT')
    return 'Claude took too long to start. Try again or use /new to reset.';
  return `Error: ${err.message}`;
}

// Claude's TUI shows ╭...╰ box-drawing chars at the input prompt
function isReadyForInput(pane) {
  return pane.includes('╭') && pane.includes('╰');
}

// Return pane content above the input box, trimmed
function extractResponse(pane) {
  const lines = pane.split('\n');
  let cutLine = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('╭')) { cutLine = i; break; }
  }
  return lines.slice(0, cutLine).join('\n').trimEnd();
}

// Detect whether the pane is showing an interactive Claude menu (❯ selector present)
function detectInteractivePrompt(pane) {
  if (!pane.includes('❯')) return null;
  const p = pane.toLowerCase();
  if (p.includes('allow') || p.includes('deny')) return 'permission';
  if ((p.includes('yes') && p.includes('no')) || p.includes('proceed')) return 'confirm';
  if (p.includes('press enter') || p.includes('continue')) return 'continue';
  return 'nav';
}

async function awaitNavButton(type, context, target, ctl, chatId, telegram) {
  const buttons = NAV_SETS[type];
  if (!buttons || ctl.cancelled) return false;

  const navId = String(navCounter++);
  const excerpt = context.trim().split('\n').slice(-12).join('\n');
  const ctxHtml = `<pre><code>${escapeHtml(excerpt.slice(0, 600))}</code></pre>`;

  let navMsg;
  try {
    navMsg = await telegram.sendMessage(chatId, ctxHtml, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons.map(([label], i) =>
        Markup.button.callback(label, `nav_${navId}_${i}`)
      )),
    });
  } catch (err) {
    console.warn('nav prompt send failed:', err.message);
    return false;
  }

  const keys = await new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingNavPrompts.delete(navId);
      telegram.deleteMessage(chatId, navMsg.message_id).catch(() => {});
      resolve(null);
    }, PERMISSION_TIMEOUT_MS);
    pendingNavPrompts.set(navId, { resolve, timer, buttons });
  });

  if (!keys || ctl.cancelled) return false;

  for (const key of keys) {
    if (key.length === 1) {
      await tmux.sendKeys(target, key, { literal: true });
    } else {
      await tmux.sendKey(target, key);
    }
    await sleep(80);
  }
  await sleep(200);
  return true;
}

async function waitForReady(target) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const pane = tmux.stripAnsi(await tmux.capturePane(target));
    if (isReadyForInput(pane)) return;
  }
  throw Object.assign(new Error('Claude took too long to start'), { code: 'READY_TIMEOUT' });
}

async function ensureClaudeWindow(target, windowName) {
  await tmux.ensureSession();

  if (!await tmux.hasWindow(tmux.SESSION, windowName)) {
    await tmux.newWindow(tmux.SESSION, windowName);
    await tmux.sendKeys(target, `cd '${__dirname}' && '${CLAUDE_PATH}'`, { enter: true });
    await waitForReady(target);
    return;
  }

  // Window exists — verify Claude is at the input prompt
  const pane = tmux.stripAnsi(await tmux.capturePane(target));
  if (!isReadyForInput(pane)) {
    await tmux.sendKey(target, 'C-c');
    await sleep(700);
    const pane2 = tmux.stripAnsi(await tmux.capturePane(target));
    if (!isReadyForInput(pane2)) {
      await tmux.sendKeys(target, `cd '${__dirname}' && '${CLAUDE_PATH}'`, { enter: true });
      await waitForReady(target);
    }
  }
}

async function pollForResponse(target, ctl, chatId, msgId, telegram) {
  let lastHash = 0;
  let stableCount = 0;
  let lastSentText = '...';
  let lastContent = '';
  const deadline = Date.now() + CLAUDE_TIMEOUT_MS;

  await sleep(POLL_MS); // let Claude start processing before first poll

  while (!ctl.cancelled && Date.now() < deadline) {
    const raw = await tmux.capturePane(target);
    const clean = tmux.stripAnsi(raw);
    const content = extractResponse(clean);
    const hash = simpleHash(content);

    if (hash !== lastHash) {
      lastHash = hash;
      stableCount = 0;
      lastContent = content;

      if (content && content !== lastSentText) {
        const html = toHtml(content);
        try {
          await telegram.editMessageText(chatId, msgId, undefined, html, { parse_mode: 'HTML' });
          lastSentText = html;
        } catch {
          try {
            await telegram.editMessageText(chatId, msgId, undefined, content);
            lastSentText = content;
          } catch {}
        }
      }
    } else {
      stableCount++;
      if (stableCount >= STABLE_POLLS) {
        const promptType = detectInteractivePrompt(clean);
        if (promptType) {
          await awaitNavButton(promptType, content || clean, target, ctl, chatId, telegram);
          stableCount = 0;
          lastHash = 0; // force re-detection after key is sent
          await sleep(POLL_MS);
          continue;
        }
        if (isReadyForInput(clean)) break;
      }
    }

    await sleep(POLL_MS);
  }

  if (ctl.cancelled) return { result: lastContent };

  if (Date.now() >= deadline)
    throw Object.assign(new Error(`Timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`), { code: 'TIMEOUT' });

  const finalContent = lastContent || '(no response)';
  const finalHtml = toHtml(finalContent);
  const chunks = splitMessage(finalHtml);
  const labeled = chunks.length > 1
    ? chunks.map((c, i) => `[${i + 1}/${chunks.length}]\n${c}`)
    : chunks;

  try {
    if (labeled[0] !== lastSentText) {
      try {
        await telegram.editMessageText(chatId, msgId, undefined, labeled[0], { parse_mode: 'HTML' });
      } catch {
        await telegram.editMessageText(chatId, msgId, undefined, labeled[0]);
      }
    }
  } catch (err) {
    console.warn('final edit failed:', err.message);
    try { await telegram.sendMessage(chatId, labeled[0]); } catch {}
  }

  for (const chunk of labeled.slice(1)) {
    try {
      await telegram.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
    } catch {
      try { await telegram.sendMessage(chatId, chunk); } catch {}
    }
  }

  return { result: finalContent };
}

async function sendToClaudeTmux(userId, message, chatId, msgId, telegram, onReady) {
  const windowName = `user-${userId}`;
  const target = `${tmux.SESSION}:${windowName}`;

  await ensureClaudeWindow(target, windowName);

  const ctl = { cancelled: false };
  onReady?.({ window: windowName, ctl });

  await tmux.sendKeys(target, message, { enter: true });
  return pollForResponse(target, ctl, chatId, msgId, telegram);
}

const bot = new Telegraf(process.env.BOT_TOKEN, { telegram: { agent: new https.Agent({ family: 4 }) } });

if (allowedUserIds) {
  bot.use((ctx, next) => {
    if (!allowedUserIds.has(ctx.from?.id)) return;
    return next();
  });
}

const HELP_TEXT = `Connected to Claude. Send a message to begin.

Claude runs in a persistent interactive session — plan mode, tool use, and interactive prompts are handled natively. When Claude shows a menu, inline buttons appear for navigation.

Commands:
/new — start a fresh conversation (kills the current session)
/session — show current session status
/cancel — interrupt the current request
/restart — restart the bot service
/help — show this message

Any other /command is forwarded to Claude as a message.`;

bot.command('start', ctx => ctx.reply(HELP_TEXT));
bot.command('help', ctx => ctx.reply(HELP_TEXT));

bot.command('new', async ctx => {
  const userId = ctx.from.id;
  const entry = inFlight.get(userId);
  if (entry?.ctl) {
    entry.ctl.cancelled = true;
    await tmux.sendKey(`${tmux.SESSION}:${entry.window}`, 'C-c').catch(() => {});
  }
  await tmux.killWindow(tmux.SESSION, `user-${userId}`);
  ctx.reply('New conversation started.');
});

bot.command('session', async ctx => {
  const userId = ctx.from.id;
  const exists = await tmux.hasWindow(tmux.SESSION, `user-${userId}`);
  ctx.reply(exists
    ? `Session active (tmux: ${tmux.SESSION}:user-${userId})`
    : 'No active session — next message will start one.');
});

bot.command('restart', async ctx => {
  await ctx.reply('Restarting...');
  setTimeout(() => {
    spawn('systemctl', ['--user', 'restart', 'claude-tui-bot'], { detached: true, stdio: 'ignore' }).unref();
  }, 500);
});

bot.command('cancel', async ctx => {
  const userId = ctx.from.id;
  const entry = inFlight.get(userId);
  if (!entry) {
    await ctx.reply('No request in progress.');
    return;
  }
  entry.ctl.cancelled = true;
  await tmux.sendKey(`${tmux.SESSION}:${entry.window}`, 'C-c').catch(() => {});
  inFlight.delete(userId);
  await ctx.reply('Request cancelled.');
});

// Navigation button taps from interactive Claude prompts
bot.action(/^nav_(\d+)_(\d+)$/, async ctx => {
  const navId = ctx.match[1];
  const btnIdx = parseInt(ctx.match[2]);
  const pending = pendingNavPrompts.get(navId);
  if (!pending) return ctx.answerCbQuery('Already handled');

  clearTimeout(pending.timer);
  pendingNavPrompts.delete(navId);

  const button = pending.buttons[btnIdx];
  await ctx.answerCbQuery(button?.[0] ?? '');
  await ctx.deleteMessage().catch(() => {});
  pending.resolve(button?.[1] ?? null);
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

  inFlight.set(userId, { window: null, ctl: null });

  await ctx.sendChatAction('typing');
  const typingInterval = setInterval(
    () => ctx.sendChatAction('typing').catch(() => {}),
    4000
  );

  let placeholderMsg;
  try {
    placeholderMsg = await ctx.reply('...');
  } catch {
    clearInterval(typingInterval);
    inFlight.delete(userId);
    return;
  }

  try {
    await sendToClaudeTmux(
      userId,
      ctx.message.text,
      ctx.chat.id,
      placeholderMsg.message_id,
      ctx.telegram,
      ({ window, ctl }) => {
        const entry = inFlight.get(userId);
        if (entry) { entry.window = window; entry.ctl = ctl; }
      }
    );
  } catch (err) {
    await ctx.reply(formatError(err)).catch(() => {});
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
  pendingNavPrompts.forEach(p => { clearTimeout(p.timer); p.resolve(null); });
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  pendingNavPrompts.forEach(p => { clearTimeout(p.timer); p.resolve(null); });
  bot.stop('SIGTERM');
});
