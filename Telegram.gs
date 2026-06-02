// ============================================================
// Telegram.gs — Web App entry points called by Activepieces
// ============================================================
// This file exposes a single doPost() endpoint which Activepieces hits with
// JSON payloads. All requests must include a shared secret that
// matches ORCHESTRATOR_SHARED_SECRET in Script Properties.
//
// Deploy as Web App: Deploy → New deployment → Type: Web app
//   Execute as:    Me (script owner)
//   Who has access: Anyone  ← required so Activepieces can hit it without OAuth
// Copy the resulting /exec URL into the Activepieces flows' WEBAPP_URL field.
//
// IMPORTANT: anyone holding ORCHESTRATOR_SHARED_SECRET can run any of these
// actions on your sheet, so generate a long random secret and treat it like
// a token. All requests are also rate-limited by Apps Script's per-user
// execution quotas — there is no need for additional throttling on
// Activepieces' side.
//
// All actions are idempotent: re-running with the same row_id either
// performs no work or completes the already-in-progress step. Activepieces
// can safely retry on transient errors.

/**
 * Web App POST handler. Activepieces calls this with a JSON body of the form:
 *   { token: "<ORCHESTRATOR_SHARED_SECRET>", action: "...", ...args }
 *
 * Supported actions (see handlers below):
 *   add_to_draft        — create a new Collecting row OR append text/media to
 *                         an in-flight one. The unified entry point that the
 *                         Activepieces inbound flow calls for every new-content
 *                         message. Includes update_id dedup automatically.
 *   finalize_collecting — flip a Collecting row to New and run Sarvam.
 *                         Called by the polling flow once the collect window
 *                         expires.
 *   check_update_id     — quick "have we seen this update id?" probe (used by
 *                         the inbound flow to short-circuit retries).
 *   process             — run Sarvam on a row by row_id (manual / fallback).
 *   approve             — set Approved (with optional edited caption) and post
 *                         immediately.
 *   setStatus           — generic status setter (used for 'Awaiting Edit').
 *   appendError         — append a one-line error from Activepieces into the
 *                         row's log.
 *
 *   rewrite_text        — Sarvam rewrite of a Hindi text blob; returns cleaned
 *                         text. Used by the writer bot. Stateless — does not
 *                         touch the sheet. Implemented in Writer.gs.
 *   generate_article    — Sarvam generation of a 3-4 paragraph Hindi news
 *                         article from a brief. Used by the writer bot.
 *                         Stateless. Implemented in Writer.gs.
 *
 * @param {GoogleAppsScript.Events.DoPost} e
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return jsonOut({ ok: false, error: 'invalid_json' }, 400);
  }

  // Constant-time-ish secret comparison (Apps Script has no native
  // crypto.timingSafeEqual, but the secret is long enough that timing attacks
  // are not practical here).
  if (!body.token || body.token !== getOrchestratorSharedSecret()) {
    return jsonOut({ ok: false, error: 'unauthorized' }, 401);
  }

  // LockService prevents two concurrent Activepieces calls from both flipping
  // status and racing each other (e.g. "process" arriving twice from a retried
  // HTTP). 30 s is plenty — Sarvam typically responds in <10 s.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30 * 1000);
  } catch (lockErr) {
    return jsonOut({ ok: false, error: 'busy' }, 503);
  }

  try {
    switch (body.action) {
      case 'add_to_draft':        return jsonOut(handleAddToDraft(body));
      case 'finalize_collecting': return jsonOut(handleFinalizeCollecting(body));
      case 'check_update_id':     return jsonOut(handleCheckUpdateId(body));
      case 'process':             return jsonOut(handleProcess(body));
      case 'approve':             return jsonOut(handleApprove(body));
      case 'setStatus':           return jsonOut(handleSetStatus(body));
      case 'appendError':         return jsonOut(handleAppendError(body));
      // Writer bot actions (Writer.gs) — stateless Sarvam calls, no sheet I/O.
      case 'rewrite_text':        return jsonOut(handleRewriteText(body));
      case 'generate_article':    return jsonOut(handleGenerateArticle(body));
      default:
        return jsonOut({ ok: false, error: 'unknown_action: ' + body.action }, 400);
    }
  } catch (err) {
    return jsonOut({ ok: false, error: err.message, stack: err.stack || '' }, 500);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Optional — answers GET pings (e.g. browser smoke test of the deployment).
 * Does NOT expose any data; just returns a static OK.
 */
function doGet(e) {
  return jsonOut({ ok: true, service: 'social-poster', version: 'v4-telegram' });
}

// ── Action handlers ─────────────────────────────────────────────

/**
 * Unified inbound handler — the only action Activepieces needs for new content.
 *
 * Behaviour (in priority order):
 *   1. If update_id was already seen in the last 6 hours: noop, returns
 *      action:'deduped'.
 *   2. EDIT FLOW INTERCEPT — if the user has an 'Awaiting Edit' row AND
 *      `text` is non-empty: write `text` to PCaption, mark Approved, run
 *      postRow synchronously. Returns action:'edited_and_posted'. Media in
 *      the edit message is ignored — the original draft's media stays.
 *      (Edit messages without text fall through to step 3/4.)
 *   3. If a Collecting row exists for this Telegram user (within
 *      COLLECT_WINDOW_SECONDS):
 *      * Append `text` (newline-separated) to col B (Caption).
 *      * Append `media_url` (comma-separated) to col C (Image/Video Upload).
 *      * Slide the row's Timestamp forward so the collect window resets —
 *        this keeps the bundle open as long as the user keeps sending media.
 *      * Returns action:'appended', row_id of the existing row.
 *   4. Else: create a fresh Collecting row, returns action:'created'.
 *
 * The polling flow's "Finalize Collecting" sweep flips Collecting → New
 * once the row's Timestamp is older than COLLECT_WINDOW_SECONDS, which kicks
 * off Sarvam.
 *
 * Body:  { telegram_user_id, text?, media_url?, update_id? }
 * Reply: { ok, row_id, action: 'appended'|'created'|'deduped'|'edited_and_posted', status? }
 */
function handleAddToDraft(body) {
  if (!body.telegram_user_id) return { ok: false, error: 'missing_telegram_user_id' };
  var telegramId = String(body.telegram_user_id);

  // Dedup: Activepieces / Telegram may retry a webhook delivery; the update_id
  // is stable across retries, so a second arrival is a no-op.
  if (body.update_id && updateIdSeen(body.update_id)) {
    return { ok: true, action: 'deduped' };
  }

  var sheet = getSheet();

  // ── EDIT FLOW INTERCEPT ──────────────────────────────────────
  // If the user has a row in 'Awaiting Edit' status (set after they tapped
  // the Edit button on an approval card) AND the incoming message has text,
  // treat that text as the corrected caption: write it to PCaption, mark
  // Approved, and post immediately. Media in the edit message is ignored;
  // the original draft's media stays.
  //
  // Edit-mode messages without text fall through to the normal new-draft
  // path — the user can keep sending content and start fresh later.
  var newText = (body.text || '').toString().trim();
  if (newText) {
    var editRowIdx = findAwaitingEditRowForUser(sheet, telegramId);
    if (editRowIdx !== -1) {
      var editRowId = sheet.getRange(editRowIdx, COL.ROW_ID).getValue().toString();
      sheet.getRange(editRowIdx, COL.PCAPTION).setValue(newText);
      appendLog(sheet, editRowIdx,
        'PCaption updated by Telegram user edit. Posting now...');
      sheet.getRange(editRowIdx, COL.STATUS).setValue(STATUS.APPROVED);
      postRow(sheet, editRowIdx);  // sets Posted / Posted (FB only) / Pending (IG) / Failed
      var finalStatus = sheet.getRange(editRowIdx, COL.STATUS).getValue().toString();
      if (body.update_id) markUpdateIdSeen(body.update_id);
      return {
        ok: true,
        action: 'edited_and_posted',
        row_id: editRowId,
        row_index: editRowIdx,
        status: finalStatus
      };
    }
  }

  var collectIdx = findCollectingRowForUser(sheet, telegramId);

  if (collectIdx !== -1) {
    // ── Append to existing Collecting row ────────────────────────
    if (body.text && body.text.trim() !== '') {
      var existingCap = (sheet.getRange(collectIdx, COL.CAPTION_RAW).getValue() || '').toString();
      var newCap = existingCap
        ? existingCap + '\n' + body.text.trim()
        : body.text.trim();
      sheet.getRange(collectIdx, COL.CAPTION_RAW).setValue(newCap);
    }
    if (body.media_url) {
      var existingMedia = (sheet.getRange(collectIdx, COL.IMAGE_URL).getValue() || '').toString();
      var newMedia = existingMedia
        ? existingMedia + ', ' + body.media_url
        : body.media_url;
      sheet.getRange(collectIdx, COL.IMAGE_URL).setValue(newMedia);
    }

    // Slide the timestamp forward — every new piece resets the collect window.
    sheet.getRange(collectIdx, COL.TIMESTAMP).setValue(new Date());

    appendLog(sheet, collectIdx,
      'Appended ' +
      (body.text ? 'text' : '') +
      (body.text && body.media_url ? ' + ' : '') +
      (body.media_url ? 'media' : '') +
      '. Collect window reset.');

    if (body.update_id) markUpdateIdSeen(body.update_id);
    var existingRowId = sheet.getRange(collectIdx, COL.ROW_ID).getValue().toString();
    return { ok: true, action: 'appended', row_id: existingRowId, row_index: collectIdx };
  }

  // ── Create a fresh Collecting row ─────────────────────────────
  var rowId   = generateRowId();
  var newRow  = [
    new Date(),                        // A — Timestamp
    (body.text || '').toString(),      // B — Caption
    (body.media_url || '').toString(), // C — Image/Video Upload
    '',                                // D — Schedule
    '',                                // E — PCaption
    '',                                // F — GHeadline
    STATUS.COLLECTING,                 // G — Status
    '',                                // H — Logs
    rowId,                             // I — Row_ID
    telegramId,                        // J — Telegram_User_Id
    'FALSE',                           // K — Approval_Requested
    '',                                // L — Approval_Sent_At
    'FALSE',                           // M — Reminder_Sent
    'FALSE',                           // N — Confirmation_Sent
    '',                                // O — Posted_At
    '',                                // P — FB_Post_ID
    '',                                // Q — IG_Post_ID
    ''                                 // R — Error_Message
  ];
  sheet.appendRow(newRow);
  var newRowIndex = sheet.getLastRow();
  appendLog(sheet, newRowIndex, 'Collecting opened from Telegram user ' + telegramId + '.');

  if (body.update_id) markUpdateIdSeen(body.update_id);
  return { ok: true, action: 'created', row_id: rowId, row_index: newRowIndex };
}

/**
 * Closes a Collecting row's window and starts Sarvam processing.
 * The polling flow calls this once the row's Timestamp is older than
 * COLLECT_WINDOW_SECONDS. Idempotent — if the row is no longer Collecting
 * (e.g. already finalized by a prior poll), returns noop:true.
 *
 * Body:  { row_id }
 * Reply: { ok, row_index, status }
 */
function handleFinalizeCollecting(body) {
  var sheet    = getSheet();
  var rowIndex = findRowByRowId(sheet, body.row_id);
  if (rowIndex === -1) return { ok: false, error: 'row_not_found' };

  var status = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
  if (status !== STATUS.COLLECTING) {
    return { ok: true, row_index: rowIndex, status: status, noop: true };
  }

  // Skip rows that ended up empty (e.g. user sent only an unsupported sticker
  // that was filtered upstream). Mark them as Error so the user gets a reply.
  var rawCap = (sheet.getRange(rowIndex, COL.CAPTION_RAW).getValue() || '').toString().trim();
  var rawMed = (sheet.getRange(rowIndex, COL.IMAGE_URL).getValue() || '').toString().trim();
  if (!rawCap && !rawMed) {
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.ERROR);
    recordError(sheet, rowIndex, 'Collecting closed but row had no content.');
    return { ok: true, row_index: rowIndex, status: STATUS.ERROR };
  }

  sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.NEW);
  appendLog(sheet, rowIndex, 'Collect window closed. Processing...');
  processRow(sheet, rowIndex);  // sets Draft on success, Error on failure
  var newStatus = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
  return { ok: true, row_index: rowIndex, status: newStatus };
}

/**
 * Quick "have we seen this update_id?" probe. Used by the inbound flow as
 * a fast-path short-circuit for retried deliveries — saves a Sheets read.
 *
 * Body:  { update_id }
 * Reply: { ok, seen }
 */
function handleCheckUpdateId(body) {
  return { ok: true, seen: updateIdSeen(body.update_id) };
}

/**
 * Process a row through Sarvam AI. Idempotent: if the row is already
 * past 'New' (e.g. already Draft / Posted), returns early with the
 * current status.
 *
 * Body:  { row_id }
 * Reply: { ok, row_index, status }
 */
function handleProcess(body) {
  var sheet    = getSheet();
  var rowIndex = findRowByRowId(sheet, body.row_id);
  if (rowIndex === -1) return { ok: false, error: 'row_not_found' };

  var status = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
  // Only run Sarvam for empty / NEW / Error / Failed rows. Anything else is
  // either in flight or already done — treat as a no-op success.
  var processable = ['', STATUS.NEW, STATUS.ERROR, STATUS.FAILED];
  if (processable.indexOf(status) === -1) {
    return { ok: true, row_index: rowIndex, status: status, noop: true };
  }

  processRow(sheet, rowIndex);  // existing function — sets Draft on success, Error on failure
  var newStatus = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
  return { ok: true, row_index: rowIndex, status: newStatus };
}

/**
 * Approve a row and post it.
 *
 * - If edited_caption is provided, it is written to PCaption first.
 * - If a future schedule is set, status flips to 'Scheduled' and the
 *   existing checkScheduledPosts trigger handles publishing on time.
 * - Otherwise postRow() runs synchronously and the user sees the result
 *   in the same Activepieces execution.
 *
 * Body:  { row_id, edited_caption? }
 * Reply: { ok, row_index, status }
 */
function handleApprove(body) {
  var sheet    = getSheet();
  var rowIndex = findRowByRowId(sheet, body.row_id);
  if (rowIndex === -1) return { ok: false, error: 'row_not_found' };

  var status = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
  // Allow approve from Draft (typical) or from Awaiting Edit (after a corrected
  // caption is sent). Anything else is a no-op (already approved, already
  // posted, or still processing).
  if (status !== STATUS.DRAFT && status !== STATUS.AWAITING_EDIT) {
    return { ok: true, row_index: rowIndex, status: status, noop: true };
  }

  if (body.edited_caption && body.edited_caption.toString().trim() !== '') {
    sheet.getRange(rowIndex, COL.PCAPTION).setValue(body.edited_caption.toString().trim());
    appendLog(sheet, rowIndex, 'PCaption updated by Telegram user edit.');
  }

  // Decide: post immediately or schedule for later.
  var scheduleVal = sheet.getRange(rowIndex, COL.SCHEDULE).getValue();
  var now         = new Date();
  var scheduleDt  = scheduleVal ? new Date(scheduleVal) : null;
  var isFuture    = !!(scheduleDt && scheduleDt > now);

  if (isFuture) {
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.SCHEDULED);
    appendLog(sheet, rowIndex,
      'Approved via Telegram. Queued for ' +
      Utilities.formatDate(scheduleDt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') + '.');
    return { ok: true, row_index: rowIndex, status: STATUS.SCHEDULED };
  }

  sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.APPROVED);
  appendLog(sheet, rowIndex, 'Approved via Telegram. Posting now...');
  postRow(sheet, rowIndex);  // sets Posted / Posted (FB only) / Pending (IG) / Failed
  var finalStatus = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
  return { ok: true, row_index: rowIndex, status: finalStatus };
}

/**
 * Generic status setter — used by Activepieces to flip a row to 'Awaiting Edit'
 * after a user taps the Edit button. Restricted to a small allowlist of
 * statuses to prevent Activepieces from accidentally jumping the state machine.
 *
 * Body:  { row_id, status }
 * Reply: { ok, row_index, status }
 */
function handleSetStatus(body) {
  var sheet    = getSheet();
  var rowIndex = findRowByRowId(sheet, body.row_id);
  if (rowIndex === -1) return { ok: false, error: 'row_not_found' };

  var allowed = [STATUS.AWAITING_EDIT, STATUS.ERROR];
  if (allowed.indexOf(body.status) === -1) {
    return { ok: false, error: 'status_not_allowed: ' + body.status };
  }
  sheet.getRange(rowIndex, COL.STATUS).setValue(body.status);
  appendLog(sheet, rowIndex, 'Status set to ' + body.status + ' by Activepieces.');
  return { ok: true, row_index: rowIndex, status: body.status };
}

/**
 * Append a one-line error from Activepieces into the row's log + Error_Message
 * column. Useful when a media-download/upload step fails before processing
 * can start.
 *
 * Body:  { row_id, message }
 * Reply: { ok }
 */
function handleAppendError(body) {
  var sheet    = getSheet();
  var rowIndex = findRowByRowId(sheet, body.row_id);
  if (rowIndex === -1) return { ok: false, error: 'row_not_found' };
  recordError(sheet, rowIndex, '[activepieces] ' + (body.message || 'unknown error'));
  return { ok: true };
}

// ── Plumbing ────────────────────────────────────────────────────

/**
 * Builds a JSON ContentService response. Apps Script doesn't expose the
 * HTTP status code from a Web App — Activepieces must check the JSON 'ok'
 * field to distinguish success from failure.
 */
function jsonOut(obj /* , httpStatus */) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
