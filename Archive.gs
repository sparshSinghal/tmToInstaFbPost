// ============================================================
// Archive.gs — Daily housekeeping
// ============================================================
// Moves rows that are in a terminal state and older than
// ARCHIVE_AFTER_DAYS to a sibling 'Archive' tab in the same
// spreadsheet, keeping the main tab small enough that the n8n
// Read Sheet step stays fast.
//
// Wired to a once-a-day trigger by setup() in Setup.gs.

var ARCHIVE_TAB_NAME    = 'Archive';
var ARCHIVE_AFTER_DAYS  = 30;

// Statuses safe to archive — these are all "no further action expected".
// Draft / Approved / Pending (IG) / Awaiting Edit / Collecting are NOT in
// this list because they may still need attention.
var ARCHIVABLE_STATUSES = [
  'Posted',
  'Posted (FB only)',
  'Failed',
  'Error',
  'Superseded'
];

/**
 * Scans the main sheet and moves any row whose status is archivable AND
 * whose effective age exceeds ARCHIVE_AFTER_DAYS to the Archive tab.
 *
 * "Effective age" means Posted_At if present, else Timestamp. This makes
 * Failed / Error rows archive based on when they entered the system,
 * not on a missing Posted_At.
 *
 * Idempotent and safe to re-run. Runs entirely server-side (no n8n call).
 */
function archiveOldPosts() {
  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var main    = getSheet();
  var lastRow = main.getLastRow();
  var lastCol = main.getLastColumn();
  if (lastRow < 2) return;

  var archive = ensureArchiveSheet(ss, main);

  // Read all data + status in one batch for speed.
  var data       = main.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var nowMs      = Date.now();
  var cutoffMs   = ARCHIVE_AFTER_DAYS * 24 * 3600 * 1000;
  var toArchive  = [];   // rows of values
  var rowsToDelete = []; // 1-based row indices

  for (var i = 0; i < data.length; i++) {
    var rowIndex = i + 2;
    var status   = (data[i][COL.STATUS - 1] || '').toString();
    if (ARCHIVABLE_STATUSES.indexOf(status) === -1) continue;

    // Use Posted_At if available, else Timestamp.
    var postedAt = data[i][COL.POSTED_AT - 1];
    var ts       = data[i][COL.TIMESTAMP - 1];
    var ageMs;
    if (postedAt) {
      ageMs = nowMs - new Date(postedAt).getTime();
    } else if (ts) {
      ageMs = nowMs - new Date(ts).getTime();
    } else {
      continue;  // no usable date — leave alone
    }
    if (ageMs < cutoffMs) continue;

    toArchive.push(data[i]);
    rowsToDelete.push(rowIndex);
  }

  if (toArchive.length === 0) {
    Logger.log('archiveOldPosts: nothing to archive.');
    return;
  }

  // Append to Archive in one batched write.
  var archStart = archive.getLastRow() + 1;
  archive.getRange(archStart, 1, toArchive.length, toArchive[0].length).setValues(toArchive);

  // Delete from main in reverse order so earlier deletes don't shift later indices.
  rowsToDelete.sort(function (a, b) { return b - a; });
  for (var j = 0; j < rowsToDelete.length; j++) {
    main.deleteRow(rowsToDelete[j]);
  }

  Logger.log('archiveOldPosts: moved ' + toArchive.length + ' row(s) to Archive.');
}

/**
 * Returns the Archive tab, creating it (with the same header row as the main
 * sheet) on first run.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {GoogleAppsScript.Spreadsheet.Sheet} mainSheet
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensureArchiveSheet(ss, mainSheet) {
  var existing = ss.getSheetByName(ARCHIVE_TAB_NAME);
  if (existing) return existing;

  var archive = ss.insertSheet(ARCHIVE_TAB_NAME);
  // Copy the header row (including bold formatting).
  var lastCol = mainSheet.getLastColumn();
  var headerRange = mainSheet.getRange(1, 1, 1, lastCol);
  archive.getRange(1, 1, 1, lastCol).setValues(headerRange.getValues());
  archive.getRange(1, 1, 1, lastCol).setFontWeight('bold');
  // Match column widths so the archive looks like the main sheet at a glance.
  for (var c = 1; c <= lastCol; c++) {
    archive.setColumnWidth(c, mainSheet.getColumnWidth(c));
  }
  archive.setFrozenRows(1);
  return archive;
}
