/**
 * Installable trigger entry point — called on every Google Form submission.
 * Wire this up by running setup() in Setup.gs once.
 *
 * @param {GoogleAppsScript.Events.SheetsOnFormSubmit} e
 */
function onFormSubmitTrigger(e) {
  var sheet    = getSheet();
  var rowIndex = e.range.getRow();
  processRow(sheet, rowIndex);
}