// ============================================================
// Processing.gs — Form-submit trigger + Sarvam AI processing
// ============================================================
// Depends on: Config.gs (shared global scope in Apps Script)


/**
 * Orchestrates processing for a single sheet row:
 *   1. Calls Sarvam AI once — returns JSON with both caption & headline
 *   2. Writes PCaption and GHeadline to the sheet
 *   3. Either posts immediately or marks as Scheduled based on col D
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowIndex - 1-based row number
 */
function processRow(sheet, rowIndex) {
  var rawCaption = sheet.getRange(rowIndex, COL.CAPTION_RAW).getValue();

  if (!rawCaption || rawCaption.toString().trim() === '') {
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.ERROR);
    recordError(sheet, rowIndex, 'Skipped: caption column is empty.');
    return;
  }

  // Stamp a Row_ID if this row doesn't already have one. Activepieces always
  // sets it on insert, but form-submitted rows arrive without one — and the
  // confirmation poller / web-app endpoints both key on Row_ID, so we
  // guarantee its presence here regardless of origin.
  // (Tolerant of legacy sheets that haven't been upgraded yet — the column
  //  read will return '' and we just won't stamp anything in that case.)
  if (sheet.getLastColumn() >= COL.ROW_ID) {
    var existingRowId = sheet.getRange(rowIndex, COL.ROW_ID).getValue();
    if (!existingRowId || existingRowId.toString().trim() === '') {
      sheet.getRange(rowIndex, COL.ROW_ID).setValue(generateRowId());
    }
  }

  // Guard against duplicate form-submit triggers (known Apps Script behaviour)
  // and against doPost() retries from Activepieces. STATUS.NEW is intentionally
  // NOT in this list — it is the canonical "Activepieces inserted, ready to
  // process" marker.
  var currentStatus = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
  var busyOrDone = [
    STATUS.PROCESSING,    STATUS.DRAFT,           STATUS.APPROVED,
    STATUS.SCHEDULED,     STATUS.POSTING_FB,      STATUS.POSTING_IG,
    STATUS.PENDING_IG,    STATUS.POSTED,          STATUS.POSTED_FB_ONLY,
    STATUS.AWAITING_EDIT,
    // 'Collecting' rows are still receiving media and must not be processed
    // until the polling flow flips them to 'New' via finalize_collecting.
    STATUS.COLLECTING,
    // 'Superseded' rows have been replaced by a newer draft from the same
    // user — do not run Sarvam on them.
    STATUS.SUPERSEDED
  ];
  if (busyOrDone.indexOf(currentStatus) !== -1) {
    // Duplicate trigger — another execution already claimed this row.
    return;
  }

  // Mark as processing and flush so the sheet reflects it immediately
  sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.PROCESSING);
  sheet.getRange(rowIndex, COL.LOGS).setValue('');  // clear any prior run logs
  SpreadsheetApp.flush();

  // ── Single Sarvam AI call → { caption, headline } ─────────────
  appendDebug(sheet, rowIndex,
    'Processing: invoking Sarvam (input=' + rawCaption.toString().trim().length + ' chars).');
  var result;
  try {
    result = withRetry(function () {
      return generateCaptionAndHeadline(rawCaption.toString().trim(), sheet, rowIndex);
    });
  } catch (e) {
    recordError(sheet, rowIndex,
      'Sarvam AI processing failed after ' + MAX_RETRIES + ' attempts: ' + e.message);
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.ERROR);
    return;
  }

  sheet.getRange(rowIndex, COL.PCAPTION).setValue(result.caption);
  sheet.getRange(rowIndex, COL.GHEADLINE).setValue(result.headline);
  SpreadsheetApp.flush();

  // ── Always save as Draft — human must approve before posting ──
  var scheduleValue = sheet.getRange(rowIndex, COL.SCHEDULE).getValue();
  var now           = new Date();
  var scheduleDate  = scheduleValue ? new Date(scheduleValue) : null;
  var isFuture      = !!(scheduleDate && scheduleDate > now);

  var scheduleNote = isFuture
    ? ' Requested schedule: ' +
      Utilities.formatDate(scheduleDate, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') +
      ' — will be queued once approved.'
    : ' No future schedule set — will post immediately once approved.';

  // Read Telegram user id once — it gates two downstream behaviours.
  var telegramId = (sheet.getLastColumn() >= COL.TELEGRAM_USER_ID)
    ? (sheet.getRange(rowIndex, COL.TELEGRAM_USER_ID).getValue() || '').toString().trim()
    : '';

  // Auto-supersede any older Draft / Awaiting Edit rows for this Telegram user.
  // This prevents the user from accidentally approving stale content if they
  // started a fresh draft while an old one was still pending.
  // (No-op for form-submitted rows that have no Telegram user id.)
  if (telegramId) {
    supersedeOlderDrafts(sheet, telegramId, rowIndex);
  }

  sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.DRAFT);
  appendLog(sheet, rowIndex, 'Processing complete. Saved as Draft.' + scheduleNote);

  // Email reviewer ONLY when the row didn't originate from Telegram.
  // Telegram rows get an approval card sent by the Activepieces polling flow —
  // emailing the reviewer too would be redundant and noisy.
  if (!telegramId) {
    sendDraftNotification(sheet, rowIndex);
  } else {
    appendLog(sheet, rowIndex,
      'Telegram-sourced row — email notification skipped; Activepieces will send Telegram approval card.');
  }
}

// ── Sarvam AI helpers ─────────────────────────────────────────

/**
 * Makes a single Sarvam AI call using the social-worker content prompt.
 * Returns both the processed Hindi caption and the Hindi headline in one shot.
 *
 * The prompt enforces:
 *   - Honest, grounded, approachable tone (सामाजिक कार्यकर्ता voice)
 *   - Clean Devanagari Hindi only (no English mix)
 *   - 60–100 words for caption, 4–7 words for headline
 *   - Strict JSON output: { "caption": "...", "headline": "..." }
 *
 * Input may be code-mixed Hindi+English, contain grammar mistakes or
 * inappropriate language — the prompt handles all of it.
 *
 * @param {string} rawCaption - Raw input from the Google Form
 * @param {GoogleAppsScript.Spreadsheet.Sheet} [sheet]    - optional, only used to surface DEBUG logs
 * @param {number} [rowIndex]                              - optional, only used to surface DEBUG logs
 * @returns {{ caption: string, headline: string }}
 * @throws {Error} On API failure or malformed JSON response
 */
function generateCaptionAndHeadline(rawCaption, sheet, rowIndex) {
  var systemPrompt =
    'तुम श्रीमती लीना सिंघल के लिए social media content writer हो। ' +
    'श्रीमती लीना सिंघल एक सामाजिक कार्यकर्ता और भारतीय जनता पार्टी की सक्रिय सदस्य हैं, ' +
    'जो नजीबाबाद विधानसभा क्षेत्र में जनसेवा करती हैं।\n\n' +

    'तुम्हारा काम: नीचे दिए गए input के आधार पर एक structured, स्पष्ट और पूर्ण caption और headline तैयार करना।\n\n' +

    'सबसे महत्वपूर्ण सिद्धांत — Information Preservation (जानकारी का संरक्षण):\n' +
    '- Input में दी गई सभी महत्वपूर्ण जानकारी को preserve करना अनिवार्य है।\n' +
    '- Output को छोटा करने के लिए किसी भी महत्वपूर्ण जानकारी को हटाना मना है।\n' +
    '- Caption में हमेशा ये शामिल होना चाहिए (अगर input में उपलब्ध हो):\n' +
    '  1. स्थान (Location)\n' +
    '  2. अवसर / कारण (Occasion / Why event happened)\n' +
    '  3. किन लोगों की उपस्थिति थी (People involved)\n' +
    '  4. क्या गतिविधि हुई (What happened)\n' +
    '  5. कोई महत्वपूर्ण वक्तव्य (Key statement)\n\n' +

    'Hallucination बिल्कुल नहीं:\n' +
    '- केवल वही जानकारी use करो जो input में दी गई है।\n' +
    '- कोई भी नया नाम, स्थान, समस्या, योजना या घटना मत जोड़ो।\n' +
    '- नाम और स्थान बिल्कुल वैसे ही लिखो जैसे input में हैं — spelling या नाम मत बदलो।\n\n' +

    'Input Handling Logic:\n' +
    '- अगर input पहले से ही detailed है → उसे साफ, structured और readable बनाओ (सिर्फ सुधार करो, जानकारी मत हटाओ)\n' +
    '- अगर input छोटा या incomplete है → उसी जानकारी को logically arrange करके meaningful caption बनाओ\n\n' +

    'Voice (Third Person):\n' +
    '- पूरा output तीसरे व्यक्ति में होना चाहिए\n' +
    '- "मैं, हम, हमने" जैसे शब्द बिल्कुल नहीं\n' +
    '- हमेशा "श्रीमती लीना सिंघल" का उपयोग करो\n\n' +

    'Tone:\n' +
    '- ईमानदार, ज़मीनी और भरोसेमंद\n' +
    '- सरल और स्पष्ट हिंदी (बहुत भारी शब्द नहीं)\n' +
    '- काम दिखे, दिखावा नहीं\n\n' +

    'Caption Rules:\n' +
    '- 80–140 शब्द (IMPORTANT: जानकारी पूरी रखने के लिए length बढ़ाई गई है)\n' +
    '- शुरुआत में context (स्थान + क्या हुआ)\n' +
    '- बीच में structured flow:\n' +
    '   → क्या गतिविधि हुई\n' +
    '   → कौन उपस्थित थे\n' +
    '   → क्या कहा गया / क्या चर्चा हुई\n' +
    '- अंत में सकारात्मक या उद्देश्यपूर्ण समापन\n' +
    '- No emojis, no hashtags, no dashes\n\n' +

    'Headline Rules:\n' +
    '- 8–12 शब्द\n' +
    '- स्पष्ट, तथ्यात्मक और context-driven\n' +
    '- "श्रीमती लीना सिंघल" शामिल होना चाहिए\n\n' +
    '- अगर input में कई नाम दिए गए हैं, तो कम से कम 2–3 प्रमुख नाम शामिल करना अनिवार्य है।' +

    'Language Requirement (MANDATORY):\n' +
    '- पूरा output केवल देवनागरी हिंदी में होना चाहिए\n' +
    '- कोई English शब्द या Roman Hindi नहीं\n\n' +

    'Must Avoid:\n' +
    '- जानकारी हटाना (information loss)\n' +
    '- generic या vague lines जैसे "बहुत अच्छा लगा"\n' +
    '- अतिशयोक्ति या प्रचार जैसा tone\n' +
    '- input में न हो ऐसी कोई भी जानकारी\n\n' +
    '- राजनीतिक नारे या aggressive tone\n' + 
    '- Hashtags (ये अलग से add होंगे)\n' + 
    '- Input में न हो एसी कोई जानकारी\n' + 
    '- अपशब्द, गाली, या अशोभनीय भाषा\n\n' +

    'Output (STRICT JSON ONLY — no markdown, no explanation):\n' +
    '{\n' +
    '  "caption": "...",\n' +
    '  "headline": "..."\n' +
    '}';

  var userPrompt = 'Input:\n' + rawCaption;

  var raw = callSarvamAPI(systemPrompt, userPrompt, sheet && rowIndex ? function(msg) {
    appendDebug(sheet, rowIndex, 'Sarvam (draft) ' + msg);
  } : null);
  var cleaned = stripCodeFences(raw);

  var parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Sarvam response was not valid JSON. Raw response: ' + raw);
  }

  if (!parsed.caption || !parsed.headline) {
    throw new Error(
      'Sarvam JSON missing "caption" or "headline" fields. Raw response: ' + raw);
  }

  return {
    caption:  parsed.caption.toString().trim(),
    headline: parsed.headline.toString().trim()
  };
}

/**
 * Strips markdown code fences that the model may wrap around JSON output.
 * Handles ```json ... ``` and ``` ... ``` patterns.
 *
 * @param {string} text - Raw model output
 * @returns {string}    - Text with code fences removed
 */
function stripCodeFences(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

/**
 * Makes a POST request to the Sarvam AI Chat Completions endpoint.
 * Uses sarvam-105b model with default parameters.
 *
 * @param {string} systemPrompt - Role/instruction prompt
 * @param {string} userPrompt   - User message content
 * @returns {string}            - Trimmed text from choices[0].message.content
 * @throws {Error}              - On non-200 response or unexpected JSON shape
 */
function callSarvamAPI(systemPrompt, userPrompt, logFn) {
  // Optional debug callback — when set, gets per-step diagnostic strings
  // (request shape, response size, latency, finish_reason). Callers in
  // sheet-bound flows pass a function that routes to appendDebug() on the
  // row's Logs column; callers in webhook-only flows (Writer.gs) can omit
  // it, in which case we fall back to Logger.log when LOG_LEVEL=DEBUG so
  // the diagnostics still land somewhere visible (Apps Script Executions
  // panel).
  function dbg(msg) {
    if (logFn) {
      logFn(msg);
    } else if (getLogLevel() === 'DEBUG') {
      Logger.log('Sarvam: ' + msg);
    }
  }

  // max_tokens caps the COMPLETION budget (reasoning + actual output, both
  // counted). Sarvam's default is 2048 which is too tight for sarvam-105b
  // in reasoning mode — the model burns ~1500-2000 tokens on internal
  // chain-of-thought (visible in `reasoning_content`) before writing the
  // JSON, often hitting the cap mid-output (`finish_reason: 'length'`,
  // truncated JSON, or `content: null`). 8192 gives plenty of headroom for
  // both reasoning and output even on the long detailed prompts; raise
  // further if the prompts grow.
  var payload = JSON.stringify({
    model:      SARVAM_MODEL,
    max_tokens: 4096,
    messages:   [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   }
    ]
  });

  var options = {
    method:           'post',
    contentType:      'application/json',
    headers:          { 'Authorization': 'Bearer ' + getSarvamApiKey() },
    payload:          payload,
    muteHttpExceptions: true
  };

  dbg('request → model=' + SARVAM_MODEL +
      ', system=' + systemPrompt.length + ' chars' +
      ', user=' + userPrompt.length + ' chars' +
      ', max_tokens=4096.');

  var startMs  = Date.now();
  var response = UrlFetchApp.fetch(SARVAM_API_URL, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();
  var durMs    = Date.now() - startMs;

  if (code !== 200) {
    dbg('error → HTTP ' + code + ' (' + durMs + ' ms).');
    throw new Error('Sarvam API error ' + code + ': ' + body);
  }

  var json = JSON.parse(body);
  if (!json.choices || !json.choices[0] || !json.choices[0].message) {
    dbg('error → response missing choices/message (' + durMs + ' ms).');
    throw new Error('Sarvam API response missing expected fields: ' + body);
  }

  var content = json.choices[0].message.content;
  if (content === null || content === undefined) {
    // Can happen when the model returns a reasoning-only response with no content.
    // The finish_reason is usually "stop" but content is null. Treat as retryable.
    var finishReason = (json.choices[0].finish_reason || 'unknown');
    dbg('error → null content (finish_reason=' + finishReason + ', ' + durMs + ' ms).');
    throw new Error(
      'Sarvam API returned null content (finish_reason: ' + finishReason + '). ' +
      'Full response: ' + body);
  }

  var trimmed = content.toString().trim();
  dbg('response → ' + trimmed.length + ' chars' +
      ', finish_reason=' + (json.choices[0].finish_reason || 'unknown') +
      ', dur=' + durMs + ' ms.');
  return trimmed;
}

// ── Human feedback loop ───────────────────────────────────────

/**
 * Sends an email notification to the reviewer when a new draft is ready.
 * The email includes the generated headline and caption so the reviewer can
 * assess the content without opening the sheet, then links directly to the
 * spreadsheet where they can edit PCaption and flip Status to "Approved".
 *
 * The recipient address is read from the NOTIFY_EMAIL Script Property.
 * If that property is absent, the email goes to the script owner.
 *
 * Errors here are non-fatal — a warning is logged but processing continues.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowIndex - 1-based row number
 */
function sendDraftNotification(sheet, rowIndex) {
  try {
    var ss          = SpreadsheetApp.getActiveSpreadsheet();
    var sheetUrl    = ss.getUrl();
    var headline    = sheet.getRange(rowIndex, COL.GHEADLINE).getValue().toString().trim();
    var caption     = sheet.getRange(rowIndex, COL.PCAPTION).getValue().toString().trim();
    var scheduleVal = sheet.getRange(rowIndex, COL.SCHEDULE).getValue();
    var scheduleStr = scheduleVal
      ? Utilities.formatDate(new Date(scheduleVal), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
      : 'Immediate (upon approval)';
    var toEmail = getNotifyEmail();

    var subject = '[FB Poster] Draft ready for review — Row ' + rowIndex;
    var body    =
      'A new draft Facebook post is ready for your review.\n\n' +
      'Headline:\n' + headline + '\n\n' +
      'Caption:\n' + caption + '\n\n' +
      'Scheduled for: ' + scheduleStr + '\n\n' +
      'Next steps:\n' +
      '  1. Open the sheet (link below)\n' +
      '  2. Review / edit the PCaption in row ' + rowIndex + ' (column E)\n' +
      '  3. Change the Status (column G) to "Approved" to queue the post\n' +
      '     — or to "Error" to discard it\n\n' +
      sheetUrl;

    MailApp.sendEmail(toEmail, subject, body);
    appendLog(sheet, rowIndex, 'Draft notification sent to ' + toEmail + '.');
  } catch (e) {
    appendLog(sheet, rowIndex, 'Warning: could not send draft notification: ' + e.message);
  }
}
