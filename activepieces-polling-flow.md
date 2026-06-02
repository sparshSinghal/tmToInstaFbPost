# Activepieces flow: polling (sweeps the sheet for pending actions)

Build this in Activepieces Cloud. When done, **Settings → Export Flow** in the AP UI and replace this file with `activepieces-polling-flow.json`.

This flow runs every 30 seconds. It reads the entire sheet, classifies which rows need an action, and dispatches one of: `finalize_collecting`, `approval` (send approval card), `reminder` (2-hour nudge), or `confirmation` (success/failure message after posting).

## Connections

Same as inbound flow: Telegram Bot, Google Sheets, Google Drive (latter not strictly required here).

## Critical settings (apply to every step of the matching type)

### 1. Follow Redirects — every HTTP POST to Apps Script

Apps Script Web App `/exec` endpoints answer POST requests with a 302 redirect to `script.googleusercontent.com/macros/echo?...` where the actual JSON response sits. AP's HTTP piece does **not** follow redirects by default — turn the toggle on (under Advanced/More-options, labelled "Follow Redirects" / "Allow Redirects" / "Auto Follow Redirects") for every HTTP step that targets `<WEBAPP_URL>`. Without this, the response body comes back as redirect HTML and any `{{stepN.body.X}}` reference downstream will be undefined.

If your AP version has no such toggle, use a two-step pair: POST captures the 302, second step GETs `{{<post_step>.headers.location}}` to fetch the JSON.

### 2. Parse Mode — every Telegram Bot · Send Message

Set **Parse Mode** to **(empty / Plain Text)** on every Send Message step. Do **not** use MarkdownV2, Markdown, or HTML.

MarkdownV2 reserves `.`, `-`, `(`, `)`, `!`, `*`, `_`, and ~10 others — any unescaped occurrence (very common in our reply texts and absolutely guaranteed in Sarvam-generated Hindi approval cards) causes a 400 error. Plain text passes everything verbatim.

## Values to inline (free tier — no Variables tab)

The Activepieces free tier does not expose flow-level variables. Paste each value literally where indicated.

| Placeholder | Value to paste | Where it goes |
|---|---|---|
| `<WEBAPP_URL>` | `https://script.google.com/macros/s/AKfy.../exec` | URL field of every HTTP step |
| `<SHARED_SECRET>` | matches Apps Script Property `ORCHESTRATOR_SHARED_SECRET` | `token` field of every HTTP body |
| `<SHEET_ID>` / `<SHEET_TAB>` | the Google Sheets piece's dropdowns let you pick the spreadsheet + tab interactively — no need to type the id literally |

## Steps

### Trigger — Schedule · Every 1 minute

Piece: **Schedule** set to **Every 1 minute**. (AP free tier's minimum cadence is 1 min; if your tier allows 30s and you want snappier UX, set it to 30s.)

End-to-end latency at 1-min cadence: ~3–4 minutes from "user sends message" to "user sees post-success confirmation". Breakdown: ~60s collect window + ~60s polling lag → finalize/Sarvam (~10s); next poll → approval card (~30–60s after Draft); user taps Approve → postRow runs synchronously (~20s for FB + IG); next poll → confirmation (~30–60s after Posted).

All the logic is correctness-safe at 1-min cadence — the boolean flag columns (`Approval_Requested`, `Reminder_Sent`, `Confirmation_Sent`) prevent duplicate dispatches, and Apps Script's per-handler idempotency guards mean a slow poll can't double-process. The 2-hour reminder threshold is far above polling cadence either way.

`COLLECT_WINDOW_SECONDS` in `Config.gs` (default 300 = 5 min) is the dominant contributor. It's set high specifically because AP free-tier inbound runs queue serially — a 6-item album's last item can land 2-7 minutes after the first, so a short window leaves stragglers in a brand-new row. If you ever upgrade AP to a tier that runs inbound flows in parallel (or otherwise see consistently fast queue turnaround), drop the window to 60-90s for snappier UX. Keep the polling-side `COLLECT_WINDOW_MS` constant in sync.

### Step 1 — Google Sheets · Get Rows

- Spreadsheet: pick from the dropdown (the Google Sheets piece lists every sheet your connection has access to).
- Sheet: pick the tab (typically `Sheet1`).
- Output is an array of row objects keyed by header name.

### Step 2 — Code · Classify pending actions

Piece: **Code**.

**Inputs panel** (required — without this binding, `rows` arrives as `undefined` and the function throws `TypeError: Cannot read properties of undefined (reading 'length')`):

| Name | Value |
|---|---|
| `rows` | `{{<your_get_rows_step_name>}}` — the **whole output** of the Google Sheets · Get Rows step. Do **not** add `.values` — that's the inner per-row field, not the array. |

The Get Rows step's output is already an array of the shape:
```json
[
  { "row": 1, "values": { "Timestamp": "...", "Status": "...", ... } },
  { "row": 2, "values": { "Timestamp": "...", "Status": "Collecting", ... } }
]
```
You want to bind `rows` to that whole array. In AP's magic-wand picker, click the Get Rows step and pick the top-level / "whole output" option (label varies by version: sometimes shown as a single "Output" entry, sometimes as `(whole step)`).

If the picker doesn't show a top-level option, try these alternative bindings in order until the input preview shows the array:
1. `{{<step>}}`
2. `{{<step>.body}}`
3. `{{<step>.rows}}`
4. `{{<step>.items}}`

```javascript
exports.code = async ({ rows }) => {
  // Defensive: if the input binding is wrong, fail fast with a useful message.
  if (!Array.isArray(rows)) {
    throw new Error(
      'Code input `rows` is not an array. Got: ' + typeof rows + '. ' +
      'Check the Inputs panel: bind `rows` to the whole output of the ' +
      'Google Sheets Get Rows step (no .values suffix). ' +
      'Expected shape: [{ row: <num>, values: { ... } }, ...]'
    );
  }

  // Must match COLLECT_WINDOW_SECONDS in Apps Script Config.gs (currently 300s).
  // The polling sweep only finalizes rows whose Timestamp is older than this.
  const COLLECT_WINDOW_MS = 300 * 1000;
  const REMINDER_AFTER_MS = 2 * 60 * 60 * 1000;
  const TERMINAL = ['Posted', 'Posted (FB only)', 'Posted (IG only)', 'Failed', 'Error'];

  // ── Sheet header names (must match exactly what's in row 1 of the sheet). ──
  // The legacy form-fed columns A-D have the verbose Google-Form-style titles
  // because the form's question text was used as the header. The newer
  // Telegram columns are short snake_case (set by ensureHeaders() in
  // Apps Script's Setup.gs).
  //
  // If your sheet's headers differ from these, edit them here OR rename your
  // sheet headers to match — both work. Renaming sheet headers does NOT break
  // the Google Form (the form writes by column position, not header name).
  const H = {
    Timestamp:           'Timestamp',
    Caption:             'Caption (Raw Content - Please input text in Hindi)',
    ImageVideoUpload:    'Image/Video Upload',
    Schedule:            'Schedule Date and Time (Required for Scheduled Posts)',
    PCaption:            'PCaption',
    GHeadline:           'GHeadline',
    Status:              'Status',
    Logs:                'Logs',
    Row_ID:              'Row_ID',
    Telegram_User_Id:    'Telegram_User_Id',
    Approval_Requested:  'Approval_Requested',
    Approval_Sent_At:    'Approval_Sent_At',
    Reminder_Sent:       'Reminder_Sent',
    Confirmation_Sent:   'Confirmation_Sent',
    Posted_At:           'Posted_At',
    FB_Post_ID:          'FB_Post_ID',
    IG_Post_ID:          'IG_Post_ID',
    Error_Message:       'Error_Message',
  };

  const now = Date.now();
  const out = [];

  // Sheet timezone offset from UTC, in hours. Sheets displays date cells in
  // this timezone; the parser treats the M/D/YYYY format as that timezone and
  // converts to absolute UTC epoch ms. Adjust if you change your sheet's TZ.
  // (File → Settings → Time zone in Google Sheets.)
  const SHEET_TZ_OFFSET_HOURS = 5.5;   // IST = UTC+5:30
  const SHEET_TZ_OFFSET_MS    = SHEET_TZ_OFFSET_HOURS * 60 * 60 * 1000;

  // Sheets returns date cells as locale-formatted strings (e.g. "5/6/2026 1:45:55"
  // for MM/DD/YYYY US locale at 24-hour time). JavaScript's `Date.parse(...)` for
  // this format will succeed but silently uses the *runtime's* timezone (AP =
  // UTC), giving a value 5.5 hours ahead of reality when the sheet TZ is IST.
  // This helper:
  //   1. Lets Date.parse handle only strings that have an explicit TZ marker
  //      (ISO 8601 with Z or ±HH:MM) — those are unambiguous.
  //   2. Falls through to the locale regex for "M/D/YYYY H:MM[:SS]", treats
  //      the fields as Sheet TZ, and converts to absolute UTC epoch ms.
  function parseSheetDate(v) {
    if (!v) return 0;
    if (v instanceof Date) return v.getTime();
    const s = String(v).trim();
    if (!s) return 0;

    // ISO 8601 with explicit TZ marker — unambiguous, parse natively
    if (/T\d.*[Zz]$|T\d.*[+-]\d{2}:?\d{2}$/.test(s)) {
      const t = Date.parse(s);
      if (!isNaN(t)) return t;
    }

    // "M/D/YYYY H:MM[:SS]" Sheets locale (US-style; default for most sheets).
    // Treat fields as Sheet TZ (IST), then convert to UTC epoch ms.
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const utcMs = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0));
      return utcMs - SHEET_TZ_OFFSET_MS;
    }

    // Last resort — let Date.parse have a go (handles "Tue, 06 May 2026..." etc.)
    const t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  }

  // Helper: build a `row` snapshot we pass through into each emitted item so
  // downstream Update Row steps can rewrite every cell with its existing
  // value and only change the flag column(s). AP's Update Row treats blank
  // fields as empty-string overwrites, which would wipe Caption/PCaption/etc.
  // if we didn't pass them through.
  //
  // Snapshot keys MUST match the sheet's header text exactly (same as `H`
  // above) so AP's Update Row form fields can reference them by name.
  //
  // Date columns are passed through as-is (no Date parsing) so the cell's
  // formatting stays intact when written back. Sheets re-parses on write.
  const snapshot = (r) => ({
    [H.Timestamp]:          (r[H.Timestamp] || '').toString(),
    [H.Caption]:            (r[H.Caption] || '').toString(),
    [H.ImageVideoUpload]:   (r[H.ImageVideoUpload] || '').toString(),
    [H.Schedule]:           (r[H.Schedule] || '').toString(),
    [H.PCaption]:           (r[H.PCaption] || '').toString(),
    [H.GHeadline]:          (r[H.GHeadline] || '').toString(),
    [H.Status]:             (r[H.Status] || '').toString(),
    [H.Logs]:               (r[H.Logs] || '').toString(),
    [H.Row_ID]:             (r[H.Row_ID] || '').toString(),
    [H.Telegram_User_Id]:   (r[H.Telegram_User_Id] || '').toString(),
    [H.Approval_Requested]: (r[H.Approval_Requested] || '').toString(),
    [H.Approval_Sent_At]:   (r[H.Approval_Sent_At] || '').toString(),
    [H.Reminder_Sent]:      (r[H.Reminder_Sent] || '').toString(),
    [H.Confirmation_Sent]:  (r[H.Confirmation_Sent] || '').toString(),
    [H.Posted_At]:          (r[H.Posted_At] || '').toString(),
    [H.FB_Post_ID]:         (r[H.FB_Post_ID] || '').toString(),
    [H.IG_Post_ID]:         (r[H.IG_Post_ID] || '').toString(),
    [H.Error_Message]:      (r[H.Error_Message] || '').toString(),
  });

  // AP's Get Rows piece returns: [{ row: <1-based sheet row>, values: { headerName: cellValue, ... } }, ...]
  // The first entry may be the header row itself (whose values literally equal
  // the headers) — we filter it out by requiring a real Row_ID.
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i] || {};
    const rowIndex = item.row;          // already the actual sheet row number
    const r = item.values || {};

    const status = (r[H.Status] || '').toString();
    const rowId  = (r[H.Row_ID] || '').toString();
    const tgId   = (r[H.Telegram_User_Id] || '').toString();

    // Skip header row leak-through and any data rows missing Row_ID
    // (legacy form-submit rows that haven't been finalized yet).
    if (!rowId || rowId === H.Row_ID) continue;

    const row = snapshot(r);  // pass-through for Update Row steps

    // 1. finalize_collecting — Collecting rows older than 60s
    if (status === 'Collecting') {
      const ts = parseSheetDate(r[H.Timestamp]);
      if (ts && (now - ts) >= COLLECT_WINDOW_MS) {
        out.push({ op: 'finalize_collecting', rowIndex, rowId, tgId, row });
      }
      continue;
    }

    // 2. approval — Draft rows that haven't had an approval card sent yet (and have a TG user)
    // PCaption is the Sarvam-generated caption used for review. Slogan and
    // hashtags are appended at posting time (Apps Script Posting.gs), so the
    // approval card shows just PCaption — no message composition here.
    //
    // Sarvam's prompt caps captions at 60-100 words (a few hundred chars in
    // Hindi), well under Telegram's 4096-char limit, so we don't split or
    // truncate. If a caption ever overflows in the future, add split logic
    // here.
    if (status === 'Draft' && tgId &&
        (r[H.Approval_Requested] || '').toString().toUpperCase() !== 'TRUE') {
      out.push({
        op: 'approval', rowIndex, rowId, tgId,
        pcaption: (r[H.PCaption] || '').toString(),
        row
      });
      continue;
    }

    // 3. reminder — Approval sent, no reply, 2+ hours old, not yet reminded
    if (status === 'Draft' && tgId &&
        (r[H.Approval_Requested] || '').toString().toUpperCase() === 'TRUE' &&
        (r[H.Reminder_Sent]      || '').toString().toUpperCase() !== 'TRUE') {
      const sentAt = parseSheetDate(r[H.Approval_Sent_At]);
      if (sentAt && (now - sentAt) >= REMINDER_AFTER_MS) {
        out.push({ op: 'reminder', rowIndex, rowId, tgId, row });
      }
      continue;
    }

    // 4. confirmation — terminal status, TG user, not yet confirmed
    if (TERMINAL.includes(status) && tgId &&
        (r[H.Confirmation_Sent] || '').toString().toUpperCase() !== 'TRUE') {
      out.push({
        op: 'confirmation', rowIndex, rowId, tgId,
        status,
        fbPostId: (r[H.FB_Post_ID] || '').toString(),
        igPostId: (r[H.IG_Post_ID] || '').toString(),
        errorMessage: (r[H.Error_Message] || '').toString(),
        row
      });
    }
  }

  // Diagnostic: surface what we parsed for each row + how it compares to now.
  // Once polling is reliably emitting items, you can delete this _debug field.
  const debug = {
    nowMs: now,
    nowIso: new Date(now).toISOString(),
    sheetTzOffsetHours: SHEET_TZ_OFFSET_HOURS,
    rows: rows.map(it => {
      const v = it && it.values || {};
      const tsRaw = v[H.Timestamp];
      const tsParsed = parseSheetDate(tsRaw);
      return {
        row: it && it.row,
        status: v[H.Status],
        rowId: v[H.Row_ID],
        timestamp_raw: tsRaw,
        timestamp_parsed_ms: tsParsed,
        timestamp_parsed_iso: tsParsed ? new Date(tsParsed).toISOString() : null,
        age_ms: tsParsed ? now - tsParsed : null,
        age_seconds: tsParsed ? Math.round((now - tsParsed) / 1000) : null
      };
    })
  };

  return { items: out, count: out.length, _debug: debug };
};
```

### Step 3 — Loop · Over `step2.items`

Piece: **Loop**. Iterate `{{<your_step2_name>.items}}` as the loop's input array.

Inside the loop, place a **Router** with four branches. Each branch's condition:
- **Field:** `{{<your_loop_step_name>.item.op}}` — **use the magic-wand picker** to find this; the exact path depends on what you named the Loop step. Common shapes:
  - `{{step_3.item.op}}` (if the Loop step is named `step_3`)
  - `{{loop_iteration.item.op}}`
  - `{{<loop_step>.iteration.op}}`
- **Operator:** `(Text) Exactly matches`
- **Value:** one of `finalize_collecting` / `approval` / `reminder` / `confirmation`

**Verify the field reference resolves before saving.** Click into the Field input, the AP UI usually shows a live preview of the resolved value. If it shows `finalize_collecting` (or whichever op the current iteration item carries), the path is correct. If it shows empty or `[object Object]`, pick a different option from the magic-wand picker until you see the literal op name.

Common pitfall: just typing `{{loop.item.op}}` literally — there's no global `loop` variable in AP. The variable must be referenced through the Loop step's own name.

The four branch bodies (replace every `{{loop.item.X}}` placeholder below with whatever path AP actually uses for your Loop step — same magic-wand picker, just navigate to the `X` field of `item`):

#### 3a — Branch `finalize_collecting`

**Step 3a-1 — HTTP**

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
  "action": "finalize_collecting",
  "row_id": "{{loop.item.rowId}}"
}
```

No Telegram reply for this branch — Apps Script silently kicks off Sarvam, and the next polling sweep will detect the resulting Draft and send the approval card via branch 3b.

#### 3b — Branch `approval`

**Step 3b-1 — Telegram Bot · Send Message**

| Field | Value |
|---|---|
| Chat ID | `{{loop.item.tgId}}` |
| Text | `{{loop.item.pcaption}}` |
| Reply Markup | (paste the JSON below) |

```json
{
  "inline_keyboard": [[
    { "text": "✅ Approve & Post", "callback_data": "approve:{{loop.item.rowId}}" },
    { "text": "✏️ Edit",           "callback_data": "edit:{{loop.item.rowId}}" }
  ]]
}
```

The two buttons embed the row_id so the inbound flow can act on the right row without a Sheets lookup.

**Step 3b-2 — Google Sheets · Update Row** (mark approval as sent so this branch doesn't fire again)

⚠️ AP's Update Row writes empty string into every blank field, **overwriting existing cells**. So we pass through every original cell value via `loop.item.row[...]` and only modify the two flag fields.

The "Field" column below is whatever AP labels each form field — when "First Row Contains Headers" is on, the labels match the sheet's header row text exactly. The "Value" column uses bracket notation everywhere because some headers contain spaces / parens / slashes that the dotted-path syntax can't express.

| Field (sheet header) | Value |
|---|---|
| Row Number | `{{loop.item.rowIndex}}` |
| Timestamp | `{{loop.item.row['Timestamp']}}` |
| Caption (Raw Content - Please input text in Hindi) | `{{loop.item.row['Caption (Raw Content - Please input text in Hindi)']}}` |
| Image/Video Upload | `{{loop.item.row['Image/Video Upload']}}` |
| Schedule Date and Time (Required for Scheduled Posts) | `{{loop.item.row['Schedule Date and Time (Required for Scheduled Posts)']}}` |
| PCaption | `{{loop.item.row['PCaption']}}` |
| GHeadline | `{{loop.item.row['GHeadline']}}` |
| Status | `{{loop.item.row['Status']}}` |
| Logs | `{{loop.item.row['Logs']}}` |
| Row_ID | `{{loop.item.row['Row_ID']}}` |
| Telegram_User_Id | `{{loop.item.row['Telegram_User_Id']}}` |
| **Approval_Requested** | **`TRUE`** ← modified |
| **Approval_Sent_At** | **`{{now}}`** ← modified (AP's current-timestamp expression — see "Notes" below if your AP version uses different syntax) |
| Reminder_Sent | `{{loop.item.row['Reminder_Sent']}}` |
| Confirmation_Sent | `{{loop.item.row['Confirmation_Sent']}}` |
| Posted_At | `{{loop.item.row['Posted_At']}}` |
| FB_Post_ID | `{{loop.item.row['FB_Post_ID']}}` |
| IG_Post_ID | `{{loop.item.row['IG_Post_ID']}}` |
| Error_Message | `{{loop.item.row['Error_Message']}}` |

#### 3c — Branch `reminder`

**Step 3c-1 — Telegram Bot · Send Message**

| Field | Value |
|---|---|
| Chat ID | `{{loop.item.tgId}}` |
| Text | `Reminder: a draft is still waiting for your approval. Scroll up to find the approval card and tap Approve or Edit.` |

**Step 3c-2 — Google Sheets · Update Row** (mark reminder as sent)

⚠️ Same passthrough pattern as Step 3b-2 — fill every field to avoid wiping unspecified cells.

| Field (sheet header) | Value |
|---|---|
| Row Number | `{{loop.item.rowIndex}}` |
| Timestamp | `{{loop.item.row['Timestamp']}}` |
| Caption (Raw Content - Please input text in Hindi) | `{{loop.item.row['Caption (Raw Content - Please input text in Hindi)']}}` |
| Image/Video Upload | `{{loop.item.row['Image/Video Upload']}}` |
| Schedule Date and Time (Required for Scheduled Posts) | `{{loop.item.row['Schedule Date and Time (Required for Scheduled Posts)']}}` |
| PCaption | `{{loop.item.row['PCaption']}}` |
| GHeadline | `{{loop.item.row['GHeadline']}}` |
| Status | `{{loop.item.row['Status']}}` |
| Logs | `{{loop.item.row['Logs']}}` |
| Row_ID | `{{loop.item.row['Row_ID']}}` |
| Telegram_User_Id | `{{loop.item.row['Telegram_User_Id']}}` |
| Approval_Requested | `{{loop.item.row['Approval_Requested']}}` |
| Approval_Sent_At | `{{loop.item.row['Approval_Sent_At']}}` |
| **Reminder_Sent** | **`TRUE`** ← modified |
| Confirmation_Sent | `{{loop.item.row['Confirmation_Sent']}}` |
| Posted_At | `{{loop.item.row['Posted_At']}}` |
| FB_Post_ID | `{{loop.item.row['FB_Post_ID']}}` |
| IG_Post_ID | `{{loop.item.row['IG_Post_ID']}}` |
| Error_Message | `{{loop.item.row['Error_Message']}}` |

#### 3d — Branch `confirmation`

**Step 3d-1 — Code · Build confirmation text**

**Inputs panel** (required):

| Name | Value |
|---|---|
| `item` | `{{loop.item}}` |

```javascript
exports.code = async ({ item }) => {
  if (item.status === 'Posted') {
    return { text: `✅ Posted to Facebook and Instagram.${item.fbPostId ? '\nFB: https://facebook.com/' + item.fbPostId : ''}` };
  }
  if (item.status === 'Posted (FB only)') {
    return { text: `⚠️ Posted to Facebook only — Instagram skipped or failed.${item.fbPostId ? '\nFB: https://facebook.com/' + item.fbPostId : ''}${item.errorMessage ? '\n' + item.errorMessage : ''}` };
  }
  if (item.status === 'Posted (IG only)') {
    return { text: `⚠️ Posted to Instagram only — Facebook upload failed (likely a video format the Page API rejected).${item.errorMessage ? '\n' + item.errorMessage : ''}` };
  }
  if (item.status === 'Failed' || item.status === 'Error') {
    return { text: `❌ Posting failed: ${item.errorMessage || 'unknown error'}` };
  }
  return { text: `Status: ${item.status}` };
};
```

**Step 3d-2 — Telegram Bot · Send Message**

| Field | Value |
|---|---|
| Chat ID | `{{loop.item.tgId}}` |
| Text | `{{<your_step_3d_1_name>.text}}` (whatever you renamed the Step 3d-1 Code piece to) |

**Step 3d-3 — Google Sheets · Update Row** (mark confirmation as sent)

⚠️ Same passthrough pattern as Step 3b-2 — fill every field to avoid wiping unspecified cells.

| Field (sheet header) | Value |
|---|---|
| Row Number | `{{loop.item.rowIndex}}` |
| Timestamp | `{{loop.item.row['Timestamp']}}` |
| Caption (Raw Content - Please input text in Hindi) | `{{loop.item.row['Caption (Raw Content - Please input text in Hindi)']}}` |
| Image/Video Upload | `{{loop.item.row['Image/Video Upload']}}` |
| Schedule Date and Time (Required for Scheduled Posts) | `{{loop.item.row['Schedule Date and Time (Required for Scheduled Posts)']}}` |
| PCaption | `{{loop.item.row['PCaption']}}` |
| GHeadline | `{{loop.item.row['GHeadline']}}` |
| Status | `{{loop.item.row['Status']}}` |
| Logs | `{{loop.item.row['Logs']}}` |
| Row_ID | `{{loop.item.row['Row_ID']}}` |
| Telegram_User_Id | `{{loop.item.row['Telegram_User_Id']}}` |
| Approval_Requested | `{{loop.item.row['Approval_Requested']}}` |
| Approval_Sent_At | `{{loop.item.row['Approval_Sent_At']}}` |
| Reminder_Sent | `{{loop.item.row['Reminder_Sent']}}` |
| **Confirmation_Sent** | **`TRUE`** ← modified |
| Posted_At | `{{loop.item.row['Posted_At']}}` |
| FB_Post_ID | `{{loop.item.row['FB_Post_ID']}}` |
| IG_Post_ID | `{{loop.item.row['IG_Post_ID']}}` |
| Error_Message | `{{loop.item.row['Error_Message']}}` |

## Notes

- **Timestamp expressions vary across AP versions.** `{{now}}` works in newer AP versions; older versions use `{{now()}}`, `{{currentDate}}`, or `{{nowIsoString}}`. Try `{{now}}` first; if it leaves the cell blank, swap for one of the others or insert a tiny Code piece (`exports.code = async () => ({ ts: new Date().toISOString() })`) and reference its output.
- **Sheets writes serialize naturally**: the polling flow only writes flag columns (`Approval_Requested`, `Approval_Sent_At`, `Reminder_Sent`, `Confirmation_Sent`) that Apps Script never touches in the same window, so concurrent writes between AP and Apps Script don't conflict.
- **Latency**: Schedule trigger fires every 30s; one full sweep including Sheets read + Telegram sends typically completes in <5s for <1000 rows. The Apps Script `archiveOldPosts` daily job keeps row count bounded.
- **Failure handling**: each HTTP/Telegram step in AP has retry on failure (default 3). If a step fails terminally, the per-row flag isn't set, so the next sweep re-attempts.
