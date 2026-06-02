// ============================================================
// Setup.gs — One-time setup functions
// ============================================================
// Run these ONCE from the Apps Script editor (select function → Run).
// They do not need to be run again unless you are rotating tokens
// or reinstalling triggers.

/**
 * STEP 1 — Save API secrets into Script Properties (Google-encrypted).
 *
 * How to use:
 *   1. Paste your real SECRET values into the placeholder fields below
 *      (SARVAM_API_KEY, FB_PAGE_ACCESS_TOKEN, IG_USER_ACCESS_TOKEN,
 *      ORCHESTRATOR_SHARED_SECRET).
 *   2. Select initScriptProperties in the function dropdown → click Run.
 *   3. Immediately replace the real secret values with placeholder strings again
 *      so they are never stored in code or version control.
 *
 *   FB_PAGE_ID and IG_USER_ID are not secrets (anyone can derive them from a
 *   public Facebook Page / Instagram account) and are baked in directly.
 *
 * To rotate a secret later, repeat steps 1-3 with the new value.
 *
 * Properties saved:
 *   SARVAM_API_KEY               → your Sarvam API key (sk_...)
 *   FB_PAGE_ACCESS_TOKEN         → never-expiring Page Access Token, used for FB writes only (see Config.gs)
 *   IG_USER_ACCESS_TOKEN         → long-lived User Access Token, used for IG ops only (see Config.gs);
 *                                  rotates every ~60 days
 *   FB_PAGE_ID                   → your Facebook Page numeric ID (public — find it at developers.facebook.com/tools/explorer)
 *   IG_USER_ID                   → your Instagram Business Account numeric ID (public — find it via the /me/accounts Graph API call)
 *   NOTIFY_EMAIL                 → email to notify when a new draft is ready
 *                                  (optional — defaults to the script owner's email)
 *   ORCHESTRATOR_SHARED_SECRET   → shared secret Activepieces sends in every doPost() call
 *   TELEGRAM_DRIVE_FOLDER_ID     → optional Drive folder where Activepieces uploads Telegram media
 *   LOG_LEVEL                    → 'INFO' (default) or 'DEBUG'. DEBUG adds per-step diagnostics
 *                                  (container IDs, file IDs, API response codes, polling
 *                                  attempts) to the Logs column. Flip to DEBUG when chasing
 *                                  IG/FB API errors, then back to INFO for steady state.
 */
function initScriptProperties() {
  var props = PropertiesService.getScriptProperties();
  props.setProperties({
    'SARVAM_API_KEY':              'PASTE_YOUR_SARVAM_KEY_HERE',
    'FB_PAGE_ACCESS_TOKEN':        'PASTE_YOUR_NEVER_EXPIRING_PAGE_TOKEN_HERE',
    'IG_USER_ACCESS_TOKEN':        'PASTE_YOUR_LONG_LIVED_USER_TOKEN_HERE',
    'FB_PAGE_ID':                  'YOUR_FB_PAGE_ID',
    'IG_USER_ID':                  'YOUR_IG_USER_ID',
    'NOTIFY_EMAIL':                'PASTE_REVIEWER_EMAIL_HERE',
    // ORCHESTRATOR_SHARED_SECRET: long random string (e.g. 32+ hex chars). The
    //   Activepieces flows must send this in every doPost() call as the 'token'
    //   field. Anyone holding this string can trigger Sarvam processing and
    //   FB/IG posting on your behalf, so generate it with a password manager
    //   and never commit it to source control.
    'ORCHESTRATOR_SHARED_SECRET':  'PASTE_LONG_RANDOM_STRING_HERE',
    // TELEGRAM_DRIVE_FOLDER_ID: optional. Drive folder where Activepieces uploads
    //   incoming Telegram media. Stored here only so the script can audit
    //   the location; the script never enforces it.
    'TELEGRAM_DRIVE_FOLDER_ID':    'PASTE_DRIVE_FOLDER_ID_OR_LEAVE_BLANK',
    // LOG_LEVEL: 'INFO' or 'DEBUG'. Default INFO. Flip to DEBUG via the
    //   Apps Script Properties UI (no need to re-run initScriptProperties)
    //   when you need per-step diagnostics in the Logs column.
    'LOG_LEVEL':                   'INFO'
  });
  Logger.log('Script Properties saved.');
  Logger.log('ACTION REQUIRED: Replace the secret values (SARVAM_API_KEY, FB_PAGE_ACCESS_TOKEN, IG_USER_ACCESS_TOKEN, ORCHESTRATOR_SHARED_SECRET) with placeholders now.');
}

/**
 * Adds the new v2 column headers (I-R) to the bound spreadsheet's first sheet
 * if they are not already present. Safe to re-run — only writes headers for
 * columns whose current value is empty.
 *
 * Run this ONCE after upgrading from v1 to v2. The legacy A-H headers are
 * never touched, so the existing Google Form continues to work unchanged.
 */
function ensureHeaders() {
  var sheet  = getSheet();
  var maxCol = 18;  // R
  var current = sheet.getRange(1, 1, 1, maxCol).getValues()[0];

  // Extend the sheet's column count if needed (sheets default to 26 cols, but
  // be defensive in case the user has a narrow custom template).
  if (sheet.getMaxColumns() < maxCol) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), maxCol - sheet.getMaxColumns());
  }

  Object.keys(COL_HEADERS).forEach(function (colNumStr) {
    var col = Number(colNumStr);
    var existing = current[col - 1];
    if (!existing || existing.toString().trim() === '') {
      sheet.getRange(1, col).setValue(COL_HEADERS[col]).setFontWeight('bold');
    }
  });
  Logger.log('ensureHeaders: v2 columns I-R verified.');
}

/**
 * STEP 2 — Install the two required project triggers.
 *
 * Installed triggers:
 *   1. onFormSubmitTrigger — fires on every Google Form submission
 *   2. checkApprovedPosts  — every 4 hours (posts human-approved drafts; safety net for n8n)
 *   3. checkScheduledPosts — every 4 hours (posts time-due scheduled posts)
 *   4. archiveOldPosts     — once a day at 03:00 (moves >30-day terminal rows to Archive tab)
 *
 * checkPendingIgContainers is NOT installed here. A one-time trigger for it is
 * created automatically by postToInstagram() only when a video is still being
 * processed by Instagram, and re-created only while items remain pending.
 *
 * Safe to re-run: deletes all existing project triggers first to avoid duplicates.
 */
function setup() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    ScriptApp.deleteTrigger(existing[i]);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  ScriptApp.newTrigger('onFormSubmitTrigger')
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();

  ScriptApp.newTrigger('checkApprovedPosts')
    .timeBased()
    .everyHours(4)
    .create();

  ScriptApp.newTrigger('checkScheduledPosts')
    .timeBased()
    .everyHours(4)
    .create();

  // Every 30 min: scan for rows at "Posted (FB only)" within the
  // FB_ONLY_RETRY_WINDOW_MS (default 6 h) and re-run the Instagram path.
  // Recovers transient IG failures (rate limit, brief outage, container 9007
  // race) without any manual intervention. Rows older than the window are
  // left alone — persistent failures don't churn API calls forever.
  ScriptApp.newTrigger('retryFbOnlyRows')
    .timeBased()
    .everyMinutes(30)
    .create();

  // Daily archival at 03:00 sheet-local time. Keeps the polling sweep
  // fast by moving >30-day terminal rows to a sibling 'Archive' tab.
  ScriptApp.newTrigger('archiveOldPosts')
    .timeBased()
    .atHour(3)
    .everyDays(1)
    .create();

  Logger.log('Triggers installed:');
  Logger.log('   1. onFormSubmitTrigger  (on form submit)');
  Logger.log('   2. checkApprovedPosts   (every 4 hours — human-approved drafts)');
  Logger.log('   3. checkScheduledPosts  (every 4 hours — time-due scheduled posts)');
  Logger.log('   4. retryFbOnlyRows      (every 30 min — re-runs IG for "Posted (FB only)" rows within 6h window)');
  Logger.log('   5. archiveOldPosts      (daily at 03:00 — archives terminal rows >30 days old)');
  Logger.log('   Note: checkPendingIgContainers is scheduled on-demand when a video post is pending.');
}
