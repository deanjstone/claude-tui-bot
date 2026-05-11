'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const exec = promisify(execFile);

const SESSION = 'claude-tui-bot';

async function run(...args) {
  const { stdout } = await exec('tmux', args);
  return stdout;
}

async function hasSession(name = SESSION) {
  try {
    await run('has-session', '-t', name);
    return true;
  } catch {
    return false;
  }
}

async function newSession(name = SESSION) {
  await run('new-session', '-d', '-s', name, '-x', '220', '-y', '50');
}

async function ensureSession(name = SESSION) {
  if (!await hasSession(name)) await newSession(name);
}

async function hasWindow(session, window) {
  try {
    await run('has-session', '-t', `${session}:${window}`);
    return true;
  } catch {
    return false;
  }
}

async function newWindow(session, window) {
  await run('new-window', '-t', session, '-n', window);
}

async function killWindow(session, window) {
  try {
    await run('kill-window', '-t', `${session}:${window}`);
  } catch {}
}

async function sendKeys(target, text, { literal = true, enter = false } = {}) {
  const args = ['send-keys', '-t', target];
  if (literal) args.push('-l');
  args.push(text);
  await run(...args);
  if (enter) await run('send-keys', '-t', target, 'Enter');
}

async function killSession(name = SESSION) {
  try {
    await run('kill-session', '-t', name);
  } catch {}
}

async function sendKey(target, key) {
  await run('send-keys', '-t', target, key);
}

async function capturePane(target) {
  const raw = await run('capture-pane', '-t', target, '-p', '-e');
  return raw;
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHFABCDJSTsu]|\x1B\][^\x07]*\x07|\x1B[()][AB012]/g, '');
}

module.exports = { SESSION, hasSession, newSession, ensureSession, hasWindow, newWindow, killWindow, killSession, sendKeys, sendKey, capturePane, stripAnsi };
