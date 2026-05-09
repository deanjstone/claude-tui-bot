Here's how to get it running:

---

**Step 1 — Create your bot on Telegram**

Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. It gives you a token like `7123456789:AAF...`.

**Step 2 — Find your Telegram user ID**

Message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric ID.

**Step 3 — Create `.env`**

```bash
cd ~/projects/telegram-claude-bot
cp .env.example .env
nano .env  # fill in BOT_TOKEN and your Telegram ID
```

**Step 4 — Start with PM2**

```bash
cd ~/projects/telegram-claude-bot
pm2 start bot.js --name claude-bot
pm2 save          # remember it across PM2 restarts
```

**Step 5 — Auto-start on WSL2 boot (optional)**

```bash
pm2 startup       # it prints a command — run that command
```

---

**Bot commands:**

- `/start` — welcome message
- `/new` — start a fresh conversation
- `/session` — show current session ID

Each conversation persists across bot restarts via `sessions.json`. To add a second user later, just add their Telegram ID comma-separated in `.env` and restart the bot.
