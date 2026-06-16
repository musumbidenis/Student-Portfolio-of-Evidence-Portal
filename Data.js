/**
 * Data.gs — generic spreadsheet data-access layer.
 *
 * Reads and writes by column NAME, never by raw index. Each returned row
 * object carries a hidden __row property (1-based sheet row number) used
 * for in-place updates.
 *
 * Results are cached for TABLE_CACHE_TTL_ seconds. Any write invalidates
 * the cache so the next read fetches live data.
 */

var TABLE_CACHE_TTL_ = 60;

function readTable_(sheetName) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'EV_TABLE_' + sheetName;
  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      var parsed = JSON.parse(cached);
      return { sheet: getSheet_(sheetName), headers: parsed.headers, rows: parsed.rows };
    } catch (e) {}
  }

  var sheet = getSheet_(sheetName);
  var values = sheet.getDataRange().getValues();
  var headers = values.shift() || [];
  var rows = values.map(function (r, i) {
    var obj = {};
    headers.forEach(function (h, c) { obj[h] = r[c]; });
    obj.__row = i + 2;
    return obj;
  });

  try {
    cache.put(cacheKey, JSON.stringify({ headers: headers, rows: rows }), TABLE_CACHE_TTL_);
  } catch (e) {}

  return { sheet: sheet, headers: headers, rows: rows };
}

function invalidateTableCache_(sheetName) {
  try { CacheService.getScriptCache().remove('EV_TABLE_' + sheetName); } catch (e) {}
}

function findRow_(sheetName, predicate) {
  var rows = readTable_(sheetName).rows;
  for (var i = 0; i < rows.length; i++) {
    if (predicate(rows[i])) return rows[i];
  }
  return null;
}

function findRows_(sheetName, predicate) {
  return readTable_(sheetName).rows.filter(predicate);
}

function appendObject_(sheetName, obj) {
  var sheet = getSheet_(sheetName);
  var headers = EV_HEADERS[sheetName];
  var row = headers.map(function (h) {
    return obj[h] !== undefined ? obj[h] : '';
  });
  sheet.appendRow(row);
  invalidateTableCache_(sheetName);
  return sheet.getLastRow();
}

function updateRow_(sheetName, rowNumber, obj) {
  var sheet = getSheet_(sheetName);
  var headers = EV_HEADERS[sheetName];
  var current = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  var merged = headers.map(function (h, c) {
    return obj[h] !== undefined ? obj[h] : current[c];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([merged]);
  invalidateTableCache_(sheetName);
}
