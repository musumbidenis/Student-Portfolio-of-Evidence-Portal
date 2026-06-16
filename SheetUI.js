/**
 * SheetUI.gs — formats the admin data spreadsheet and builds helper dropdowns.
 *
 * setupSheetDropdowns():
 *   1. Table formatting (frozen bold header, banded rows, filter).
 *   2. Dropdowns: FK columns → valid IDs from referenced tab.
 *   3. A Lookups tab: pick a name, the matching ID appears beside it.
 */

function setupSheetDropdowns() {
  var ss = getSheet_(EV.SHEETS.PROGRAMMES).getParent();
  applyTableFormatting_(ss);
  applyValidations_(ss);
  buildLookupsSheet_(ss);
  return { ok: true };
}

function applyTableFormatting_(ss) {
  Object.keys(EV_HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    var lastCol = EV_HEADERS[name].length;
    try {
      sheet.setFrozenRows(1);
      sheet.getBandings().forEach(function (b) { try { b.remove(); } catch (e) {} });
      var maxRows = Math.max(sheet.getMaxRows(), 2);
      sheet.getRange(1, 1, maxRows, lastCol)
           .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
      sheet.getRange(1, 1, 1, lastCol)
           .setFontWeight('bold').setBackground('#0f5c52').setFontColor('#ffffff');
      var f = sheet.getFilter();
      if (f) f.remove();
      sheet.getRange(1, 1, maxRows, lastCol).createFilter();
    } catch (e) {
      Logger.log('Formatting skipped for ' + name + ': ' + e.message);
    }
  });
}

function applyValidations_(ss) {
  setRefValidation_(ss, 'Classes',  'programme_id', 'Programmes');
  setRefValidation_(ss, 'Units',    'programme_id', 'Programmes');
  setRefValidation_(ss, 'Students', 'programme_id', 'Programmes');
  setRefValidation_(ss, 'Students', 'class_id',     'Classes');
}

function setListValidation_(ss, sheetName, colName, list) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  var col = colIndex_(sheetName, colName);
  if (!col) return;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(list, true).setAllowInvalid(false).build();
  sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

function setRefValidation_(ss, sheetName, colName, refSheetName) {
  var sheet = ss.getSheetByName(sheetName);
  var refSheet = ss.getSheetByName(refSheetName);
  if (!sheet || !refSheet) return;
  var col = colIndex_(sheetName, colName);
  if (!col) return;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(refSheet.getRange('A2:A'), true).setAllowInvalid(false).build();
  sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

function colIndex_(sheetName, colName) {
  var headers = EV_HEADERS[sheetName] || [];
  var i = headers.indexOf(colName);
  return i < 0 ? 0 : i + 1;
}

function colLetter_(n) {
  var s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

function buildLookupsSheet_(ss) {
  var name = 'Lookups';
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  sheet.getRange('A1').setValue('ID LOOKUP — pick a name, copy the ID')
       .setFontWeight('bold').setFontSize(12);
  sheet.getRange('A2').setValue('Use these to find the ID to paste into other tabs.')
       .setFontColor('#726c61');

  [
    { row: 4,  sheetName: 'Programmes', idField: 'programme_id', nameField: 'programme_name', nameLabel: 'Programme name', idLabel: 'Programme ID' },
    { row: 8,  sheetName: 'Classes',    idField: 'class_id',     nameField: 'class_name',     nameLabel: 'Class name',     idLabel: 'Class ID'     },
    { row: 12, sheetName: 'Units',      idField: 'unit_id',      nameField: 'unit_name',      nameLabel: 'Unit name',      idLabel: 'Unit ID'      }
  ].forEach(function (b) {
    var headers = EV_HEADERS[b.sheetName];
    var idCol   = colLetter_(headers.indexOf(b.idField)   + 1);
    var nameCol = colLetter_(headers.indexOf(b.nameField) + 1);
    var pickRow = b.row + 1;
    var formula = '=IFERROR(INDEX(' + b.sheetName + '!' + idCol + ':' + idCol +
                  ',MATCH(A' + pickRow + ',' + b.sheetName + '!' + nameCol + ':' + nameCol + ',0)),"")';
    lookupBlock_(sheet, b.row, b.nameLabel, b.idLabel, formula, b.sheetName, nameCol + '2:' + nameCol);
  });

  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 240);
}

function lookupBlock_(sheet, row, labelA, labelB, formula, refSheet, refRange) {
  sheet.getRange(row, 1).setValue(labelA).setFontWeight('bold').setBackground('#f0ede6');
  sheet.getRange(row, 2).setValue(labelB).setFontWeight('bold').setBackground('#f0ede6');
  var ss = sheet.getParent();
  var ref = ss.getSheetByName(refSheet);
  if (ref) {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(ref.getRange(refRange), true).setAllowInvalid(true).build();
    sheet.getRange(row + 1, 1).setDataValidation(rule);
  }
  sheet.getRange(row + 1, 2).setFormula(formula);
}
