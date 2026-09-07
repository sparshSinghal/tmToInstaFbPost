# Activepieces flow: inbound (Telegram → Apps Script)

Build this in Activepieces Cloud (cloud.activepieces.com). When done, hit **Settings → Export Flow** in the AP UI and replace this file with the resulting `activepieces-inbound-flow.json`.

## Connections to create first

| Connection | Piece | Auth |
|---|---|---|
| Telegram Bot | `@activepieces/piece-telegram-bot` | Paste BotFather token |
| Google Sheets | `@activepieces/piece-google-sheets` | OAuth (sign in with Google account that owns the sheet) |

> **No Google Drive connection needed.** Media is no longer uploaded to Drive
> by Activepieces — AP's Drive Upload piece can't store the file (it makes an
> empty "Untitled" file from any string input). Instead this flow passes the
> raw Telegram `file_url` to Apps Script, and Apps Script downloads it into the
> Drive folder itself (it owns the folder and holds the Drive OAuth scope). See
> `downloadTelegramFileToDrive` in `Telegram.gs`.

## Critical settings (apply to every step of the matching type)

### 1. Follow Redirects — every HTTP POST to Apps Script

Apps Script Web App `/exec` endpoints answer POST requests with a **302 redirect** to a `script.googleusercontent.com/macros/echo?...` URL where the actual JSON response sits. AP's HTTP piece does **not** follow redirects by default — it returns the 302 itself, leaving you with HTML and a Location header instead of your JSON.

Every HTTP step in this flow that targets `<WEBAPP_URL>` needs **Follow Redirects** enabled. The toggle lives under the HTTP step's Advanced/More-options section (label varies by AP version: "Follow Redirects" / "Allow Redirects" / "Auto Follow Redirects"). Turn it **on** for every Apps Script call.

If your AP version has no such toggle, replace each Apps Script POST with a two-step pair: one POST that captures the 302, one GET to `{{<post_step>.headers.location}}` that fetches the JSON. Reference the GET step's output downstream instead of the POST step's.

(There's no HTTP GET to Telegram's CDN in this flow — the media download happens inside Apps Script, not Activepieces.)

### 2. Parse Mode — every Telegram Bot · Send Message

Set **Parse Mode** to **(empty / Plain Text)** on every Send Message step. Do **not** use MarkdownV2, Markdown, or HTML.

Why: MarkdownV2 treats `.`, `-`, `(`, `)`, `!`, `*`, `_`, and ~10 other characters as reserved — any unescaped occurrence in the message body causes a 400 error (`can't parse entities: Character '.' is reserved...`). Our reply texts (and especially Sarvam-generated Hindi captions in the approval card) contain these characters constantly. Plain text mode passes everything through verbatim with no escaping required.

If you ever need bold/italic/links in a specific message later, escape that one message's reserved chars and set its parse_mode locally — but the default should be empty.

## Values to inline (free tier — no Variables tab)

The Activepieces free tier does not expose flow-level variables. Keep this table open while building the flow and paste each value literally into the relevant step. The references below (e.g. `<WEBAPP_URL>`) mark exactly where each value goes.

| Placeholder | Value to paste | Where it goes |
|---|---|---|
| `<WEBAPP_URL>` | `https://script.google.com/macros/s/AKfy.../exec` | URL field of every HTTP step |
| `<SHARED_SECRET>` | 32+ char random string matching Apps Script Property `ORCHESTRATOR_SHARED_SECRET` | `token` field of every HTTP body |
| `<WHITELIST>` | Comma-separated Telegram user ids, e.g. `26555995744020286` | **Hard-code inside the Step 1 Code piece** (see code block below — replace the inputs binding with a literal array) |

> The Drive folder id is **not** pasted anywhere in Activepieces anymore. It
> lives only as the Apps Script Script Property `TELEGRAM_DRIVE_FOLDER_ID`,
> which `downloadTelegramFileToDrive` reads when storing media.

## Steps

### Trigger — Telegram Bot · New Message

- Piece: Telegram Bot
- Trigger: `New Message`
- Connection: the one created above
- AP auto-registers the webhook with Telegram on flow publish.

### Step 1 — Code · Whitelist gate

Piece: **Code**.

**Inputs panel** (this is required — the function destructures `update` from inputs; if you skip this, you'll get `TypeError: Cannot read properties of undefined (reading 'message')`):

| Name | Value |
|---|---|
| `update` | `{{trigger}}` (use the magic-wand picker → Trigger → `(whole object)`) |

The trigger emits the full Telegram Update wrapper, shape:
```json
{ "update_id": 579284602, "message": { "message_id": 2, "from": {...}, "chat": {...}, "text": "..." } }
```
So `update.message` is the actual message; `update.callback_query` (when present) is a button tap. The code below handles both.

Hard-code the whitelist inside the function body since there's no Variables tab on free tier.

```javascript
exports.code = async ({ update }) => {
  // Hard-coded whitelist — replace with your Telegram user_ids from @userinfobot
  const ALLOWED = ['5090847886'];  // <WHITELIST>

  // Telegram update can be a regular message or a callback_query (button tap).
  const msg = update.message || update.edited_message;
  const cb  = update.callback_query;
  const fromId = String(
    (msg && msg.from && msg.from.id) ||
    (cb  && cb.from  && cb.from.id) ||
    ''
  );
  const chatId = String(
    (msg && msg.chat && msg.chat.id) ||
    (cb  && cb.message && cb.message.chat && cb.message.chat.id) ||
    fromId
  );

  const isWhitelisted = ALLOWED.includes(fromId);

  // Update id is unique per Telegram update — perfect dedup key.
  const updateId = String(update.update_id);

  // ── Media classification ──
  // Emit a string flag (`mediaType`) and a flat `mediaFileId` so the
  // downstream Branch step can use a string operator (AP free tier only
  // gives string-comparison operators on Branch — no is-null / exists).
  const photo = (msg && msg.photo && msg.photo[msg.photo.length - 1]) || null;  // largest size
  const video = (msg && msg.video) || null;
  const doc   = (msg && msg.document) || null;

  let mediaType = 'none';
  let mediaFileId = '';
  if (photo) {
    mediaType   = 'photo';
    mediaFileId = photo.file_id;
  } else if (video) {
    mediaType   = 'video';
    mediaFileId = video.file_id;
  } else if (doc) {
    mediaType   = 'document';
    mediaFileId = doc.file_id;
  }
  const hasMedia = mediaType !== 'none';

  return {
    fromId, chatId, updateId, isWhitelisted,
    text:        (msg && msg.text) || '',
    caption:     (msg && msg.caption) || '',
    callbackData:(cb && cb.data) || '',
    isCallback:  !!cb,
    callbackQueryId: (cb && cb.id) || '',
    hasMedia,         // boolean — branch on this directly
    mediaType,        // 'none' | 'photo' | 'video' | 'document'
    mediaFileId,      // empty string when !hasMedia
  };
};
```

### Step 2 — Branch · Whitelisted?

Use AP's **Router → Branch**:
- **Field:** `{{step1.isWhitelisted}}`
- **Operator:** `(Boolean) Is true`

**True branch:** continue to Step 3.

**Else (default) branch:** Telegram Bot · Send Message →
- chat_id: `{{step1.chatId}}`
- text: `Not authorized.`

Then: end.

### Step 3 — Has media? (Branch)

Use AP's **Router → Branch**:
- **Field:** `{{step1.hasMedia}}`
- **Operator:** `(Boolean) Is true`

The **else / default** path is the no-media case — let it skip to Step 4.

#### 3a — Has media (the `Is true` branch):

**One step only — Telegram Bot · Get File.**

- **File ID:** `{{step1.mediaFileId}}`
- **Download file:** leave **`false`**. We don't need the bytes in Activepieces — Apps Script fetches them. (If your AP version always downloads, `true` is harmless; we just ignore `file_content_base64`.)

The output exposes the file's temporary download URL and its Telegram path:
```json
{
  "file_info": { "file_id": "...", "file_path": "photos/file_560.jpg", "file_size": 175828 },
  "file_url":  "https://api.telegram.org/file/bot<TOKEN>/photos/file_560.jpg"
}
```

We pass `file_url` and `file_info.file_path` straight through to Apps Script (Steps 4 and 5a-1). Apps Script's `downloadTelegramFileToDrive` fetches `file_url` with `UrlFetchApp`, derives the name/MIME from `file_path`, writes the file into the Drive folder, and hands the normal pipeline a `https://drive.google.com/file/d/{id}/view` URL. **No Code steps and no Drive Upload step here anymore.**

> These Telegram download URLs stay valid ~1 hour, far longer than the AP→Apps
> Script hop, so no race. Telegram's `getFile` caps bot downloads at 20 MB,
> well within `UrlFetchApp`'s 50 MB limit.

#### 3b — No media (the else / default branch): no steps; `file_url` / `file_path` resolve to empty string in Step 4, and Apps Script skips the download.

### Step 4 — Code · State router

Piece: **Code**.

**Inputs panel** (required):

| Name | Value |
|---|---|
| `step1` | `{{<your_step_1_name>}}` — pick the whole output of the Step 1 Code piece (whatever you renamed it to; AP shows it in the magic-wand picker) |
| `fileUrl` | `{{<your_get_file_step>.file_url}}` — the `file_url` from the Get File step (Step 3a). Resolves to empty string when the no-media branch fired. |
| `filePath` | `{{<your_get_file_step>.file_info.file_path}}` — the Telegram file path (used by Apps Script for naming + MIME). Empty when no media. |

```javascript
exports.code = async ({ step1, fileUrl, filePath }) => {
  const text = (step1.text || step1.caption || '').trim();
  const cb   = step1.callbackData || '';

  // Approve / Edit button taps come in as callback_queries. The polling flow
  // embeds the row_id in callback_data as "approve:<rowId>" or "edit:<rowId>",
  // so we split on the first ':' to extract action + rowId. No Sheets lookup
  // needed.
  if (step1.isCallback && cb) {
    const colonIdx = cb.indexOf(':');
    const action   = colonIdx === -1 ? cb : cb.substring(0, colonIdx);
    const rowId    = colonIdx === -1 ? '' : cb.substring(colonIdx + 1);
    if (action === 'approve') return { route: 'approve', text, rowId, fileUrl: '', filePath: '' };
    if (action === 'edit')    return { route: 'edit',    text, rowId, fileUrl: '', filePath: '' };
  }

  // Everything else (text, media, or both) goes to add_to_draft. Apps Script's
  // handleAddToDraft has an EDIT FLOW INTERCEPT at the top: if the user has
  // a row in 'Awaiting Edit' status (set by a prior Edit-button tap) and the
  // incoming text is non-empty, it applies the text to PCaption and posts
  // immediately, returning action:'edited_and_posted'. Otherwise it falls
  // through to the normal Collecting / new-draft path. When media is present,
  // Apps Script downloads fileUrl into Drive itself.
  return { route: 'add_to_draft', text, fileUrl: fileUrl || '', filePath: filePath || '', rowId: '' };
};
```

### Step 5 — Router · Route by `step4.route`

Step 4 returns exactly one of three values: `approve`, `edit`, `add_to_draft`. The Router has **three branches**, each with this condition:
- **Field:** `{{step4.route}}`
- **Operator:** `(Text) Exactly matches`
- **Value:** the branch's literal name (`approve` / `edit` / `add_to_draft`)

Each branch's contents are spelled out below. Build them in any order.

#### 5a — Branch `add_to_draft`

This is the most common path: a user is sending content (text and/or media) for a new or in-flight draft.

**Step 5a-1 — HTTP**

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `<WEBAPP_URL>` (your Apps Script `/exec` URL) |
| Headers | `Content-Type: application/json` |
| Body Type | JSON |
| Body | (paste the JSON below — AP substitutes the `{{...}}` placeholders) |

```json
{
  "token": "<SHARED_SECRET>",
  "action": "add_to_draft",
  "telegram_user_id": "{{step1.fromId}}",
  "text": "{{step4.text}}",
  "file_url": "{{step4.fileUrl}}",
  "file_path": "{{step4.filePath}}",
  "update_id": "{{step1.updateId}}"
}
```

Apps Script downloads `file_url` into the Drive folder and records the Drive URL
as the row's media. When `file_url` is empty (no-media message), it's a
text-only draft. (`media_url` is still accepted as an alternative to `file_url`
for the Google Form path, but the Telegram flow uses `file_url`.)

**Step 5a-2 — Router · acknowledge based on Apps Script's response**

Apps Script returns `body.action` set to one of: `created`, `appended`, `edited_and_posted`, `deduped`. We acknowledge three of those; `deduped` gets no reply (it means a retry of an already-handled message).

Inside the `add_to_draft` branch, add a nested **Router** with three branches. Each branch's condition:
- **Field:** `{{step5a_1.body.action}}` (replace with whatever you named the HTTP step)
- **Operator:** `(Text) Exactly matches`
- **Value:** the branch's literal action name

| Sub-branch | Match value | Telegram Bot · Send Message text |
|---|---|---|
| 5a-2.A | `created` | `Got it. Send any other photos/videos within the next minute and I'll bundle them into one post.` |
| 5a-2.B | `appended` | `Added. Send more or wait — I'll draft your post when you're done.` |
| 5a-2.C | `edited_and_posted` | `Got it — applied your correction and posting now.` |

For each Send Message:
- Chat ID: `{{step1.chatId}}`
- Text: the literal string from the table above

(`deduped` has no sub-branch — silent.)

#### 5b — Branch `approve`

> **Do NOT add an "Answer Callback Query" step.** Telegram callback-query IDs
> expire ~15 seconds after the button tap. On AP free tier, the inbound run
> is often queued and doesn't start until well after that, so
> `answerCallbackQuery` returns `400 "query is too old ... or query ID is
> invalid"`. That call is purely cosmetic (it clears the little spinner on the
> tapped button; Telegram auto-clears it after a few seconds anyway) — and if
> it runs first and AP stops on error, it can abort the whole branch so the
> approval never happens. Skip it entirely; the Send Message below is the
> user's confirmation.

**Step 5b-1 — HTTP** (the actual approve — run this first so a stale callback never blocks it)

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `<WEBAPP_URL>` |
| Headers | `Content-Type: application/json` |
| Body Type | JSON |
| Body | (paste below) |

```json
{
  "token": "<SHARED_SECRET>",
  "action": "approve",
  "row_id": "{{step4.rowId}}",
  "update_id": "{{step1.updateId}}"
}
```

**Step 5b-2 — Telegram Bot · Send Message**

| Field | Value |
|---|---|
| Chat ID | `{{step1.chatId}}` |
| Text | `Approved. Posting now...` |

**Duplicate taps:** Telegram redelivers the same `callback_query` (same `update_id`) if it doesn't get a fast 200 — common under AP queue lag — so one Approve tap can reach Apps Script twice. Apps Script dedups on `update_id`: the first call approves and posts; the second returns `{ "ok": true, "duplicate": true, "noop": true }` and does nothing (posting is safe either way — LockService + status guard prevent double-posts). To suppress the duplicate "Approved. Posting now..." confirmation, wrap this Send Message in a Router branch: **Field** `{{step5b_1.body.duplicate}}`, **Operator** `(Boolean) Is true` → leave that branch empty; put the Send Message in the else/default branch. If you skip that, the worst case is one extra confirmation message — harmless.

#### 5c — Branch `edit`

> Same as 5b: **no Answer Callback Query step** (see the note above).

**Step 5c-1 — HTTP**

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `<WEBAPP_URL>` |
| Headers | `Content-Type: application/json` |
| Body Type | JSON |
| Body | (paste below) |

```json
{
  "token": "<SHARED_SECRET>",
  "action": "setStatus",
  "row_id": "{{step4.rowId}}",
  "status": "Awaiting Edit",
  "update_id": "{{step1.updateId}}"
}
```

**Step 5c-2 — Telegram Bot · Send Message**

| Field | Value |
|---|---|
| Chat ID | `{{step1.chatId}}` |
| Text | `Send the corrected caption as your next message.` |

After this point, the user's next text message comes back through the inbound flow as a normal `add_to_draft` call. Apps Script's edit-flow intercept (top of `handleAddToDraft`) detects the `Awaiting Edit` row, applies the text to PCaption, and posts immediately — the user gets the `edited_and_posted` acknowledgement from Step 5a-2.C. No extra AP wiring required.

### Step 6 — End

The final Send Message inside each branch is the last step. No global end action needed; AP terminates the flow when each branch finishes.
