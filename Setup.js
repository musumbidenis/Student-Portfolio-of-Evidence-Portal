/**
 * Setup.gs — one-time, idempotent initialisation of the Evidence Submission System.
 *
 * Run setupSystem() once from the Apps Script editor after creating the project.
 * Running it again is harmless: it only creates what is missing.
 */

function setupSystem() {
  const props = PropertiesService.getScriptProperties();

  // 1. Resolve or create the admin data spreadsheet.
  let ss;
  const existingId = props.getProperty(EV.PROP_SPREADSHEET_ID);
  if (existingId) {
    ss = SpreadsheetApp.openById(existingId);
  } else if (SpreadsheetApp.getActiveSpreadsheet()) {
    ss = SpreadsheetApp.getActiveSpreadsheet();
    props.setProperty(EV.PROP_SPREADSHEET_ID, ss.getId());
  } else {
    ss = SpreadsheetApp.create('Evidence Submission System — Data');
    props.setProperty(EV.PROP_SPREADSHEET_ID, ss.getId());
  }

  // 2. Create every sheet tab with its header row.
  Object.keys(EV_HEADERS).forEach(function (sheetName) {
    ensureSheetWithHeaders_(ss, sheetName, EV_HEADERS[sheetName]);
  });

  // 3. Remove the default "Sheet1" if it exists.
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  // 4. Create the Drive root folder.
  if (!props.getProperty(EV.PROP_ROOT_FOLDER_ID)) {
    const folder = DriveApp.createFolder(EV.ROOT_FOLDER_NAME);
    props.setProperty(EV.PROP_ROOT_FOLDER_ID, folder.getId());
    Logger.log('Drive root folder created: ' + folder.getId());
  }

  // 5. Create the tracker spreadsheet (separate from admin data).
  //    Tabs are created per programme on a student's first submission.
  if (!props.getProperty(EV.PROP_TRACKER_SHEET_ID)) {
    const tracker = SpreadsheetApp.create('Evidence — Student Folder Tracker');
    // Rename the default sheet to _index so programme tabs are named properly.
    tracker.getSheets()[0].setName('_index');
    props.setProperty(EV.PROP_TRACKER_SHEET_ID, tracker.getId());
    Logger.log('Tracker spreadsheet created: ' + tracker.getId() + ' url=' + tracker.getUrl());
  }

  // 6. Seed the master form ID from the config default if not already set.
  if (!props.getProperty(EV.PROP_MASTER_FORM_ID) && EV.DEFAULT_MASTER_FORM_ID) {
    props.setProperty(EV.PROP_MASTER_FORM_ID, EV.DEFAULT_MASTER_FORM_ID);
    Logger.log('Master form ID seeded: ' + EV.DEFAULT_MASTER_FORM_ID);
  }

  // 7. Seed org email domains.
  if (!props.getProperty(EV.PROP_ORG_EMAIL_DOMAINS)) {
    props.setProperty(EV.PROP_ORG_EMAIL_DOMAINS, JSON.stringify(EV.DEFAULT_ORG_EMAIL_DOMAINS));
    Logger.log('Org domains seeded: ' + JSON.stringify(EV.DEFAULT_ORG_EMAIL_DOMAINS));
  }

  Logger.log('Setup complete.');
  Logger.log('Spreadsheet ID:  ' + props.getProperty(EV.PROP_SPREADSHEET_ID));
  Logger.log('Drive root ID:   ' + props.getProperty(EV.PROP_ROOT_FOLDER_ID));
  Logger.log('Tracker sheet:   ' + props.getProperty(EV.PROP_TRACKER_SHEET_ID));
  Logger.log('Org domains:     ' + props.getProperty(EV.PROP_ORG_EMAIL_DOMAINS));
}

function ensureSheetWithHeaders_(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const isEmpty = firstRow.every(function (c) { return c === '' || c === null; });
  if (isEmpty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  sheet.setFrozenRows(1);
  return sheet;
}

/* ── Shared accessors ─────────────────────────────────────────────────────── */

function getDataSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(EV.PROP_SPREADSHEET_ID);
  if (!id) throw new Error('Run setupSystem() first — spreadsheet ID not set.');
  return SpreadsheetApp.openById(id);
}

function getRootFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty(EV.PROP_ROOT_FOLDER_ID);
  if (!id) throw new Error('Run setupSystem() first — root folder ID not set.');
  return DriveApp.getFolderById(id);
}

function getTrackerSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(EV.PROP_TRACKER_SHEET_ID);
  if (!id) throw new Error('Run setupSystem() first — tracker spreadsheet ID not set.');
  return SpreadsheetApp.openById(id);
}

function getSheet_(sheetName) {
  return getDataSpreadsheet_().getSheetByName(sheetName);
}

function getMasterFormId_() {
  var id = PropertiesService.getScriptProperties().getProperty(EV.PROP_MASTER_FORM_ID);
  if (!id) throw new Error('Master form ID not set. Run setupSystem() or setMasterFormId("FORM_ID") first.');
  return id;
}

function setMasterFormId(formId) {
  if (!formId) throw new Error('formId is required.');
  PropertiesService.getScriptProperties().setProperty(EV.PROP_MASTER_FORM_ID, String(formId).trim());
  Logger.log('Master form ID saved: ' + formId);
}
