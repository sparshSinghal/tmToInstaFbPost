# Activepieces flow: writer bot (Telegram → Sarvam → Telegram)

A second, **independent** Telegram bot (separate BotFather token, separate AP flow) that takes a Hindi text input and returns either a cleaned-up rewrite or a 3-4 paragraph news article. **No sheet writes, no FB/IG posting** — the bot is pure Sarvam-as-a-service.

When done building this in Activepieces Cloud, hit Settings → Export Flow and replace this file with `activepieces-writer-flow.json`.

## Bot setup (one-time)

1. In Telegram, message `@BotFather` → `/newbot` → pick a name (e.g., "Leena Writer Bot") → pick a handle ending in `bot` (e.g., `@leena_writer_bot`). Save the token.
2. Send `/start` to the new bot from your account so Telegram allows the bot to DM you.
3. Optionally `/setdescription` and `/setabouttext` in BotFather to make the bot's profile clear ("Hindi rewriter and article generator").

## Connections

In Activepieces Cloud:
- **Telegram Bot (writer)** — paste the new bot's token. Use a connection name like `telegram_writer_bot` so it's distinct from `telegram_post_bot`.
- **HTTP** (no auth) — used to call the Apps Script Web App.

## Critical settings (apply to every step of the matching type)

### 1. Follow Redirects — every HTTP POST to Apps Script

Apps Script Web App `/exec` endpoints answer POST requests with a 302 redirect to `script.googleusercontent.com/macros/echo?...` where the JSON sits. AP's HTTP piece does **not** follow redirects by default — turn the toggle on (under Advanced/More-options, labelled "Follow Redirects" / "Allow Redirects" / "Auto Follow Redirects") for every HTTP step that targets `<WEBAPP_URL>`. Without this, the writer bot's reply will be empty/HTML instead of the Sarvam-generated text.

### 2. Parse Mode — every Telegram Bot · Send Message

Set **Parse Mode** to **(empty / Plain Text)** on every Send Message step. Do **not** use MarkdownV2, Markdown, or HTML.

MarkdownV2 reserves `.`, `-`, `(`, `)`, `!`, `*`, `_`, and ~10 others. Sarvam-generated Hindi rewrites and articles will contain these constantly (every sentence ends with a period; news articles use lots of punctuation), so MarkdownV2 will throw 400 errors. Plain text passes everything through verbatim.

## Values to inline (free tier — no Variables tab)

The Activepieces free tier does not expose flow-level variables. Paste each value literally where indicated.

| Placeholder | Value to paste | Where it goes |
|---|---|---|
| `<WEBAPP_URL>` | `https://script.google.com/macros/s/.../exec` (same as post bot) | URL field of the HTTP step |
| `<SHARED_SECRET>` | matches Apps Script Property `ORCHESTRATOR_SHARED_SECRET` (same as post bot) | `token` field of the HTTP body |
| `<WHITELIST>` | Comma-separated Telegram user ids — reuse the post bot's whitelist | **Hard-code inside the Step 1 Code piece** (see code below — replace the `ALLOWED` array) |

## Flow steps

### Trigger — Telegram Bot · New Message

- Connection: `telegram_writer_bot`.
- Trigger: `New Message`.

### Step 1 — Code · Parse + whitelist + route

Piece: **Code**.

**Inputs panel** (required — without this binding, `update` arrives as `undefined` and the function throws `TypeError: Cannot read properties of undefined (reading 'message')`):

| Name | Value |
|---|---|
| `update` | `{{trigger}}` (use the magic-wand picker → Trigger → `(whole object)`) |

The Telegram trigger emits the full Update wrapper, shape `{ update_id, message: {...} }`. The code below reads `update.message`. Hard-code the whitelist inside the function body since there's no Variables tab on free tier.

```javascript
exports.code = async ({ update }) => {
  // Hard-coded whitelist — replace with your Telegram user_ids from @userinfobot
  const ALLOWED = ['5090847886'];  // <WHITELIST>

  const msg = update.message || update.edited_message;
  if (!msg) {
    // ignore non-message updates (no callback_queries on this bot)
    return { halt: true };
  }

  const fromId = String(msg.from && msg.from.id || '');
  const chatId = String(msg.chat && msg.chat.id || fromId);
  if (!ALLOWED.includes(fromId)) {
    return { halt: true, chatId, reason: 'not_whitelisted' };
  }

  const text = (msg.text || msg.caption || '').trim();
  if (!text) {
    return { halt: false, chatId, route: 'help', input: '' };
  }

  // Slash-command routing. Default = rewrite.
  // Handles "/rewrite", "/rewrite some text", "/article some brief".
  const match = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (match) {
    const cmd = match[1].toLowerCase();
    const arg = (match[2] || '').trim();
    if (cmd === 'rewrite')  return { halt: false, chatId, route: 'rewrite',  input: arg };
    if (cmd === 'article')  return { halt: false, chatId, route: 'article',  input: arg };
    if (cmd === 'start' || cmd === 'help')
      return { halt: false, chatId, route: 'help', input: '' };
    // Unknown command — treat as help so the user gets a usage hint
    return { halt: false, chatId, route: 'help', input: '' };
  }

  // No slash command → default to rewrite
  return { halt: false, chatId, route: 'rewrite', input: text };
};
```

### Step 2 — Branch · `step1.halt`

Use AP's **Router → Branch**:
- **Field:** `{{step1.halt}}`
- **Operator:** `(Boolean) Is true`

**Is true** branch: end (silent — don't reply to non-whitelisted users). Optional: send "Not authorized" if you prefer noisy rejection.

**Else (default)** branch: continue.

### Step 3 — Router · Route by `step1.route`

Use AP's **Router** with three branches. Each branch's condition:
- **Field:** `{{step1.route}}`
- **Operator:** `(Text) Exactly matches`
- **Value:** one of `rewrite` / `article` / `help`

`rewrite` is the default behavior (Step 1 falls back to it for non-command text), so set it as either the first conditional branch or the fallthrough/default. The two main routes call Apps Script; `help` replies with a usage message inline.

#### 3a — route `rewrite`

If `{{step1.input}}` is empty (user typed just `/rewrite`):
- Telegram Bot · Send Message: `chat_id = {{step1.chatId}}`, `text = Send a Hindi text blob to rewrite. Example:\n\n/rewrite आज बैठक हुई थी ...`

Else:
- HTTP POST to `<WEBAPP_URL>`:
  ```json
  {
    "token": "<SHARED_SECRET>",
    "action": "rewrite_text",
    "input": "{{step1.input}}"
  }
  ```
- Telegram Bot · Send Message:
  - chat_id: `{{step1.chatId}}`
  - text: `{{step3a_http.body.output}}` if `{{step3a_http.body.ok}} == true`; otherwise `❌ Error: {{step3a_http.body.error}}`.
- Optional: also send a Telegram "typing..." action just before the HTTP call so the user knows the bot is working. Telegram Bot · Send Chat Action with `action: typing`.

#### 3b — route `article`

If `{{step1.input}}` is empty:
- Send: `Send a brief and I'll write a 3-4 paragraph news article. Example:\n\n/article श्रीमती लीना सिंघल आज नजीबाबाद में किसानों से मिलीं ...`

Else:
- HTTP POST:
  ```json
  {
    "token": "<SHARED_SECRET>",
    "action": "generate_article",
    "input": "{{step1.input}}"
  }
  ```
- Reply same shape as 3a.

Articles can run 200-400 Hindi words and Telegram caps a single message at 4096 chars — almost never an issue at this length, but if a Sarvam response ever exceeds 4096 chars, split on the nearest paragraph break and send two messages.

#### 3c — route `help`

Telegram Bot · Send Message: `chat_id = {{step1.chatId}}`, `text =`
```
यह bot Sarvam AI का उपयोग करके दो काम करता है:

✏️ /rewrite <text>
   हिंदी text को सुधारता है — व्याकरण, स्पष्टता, structure।
   (बिना command भी काम करता है — text भेज दो।)

📰 /article <brief>
   दिए गए brief पर 3-4 पैराग्राफ का समाचार-शैली का लेख लिखता है।

कोई media नहीं, कोई posting नहीं — सिर्फ text।
```

## Notes

- **Latency:** Sarvam calls are ~3-8 seconds typically. With `withRetry()` on Apps Script side, worst case is ~25s before final failure. Telegram's "typing..." action keeps the chat from feeling dead.
- **No sheet writes.** `Writer.gs` deliberately doesn't touch `getSheet()`. If you ever want a history tab for review, add it later with a separate sheet-id flow variable.
- **Cost:** every message is one Sarvam call. There's no batching. At expected personal volume (a few dozen messages/day), this is well within Sarvam's free tier or trivial paid spend.
- **Same shared secret as the post bot.** Both bots POST to the same `/exec` with the same token; they're distinguished only by `action`. If you ever want stricter isolation, generate a second secret and have Apps Script accept either — but at single-user volume this is overkill.
