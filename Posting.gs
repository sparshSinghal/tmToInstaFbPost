// ============================================================
// Posting.gs — Facebook Graph API + scheduled post checker
// ============================================================
// Depends on: Config.gs (shared global scope in Apps Script)

/**
 * Posts a single sheet row to the Facebook Page.
 * Called by processRow() for immediate posts, or by
 * checkScheduledPosts() when a scheduled row becomes due.
 *
 * Two body texts are built and used depending on what's being posted:
 *   - captionMessage  = PCaption  + slogan + hashtags  → for photo posts
 *   - headlineMessage = GHeadline + slogan + hashtags  → for video posts
 *     (falls back to PCaption if GHeadline is empty)
 *
 * Routing logic:
 *   - No files          → text-only post with caption           /{page}/feed
 *   - Images only (1)   → single photo with caption             /{page}/photos
 *   - Images only (2+)  → multi-photo gallery with caption      /{page}/feed with attached_media
 *   - Video(s) only     → first video with caption              /{page}/videos  (FB has no multi-video post)
 *   - Images + videos   → photos as gallery with caption,
 *                         then each video as a separate post with headline.
 *                         IG mirrors this: photos as carousel/single with caption,
 *                         each video as a separate Reel with headline.
 *
 * Note: UrlFetchApp has a ~50 MB payload cap. Videos larger than that will fail;
 * the error is logged and Status is set to Failed.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowIndex - 1-based row number
 */
function postRow(sheet, rowIndex) {
  var pCaption     = sheet.getRange(rowIndex, COL.PCAPTION).getValue().toString().trim();
  var gHeadline    = sheet.getRange(rowIndex, COL.GHEADLINE).getValue().toString().trim();
  var rawImageCell = sheet.getRange(rowIndex, COL.IMAGE_URL).getValue().toString().trim();

  if (!pCaption) {
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.FAILED);
    appendLog(sheet, rowIndex, 'Post skipped: PCaption is empty. Run processing first.');
    return;
  }

  // Slogan and hashtags are appended here at send time so they are
  // always present regardless of edits made during the review step.
  function buildMessage(body) {
    return (body || pCaption) +
      (POST_SLOGAN   ? '\n\n' + POST_SLOGAN   : '') +
      (POST_HASHTAGS ? '\n\n' + POST_HASHTAGS : '');
  }
  var captionMessage  = buildMessage(pCaption);    // photos use this
  var headlineMessage = buildMessage(gHeadline);   // videos use this in mixed case (falls back to pCaption if no headline)

  sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.POSTING_FB);
  SpreadsheetApp.flush();

  try {
    // Resolve credentials once
    var pageId = getFbPageId();
    var token  = getFbPageAccessToken();
    appendDebug(sheet, rowIndex,
      'FB entry: pageId=' + pageId + ', caption=' + captionMessage.length +
      ' chars, headline=' + headlineMessage.length + ' chars.');

    // Parse all Drive file IDs from the (possibly comma-separated) cell value
    var allFileIds   = extractAllDriveFileIds(rawImageCell);
    var imageFileIds = [];
    var videoFileIds = [];

    // Classify each file as image or video
    for (var i = 0; i < allFileIds.length; i++) {
      var fid      = allFileIds[i];
      var mimeType = '';
      var fileSize = 0;
      var driveFile;
      try {
        driveFile = DriveApp.getFileById(fid);
        mimeType  = driveFile.getMimeType();
        fileSize  = driveFile.getSize();
      } catch (e) {
        appendLog(sheet, rowIndex,
          'Warning: could not read file ' + fid + ' (' + e.message + ') — skipping.');
        continue;
      }
      if (mimeType.indexOf('video') !== -1) {
        if (fileSize >= MAX_VIDEO_BYTES) {
          var sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
          appendLog(sheet, rowIndex,
            'Skipping video file ' + fid + ': size ' + sizeMB + ' MB exceeds the ' +
            '50 MB upload limit. Upload the video directly to Facebook instead.');
        } else {
          videoFileIds.push(fid);
          appendDebug(sheet, rowIndex,
            'FB classified file ' + fid + ' as video (mime=' + mimeType +
            ', size=' + (fileSize / 1024 / 1024).toFixed(2) + ' MB).');
        }
      } else {
        imageFileIds.push(fid);
        appendDebug(sheet, rowIndex,
          'FB classified file ' + fid + ' as image (mime=' + mimeType +
          ', size=' + (fileSize / 1024).toFixed(0) + ' KB).');
      }
    }

    // Log a note if the cell had content but no Drive URLs were found
    if (rawImageCell && allFileIds.length === 0) {
      appendLog(sheet, rowIndex,
        'No Google Drive URLs found in the image field; posting as text only.');
    }

    var hasImages = imageFileIds.length > 0;
    var hasVideos = videoFileIds.length > 0;
    var fbPostId  = null;  // stamped onto col P after success

    if (!hasImages && !hasVideos) {
      // ── No usable files — text-only post with caption
      appendDebug(sheet, rowIndex, 'FB path: text-only feed post.');
      fbPostId = withRetry(function () { return postTextToFacebook(pageId, token, captionMessage); });
      appendDebug(sheet, rowIndex, 'FB text-only posted (post_id=' + fbPostId + ').');
      appendLog(sheet, rowIndex, 'Posted as text-only.');

    } else if (hasImages && !hasVideos) {
      // ── Images only — single or gallery, with caption
      if (imageFileIds.length === 1) {
        var sid = imageFileIds[0];
        appendDebug(sheet, rowIndex, 'FB path: single image (file=' + sid + ').');
        fbPostId = withRetry(function () { return uploadPhotoToFacebook(pageId, token, captionMessage, sid); });
      } else {
        var iids = imageFileIds;
        appendDebug(sheet, rowIndex,
          'FB path: multi-photo (' + iids.length + ' files=[' + iids.join(',') + ']).');
        fbPostId = withRetry(function () { return postWithMultiplePhotos(pageId, token, captionMessage, iids); });
      }
      appendDebug(sheet, rowIndex, 'FB photo post created (post_id=' + fbPostId + ').');
      appendLog(sheet, rowIndex, 'Posted ' + imageFileIds.length + ' image(s) to Facebook Page.');

    } else if (hasVideos && !hasImages) {
      // ── Videos only — post the first; log if more than one (FB has no multi-video post).
      // Wrapped in try/catch so a codec/format rejection doesn't abort the whole row —
      // IG might still accept the same video (different processing pipeline), and the
      // row falls through to status=Posted (IG only) instead of Failed.
      if (videoFileIds.length > 1) {
        appendLog(sheet, rowIndex,
          'Multiple videos detected (' + videoFileIds.length + '). ' +
          'Facebook does not support multi-video posts via this API. ' +
          'Posting the first video only.');
      }
      var vid = videoFileIds[0];
      appendDebug(sheet, rowIndex, 'FB path: single video (file=' + vid + ').');
      try {
        fbPostId = withRetry(function () {
          return postVideoToFacebook(pageId, token, captionMessage, vid);
        });
        appendDebug(sheet, rowIndex, 'FB video posted (post_id=' + fbPostId + ').');
        appendLog(sheet, rowIndex, 'Posted video to Facebook Page.');
      } catch (videoFbErr) {
        // Don't escalate to Failed — let the IG attempt run, and report the failure
        // through the FB-only log + Error_Message column.
        appendLog(sheet, rowIndex,
          'Facebook video upload failed: ' + videoFbErr.message + '. Continuing to Instagram.');
        fbPostId = null;
      }

    } else {
      // ── Mixed: images + videos
      // Step 1: photos as a gallery with the caption.
      // Step 2: each video as a separate FB Page post with the headline.
      appendLog(sheet, rowIndex,
        'Mixed files detected (' + imageFileIds.length + ' image(s), ' +
        videoFileIds.length + ' video(s)). ' +
        'Posting photos with caption, then each video as a separate post with headline.');

      if (imageFileIds.length === 1) {
        var msid = imageFileIds[0];
        appendDebug(sheet, rowIndex, 'FB mixed path: single image (file=' + msid + ').');
        fbPostId = withRetry(function () { return uploadPhotoToFacebook(pageId, token, captionMessage, msid); });
      } else {
        var miids = imageFileIds;
        appendDebug(sheet, rowIndex,
          'FB mixed path: multi-photo (' + miids.length + ' files=[' + miids.join(',') + ']).');
        fbPostId = withRetry(function () { return postWithMultiplePhotos(pageId, token, captionMessage, miids); });
      }
      appendDebug(sheet, rowIndex, 'FB mixed photo gallery posted (post_id=' + fbPostId + ').');
      appendLog(sheet, rowIndex, 'Posted ' + imageFileIds.length + ' image(s) to Facebook Page (photo gallery).');

      // Each video → its own /{page}/videos post with the headline message.
      // Logged individually; partial failures don't abort the loop.
      var fbVideoPostIds = [];
      for (var vIdx = 0; vIdx < videoFileIds.length; vIdx++) {
        (function (videoFid, oneBased) {
          appendDebug(sheet, rowIndex,
            'FB mixed video ' + oneBased + '/' + videoFileIds.length + ' (file=' + videoFid + ') uploading...');
          try {
            var vidPostId = withRetry(function () {
              return postVideoToFacebook(pageId, token, headlineMessage, videoFid);
            });
            if (vidPostId) fbVideoPostIds.push(vidPostId);
            appendDebug(sheet, rowIndex,
              'FB mixed video ' + oneBased + ' posted (post_id=' + vidPostId + ').');
            appendLog(sheet, rowIndex,
              'Posted video ' + oneBased + '/' + videoFileIds.length + ' to Facebook Page (with headline).');
          } catch (vidErr) {
            appendLog(sheet, rowIndex,
              'Failed to post video ' + oneBased + '/' + videoFileIds.length +
              ' to Facebook: ' + vidErr.message);
          }
        })(videoFileIds[vIdx], vIdx + 1);
      }
      // Append video post IDs to the column-P stamp (comma-separated). The first ID
      // (the photo gallery's) stays the "primary" post for Telegram URL display.
      if (fbVideoPostIds.length > 0) {
        fbPostId = (fbPostId ? fbPostId + ', ' : '') + fbVideoPostIds.join(', ');
      }
    }

    // ── Also post to Instagram ──────────────────────────────────────────
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.POSTING_IG);
    SpreadsheetApp.flush();

    // fbPostId is non-null when FB succeeded (photos and/or video). It's null
    // when the FB step failed gracefully (e.g. unsupported video codec) — in
    // which case we still try IG and report status accordingly.
    var fbOk = !!fbPostId;

    var igResult = postToInstagram(sheet, rowIndex, captionMessage, headlineMessage, imageFileIds, videoFileIds);
    var igPosted  = igResult && igResult.status === 'posted';
    var igPending = igResult === 'pending';
    var igOk      = igPosted || igPending;

    if (fbOk && igPosted) {
      sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.POSTED);
      stampPostSuccess(sheet, rowIndex, fbPostId, igResult.igPostId);
    } else if (fbOk && igPending) {
      // IG video container queued; trigger will publish + stamp IG_Post_ID once ready.
      sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.PENDING_IG);
      stampPostSuccess(sheet, rowIndex, fbPostId, null);
    } else if (fbOk && !igOk) {
      // 'skipped' or 'failed' — FB succeeded so mark as FB only
      sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.POSTED_FB_ONLY);
      stampPostSuccess(sheet, rowIndex, fbPostId, null);
    } else if (!fbOk && igPosted) {
      sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.POSTED_IG_ONLY);
      stampPostSuccess(sheet, rowIndex, null, igResult.igPostId);
    } else if (!fbOk && igPending) {
      // FB failed, IG queued. Treat as Pending (IG) — trigger will eventually
      // flip to Posted (IG only) when ready (or to Failed if IG ultimately
      // rejects too). User sees the FB failure note in the log.
      sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.PENDING_IG);
      stampPostSuccess(sheet, rowIndex, null, null);
    } else {
      // Neither succeeded — FB failed gracefully and IG also rejected.
      sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.FAILED);
      recordError(sheet, rowIndex, 'Both Facebook and Instagram posting failed; see prior log entries.');
    }

  } catch (e) {
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.FAILED);
    recordError(sheet, rowIndex, 'Posting failed: ' + e.message);
  }
}

// ── IG-only retry (for rows stuck at "Posted (FB only)") ──────

/**
 * Retries the Instagram half of a row that ended at "Posted (FB only)".
 * Re-runs the same IG flow as postRow without touching Facebook. Useful
 * after a transient IG failure (rate limit, brief outage, container 9007
 * race) — call this and the row gets a fresh attempt at IG without
 * re-posting to FB.
 *
 * Behaviour:
 *   - Only runs on rows currently at STATUS.POSTED_FB_ONLY. Other
 *     statuses are no-op (logged + returns false).
 *   - On success: status flips to Posted, IG_Post_ID is stamped (the
 *     existing FB_Post_ID is untouched), and Confirmation_Sent is reset
 *     so the polling flow sends a fresh "now on IG too" confirmation.
 *   - On pending: status flips to Pending (IG); the existing
 *     checkPendingIgContainers() trigger publishes when ready.
 *   - On failure / skip: status reverts to Posted (FB only), the failure
 *     is logged, and the row stays eligible for future retries.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowIndex - 1-based row number
 * @returns {boolean} true if IG path succeeded or queued; false otherwise
 */
function retryIgForRow(sheet, rowIndex) {
  var status = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
  if (status !== STATUS.POSTED_FB_ONLY) {
    appendLog(sheet, rowIndex,
      'IG retry skipped: row status is "' + status +
      '" (must be "' + STATUS.POSTED_FB_ONLY + '").');
    return false;
  }

  var pCaption     = sheet.getRange(rowIndex, COL.PCAPTION).getValue().toString().trim();
  var gHeadline    = sheet.getRange(rowIndex, COL.GHEADLINE).getValue().toString().trim();
  var rawImageCell = sheet.getRange(rowIndex, COL.IMAGE_URL).getValue().toString().trim();

  if (!pCaption) {
    appendLog(sheet, rowIndex, 'IG retry skipped: PCaption is empty.');
    return false;
  }

  // Same caption/headline construction as postRow.
  function buildMessage(body) {
    return (body || pCaption) +
      (POST_SLOGAN   ? '\n\n' + POST_SLOGAN   : '') +
      (POST_HASHTAGS ? '\n\n' + POST_HASHTAGS : '');
  }
  var captionMessage  = buildMessage(pCaption);
  var headlineMessage = buildMessage(gHeadline);

  // Same media classification as postRow.
  var allFileIds   = extractAllDriveFileIds(rawImageCell);
  var imageFileIds = [];
  var videoFileIds = [];
  for (var i = 0; i < allFileIds.length; i++) {
    var fid = allFileIds[i];
    var mimeType = '';
    var fileSize = 0;
    try {
      var driveFile = DriveApp.getFileById(fid);
      mimeType = driveFile.getMimeType();
      fileSize = driveFile.getSize();
    } catch (driveErr) {
      appendLog(sheet, rowIndex,
        'IG retry: could not read file ' + fid + ' (' + driveErr.message + ') — skipping.');
      continue;
    }
    if (mimeType.indexOf('video') !== -1) {
      if (fileSize >= MAX_VIDEO_BYTES) {
        appendLog(sheet, rowIndex,
          'IG retry: skipping oversized video ' + fid +
          ' (' + (fileSize / 1024 / 1024).toFixed(1) + ' MB > 50 MB).');
      } else {
        videoFileIds.push(fid);
      }
    } else {
      imageFileIds.push(fid);
    }
  }

  if (imageFileIds.length === 0 && videoFileIds.length === 0) {
    appendLog(sheet, rowIndex,
      'IG retry skipped: no media (text-only posts are not supported on Instagram).');
    return false;
  }

  sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.POSTING_IG);
  appendLog(sheet, rowIndex, 'Retrying Instagram post...');
  SpreadsheetApp.flush();

  var igResult;
  try {
    igResult = postToInstagram(sheet, rowIndex, captionMessage, headlineMessage, imageFileIds, videoFileIds);
  } catch (igErr) {
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.POSTED_FB_ONLY);
    appendLog(sheet, rowIndex,
      'IG retry threw: ' + igErr.message + '. Status restored to "' + STATUS.POSTED_FB_ONLY + '".');
    return false;
  }

  if (igResult && igResult.status === 'posted') {
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.POSTED);
    sheet.getRange(rowIndex, COL.IG_POST_ID).setValue(igResult.igPostId);
    // Reset confirmation flag so the polling flow sends a fresh "now on IG" message.
    if (sheet.getLastColumn() >= COL.CONFIRMATION_SENT) {
      sheet.getRange(rowIndex, COL.CONFIRMATION_SENT).setValue('FALSE');
    }
    appendLog(sheet, rowIndex, 'IG retry succeeded.');
    return true;
  }
  if (igResult === 'pending') {
    sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.PENDING_IG);
    if (sheet.getLastColumn() >= COL.CONFIRMATION_SENT) {
      sheet.getRange(rowIndex, COL.CONFIRMATION_SENT).setValue('FALSE');
    }
    appendLog(sheet, rowIndex, 'IG retry: video container queued; trigger will publish.');
    return true;
  }

  // 'failed' or 'skipped' — revert to Posted (FB only) so future retries are allowed.
  sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.POSTED_FB_ONLY);
  appendLog(sheet, rowIndex,
    'IG retry did not succeed; status restored to "' + STATUS.POSTED_FB_ONLY + '".');
  return false;
}

// Time window inside which a Posted (FB only) row is considered "transiently
// failed" and worth retrying. After this window, IG failures are presumed
// persistent (codec issue, account block, etc.) and we stop retrying so the
// trigger doesn't burn API calls forever.
//
// 6 hours × every 30 min = up to 12 retry attempts per row.
var FB_ONLY_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Scheduled trigger entry point: scans the sheet for rows at "Posted (FB only)"
 * and re-runs the Instagram path for each one that's still inside the retry
 * window. Installed by setup() as a 30-minute recurring time trigger.
 *
 * Bounding rules:
 *   - Only rows whose Posted_At is within FB_ONLY_RETRY_WINDOW_MS of now.
 *   - Rows older than that are left at Posted (FB only) permanently — the
 *     failure is presumed persistent and not worth more API calls.
 *
 * No external trigger needed (no Activepieces, no Telegram command). The
 * trigger fires every 30 minutes and the function does its own scan.
 */
function retryFbOnlyRows() {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var statuses  = sheet.getRange(2, COL.STATUS,    lastRow - 1, 1).getValues();
  var postedAts = sheet.getRange(2, COL.POSTED_AT, lastRow - 1, 1).getValues();

  var now = Date.now();
  var attempted = 0, succeeded = 0, failed = 0, skippedTooOld = 0;

  for (var i = 0; i < statuses.length; i++) {
    if (statuses[i][0] !== STATUS.POSTED_FB_ONLY) continue;

    var postedAtVal = postedAts[i][0];
    if (!postedAtVal) {
      // No Posted_At stamped — should be rare (legacy rows). Skip rather
      // than retry an unbounded number of times.
      skippedTooOld++;
      continue;
    }
    var age = now - new Date(postedAtVal).getTime();
    if (age > FB_ONLY_RETRY_WINDOW_MS) {
      skippedTooOld++;
      continue;
    }

    var rowIndex = i + 2;
    attempted++;
    var ok;
    try {
      ok = retryIgForRow(sheet, rowIndex);
    } catch (e) {
      ok = false;
      try {
        appendLog(sheet, rowIndex, 'Scheduled IG retry threw: ' + e.message);
      } catch (logErr) { /* ignore */ }
    }
    if (ok) succeeded++;
    else failed++;
  }

  Logger.log('retryFbOnlyRows: attempted ' + attempted +
    ', succeeded ' + succeeded +
    ', failed ' + failed +
    ', skipped (out of window) ' + skippedTooOld);
}

// ── Facebook Graph API helpers ────────────────────────────────

/**
 * Posts a text-only message to the Facebook Page feed.
 *
 * @param {string} pageId  - Facebook Page ID
 * @param {string} token   - Page Access Token
 * @param {string} message - Full post message
 * @throws {Error} On non-200 response from the Graph API
 */
function postTextToFacebook(pageId, token, message) {
  var url     = FB_GRAPH_BASE + '/' + pageId + '/feed';
  var options = {
    method:             'post',
    contentType:        'application/x-www-form-urlencoded',
    payload:            { message: message, access_token: token },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('FB feed post error ' + code + ': ' + body);
  }
  // Return the FB post ID so postRow() can stamp it onto the sheet.
  try {
    var json = JSON.parse(body);
    return json.id || null;
  } catch (e) {
    return null;
  }
}

/**
 * Posts a video from Google Drive to the Facebook Page.
 * Uses the /{page-id}/videos endpoint with a binary blob upload.
 *
 * Works for typical short social media clips. The hard limit is
 * Apps Script's UrlFetchApp payload cap (~50 MB). Videos larger than
 * that will throw a network error which is caught and logged by postRow.
 *
 * @param {string} pageId      - Facebook Page ID
 * @param {string} token       - Page Access Token
 * @param {string} description - Post message shown below the video
 * @param {string} fileId      - Google Drive file ID
 * @throws {Error} On Drive access failure or non-200 from Graph API
 */
function postVideoToFacebook(pageId, token, description, fileId) {
  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    throw new Error('Cannot access Drive file "' + fileId + '": ' + e.message);
  }

  // Force BOTH the blob's MIME type AND filename to video/mp4 / *.mp4.
  // FB's /videos endpoint validates uploaded videos via two signals:
  //   1. Content-Type header on the multipart binary part
  //   2. filename in the multipart Content-Disposition (extension sniff)
  // AP-uploaded files in Drive often arrive with a generic Content-Type
  // (application/octet-stream from Telegram's CDN) and a filename with no
  // extension (e.g. "tg_42_video"). With either signal off, FB returns
  // error 352 / subcode 1363024 ("unsupported video format") even when the
  // bytes are a valid H.264 MP4. setName/setContentType only change what
  // gets sent in this upload — the file in Drive is untouched.
  var blob = file.getBlob()
    .setName('video.mp4')
    .setContentType('video/mp4');
  var url     = FB_GRAPH_BASE + '/' + pageId + '/videos';
  var options = {
    method:             'post',
    payload:            { source: blob, description: description, access_token: token },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('FB video upload error ' + code + ': ' + body);
  }
  // /{page}/videos returns either {"id": video_id} or sometimes {"id":..,"post_id":..}
  try {
    var json = JSON.parse(body);
    return json.post_id || json.id || null;
  } catch (e) {
    return null;
  }
}

/**
 * Uploads a single Google Drive image to the Facebook Page as a published photo post.
 * Used when there is exactly one image. Caption becomes the post message.
 *
 * @param {string} pageId  - Facebook Page ID
 * @param {string} token   - Page Access Token
 * @param {string} caption - Photo caption / full post message
 * @param {string} fileId  - Google Drive file ID
 * @throws {Error} On Drive access failure or non-200 from Graph API
 */
function uploadPhotoToFacebook(pageId, token, caption, fileId) {
  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    throw new Error('Cannot access Drive file "' + fileId + '": ' + e.message);
  }

  var blob    = file.getBlob();
  var url     = FB_GRAPH_BASE + '/' + pageId + '/photos';
  var options = {
    method:             'post',
    payload:            { source: blob, caption: caption, access_token: token },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('FB photo upload error ' + code + ': ' + body);
  }
  // /{page}/photos returns {"id": photo_fbid, "post_id": page_post_id}
  try {
    var json = JSON.parse(body);
    return json.post_id || json.id || null;
  } catch (e) {
    return null;
  }
}

/**
 * Posts 2–10 images as a single multi-photo Facebook post.
 *
 * Facebook multi-photo flow:
 *   1. Upload each image as unpublished → GET back a photo ID per image
 *   2. POST to /{page-id}/feed with the message and all photo IDs as attached_media
 *
 * @param {string}   pageId  - Facebook Page ID
 * @param {string}   token   - Page Access Token
 * @param {string}   message - Full post message (headline + caption)
 * @param {string[]} fileIds - Array of Google Drive file IDs (2–10 items)
 * @throws {Error} On any Drive or Graph API failure
 */
function postWithMultiplePhotos(pageId, token, message, fileIds) {
  var photoIds = [];

  // Step 1: upload each image without publishing it
  for (var i = 0; i < fileIds.length; i++) {
    var photoId = uploadPhotoUnpublished(pageId, token, fileIds[i]);
    photoIds.push(photoId);
  }

  // Step 2: build attached_media array and post to the page feed
  var attachedMedia = [];
  for (var j = 0; j < photoIds.length; j++) {
    attachedMedia.push({ media_fbid: photoIds[j] });
  }

  var url     = FB_GRAPH_BASE + '/' + pageId + '/feed';
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({
      message:        message,
      attached_media: attachedMedia,
      access_token:   token
    }),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('FB multi-photo feed post error ' + code + ': ' + body);
  }
  try {
    var json = JSON.parse(body);
    return json.id || null;
  } catch (e) {
    return null;
  }
}

/**
 * Uploads a single Google Drive image to Facebook as an UNPUBLISHED photo.
 * Used as part of the multi-photo post flow — does not create a visible post.
 *
 * @param {string} pageId - Facebook Page ID
 * @param {string} token  - Page Access Token
 * @param {string} fileId - Google Drive file ID
 * @returns {string} The Facebook photo ID (media_fbid) for use in attached_media
 * @throws {Error} On Drive access failure or non-200 from Graph API
 */
function uploadPhotoUnpublished(pageId, token, fileId) {
  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    throw new Error('Cannot access Drive file "' + fileId + '": ' + e.message);
  }

  var blob    = file.getBlob();
  var url     = FB_GRAPH_BASE + '/' + pageId + '/photos';
  var options = {
    method:             'post',
    payload:            { source: blob, published: 'false', access_token: token },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error(
      'FB unpublished photo upload error ' + code + ' for file ' + fileId + ': ' + body);
  }

  var json = JSON.parse(body);
  if (!json.id) {
    throw new Error('FB unpublished photo response missing id. Response: ' + body);
  }
  return json.id;
}

/**
 * Parses the image/video cell value from the sheet and returns an array
 * of Google Drive file IDs. Handles the comma-separated multi-file format
 * that Google Forms produces when "Allow multiple files" is enabled.
 *
 * Skips tokens that are not recognisable Google Drive URLs without throwing.
 *
 * @param {string} cellValue - Raw cell value (one URL or comma-separated URLs)
 * @returns {string[]} Array of Drive file ID strings (may be empty)
 */
function extractAllDriveFileIds(cellValue) {
  if (!cellValue || cellValue.trim() === '') return [];

  // Google Forms separates multiple upload URLs with ', ' (comma + space)
  var parts   = cellValue.split(',');
  var fileIds = [];

  for (var i = 0; i < parts.length; i++) {
    var id = extractDriveFileId(parts[i].trim());
    if (id) fileIds.push(id);
  }

  return fileIds;
}

/**
 * Extracts the Google Drive file ID from a single Drive URL.
 * Handles the two common formats produced by Google Forms:
 *   - https://drive.google.com/file/d/FILE_ID/view
 *   - https://drive.google.com/open?id=FILE_ID
 *
 * @param {string} url - Single URL string
 * @returns {string|null} The file ID string, or null if not a Drive URL
 */
function extractDriveFileId(url) {
  if (!url) return null;

  // Format: /file/d/{id}/...
  var match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // Format: ?id={id} or &id={id}  (open?id= links)
  match = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  return null;
}

// ── Scheduled posts checker ───────────────────────────────────

/**
 * Scans every row for Status = "Scheduled" and posts any whose
 * schedule datetime is now or in the past.
 *
 * This function is wired to a 4-hour time-based trigger by setup().
 * It reads the status and schedule columns in a single batch call
 * for efficiency, then posts each due row sequentially.
 */
function checkScheduledPosts() {
  var sheet   = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;  // no data rows

  var dataRowCount  = lastRow - 1;  // subtract header row
  var now           = new Date();
  var statusValues  = sheet.getRange(2, COL.STATUS,   dataRowCount, 1).getValues();
  var scheduleValues = sheet.getRange(2, COL.SCHEDULE, dataRowCount, 1).getValues();

  for (var i = 0; i < dataRowCount; i++) {
    if (statusValues[i][0] !== STATUS.SCHEDULED) continue;

    var scheduleDate = scheduleValues[i][0] ? new Date(scheduleValues[i][0]) : null;
    if (scheduleDate && scheduleDate <= now) {
      var rowIndex = i + 2;  // +1 for header, +1 for 0→1-based index
      // Re-read live to guard against concurrent trigger executions
      // seeing the same snapshot and posting the same row twice.
      var liveStatus = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
      if (liveStatus !== STATUS.SCHEDULED) continue;
      appendLog(sheet, rowIndex, 'Schedule time reached. Posting now...');
      postRow(sheet, rowIndex);
    }
  }
}

// ── Approved-posts checker ────────────────────────────────────

/**
 * Scans every row for Status = "Approved" and either posts the row
 * immediately or hands it to the scheduler, depending on whether a
 * future Schedule date is set.
 *
 * This is the human-in-the-loop dispatch step:
 *   - Approved + no future schedule  → post immediately
 *   - Approved + future schedule     → set status to "Scheduled"
 *                                       (checkScheduledPosts handles the rest)
 *
 * Wired to a 4-hour time-based trigger by setup().
 * Runs alongside checkScheduledPosts() in the same trigger cycle.
 */
function checkApprovedPosts() {
  var sheet   = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;  // no data rows

  var dataRowCount   = lastRow - 1;
  var now            = new Date();
  var statusValues   = sheet.getRange(2, COL.STATUS,   dataRowCount, 1).getValues();
  var scheduleValues = sheet.getRange(2, COL.SCHEDULE, dataRowCount, 1).getValues();

  for (var i = 0; i < dataRowCount; i++) {
    if (statusValues[i][0] !== STATUS.APPROVED) continue;

    var rowIndex    = i + 2;  // +1 for header, +1 for 0→1-based index
    // Re-read live to guard against concurrent trigger executions
    // seeing the same snapshot and posting the same row twice.
    var liveStatus  = sheet.getRange(rowIndex, COL.STATUS).getValue().toString();
    if (liveStatus !== STATUS.APPROVED) continue;
    var scheduleVal = scheduleValues[i][0] ? new Date(scheduleValues[i][0]) : null;
    var isFuture    = !!(scheduleVal && scheduleVal > now);

    if (isFuture) {
      // Human approved a post with a future schedule — hand off to time-based trigger
      sheet.getRange(rowIndex, COL.STATUS).setValue(STATUS.SCHEDULED);
      appendLog(sheet, rowIndex,
        'Approved. Queued for scheduled posting at: ' +
        Utilities.formatDate(scheduleVal, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
    } else {
      // Post immediately
      appendLog(sheet, rowIndex, 'Approved. Posting now...');
      postRow(sheet, rowIndex);
    }
  }
}

// ── Instagram Graph API ───────────────────────────────────────

/**
 * Posts to the connected Instagram Business Account via the Instagram Graph API.
 *
 * Permission lifecycle (automatic — no manual Drive sharing required):
 * This function temporarily grants public read access on each Drive file so
 * Instagram's servers can fetch it by URL, then revokes that access as soon as
 * Instagram has received the media:
 *   - Images:        public → container created (IG fetches instantly) → private
 *   - Videos (sync): public → container created → poll until FINISHED → private → publish
 *   - Videos (async):public → container created → store as pending (file stays public
 *                    until checkPendingIgContainers() confirms FINISHED, then revokes)
 *
 * Returns a result consumed by postRow() to set the sheet Status column:
 *   { status: 'posted', igPostId: '...' }  — published successfully
 *   'pending' — IG video container created; 5-min trigger will finalize
 *   'skipped' — no media files (Instagram does not support text-only posts)
 *   'failed'  — API error (details in the Logs column)
 *
 * Mixed media (images + videos): photos go up as a single carousel/photo with
 * `captionMessage`, then each video goes up as a separate Reel with
 * `headlineMessage`. Single-media-type cases use `captionMessage` for everything.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number}   rowIndex        - 1-based row number (used for logging)
 * @param {string}   captionMessage  - Photo post caption (already includes slogan + hashtags)
 * @param {string}   headlineMessage - Video Reel caption used in the mixed case (already includes slogan + hashtags)
 * @param {string[]} imageFileIds    - Google Drive file IDs for images
 * @param {string[]} videoFileIds    - Google Drive file IDs for videos
 * @returns {string|object} 'posted' (with igPostId) | 'pending' | 'skipped' | 'failed'
 */
function postToInstagram(sheet, rowIndex, captionMessage, headlineMessage, imageFileIds, videoFileIds) {
  if (imageFileIds.length === 0 && videoFileIds.length === 0) {
    appendLog(sheet, rowIndex,
      'Instagram: skipped \u2014 no media (text-only posts are not supported on Instagram).');
    return 'skipped';
  }

  var igUserId  = getIgUserId();
  // IG ops (create / status read / publish) use the User Access Token, not
  // the Page Access Token — see getIgUserAccessToken() docstring for why.
  var token     = getIgUserAccessToken();
  appendDebug(sheet, rowIndex,
    'IG entry: ' + imageFileIds.length + ' image(s), ' + videoFileIds.length +
    ' video(s), igUserId=' + igUserId + '.');
  function trimIg(msg) { return (msg || '').length > 2200 ? msg.substring(0, 2197) + '...' : (msg || ''); }
  var igCaption  = trimIg(captionMessage);
  var igHeadline = trimIg(headlineMessage);

  // Mixed (images + videos): photos as carousel/single with caption, then each
  // video as a separate Reel with headline. Aggregate post IDs (photo first,
  // then videos). If any video is still IN_PROGRESS at publish time, it gets
  // queued via the existing pending-IG mechanism and the row goes Pending (IG).
  if (imageFileIds.length > 0 && videoFileIds.length > 0) {
    return postIgMixed(sheet, rowIndex, igCaption, igHeadline, imageFileIds, videoFileIds, igUserId, token);
  }

  // Images first, then videos (preserves relative order within each type)
  var allFileIds = imageFileIds.concat(videoFileIds);

  // Track files currently made public so the catch block can revoke them on any error.
  // A file is removed from this list once makeFilePrivate() is called for it,
  // or once it is handed off to the pending queue (which manages its own revocation).
  var publicFileIds = [];

  try {
    if (allFileIds.length === 1) {
      // ── Single image or video ─────────────────────────────────
      var fid   = allFileIds[0];
      var isVid = videoFileIds.indexOf(fid) !== -1;
      var cid;

      makeFilePublic(fid);
      publicFileIds.push(fid);

      if (isVid) {
        appendDebug(sheet, rowIndex,
          'IG single video: file=' + fid + ', url=' + getDrivePublicUrl(fid) + '.');
        cid = createIgVideoContainer(igUserId, token, getDrivePublicUrl(fid), igCaption);
        appendDebug(sheet, rowIndex,
          'IG single video container created (id=' + cid + '); polling for FINISHED.');
        var ready = waitForIgContainerReady(cid, token, function(msg) {
          appendDebug(sheet, rowIndex, 'IG video ' + cid + ' ' + msg);
        });
        if (!ready) {
          // Hand off to pending queue — queue owns revocation; remove from our list
          publicFileIds = publicFileIds.filter(function(id) { return id !== fid; });
          var pending = getIgPendingContainers();
          pending.push({
            rowIndex:     rowIndex,
            type:         'single_video',
            containerId:  cid,
            videoFileIds: [fid]
          });
          saveIgPendingContainers(pending);
          scheduleIgPendingTrigger();
          appendDebug(sheet, rowIndex,
            'IG single video queued (container=' + cid + ', file=' + fid +
            '); pending trigger scheduled.');
          appendLog(sheet, rowIndex,
            'Instagram: video still processing; will publish automatically once ready.');
          return 'pending';
        }
        makeFilePrivate(fid);
        publicFileIds = publicFileIds.filter(function(id) { return id !== fid; });
      } else {
        appendDebug(sheet, rowIndex,
          'IG single image: file=' + fid + ', url=' + getIgImageUrl(fid) + '.');
        cid = createIgImageContainer(igUserId, token, getIgImageUrl(fid), igCaption);
        appendDebug(sheet, rowIndex,
          'IG single image container created (id=' + cid + ').');
        makeFilePrivate(fid);  // IG fetches at container-creation time; safe to revoke now
        publicFileIds = publicFileIds.filter(function(id) { return id !== fid; });
      }

      appendDebug(sheet, rowIndex, 'IG publishing container ' + cid + '...');
      var singleIgId = publishIgContainer(igUserId, token, cid, function(msg) {
        appendDebug(sheet, rowIndex, 'IG publish ' + cid + ' ' + msg);
      });
      appendDebug(sheet, rowIndex,
        'IG published (media_id=' + singleIgId + ').');
      appendLog(sheet, rowIndex,
        'Instagram: posted ' + (isVid ? 'video (Reel)' : 'image') + '.');

      // Also post the same media as a Story (best-effort, never aborts).
      var singleStoryIds = postIgStoriesForRow(
        sheet, rowIndex, igUserId, token,
        isVid ? [] : [fid], isVid ? [fid] : []);
      var singleAllIds = [singleIgId].concat(singleStoryIds);
      return { status: 'posted', igPostId: singleAllIds.join(', ') };

    } else {
      // ── Carousel (2–10 items) ─────────────────────────────────
      var clipped = Math.min(allFileIds.length, 10);
      if (allFileIds.length > 10) {
        appendLog(sheet, rowIndex,
          'Instagram: carousel limited to 10 items; ' +
          (allFileIds.length - 10) + ' file(s) skipped.');
      }

      var childIds         = [];
      var timedOutChildIds = [];   // video child IDs still IN_PROGRESS
      var timedOutFileIds  = [];   // corresponding Drive file IDs (stay public)

      for (var i = 0; i < clipped; i++) {
        var cfid   = allFileIds[i];
        var isVidC = videoFileIds.indexOf(cfid) !== -1;
        var childId;

        makeFilePublic(cfid);
        publicFileIds.push(cfid);

        if (isVidC) {
          childId = createIgCarouselVideoItem(igUserId, token, getDrivePublicUrl(cfid));
          var childReady = waitForIgContainerReady(childId, token);
          if (childReady) {
            makeFilePrivate(cfid);
            publicFileIds = publicFileIds.filter(function(id) { return id !== cfid; });
          } else {
            // Hand off to pending queue — remove from our cleanup list
            publicFileIds = publicFileIds.filter(function(id) { return id !== cfid; });
            timedOutChildIds.push(childId);
            timedOutFileIds.push(cfid);
          }
        } else {
          childId = createIgCarouselImageItem(igUserId, token, getIgImageUrl(cfid));
          makeFilePrivate(cfid);
          publicFileIds = publicFileIds.filter(function(id) { return id !== cfid; });
        }
        childIds.push(childId);
        appendDebug(sheet, rowIndex,
          'IG carousel child ' + (i + 1) + '/' + clipped +
          ' created (id=' + childId + ', url=' + (isVidC ? getDrivePublicUrl(cfid) : getIgImageUrl(cfid)) + ').');
      }

      if (timedOutChildIds.length > 0) {
        // At least one video child still processing — queue the whole carousel
        var pendingArr = getIgPendingContainers();
        pendingArr.push({
          rowIndex:             rowIndex,
          type:                 'carousel',
          childContainerIds:    childIds,
          pendingVideoChildIds: timedOutChildIds,
          pendingVideoFileIds:  timedOutFileIds,
          caption:              igCaption
        });
        saveIgPendingContainers(pendingArr);
        scheduleIgPendingTrigger();
        appendDebug(sheet, rowIndex,
          'IG carousel queued (' + timedOutChildIds.length + ' video child(ren) still processing; ' +
          'all children=[' + childIds.join(',') + ']); pending trigger scheduled.');
        appendLog(sheet, rowIndex,
          'Instagram: carousel video(s) still processing; will publish automatically once ready.');
        return 'pending';
      }

      var parentId = createIgCarouselContainer(igUserId, token, igCaption, childIds);
      appendDebug(sheet, rowIndex,
        'IG carousel parent created (id=' + parentId +
        ', children=[' + childIds.join(',') + ']).');
      // IG carousel parents need a moment to assemble before publish — even
      // when all children are ready, the parent's own status_code starts as
      // IN_PROGRESS and must reach FINISHED before /media_publish accepts it.
      // Without this wait we hit error 9007 / subcode 2207027 ("Media is not
      // ready to be published").
      var parentReady = waitForIgContainerReady(parentId, token, function(msg) {
        appendDebug(sheet, rowIndex, 'IG parent ' + parentId + ' ' + msg);
      });
      if (!parentReady) {
        throw new Error('IG carousel parent container did not reach FINISHED within timeout.');
      }
      appendDebug(sheet, rowIndex, 'IG publishing carousel parent ' + parentId + '...');
      var carouselId = publishIgContainer(igUserId, token, parentId, function(msg) {
        appendDebug(sheet, rowIndex, 'IG publish ' + parentId + ' ' + msg);
      });
      appendDebug(sheet, rowIndex,
        'IG carousel published (media_id=' + carouselId + ', items=' + clipped + ').');
      appendLog(sheet, rowIndex,
        'Instagram: posted carousel with ' + clipped + ' item(s).');

      // Also post each carousel item as its own Story (best-effort).
      // Stories don't support carousels, so each item becomes a separate slide.
      // Pass the original arrays since both (single-type carousel paths)
      // contain only one media type.
      var carStoryIds = postIgStoriesForRow(
        sheet, rowIndex, igUserId, token, imageFileIds, videoFileIds);
      var carAllIds = [carouselId].concat(carStoryIds);
      return { status: 'posted', igPostId: carAllIds.join(', ') };
    }

  } catch (e) {
    // Revoke public access on any files that were not cleaned up before the error
    for (var k = 0; k < publicFileIds.length; k++) {
      makeFilePrivate(publicFileIds[k]);
    }
    appendLog(sheet, rowIndex, 'Instagram posting failed: ' + e.message);
    return 'failed';
  }
}

/**
 * Mixed-media Instagram posting: photos as a single image / carousel with
 * `igCaption`, then each video as a separate Reel with `igHeadline`.
 *
 * Behaviour:
 *   - Photo block runs first. If it fails, abort (do not post videos) and
 *     return 'failed'.
 *   - Each video runs in its own try/catch — a single video failure or
 *     timeout does not stop the others. Pending videos are queued via
 *     scheduleIgPendingTrigger() the same way single-video posts are.
 *   - Returns 'posted' with all IG post IDs joined comma-separated when
 *     everything completed synchronously. Returns 'pending' when at least
 *     one video is still IN_PROGRESS (the photo IDs that did publish are
 *     logged but the row's IG_Post_ID column is left for postRow to handle).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number}   rowIndex
 * @param {string}   igCaption       - Trimmed caption for the photo block
 * @param {string}   igHeadline      - Trimmed headline for each Reel
 * @param {string[]} imageFileIds
 * @param {string[]} videoFileIds
 * @param {string}   igUserId
 * @param {string}   token
 * @returns {string|object} 'posted' (with igPostId) | 'pending' | 'failed'
 */
function postIgMixed(sheet, rowIndex, igCaption, igHeadline, imageFileIds, videoFileIds, igUserId, token) {
  var publicFileIds        = [];
  var allIgPostIds         = [];
  var publishedVideoIds    = [];   // Drive file IDs of videos that successfully published — used for Stories
  var hasPending           = false;

  appendDebug(sheet, rowIndex,
    'IG mixed entry: ' + imageFileIds.length + ' image(s) + ' + videoFileIds.length + ' video(s).');

  // ── Step 1: photo block (single image OR multi-image carousel) with caption ──
  try {
    if (imageFileIds.length === 1) {
      var pfid = imageFileIds[0];
      makeFilePublic(pfid);
      publicFileIds.push(pfid);
      appendDebug(sheet, rowIndex,
        'IG mixed photo block: single image file=' + pfid + '.');
      var photoCid = createIgImageContainer(igUserId, token, getIgImageUrl(pfid), igCaption);
      appendDebug(sheet, rowIndex,
        'IG mixed single image container created (id=' + photoCid + ').');
      makeFilePrivate(pfid);
      publicFileIds = publicFileIds.filter(function (id) { return id !== pfid; });
      var singlePhotoId = publishIgContainer(igUserId, token, photoCid, function(msg) {
        appendDebug(sheet, rowIndex, 'IG publish ' + photoCid + ' ' + msg);
      });
      if (singlePhotoId) allIgPostIds.push(singlePhotoId);
      appendDebug(sheet, rowIndex,
        'IG mixed single image published (media_id=' + singlePhotoId + ').');
      appendLog(sheet, rowIndex, 'Instagram: posted single image with caption.');
    } else {
      var photoChildIds = [];
      var photoLimit    = Math.min(imageFileIds.length, 10);
      if (imageFileIds.length > 10) {
        appendLog(sheet, rowIndex,
          'Instagram: photo carousel limited to 10 items; ' +
          (imageFileIds.length - 10) + ' image(s) skipped.');
      }
      for (var i = 0; i < photoLimit; i++) {
        var ifid = imageFileIds[i];
        makeFilePublic(ifid);
        publicFileIds.push(ifid);
        var childCid = createIgCarouselImageItem(igUserId, token, getIgImageUrl(ifid));
        appendDebug(sheet, rowIndex,
          'IG mixed photo carousel child ' + (i + 1) + '/' + photoLimit +
          ' created (id=' + childCid + ', file=' + ifid + ').');
        makeFilePrivate(ifid);
        publicFileIds = publicFileIds.filter(function (id) { return id !== ifid; });
        photoChildIds.push(childCid);
      }
      var carouselParentCid = createIgCarouselContainer(igUserId, token, igCaption, photoChildIds);
      appendDebug(sheet, rowIndex,
        'IG mixed photo carousel parent created (id=' + carouselParentCid +
        ', children=[' + photoChildIds.join(',') + ']).');
      // IG carousel parents need a moment to assemble before publish — without
      // this wait, /media_publish returns error 9007 / subcode 2207027
      // ("Media is not ready to be published") even though the create call
      // succeeded.
      var photoCarouselReady = waitForIgContainerReady(carouselParentCid, token, function(msg) {
        appendDebug(sheet, rowIndex, 'IG mixed parent ' + carouselParentCid + ' ' + msg);
      });
      if (!photoCarouselReady) {
        throw new Error('IG photo carousel parent did not reach FINISHED within timeout.');
      }
      var carouselId = publishIgContainer(igUserId, token, carouselParentCid, function(msg) {
        appendDebug(sheet, rowIndex, 'IG publish ' + carouselParentCid + ' ' + msg);
      });
      if (carouselId) allIgPostIds.push(carouselId);
      appendDebug(sheet, rowIndex,
        'IG mixed photo carousel published (media_id=' + carouselId + ', items=' + photoLimit + ').');
      appendLog(sheet, rowIndex,
        'Instagram: posted ' + photoLimit + '-image carousel with caption.');
    }
  } catch (photoErr) {
    // Photo block failed — clean up and abort (do not post videos)
    for (var k = 0; k < publicFileIds.length; k++) {
      makeFilePrivate(publicFileIds[k]);
    }
    appendLog(sheet, rowIndex,
      'Instagram mixed posting failed at photo block: ' + photoErr.message);
    return 'failed';
  }

  // ── Step 2: each video as a separate Reel with headline ──
  for (var v = 0; v < videoFileIds.length; v++) {
    var vfid = videoFileIds[v];
    var oneBased = v + 1;
    try {
      makeFilePublic(vfid);
      publicFileIds.push(vfid);
      appendDebug(sheet, rowIndex,
        'IG mixed video ' + oneBased + '/' + videoFileIds.length +
        ': file=' + vfid + '.');
      var vidCid = createIgVideoContainer(igUserId, token, getDrivePublicUrl(vfid), igHeadline);
      appendDebug(sheet, rowIndex,
        'IG mixed video ' + oneBased + ' container created (id=' + vidCid + '); polling for FINISHED.');
      var vidReady = waitForIgContainerReady(vidCid, token, function(msg) {
        appendDebug(sheet, rowIndex, 'IG video ' + vidCid + ' ' + msg);
      });
      if (!vidReady) {
        // Hand off to pending queue — file stays public until the trigger picks it up
        publicFileIds = publicFileIds.filter(function (id) { return id !== vfid; });
        var pendingArr = getIgPendingContainers();
        pendingArr.push({
          rowIndex:     rowIndex,
          type:         'single_video',
          containerId:  vidCid,
          videoFileIds: [vfid]
        });
        saveIgPendingContainers(pendingArr);
        scheduleIgPendingTrigger();
        appendDebug(sheet, rowIndex,
          'IG mixed video ' + oneBased + ' queued (container=' + vidCid + ', file=' + vfid + ').');
        appendLog(sheet, rowIndex,
          'Instagram: video ' + oneBased + '/' + videoFileIds.length +
          ' still processing; will publish automatically once ready.');
        hasPending = true;
        continue;
      }
      makeFilePrivate(vfid);
      publicFileIds = publicFileIds.filter(function (id) { return id !== vfid; });
      var vidIgId = publishIgContainer(igUserId, token, vidCid, function(msg) {
        appendDebug(sheet, rowIndex, 'IG publish ' + vidCid + ' ' + msg);
      });
      if (vidIgId) allIgPostIds.push(vidIgId);
      publishedVideoIds.push(vfid);
      appendDebug(sheet, rowIndex,
        'IG mixed video ' + oneBased + ' published (media_id=' + vidIgId + ').');
      appendLog(sheet, rowIndex,
        'Instagram: posted video ' + oneBased + '/' + videoFileIds.length +
        ' as Reel (with headline).');
    } catch (vidErr) {
      // Per-video failure: log and continue. Clean up this file's public sharing
      // if it was set; other videos still get a chance.
      if (publicFileIds.indexOf(vfid) !== -1) {
        makeFilePrivate(vfid);
        publicFileIds = publicFileIds.filter(function (id) { return id !== vfid; });
      }
      appendLog(sheet, rowIndex,
        'Instagram: failed to post video ' + oneBased + '/' + videoFileIds.length +
        ': ' + vidErr.message);
    }
  }

  // Photos posted; some videos may have failed or be pending.
  if (hasPending) {
    // The pending trigger will publish remaining videos. We don't stamp
    // partial IG post IDs here — postRow leaves IG_Post_ID empty when status
    // is Pending (IG); checkPendingIgContainers() updates it when ready.
    // Stories are also skipped for the pending case to keep the trigger logic
    // simple — the user can manually share to Story from the IG app if needed.
    return 'pending';
  }

  // Photo block + every published video → also post as Stories (best-effort).
  // Photos: all of imageFileIds (photo block aborts on failure, so if we got
  //   here all photos went up). Videos: only the ones that successfully
  //   published to Reels — others (failed or skipped) don't get Stories.
  var mixedStoryIds = postIgStoriesForRow(
    sheet, rowIndex, igUserId, token, imageFileIds, publishedVideoIds);
  for (var s = 0; s < mixedStoryIds.length; s++) allIgPostIds.push(mixedStoryIds[s]);

  return { status: 'posted', igPostId: allIgPostIds.join(', ') };
}

/**
 * Returns a publicly accessible download URL for a Google Drive file.
 * The file must be shared as "Anyone with the link can view".
 *
 * @param {string} fileId - Google Drive file ID
 * @returns {string}
 */
function getDrivePublicUrl(fileId) {
  return 'https://drive.google.com/uc?export=download&id=' + fileId;
}

// ── Instagram image aspect-ratio normalization ─────────────────────────────
// IG single images and carousel items must have aspect ratio between 4:5 and
// 1.91:1; carousels additionally require every item to share the SAME ratio.
// Mixed-orientation phone photos (a portrait + a landscape) will crash a
// carousel with error 36003 / subcode 2207009 ("aspect ratio not supported").
//
// Fix: route every IG-bound image through the free wsrv.nl image proxy with
// fit=contain, which letterboxes/pillarboxes the image to a fixed canvas
// without cropping content. wsrv.nl fetches the Drive URL (already made
// public by makeFilePublic), pads with IG_PAD_BG, and serves the result
// back to IG's media-fetch step. Free, no signup, no rate-limit issues
// at our volume.
//
// Change to 1080x1350 (4:5 portrait) if all your content is vertical and
// you want the bigger canvas; 1080x1080 (1:1) is the safest universal target.
var IG_TARGET_W = 1080;
var IG_TARGET_H = 1080;
var IG_PAD_BG   = 'white';   // CSS color name or hex without '#'

/**
 * Returns a public URL that serves the Drive image padded to
 * IG_TARGET_W x IG_TARGET_H via the wsrv.nl proxy. The original Drive file is
 * untouched; the proxy generates the padded version on the fly.
 *
 * Use this for any URL passed to Instagram's image_url param. Use the raw
 * getDrivePublicUrl() for Facebook (FB has no aspect-ratio restrictions).
 *
 * @param {string} fileId - Google Drive file ID
 * @returns {string}
 */
function getIgImageUrl(fileId) {
  var src = encodeURIComponent('https://drive.google.com/uc?export=download&id=' + fileId);
  return 'https://wsrv.nl/?url=' + src +
    '&w='   + IG_TARGET_W +
    '&h='   + IG_TARGET_H +
    '&fit=contain' +
    '&cbg=' + IG_PAD_BG +
    '&output=jpg';
}

// ── Instagram Stories aspect ratio ──────────────────────────────────────────
// Stories are full-screen 9:16 vertical. Pre-pad images to 1080x1920 so they
// fill the screen instead of letterboxing top/bottom in the viewer. Videos
// are sent as-is — most phone-recorded video is already 9:16 or close.
var IG_TARGET_W_STORY = 1080;
var IG_TARGET_H_STORY = 1920;

/**
 * Returns a public URL that serves the Drive image padded to 1080x1920 via
 * wsrv.nl, suitable for Instagram Story image_url param.
 *
 * @param {string} fileId - Google Drive file ID
 * @returns {string}
 */
function getIgStoryImageUrl(fileId) {
  var src = encodeURIComponent('https://drive.google.com/uc?export=download&id=' + fileId);
  return 'https://wsrv.nl/?url=' + src +
    '&w='   + IG_TARGET_W_STORY +
    '&h='   + IG_TARGET_H_STORY +
    '&fit=contain' +
    '&cbg=' + IG_PAD_BG +
    '&output=jpg';
}

/**
 * Creates an Instagram single-image media container (not yet published).
 *
 * @param {string} igUserId  - Instagram Business Account user ID
 * @param {string} token     - Page Access Token
 * @param {string} imageUrl  - Publicly accessible image URL
 * @param {string} caption   - Post caption
 * @returns {string} Container ID
 * @throws {Error} On non-200 response from the Graph API
 */
function createIgImageContainer(igUserId, token, imageUrl, caption) {
  var url     = FB_GRAPH_BASE + '/' + igUserId + '/media';
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({
      image_url:    imageUrl,
      caption:      caption,
      access_token: token
    }),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('IG image container error ' + code + ': ' + body);
  }
  var json = JSON.parse(body);
  if (!json.id) throw new Error('IG image container response missing id: ' + body);
  return json.id;
}

/**
 * Creates an Instagram single-video (Reel) media container (not yet published).
 * Instagram processes video asynchronously; call waitForIgContainerReady()
 * before publishing.
 *
 * @param {string} igUserId  - Instagram Business Account user ID
 * @param {string} token     - Page Access Token
 * @param {string} videoUrl  - Publicly accessible video URL
 * @param {string} caption   - Post caption
 * @returns {string} Container ID
 * @throws {Error} On non-200 response from the Graph API
 */
function createIgVideoContainer(igUserId, token, videoUrl, caption) {
  var url     = FB_GRAPH_BASE + '/' + igUserId + '/media';
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({
      media_type:   'REELS',
      video_url:    videoUrl,
      caption:      caption,
      access_token: token
    }),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('IG video container error ' + code + ': ' + body);
  }
  var json = JSON.parse(body);
  if (!json.id) throw new Error('IG video container response missing id: ' + body);
  return json.id;
}

/**
 * Creates an Instagram carousel image child container (not published).
 *
 * @param {string} igUserId  - Instagram Business Account user ID
 * @param {string} token     - Page Access Token
 * @param {string} imageUrl  - Publicly accessible image URL
 * @returns {string} Child container ID
 * @throws {Error} On non-200 response from the Graph API
 */
function createIgCarouselImageItem(igUserId, token, imageUrl) {
  var url     = FB_GRAPH_BASE + '/' + igUserId + '/media';
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({
      image_url:        imageUrl,
      is_carousel_item: true,
      access_token:     token
    }),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('IG carousel image item error ' + code + ': ' + body);
  }
  var json = JSON.parse(body);
  if (!json.id) throw new Error('IG carousel image item response missing id: ' + body);
  return json.id;
}

/**
 * Creates an Instagram carousel video child container (not published).
 * Video is processed asynchronously; call waitForIgContainerReady() before
 * adding this child to the carousel container.
 *
 * @param {string} igUserId  - Instagram Business Account user ID
 * @param {string} token     - Page Access Token
 * @param {string} videoUrl  - Publicly accessible video URL
 * @returns {string} Child container ID
 * @throws {Error} On non-200 response from the Graph API
 */
function createIgCarouselVideoItem(igUserId, token, videoUrl) {
  var url     = FB_GRAPH_BASE + '/' + igUserId + '/media';
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({
      video_url:        videoUrl,
      media_type:       'VIDEO',
      is_carousel_item: true,
      access_token:     token
    }),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('IG carousel video item error ' + code + ': ' + body);
  }
  var json = JSON.parse(body);
  if (!json.id) throw new Error('IG carousel video item response missing id: ' + body);
  return json.id;
}

/**
 * Creates an Instagram carousel container from pre-built child container IDs.
 *
 * @param {string}   igUserId - Instagram Business Account user ID
 * @param {string}   token    - Page Access Token
 * @param {string}   caption  - Carousel caption
 * @param {string[]} childIds - Array of child container IDs (2–10)
 * @returns {string} Carousel container ID
 * @throws {Error} On non-200 response from the Graph API
 */
function createIgCarouselContainer(igUserId, token, caption, childIds) {
  var url     = FB_GRAPH_BASE + '/' + igUserId + '/media';
  // NOTE: `children` MUST be a JSON array when contentType is application/json.
  // Passing it as a comma-joined string (e.g. childIds.join(',')) makes the
  // Graph API return 200 with an id, but the resulting parent container is
  // degenerate — any subsequent GET /{id} returns
  //   {"error":{"code":100,"type":"GraphMethodException","error_subcode":33}}
  // i.e. "object does not exist or you don't have permission". The
  // comma-string form is only valid for form-urlencoded requests.
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({
      media_type:   'CAROUSEL',
      children:     childIds,
      caption:      caption,
      access_token: token
    }),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('IG carousel container error ' + code + ': ' + body);
  }
  var json = JSON.parse(body);
  if (!json.id) throw new Error('IG carousel container response missing id: ' + body);
  return json.id;
}

// ── Instagram Stories container helpers ─────────────────────────────────────
// Stories use the same /media + /media_publish endpoints as feed posts, with
// `media_type: STORIES`. They don't render captions visibly in the IG app, so
// we omit the caption parameter. Each Story is one media item — Stories don't
// support carousels.

/**
 * Creates an Instagram Story image container (not yet published).
 *
 * @param {string} igUserId  - Instagram Business Account user ID
 * @param {string} token     - Page Access Token
 * @param {string} imageUrl  - Publicly accessible image URL (preferably 1080x1920 — see getIgStoryImageUrl)
 * @returns {string} Container ID
 * @throws {Error} On non-200 response from the Graph API
 */
function createIgStoryImageContainer(igUserId, token, imageUrl) {
  var url     = FB_GRAPH_BASE + '/' + igUserId + '/media';
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({
      media_type:   'STORIES',
      image_url:    imageUrl,
      access_token: token
    }),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('IG Story image container error ' + code + ': ' + body);
  }
  var json = JSON.parse(body);
  if (!json.id) throw new Error('IG Story image container response missing id: ' + body);
  return json.id;
}

/**
 * Creates an Instagram Story video container (not yet published). IG processes
 * video Stories asynchronously — call waitForIgContainerReady() before publishing.
 *
 * @param {string} igUserId  - Instagram Business Account user ID
 * @param {string} token     - Page Access Token
 * @param {string} videoUrl  - Publicly accessible video URL
 * @returns {string} Container ID
 * @throws {Error} On non-200 response from the Graph API
 */
function createIgStoryVideoContainer(igUserId, token, videoUrl) {
  var url     = FB_GRAPH_BASE + '/' + igUserId + '/media';
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({
      media_type:   'STORIES',
      video_url:    videoUrl,
      access_token: token
    }),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('IG Story video container error ' + code + ': ' + body);
  }
  var json = JSON.parse(body);
  if (!json.id) throw new Error('IG Story video container response missing id: ' + body);
  return json.id;
}

/**
 * Posts a single media file as an Instagram Story.
 *
 * Best-effort: per-item failures are logged but never thrown. Stories are
 * additive content (the main feed post is what counts). On video timeout
 * (still IN_PROGRESS after waitForIgContainerReady), the Story is silently
 * skipped — Stories are not added to the pending-IG queue.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number}  rowIndex
 * @param {string}  igUserId
 * @param {string}  token
 * @param {string}  fileId  - Google Drive file ID
 * @param {boolean} isVideo - true = video Story, false = image Story
 * @returns {string|null} Story ID on success, null on failure or skip
 */
function postIgStorySingle(sheet, rowIndex, igUserId, token, fileId, isVideo) {
  try {
    appendDebug(sheet, rowIndex,
      'IG Story: file=' + fileId + ', type=' + (isVideo ? 'video' : 'image') + '.');
    var cid;
    if (isVideo) {
      cid = createIgStoryVideoContainer(igUserId, token, getDrivePublicUrl(fileId));
    } else {
      cid = createIgStoryImageContainer(igUserId, token, getIgStoryImageUrl(fileId));
    }
    appendDebug(sheet, rowIndex,
      'IG Story container created (id=' + cid + '); polling for FINISHED.');
    // Wait for the Story container's status_code to reach FINISHED before
    // publish — IG's Stories endpoint can leave even image containers in
    // IN_PROGRESS for a few seconds under load. Without this gate we hit:
    //   - 9007 / 2207027 ("Media not ready to be published"), or
    //   - 24 / 2207006 ("Media not found") if the container was lost in the race.
    // Both are caught early by the status poll. Same pattern as carousel
    // parents and video Reels.
    var ready = waitForIgContainerReady(cid, token, function(msg) {
      appendDebug(sheet, rowIndex, 'IG Story ' + cid + ' ' + msg);
    });
    if (!ready) {
      appendLog(sheet, rowIndex,
        'Instagram Story (' + (isVideo ? 'video' : 'image') + ' ' + fileId +
        '): container did not reach FINISHED within timeout — Story skipped.');
      return null;
    }
    var storyId = publishIgContainer(igUserId, token, cid, function(msg) {
      appendDebug(sheet, rowIndex, 'IG Story publish ' + cid + ' ' + msg);
    });
    appendDebug(sheet, rowIndex, 'IG Story published (media_id=' + storyId + ').');
    appendLog(sheet, rowIndex,
      'Instagram Story posted (' + (isVideo ? 'video' : 'image') + ': ' + fileId + ').');
    return storyId;
  } catch (e) {
    appendLog(sheet, rowIndex,
      'Instagram Story failed for file ' + fileId + ' (' + (isVideo ? 'video' : 'image') + '): ' + e.message);
    return null;
  }
}

/**
 * Posts every supplied photo and video as its own Instagram Story.
 * Stories don't support carousels, so each item becomes a separate slide
 * in the user's Story queue. Returns the array of successfully-published
 * Story IDs (in image-then-video order, with skips/failures dropped).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number}   rowIndex
 * @param {string}   igUserId
 * @param {string}   token
 * @param {string[]} imageFileIds - Photos to post as Stories
 * @param {string[]} videoFileIds - Videos to post as Stories
 * @returns {string[]} Story IDs (may be empty if everything failed/skipped)
 */
function postIgStoriesForRow(sheet, rowIndex, igUserId, token, imageFileIds, videoFileIds) {
  var storyIds = [];
  for (var i = 0; i < imageFileIds.length; i++) {
    var iSid = postIgStorySingle(sheet, rowIndex, igUserId, token, imageFileIds[i], false);
    if (iSid) storyIds.push(iSid);
  }
  for (var v = 0; v < videoFileIds.length; v++) {
    var vSid = postIgStorySingle(sheet, rowIndex, igUserId, token, videoFileIds[v], true);
    if (vSid) storyIds.push(vSid);
  }
  if (storyIds.length > 0) {
    appendLog(sheet, rowIndex,
      'Instagram Stories: ' + storyIds.length + ' posted (' +
      (imageFileIds.length + videoFileIds.length - storyIds.length) + ' failed/skipped).');
  }
  return storyIds;
}

/**
 * Publishes a ready Instagram media container.
 *
 * @param {string} igUserId     - Instagram Business Account user ID
 * @param {string} token        - Page Access Token
 * @param {string} containerId  - Container ID to publish
 * @param {Function} [logFn]    - optional callback(msg) for per-attempt debug logs;
 *                                 see appendDebug() for the standard call shape.
 * @throws {Error} On non-200 response from the Graph API
 */
function publishIgContainer(igUserId, token, containerId, logFn) {
  var url     = FB_GRAPH_BASE + '/' + igUserId + '/media_publish';
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify({
      creation_id:  containerId,
      access_token: token
    }),
    muteHttpExceptions: true
  };

  // Meta returns error 9007 / subcode 2207027 ("Media is not ready to be
  // published") for a brief window after container creation, even on
  // single-image containers where the container is assumed to be ready
  // instantly (and even when status_code already reads FINISHED — the
  // status endpoint and the publish endpoint are eventually consistent).
  // Retry every 5s for up to 60s, matching waitForIgContainerReady's
  // polling window. Any non-2207027 error is fatal and bubbles up
  // immediately so we don't mask real auth or validation failures.
  var maxAttempts = 12;
  var delayMs     = 5000;
  var lastCode    = 0;
  var lastBody    = '';

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var response = UrlFetchApp.fetch(url, options);
    lastCode = response.getResponseCode();
    lastBody = response.getContentText();

    if (lastCode === 200) {
      if (logFn) logFn('attempt ' + (attempt + 1) + '/' + maxAttempts + ' → published');
      try {
        var json = JSON.parse(lastBody);
        return json.id || null;
      } catch (e) {
        return null;
      }
    }

    // Not 200. Bail immediately unless the failure is the "media not ready"
    // race, which we treat as transient.
    if (lastBody.indexOf('"error_subcode":2207027') === -1) {
      throw new Error('IG media_publish error ' + lastCode + ': ' + lastBody);
    }

    if (logFn) logFn('attempt ' + (attempt + 1) + '/' + maxAttempts +
                     ' → 9007/2207027 (not ready, will retry)');
    if (attempt < maxAttempts - 1) Utilities.sleep(delayMs);
  }

  // Every attempt returned 2207027 — Meta still wasn't ready after the full
  // window. Surface the last response body so the audit log is actionable.
  throw new Error('IG media_publish error ' + lastCode +
                  ' (container ' + containerId + ' still not ready after ' +
                  Math.floor(maxAttempts * delayMs / 1000) + 's): ' + lastBody);
}

/**
 * Polls the Instagram container's status_code until FINISHED or timeout.
 * Returns true when the container is ready to publish, false if polling timed out
 * (caller should queue the container for checkPendingIgContainers()).
 * Throws on ERROR or EXPIRED (unrecoverable IG-side failure).
 *
 * Polls every 5 seconds for up to 12 attempts (60 seconds maximum).
 *
 * @param {string} containerId - Instagram media container ID
 * @param {string} token       - Page Access Token
 * @param {Function} [logFn]   - optional callback(msg) for per-attempt debug logs
 * @returns {boolean} true = FINISHED; false = timed out (still IN_PROGRESS)
 * @throws {Error} If IG reports ERROR or EXPIRED
 */
function waitForIgContainerReady(containerId, token, logFn) {
  var maxAttempts = 12;   // 12 × 5 s = 60 s max synchronous wait
  var delayMs     = 5000;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      var statusCode = getIgContainerStatus(containerId, token);
      if (logFn) logFn('attempt ' + (attempt + 1) + '/' + maxAttempts +
                       ' → status_code=' + statusCode);
      if (statusCode === 'FINISHED') return true;
      if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
        throw new Error('IG container processing failed with status: ' + statusCode);
      }
      // IN_PROGRESS (or any other non-terminal state) — fall through to sleep.
    } catch (e) {
      // Newly-minted IG containers can briefly return error code 100 /
      // subcode 33 ("Authorization Error", message implies "object does not
      // exist or you don't have permission") before they propagate across
      // Meta's read replicas. Manual GETs of the same ID from a browser a
      // few seconds later succeed and return FINISHED. Treat this specific
      // error as transient — keep polling for the same 60-second window we
      // already allow for IN_PROGRESS. Anything else (real auth failure,
      // network error, ERROR/EXPIRED rethrows from above) bubbles up.
      if (e.message.indexOf('"error_subcode":33') === -1) {
        throw e;
      }
      if (logFn) logFn('attempt ' + (attempt + 1) + '/' + maxAttempts +
                       ' → subcode 33 (treating as transient)');
    }
    Utilities.sleep(delayMs);
  }
  return false;  // timed out — caller queues for the checkPendingIgContainers trigger
}

/**
 * Fetches the current status_code of an Instagram media container (single poll, no wait).
 *
 * @param {string} containerId - Instagram media container ID
 * @param {string} token       - Page Access Token
 * @returns {string} 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED'
 * @throws {Error} On non-200 response from the Graph API
 */
function getIgContainerStatus(containerId, token) {
  var url      = FB_GRAPH_BASE + '/' + containerId +
                 '?fields=status_code&access_token=' + encodeURIComponent(token);
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code     = response.getResponseCode();
  var body     = response.getContentText();

  if (code !== 200) {
    throw new Error('IG container status check error ' + code +
                    ' for container ' + containerId + ': ' + body);
  }
  return JSON.parse(body).status_code;
}

// ── Instagram pending video container trigger ─────────────────────────────────

/**
 * Processes all queued Instagram containers stored in Script Properties.
 * Invoked by a one-time trigger created on demand by scheduleIgPendingTrigger().
 *
 * For each pending item it:
 *   single_video — polls status → if FINISHED: revokes Drive access → publishes → updates status
 *   carousel     — polls each pending video child → when all ready: revokes Drive access →
 *                   creates carousel parent → publishes → updates status
 *
 * Failure handling:
 *   ERROR / EXPIRED → revokes Drive access immediately, sets status to Posted (FB only), logs error.
 *   IN_PROGRESS     → keeps item in queue; a new one-time trigger is rescheduled.
 *   API error       → keeps item in queue (will retry); logs warning.
 *
 * Drive files are never left permanently public — access is revoked as soon as
 * Instagram confirms it has finished processing each file.
 */
function checkPendingIgContainers() {
  // Delete the one-time trigger that fired this run before doing any work.
  // If items are still pending at the end, a fresh one-time trigger is created.
  deleteIgPendingTrigger();

  var pending = getIgPendingContainers();
  if (pending.length === 0) return;

  // IG ops use the User Access Token — see getIgUserAccessToken() docstring.
  var token     = getIgUserAccessToken();
  var igUserId  = getIgUserId();
  var sheet     = getSheet();
  var remaining = [];

  for (var i = 0; i < pending.length; i++) {
    var item = pending[i];
    appendDebug(sheet, item.rowIndex,
      'IG pending trigger: processing ' + item.type + ' (item ' + (i + 1) + '/' + pending.length + ').');
    try {
      if (item.type === 'single_video') {
        var sc = getIgContainerStatus(item.containerId, token);
        appendDebug(sheet, item.rowIndex,
          'IG pending single_video status: container=' + item.containerId + ', status_code=' + sc + '.');

        if (sc === 'FINISHED') {
          makeFilePrivate(item.videoFileIds[0]);
          var singleId = publishIgContainer(igUserId, token, item.containerId, function(msg) {
            appendDebug(sheet, item.rowIndex, 'IG pending publish ' + item.containerId + ' ' + msg);
          });
          appendDebug(sheet, item.rowIndex,
            'IG pending single_video published (media_id=' + singleId + ').');
          sheet.getRange(item.rowIndex, COL.STATUS).setValue(STATUS.POSTED);
          // FB ID was already stamped at original postRow time; only update IG fields here.
          stampPostSuccess(sheet, item.rowIndex, null, singleId);
          appendLog(sheet, item.rowIndex, 'Instagram: video published successfully.');

        } else if (sc === 'ERROR' || sc === 'EXPIRED') {
          makeFilePrivate(item.videoFileIds[0]);
          sheet.getRange(item.rowIndex, COL.STATUS).setValue(STATUS.POSTED_FB_ONLY);
          appendLog(sheet, item.rowIndex,
            'Instagram: video container failed with status: ' + sc + '.');

        } else {
          remaining.push(item);  // still IN_PROGRESS — check next cycle
        }

      } else if (item.type === 'carousel') {
        var stillWaitingChildIds = [];
        var stillWaitingFileIds  = [];
        var anyFailed            = false;

        for (var v = 0; v < item.pendingVideoChildIds.length; v++) {
          var csc = getIgContainerStatus(item.pendingVideoChildIds[v], token);
          appendDebug(sheet, item.rowIndex,
            'IG pending carousel child ' + (v + 1) + '/' + item.pendingVideoChildIds.length +
            ' (container=' + item.pendingVideoChildIds[v] + ') status_code=' + csc + '.');

          if (csc === 'FINISHED') {
            makeFilePrivate(item.pendingVideoFileIds[v]);

          } else if (csc === 'ERROR' || csc === 'EXPIRED') {
            makeFilePrivate(item.pendingVideoFileIds[v]);
            anyFailed = true;
            appendLog(sheet, item.rowIndex,
              'Instagram: carousel video child failed with status: ' + csc +
              '. Cancelling carousel.');

          } else {
            stillWaitingChildIds.push(item.pendingVideoChildIds[v]);
            stillWaitingFileIds.push(item.pendingVideoFileIds[v]);
          }
        }

        if (anyFailed) {
          // Revoke access on any remaining pending files and abandon the carousel
          for (var r = 0; r < stillWaitingFileIds.length; r++) {
            makeFilePrivate(stillWaitingFileIds[r]);
          }
          sheet.getRange(item.rowIndex, COL.STATUS).setValue(STATUS.POSTED_FB_ONLY);

        } else if (stillWaitingChildIds.length > 0) {
          // Update pending record — only keep the still-waiting children
          item.pendingVideoChildIds = stillWaitingChildIds;
          item.pendingVideoFileIds  = stillWaitingFileIds;
          remaining.push(item);

        } else {
          // All children are FINISHED — create and publish the carousel.
          // The parent container itself needs a beat to reach FINISHED before
          // publish (error 9007 / subcode 2207027 otherwise).
          var pCarouselId = createIgCarouselContainer(
            igUserId, token, item.caption, item.childContainerIds);
          appendDebug(sheet, item.rowIndex,
            'IG pending carousel parent created (id=' + pCarouselId + ').');
          var pCarouselReady = waitForIgContainerReady(pCarouselId, token, function(msg) {
            appendDebug(sheet, item.rowIndex, 'IG pending parent ' + pCarouselId + ' ' + msg);
          });
          if (!pCarouselReady) {
            // Parent didn't finalize in 60s — leave the queue entry for the
            // next trigger pass to retry. (Children are already FINISHED, so
            // the next pass will re-create the parent and try again.)
            remaining.push(item);
            appendLog(sheet, item.rowIndex,
              'Instagram: carousel parent still IN_PROGRESS; will retry on next trigger.');
          } else {
            var carPubId = publishIgContainer(igUserId, token, pCarouselId, function(msg) {
              appendDebug(sheet, item.rowIndex, 'IG pending publish ' + pCarouselId + ' ' + msg);
            });
            appendDebug(sheet, item.rowIndex,
              'IG pending carousel published (media_id=' + carPubId + ').');
            sheet.getRange(item.rowIndex, COL.STATUS).setValue(STATUS.POSTED);
            stampPostSuccess(sheet, item.rowIndex, null, carPubId);
            appendLog(sheet, item.rowIndex,
              'Instagram: carousel published with ' +
              item.childContainerIds.length + ' item(s).');
          }
        }
      }

    } catch (e) {
      appendLog(sheet, item.rowIndex,
        'Instagram pending check error: ' + e.message + '. Will retry next cycle.');
      remaining.push(item);
    }
  }

  saveIgPendingContainers(remaining);

  // If any items are still waiting, schedule another one-time check in 15 minutes.
  if (remaining.length > 0) {
    scheduleIgPendingTrigger();
  }
}