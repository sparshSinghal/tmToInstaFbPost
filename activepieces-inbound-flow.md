# Activepieces flow: inbound (Telegram → Apps Script)

Build this in Activepieces Cloud (cloud.activepieces.com). When done, hit **Settings → Export Flow** in the AP UI and replace this file with the resulting `activepieces-inbound-flow.json`.

## Connections to create first

| Connection | Piece | Auth |
|---|---|---|
| Telegram Bot | `@activepieces/piece-telegram-bot` | Paste BotFather token |
| Google Sheets | `@activepieces/piece-google-sheets` | OAuth (sign in with Google account that owns the sheet) |
| Google Drive | `@activepieces/piece-google-drive` | Same Google account; scope must include drive.file |

## Critical settings (apply to every step of the matching type)

### 1. Follow Redirects — every HTTP POST to Apps Script

Apps Script Web App `/exec` endpoints answer POST requests with a **302 redirect** to a `script.googleusercontent.com/macros/echo?...` URL where the actual JSON response sits. AP's HTTP piece does **not** follow redirects by default — it returns the 302 itself, leaving you with HTML and a Location header instead of your JSON.

Every HTTP step in this flow that targets `<WEBAPP_URL>` needs **Follow Redirects** enabled. The toggle lives under the HTTP step's Advanced/More-options section (label varies by AP version: "Follow Redirects" / "Allow Redirects" / "Auto Follow Redirects"). Turn it **on** for every Apps Script call.

If your AP version has no such toggle, replace each Apps Script POST with a two-step pair: one POST that captures the 302, one GET to `{{<post_step>.headers.location}}` that fetches the JSON. Reference the GET step's output downstream instead of the POST step's.

The HTTP GET to Telegram's CDN (Step 3a-2) doesn't need this setting — it's a single hop with no redirect.

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
| `<TELEGRAM_DRIVE_FOLDER_ID>` | Drive folder id (string) | Folder field of the Google Drive · Upload File step |
| `<WHITELIST>` | Comma-separated Telegram user ids, e.g. `26555995744020286` | **Hard-code inside the Step 1 Code piece** (see code block below — replace the inputs binding with a literal array) |

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

The **else / default** path is the no-media case — let it skip to Step 4 with no Drive upload.

#### 3a — Has media (the `Is true` branch):

1. **Telegram Bot · Get File** with `file_id = {{step1.mediaFileId}}` → returns an object shaped:
   ```json
   {
     "file_info": { "file_id": "...", "file_path": "videos/file_3.MP4", "file_size": ... },
     "file_url":  "https://api.telegram.org/file/bot<TOKEN>/videos/file_3.MP4"
   }
   ```
   Note `file_url` already has your bot token embedded — no manual URL construction needed in the next step.

2. **Google Drive · Upload File** — pass the URL directly; AP's Drive Upload fetches it server-side and uploads the result. **Do not insert an HTTP GET step in between** (Drive Upload rejects raw binary streams with `Expected file url or base64 with mimeType, received: <binary>`).
   - **File**: `{{<get_file_step>.file_url}}` — bind the **top-level** `file_url` field via the magic-wand picker (NOT inside `file_info`). The Telegram URL has the bot token embedded in its path, so AP's anonymous fetch succeeds.
   - **Folder**: paste your `<TELEGRAM_DRIVE_FOLDER_ID>` literally, or use the Drive folder picker.
   - **File name**: use any sensible string — Apps Script reads the actual MIME type from Drive at post time, so the filename extension is just a hint. A safe template: `tg_{{step1.updateId}}_{{step1.mediaType}}` (e.g. `tg_42_photo`, `tg_43_video`).

3. **Code · Build Drive URL**:

   **Inputs panel** (required):

   | Name | Value |
   |---|---|
   | `fileId` | `{{<your_drive_upload_step_name>.id}}` — the `id` field returned by the Google Drive · Upload File step |

   ```javascript
   exports.code = async ({ fileId }) => {
     return { mediaUrl: `https://drive.google.com/file/d/${fileId}/view` };
   };
   ```

#### 3b — No media (the else / default branch): skip the four steps above; `mediaUrl` will be empty string in Step 4.

### Step 4 — Code · State router

Piece: **Code**.

**Inputs panel** (required):

| Name | Value |
|---|---|
| `step1` | `{{<your_step_1_name>}}` — pick the whole output of the Step 1 Code piece (whatever you renamed it to; AP shows it in the magic-wand picker) |
| `mediaUrl` | `{{<your_step_3a_4_name>.mediaUrl}}` — the `mediaUrl` field from the Build-Drive-URL step inside the has-media branch. Resolves to empty string when the no-media branch fired. |

```javascript
exports.code = async ({ step1, mediaUrl }) => {
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
    if (action === 'approve') return { route: 'approve', text, rowId, mediaUrl: '' };
    if (action === 'edit')    return { route: 'edit',    text, rowId, mediaUrl: '' };
  }

  // Everything else (text, media, or both) goes to add_to_draft. Apps Script's
  // handleAddToDraft has an EDIT FLOW INTERCEPT at the top: if the user has
  // a row in 'Awaiting Edit' status (set by a prior Edit-button tap) and the
  // incoming text is non-empty, it applies the text to PCaption and posts
  // immediately, returning action:'edited_and_posted'. Otherwise it falls
  // through to the normal Collecting / new-draft path.
  return { route: 'add_to_draft', text, mediaUrl, rowId: '' };
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
  "media_url": "{{step4.mediaUrl}}",
  "update_id": "{{step1.updateId}}"
}
```

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

**Step 5b-1 — Telegram Bot · Answer Callback Query** (dismisses the loading spinner on the button)

| Field | Value |
|---|---|
| Callback Query ID | `{{step1.callbackQueryId}}` |
| Text | (leave empty) |
| Show Alert | false |

If your AP version doesn't have an "Answer Callback Query" action, replace this step with a plain HTTP POST:

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `https://api.telegram.org/bot<BOT_TOKEN>/answerCallbackQuery` |
| Body Type | JSON |
| Body | `{ "callback_query_id": "{{step1.callbackQueryId}}" }` |

**Step 5b-2 — HTTP**

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

**Step 5b-3 — Telegram Bot · Send Message**

| Field | Value |
|---|---|
| Chat ID | `{{step1.chatId}}` |
| Text | `Approved. Posting now...` |

(If Apps Script returns `noop: true` — meaning the row was already past the approval state — the message still sends. Harmless; the user knows their tap registered.)

#### 5c — Branch `edit`

**Step 5c-1 — Telegram Bot · Answer Callback Query** (same setup as Step 5b-1)

| Field | Value |
|---|---|
| Callback Query ID | `{{step1.callbackQueryId}}` |
| Text | (leave empty) |
| Show Alert | false |

**Step 5c-2 — HTTP**

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
  "status": "Awaiting Edit"
}
```

**Step 5c-3 — Telegram Bot · Send Message**

| Field | Value |
|---|---|
| Chat ID | `{{step1.chatId}}` |
| Text | `Send the corrected caption as your next message.` |

After this point, the user's next text message comes back through the inbound flow as a normal `add_to_draft` call. Apps Script's edit-flow intercept (top of `handleAddToDraft`) detects the `Awaiting Edit` row, applies the text to PCaption, and posts immediately — the user gets the `edited_and_posted` acknowledgement from Step 5a-2.C. No extra AP wiring required.

### Step 6 — End

The final Send Message inside each branch is the last step. No global end action needed; AP terminates the flow when each branch finishes.
