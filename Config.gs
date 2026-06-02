// ============================================================
// Config.gs — API tokens, column constants, shared utilities
// ============================================================
// All .gs files share the same global scope in Apps Script,
// so everything declared here is available in Processing.gs
// and Posting.gs automatically.

// ── API Tokens ────────────────────────────────────────────────
// Tokens are stored in Script Properties (encrypted), NOT hardcoded here.
// Run initScriptProperties() once from the Apps Script editor to save them.
// To update a token later, run initScriptProperties() again.
//
// SARVAM_API_KEY          → your Sarvam API key (sk_...)
// FB_PAGE_ACCESS_TOKEN    → a never-expiring Page Access Token.
//                           How to get one:
//                             1. Go to Graph API Explorer (developers.facebook.com/tools/explorer)
//                             2. Select your App and your Page under "User or Page"
//                             3. Add permissions: pages_manage_posts, pages_read_engagement
//                             4. Click "Generate Access Token" — this gives a SHORT-LIVED page token
//                             5. Open Access Token Debugger, paste the token, click "Extend Access Token"
//                             6. The extended Page Access Token never expires — paste it below
// FB_PAGE_ID              → your Facebook Page numeric ID

/**
 * Returns the Sarvam API key from Script Properties.
 * @returns {string}
 */
function getSarvamApiKey() {
  var key = PropertiesService.getScriptProperties().getProperty('SARVAM_API_KEY');
  if (!key) throw new Error('SARVAM_API_KEY not set. Run initScriptProperties() first.');
  return key;
}

/**
 * Returns the Facebook Page Access Token from Script Properties.
 * Used for ALL Facebook Page write operations (/photos, /videos, /feed)
 * and ONLY for Facebook. Instagram operations use IG_USER_ACCESS_TOKEN
 * instead — see getIgUserAccessToken() below for why.
 * @returns {string}
 */
function getFbPageAccessToken() {
  var token = PropertiesService.getScriptProperties().getProperty('FB_PAGE_ACCESS_TOKEN');
  if (!token) throw new Error('FB_PAGE_ACCESS_TOKEN not set. Run initScriptProperties() first.');
  return token;
}

/**
 * Returns the Facebook User Access Token from Script Properties, used for
 * ALL Instagram Graph API operations (container create, status read, publish).
 *
 * Why two tokens:
 *   - Facebook Page write endpoints (e.g. unpublished /photos upload used in
 *     multi-photo posts) reject User tokens with error 200: "Unpublished
 *     posts must be posted to a page as the page itself."
 *   - Instagram container READ endpoints (GET /{ig-container-id}?fields=
 *     status_code) reject Page tokens with error 100 / subcode 33
 *     "Authorization Error" — even when the Page token has instagram_basic
 *     granted on the right IG user ID. This appears to be a Meta-side
 *     enforcement quirk affecting at least Pages connected via the New
 *     Pages Experience; same call with a User token having instagram_basic
 *     succeeds.
 *
 * So we use whichever token each endpoint actually accepts.
 *
 * Token type required: User Access Token (NOT Page Access Token) with scopes
 * instagram_basic + instagram_content_publish, granular-bound to the
 * Instagram Business Account ID stored in IG_USER_ID.
 *
 * Long-lived User tokens last ~60 days. To rotate, re-run the OAuth exchange
 * flow documented in README §4 (steps 4–5) and paste the long-lived token
 * into Script Properties.
 *
 * @returns {string}
 */
function getIgUserAccessToken() {
  var token = PropertiesService.getScriptProperties().getProperty('IG_USER_ACCESS_TOKEN');
  if (!token) throw new Error('IG_USER_ACCESS_TOKEN not set. Run initScriptProperties() first.');
  return token;
}

/**
 * Returns the Facebook Page ID from Script Properties.
 * @returns {string}
 */
function getFbPageId() {
  var id = PropertiesService.getScriptProperties().getProperty('FB_PAGE_ID');
  if (!id) throw new Error('FB_PAGE_ID not set. Run initScriptProperties() first.');
  return id;
}

/**
 * Returns the Instagram Business Account User ID from Script Properties.
 * This is the numeric ID of the Instagram account linked to your Facebook Page.
 * Hard-coded in Setup.gs (it's not a secret — anyone can find it).
 *
 * @returns {string}
 */
function getIgUserId() {
  var id = PropertiesService.getScriptProperties().getProperty('IG_USER_ID');
  if (!id) throw new Error('IG_USER_ID not set. Run initScriptProperties() first.');
  return id;
}

// ── Sarvam AI ─────────────────────────────────────────────────
var SARVAM_MODEL   = 'sarvam-105b';
var SARVAM_API_URL = 'https://api.sarvam.ai/v1/chat/completions';

// ── Facebook Graph API ────────────────────────────────────────
// Bumped from v21.0 → v25.0 in May 2026 because IG container status reads
// (GET /{ig-container-id}?fields=status_code) on v21.0 returned
//   {"error":{"code":100,"type":"GraphMethodException","error_subcode":33,
//    "message":"Authorization Error"}}
// for every read with our Page Access Token, even though the same call
// with the same container ID succeeded on v25.0 in Graph API Explorer.
// v25.0 picked specifically because Graph API Explorer's debugger uses it,
// so any future read failures can be reproduced in the Explorer 1:1.
// FB Page posting endpoints (/photos, /videos, /feed) and the IG /media +
// /media_publish endpoints are stable across recent Graph versions, so the
// bump is safe for them.
var FB_GRAPH_VERSION = 'v25.0';
var FB_GRAPH_BASE    = 'https://graph.facebook.com/' + FB_GRAPH_VERSION;

// ── Sheet ─────────────────────────────────────────────────────
// No sheet name needed — since this script is bound to the spreadsheet,
// we always use the first tab, which is where Google Forms writes responses.

// ── Column indices (1-based, matching your sheet layout) ──────
// LEGACY columns A-H are unchanged — the existing form keeps working
// and the Sarvam / posting code never had to be re-wired.
//
// A=Timestamp, B=Caption(Raw), C=Image/Video Upload,
// D=Schedule Date and Time, E=PCaption, F=GHeadline,
// G=Status, H=Logs
//
// NEW columns I-R are added by the Telegram → Activepieces integration.
// They are populated only for rows that originated from Telegram;
// rows from the Google Form leave them blank, which the polling
// logic correctly interprets as "no Telegram user to notify".
var COL = {
  // ── Legacy (form-fed) ──
  TIMESTAMP:   1,  // A
  CAPTION_RAW: 2,  // B — raw Hindi/mixed input from form or Telegram
  IMAGE_URL:   3,  // C — Google Drive URL(s), comma-separated
  SCHEDULE:    4,  // D — optional schedule datetime
  PCAPTION:    5,  // E — processed Hindi caption (Sarvam output, editable)
  GHEADLINE:   6,  // F — generated Hindi headline (Sarvam output)
  STATUS:      7,  // G — processing/posting status
  LOGS:        8,  // H — timestamped audit log

  // ── Telegram / Activepieces integration ──
  ROW_ID:              9,   // I — UUID; set by Activepieces on insert, stable cross-system reference
  TELEGRAM_USER_ID:    10,  // J — Telegram user id (numeric), stored as string
  APPROVAL_REQUESTED:  11,  // K — TRUE once Activepieces has sent the Telegram approval card
  APPROVAL_SENT_AT:    12,  // L — Date when approval card was sent (drives reminders)
  REMINDER_SENT:       13,  // M — TRUE once the 2-hour reminder has been sent (prevents dupes)
  CONFIRMATION_SENT:   14,  // N — TRUE once the post-success confirmation has been sent
  POSTED_AT:           15,  // O — Date stamped by Apps Script when posting succeeded
  FB_POST_ID:          16,  // P — Facebook post ID returned by Graph API
  IG_POST_ID:          17,  // Q — Instagram media ID returned by Graph API
  ERROR_MESSAGE:       18   // R — most-recent error string (Logs col still has full history)
};

// Header strings used by ensureHeaders() in Setup.gs to back-fill the new columns
// onto an existing sheet without breaking the legacy A-H names.
var COL_HEADERS = {
  9:  'Row_ID',
  10: 'Telegram_User_Id',
  11: 'Approval_Requested',
  12: 'Approval_Sent_At',
  13: 'Reminder_Sent',
  14: 'Confirmation_Sent',
  15: 'Posted_At',
  16: 'FB_Post_ID',
  17: 'IG_Post_ID',
  18: 'Error_Message'
};

// ── Status strings ────────────────────────────────────────────
var STATUS = {
  // ── Pre-existing states (unchanged) ──
  PROCESSING:     'Processing',       // actively running Sarvam AI
  DRAFT:          'Draft',            // AI done, awaiting human approval
  APPROVED:       'Approved',         // human approved → will post on next check cycle
  SCHEDULED:      'Scheduled',        // approved with a future schedule → waiting for time
  POSTING_FB:     'Posting (FB)',     // actively calling the Facebook API
  POSTING_IG:     'Posting (IG)',     // Facebook done; now calling the Instagram API
  PENDING_IG:     'Pending (IG)',     // IG video container created; awaiting IG processing
  POSTED:         'Posted',           // published to both Facebook and Instagram
  POSTED_FB_ONLY: 'Posted (FB only)', // Facebook succeeded; Instagram failed or skipped
  POSTED_IG_ONLY: 'Posted (IG only)', // Instagram succeeded; Facebook failed (e.g. video codec rejected)
  FAILED:         'Failed',           // Both Facebook and Instagram failed (or no media for IG and FB failed)
  ERROR:          'Error',            // processing (Sarvam) failed after all retries

  // ── New states (Telegram / Activepieces integration) ──
  // 'Collecting' is set by add_to_draft when it creates a fresh row from a
  // Telegram message. The row stays in this state for COLLECT_WINDOW_SECONDS,
  // during which any additional messages from the same Telegram user are
  // appended (text concatenated, media URLs comma-joined). The polling
  // flow flips Collecting → New once the window expires, which kicks
  // off Sarvam processing. This is how "send a caption + 3 photos" gets
  // bundled into a single carousel post.
  COLLECTING:     'Collecting',
  // 'New' is the canonical "ready to process" marker. Set either by
  // finalize_collecting after the window closes, or directly by legacy
  // ingestion paths.
  NEW:            'New',
  // 'Awaiting Edit' is set by Activepieces when a user taps the Edit button.
  // The next text message from that Telegram user is treated as the corrected
  // PCaption; Activepieces then flips Status back to 'Approved'.
  AWAITING_EDIT:  'Awaiting Edit',
  // 'Superseded' is set when a user starts a new draft while an older draft
  // from the same user is still awaiting approval. The older draft is
  // closed out so the user can't accidentally approve stale content.
  SUPERSEDED:     'Superseded'
};

// How long Apps Script keeps a 'Collecting' row open for additional media
// before automatically flipping it to 'New' and starting Sarvam processing.
//
// Telegram delivers album items within a few seconds, BUT the Activepieces
// inbound flow runs serially per item (Get File → HTTP GET binary → Drive
// Upload → Code → HTTP POST to Apps Script ≈ 5-30s per item). On AP free
// tier with limited concurrency, a 6-item album's last item can land
// 2-7 minutes after the first — so a short window leaves stragglers
// orphaned in a brand-new row. 5 minutes is the empirical sweet spot:
// generous enough to absorb AP queue lag, short enough that the user
// doesn't wait too long for the approval card to arrive.
//
// User-facing wait from last message → approval card ≈ this window +
// polling cadence + Sarvam latency, so ~5 min window + 1 min polling +
// 10s Sarvam ≈ 6 minutes worst case after the last item is sent.
var COLLECT_WINDOW_SECONDS = 300;

// Statuses that represent a "completed" outcome — used by the Activepieces
// confirmation poller and by appendError() to know when not to overwrite history.
var TERMINAL_STATUSES = ['Posted', 'Posted (FB only)', 'Posted (IG only)', 'Failed', 'Error'];

// ── Retry configuration ───────────────────────────────────────
var MAX_RETRIES    = 3;
var RETRY_DELAY_MS = 2000; // 2 seconds between retries

// ── Upload limits ─────────────────────────────────────────────
// Apps Script UrlFetchApp hard cap is ~50 MB for binary payloads.
// Videos at or above this limit are skipped to avoid a silent network failure.
var MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB in bytes

// ── Content identity ───────────────────────────────────────────
// Slogan appended after caption, before hashtags.
// Set to '' to disable.
var POST_SLOGAN   = 'फिर एक बार, भाजपा सरकार|';

// Hashtags appended to every caption after AI output.
// Edit once here — applies to all future posts automatically.
var POST_HASHTAGS = '#नजीबाबाद #नजीबाबादविधानसभा #BJP #NajibabadVidhansabha';

/**
 * Returns the shared secret used to authenticate calls from Activepieces into
 * the Apps Script web app. Set via initScriptProperties() — long random string.
 * @returns {string}
 */
function getOrchestratorSharedSecret() {
  var s = PropertiesService.getScriptProperties().getProperty('ORCHESTRATOR_SHARED_SECRET');
  if (!s) throw new Error('ORCHESTRATOR_SHARED_SECRET not set. Run initScriptProperties() first.');
  return s;
}

/**
 * Returns the Drive folder ID where Activepieces drops uploaded Telegram media.
 * Optional — only used if Apps Script ever needs to verify or inspect the folder.
 * @returns {string|null}
 */
function getTelegramDriveFolderId() {
  return PropertiesService.getScriptProperties().getProperty('TELEGRAM_DRIVE_FOLDER_ID');
}

/**
 * Returns the notification email address from Script Properties.
 * Falls back to the script-owner's email if NOTIFY_EMAIL is not set.
 *
 * @returns {string}
 */
function getNotifyEmail() {
  var email = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  return email || Session.getEffectiveUser().getEmail();
}

/**
 * Executes fn(), retrying up to maxRetries times on any thrown error.
 * Waits delayMs milliseconds between attempts.
 * Throws the last caught error if all attempts fail.
 *
 * @param {Function} fn          - Zero-arg function to execute
 * @param {number}   maxRetries  - Max attempts (default: MAX_RETRIES)
 * @param {number}   delayMs     - Delay between retries ms (default: RETRY_DELAY_MS)
 * @returns {*} Return value of fn()
 */
function withRetry(fn, maxRetries, delayMs) {
  maxRetries = (maxRetries !== undefined) ? maxRetries : MAX_RETRIES;
  delayMs    = (delayMs    !== undefined) ? delayMs    : RETRY_DELAY_MS;

  var lastError;
  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        Utilities.sleep(delayMs);
      }
    }
  }
  throw lastError;
}

/**
 * Returns the first sheet tab of the bound spreadsheet.
 * Google Forms always writes responses to the first tab, so no name is needed.
 *
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}

/**
 * Appends a timestamped log message to the Logs cell (col H).
 * Preserves all existing log content — does not overwrite.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowIndex - 1-based row number
 * @param {string} msg      - Message to append
 */
function appendLog(sheet, rowIndex, msg) {
  var cell     = sheet.getRange(rowIndex, COL.LOGS);
  var existing = cell.getValue() ? cell.getValue().toString() : '';
  var ts       = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  var entry    = '[' + ts + '] ' + msg;
  cell.setValue(existing ? existing + '\n' + entry : entry);
}

// ── Log level ─────────────────────────────────────────────────────────────
// Configurable via the LOG_LEVEL Script Property:
//   INFO  (default) — only operational events (post created, posted, failed)
//   DEBUG           — INFO plus per-step diagnostics (file IDs, container
//                     IDs, API status codes, polling progression, payload
//                     sizes). Useful when chasing IG/FB API errors but
//                     adds significant noise to the Logs column for
//                     every post, so leave it at INFO in steady state.
//
// Cached for the duration of a single Apps Script execution so the dozens
// of appendDebug() calls inside one postRow() don't each hit the Properties
// service. Changes take effect on the next invocation.

var _LOG_LEVEL_CACHE = null;

/**
 * Returns the active log level ('INFO' or 'DEBUG'), defaulting to INFO when
 * the Script Property is unset. Cached per execution.
 * @returns {string}
 */
function getLogLevel() {
  if (_LOG_LEVEL_CACHE === null) {
    var raw = PropertiesService.getScriptProperties().getProperty('LOG_LEVEL');
    _LOG_LEVEL_CACHE = (raw && raw.toUpperCase() === 'DEBUG') ? 'DEBUG' : 'INFO';
  }
  return _LOG_LEVEL_CACHE;
}

/**
 * Appends a debug-level log entry. No-op unless LOG_LEVEL=DEBUG. Same
 * timestamped format as appendLog(), prefixed with "DEBUG " so the level
 * is obvious when skimming the Logs column.
 *
 * Call this for diagnostic detail that should NOT appear in routine
 * production runs (container IDs, payload sizes, per-attempt polling
 * outcomes, internal URLs). Use appendLog() for events the operator
 * always wants to see (post created, posted, failed, retried).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowIndex
 * @param {string} msg
 */
function appendDebug(sheet, rowIndex, msg) {
  if (getLogLevel() !== 'DEBUG') return;
  appendLog(sheet, rowIndex, 'DEBUG ' + msg);
}

// ── Drive file permission management (for Instagram URL access) ─────────────
//
// As of v4, both functions below are NO-OPS. The TELEGRAM_DRIVE_FOLDER is
// configured once in the Drive UI as "Anyone with the link can view" so that
// uploaded files inherit public-read access from the folder. This sidesteps:
//   - The per-file setSharing() permission errors ("Zugriff verweigert"),
//     which can fire even with full `drive` OAuth scope due to subtleties
//     around AP-uploaded file ownership / Drive quota / shared-drive rules.
//   - The race window where IG hasn't yet finished fetching a file but
//     makeFilePrivate() has revoked it.
//   - Dependency on the script having edit permission on each file.
//
// Trade-off: file URLs are publicly readable. Drive file IDs are 33+ char
// random strings — not enumerable — so the practical leak surface is
// "anyone we explicitly share a file URL with can re-view it later." For a
// personal automation, that's acceptable. To revert to per-file sharing,
// restore the original setSharing() bodies below.
//
// The function names are kept (and called by Posting.gs) so re-enabling
// per-file sharing later is a one-function change, not a refactor.

/**
 * NO-OP. The Drive folder is permanently shared as "Anyone with link".
 * @param {string} fileId - Google Drive file ID (unused)
 */
function makeFilePublic(fileId) {
  // Intentionally empty. See block comment above.
}

/**
 * NO-OP. The Drive folder is permanently shared as "Anyone with link".
 * @param {string} fileId - Google Drive file ID (unused)
 */
function makeFilePrivate(fileId) {
  // Intentionally empty. See block comment above.
}

// ── Instagram pending video containers ───────────────────────────────────────
// When an IG video container is still processing (IN_PROGRESS) at the end of a
// postRow() call, its details are saved here AND a one-time time-based trigger
// is created. The trigger deletes itself when it fires, then re-creates itself
// only if some items are still pending. No permanent trigger is installed.

var IG_PENDING_KEY = 'IG_PENDING_CONTAINERS';

/**
 * Returns the list of pending Instagram containers from Script Properties.
 * Each item shape:
 *   { rowIndex, type, containerId?, childContainerIds?,
 *     pendingVideoChildIds?, pendingVideoFileIds?, caption?, videoFileIds? }
 *
 * @returns {Object[]}
 */
function getIgPendingContainers() {
  var raw = PropertiesService.getScriptProperties().getProperty(IG_PENDING_KEY);
  return raw ? JSON.parse(raw) : [];
}

/**
 * Persists the pending container list back to Script Properties.
 *
 * @param {Object[]} arr
 */
function saveIgPendingContainers(arr) {
  PropertiesService.getScriptProperties().setProperty(
    IG_PENDING_KEY, JSON.stringify(arr));
}

/**
 * Creates a one-time trigger that fires checkPendingIgContainers() in 15 minutes.
 * Only creates one if none already exists for that function, so multiple async
 * videos queued in the same postRow() call share a single trigger.
 */
function scheduleIgPendingTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkPendingIgContainers') {
      return;  // a trigger already exists — don't create a duplicate
    }
  }
  ScriptApp.newTrigger('checkPendingIgContainers')
    .timeBased()
    .after(15 * 60 * 1000)  // 15 minutes in milliseconds
    .create();
}

/**
 * Deletes all triggers pointing at checkPendingIgContainers.
 * Called at the start of checkPendingIgContainers() so the one-time
 * trigger cleans itself up before deciding whether to reschedule.
 */
function deleteIgPendingTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkPendingIgContainers') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

// ── Cross-cutting stampers (used by Posting.gs and Telegram.gs) ──────────────

/**
 * Writes a single-line error string to the Error_Message column AND appends
 * a longer entry to the Logs column. The Logs column keeps full history while
 * Error_Message gives the Activepieces confirmation step a one-line summary
 * to send to the user without parsing the multi-line logs.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowIndex
 * @param {string} msg
 */
function recordError(sheet, rowIndex, msg) {
  appendLog(sheet, rowIndex, msg);
  try {
    sheet.getRange(rowIndex, COL.ERROR_MESSAGE).setValue(msg);
  } catch (e) {
    // Sheet may be missing the new column on a freshly-upgraded spreadsheet.
    // Logs already captured the message — silently move on.
  }
}

/**
 * Stamps Posted_At (now), FB_Post_ID, and IG_Post_ID for a successfully posted row.
 * Tolerates missing columns on legacy sheets (silently skips writes).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowIndex
 * @param {string|null} fbPostId
 * @param {string|null} igPostId
 */
function stampPostSuccess(sheet, rowIndex, fbPostId, igPostId) {
  var lastCol = sheet.getLastColumn();
  if (lastCol >= COL.POSTED_AT)  sheet.getRange(rowIndex, COL.POSTED_AT).setValue(new Date());
  if (lastCol >= COL.FB_POST_ID && fbPostId) sheet.getRange(rowIndex, COL.FB_POST_ID).setValue(fbPostId);
  if (lastCol >= COL.IG_POST_ID && igPostId) sheet.getRange(rowIndex, COL.IG_POST_ID).setValue(igPostId);
}

/**
 * Generates a UUID v4 for use as a Row_ID. Uses a JS implementation since
 * Apps Script's Utilities.getUuid() returns the same shape but takes a
 * round-trip; this avoids that and works offline.
 * @returns {string}
 */
function generateRowId() {
  return Utilities.getUuid();
}

/**
 * Returns the 1-based row index of the row with the given Row_ID, or -1 if not found.
 * Reads only column I (Row_ID) for efficiency.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} rowId
 * @returns {number} 1-based row index, or -1 if not found
 */
function findRowByRowId(sheet, rowId) {
  if (!rowId) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var values = sheet.getRange(2, COL.ROW_ID, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] && values[i][0].toString() === rowId) {
      return i + 2;
    }
  }
  return -1;
}

/**
 * Returns the 1-based row index of the most-recent 'Collecting' row for the
 * given Telegram user id whose Timestamp is within COLLECT_WINDOW_SECONDS of
 * now, or -1 if none. Used by add_to_draft to decide between APPENDING to an
 * in-flight draft vs CREATING a brand new row.
 *
 * Reads columns J (telegram id), G (status), A (timestamp) in three batched calls.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} telegramId — Telegram user id as string
 * @returns {number} 1-based row index, or -1 if none in the window
 */
function findCollectingRowForUser(sheet, telegramId) {
  if (!telegramId) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var ids    = sheet.getRange(2, COL.TELEGRAM_USER_ID, lastRow - 1, 1).getValues();
  var states = sheet.getRange(2, COL.STATUS,           lastRow - 1, 1).getValues();
  var times  = sheet.getRange(2, COL.TIMESTAMP,        lastRow - 1, 1).getValues();

  var nowMs    = Date.now();
  var windowMs = COLLECT_WINDOW_SECONDS * 1000;
  var bestIdx  = -1;
  var bestTs   = 0;

  var target = String(telegramId);
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) !== target) continue;
    if (states[i][0] !== STATUS.COLLECTING) continue;

    var ts = times[i][0] ? new Date(times[i][0]).getTime() : 0;
    if (!ts || (nowMs - ts) > windowMs) continue;

    if (ts > bestTs) {
      bestTs  = ts;
      bestIdx = i + 2;
    }
  }
  return bestIdx;
}

/**
 * Returns the 1-based row index of the most-recent 'Awaiting Edit' row for
 * the given Telegram user id, or -1 if none. Used by handleAddToDraft to
 * detect "user is mid-edit" and treat the incoming text as the corrected
 * caption rather than the start of a new draft.
 *
 * No time window — Awaiting Edit can persist for hours; the user explicitly
 * tapped Edit, so the next text message is treated as the correction.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} telegramId
 * @returns {number} 1-based row index, or -1 if none
 */
function findAwaitingEditRowForUser(sheet, telegramId) {
  if (!telegramId) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var ids    = sheet.getRange(2, COL.TELEGRAM_USER_ID, lastRow - 1, 1).getValues();
  var states = sheet.getRange(2, COL.STATUS,           lastRow - 1, 1).getValues();
  var times  = sheet.getRange(2, COL.TIMESTAMP,        lastRow - 1, 1).getValues();

  var bestIdx = -1;
  var bestTs  = 0;
  var target  = String(telegramId);

  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) !== target) continue;
    if (states[i][0] !== STATUS.AWAITING_EDIT) continue;
    var ts = times[i][0] ? new Date(times[i][0]).getTime() : 0;
    if (ts > bestTs) {
      bestTs  = ts;
      bestIdx = i + 2;
    }
  }
  return bestIdx;
}

/**
 * Flips any older Draft / Awaiting Edit row for the same Telegram user to
 * 'Superseded'. Called when a brand new Collecting row is finalized so the
 * user never has two open drafts at once — they would otherwise compete for
 * the user's button-tap reply.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} telegramId
 * @param {number} exceptRowIndex — row that should not be superseded (the new one)
 */
function supersedeOlderDrafts(sheet, telegramId, exceptRowIndex) {
  if (!telegramId) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var ids    = sheet.getRange(2, COL.TELEGRAM_USER_ID, lastRow - 1, 1).getValues();
  var states = sheet.getRange(2, COL.STATUS,           lastRow - 1, 1).getValues();
  var supersedable = [STATUS.DRAFT, STATUS.AWAITING_EDIT];

  var target = String(telegramId);
  for (var i = 0; i < ids.length; i++) {
    var rowIndex = i + 2;
    if (rowIndex === exceptRowIndex) continue;
    if (String(ids[i][0]) !== target) continue;
    if (supersedable.indexOf(states[i][0]) === -1) continue;

    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.SUPERSEDED);
    appendLog(sheet, rowIndex,
      'Superseded by newer draft from same Telegram user (row ' + exceptRowIndex + ').');
  }
}

// ── Telegram update-ID dedup (CacheService) ────────────────────────────────
// Activepieces or Telegram may retry webhook delivery on transient errors.
// LockService prevents in-process races, but a retried delivery later would
// still process the same payload. CacheService gives us a fast TTL'd
// "have we seen this update_id?" check.
//
// CacheService TTL max is 6 hours, which comfortably exceeds typical retry
// windows. 'update_id:' prefix avoids collisions with any future cache use.

/**
 * Returns true if the given Telegram update id has been processed in the
 * last ~6 hours.
 * @param {string} updateId
 * @returns {boolean}
 */
function updateIdSeen(updateId) {
  if (!updateId) return false;
  return CacheService.getScriptCache().get('update_id:' + updateId) === '1';
}

/**
 * Marks a Telegram update id as processed. Idempotent.
 * @param {string} updateId
 */
function markUpdateIdSeen(updateId) {
  if (!updateId) return;
  CacheService.getScriptCache().put('update_id:' + updateId, '1', 6 * 3600);
}
