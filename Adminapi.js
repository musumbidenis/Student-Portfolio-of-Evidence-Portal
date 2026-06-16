/**
 * AdminApi.gs — web-app entry point and admin-only backend.
 *
 * Serves Admin.html for administrators. Provides reference-data CRUD,
 * bulk import, programme form management, sync scheduling, domain
 * configuration, and system diagnostics.
 */

var _portalCtxCache_ = null;

/* ── Web app entry point ─────────────────────────────────────────────────── */

function doGet(e) {
  var ctx = getPortalContext_();
  if (!ctx.isOrgEmail) {
    return HtmlService.createHtmlOutput(portalErrorPage_(
      'Wrong account — organizational email required', '🔐',
      'You are signed in as <b>' + escapeHtml_(ctx.email || 'unknown') + '</b>.',
      'Use your <b>' + escapeHtml_(allowedDomainText_()) + '</b> account.',
      [
        'Click your profile picture and select Sign out.',
        'Sign in with your ' + escapeHtml_(allowedDomainText_()) + ' institutional email.',
        'Re-open this link.'
      ]
    )).setTitle('Evidence — Wrong account');
  }
  if (!ctx.isAdmin) {
    return HtmlService.createHtmlOutput(portalErrorPage_(
      'No access', '🚫',
      'You are signed in as <b>' + escapeHtml_(ctx.email || 'unknown') + '</b>.',
      'This account is not registered as an administrator.',
      [
        'Check that you are using the correct email.',
        'Ask the system administrator to add your account.',
        'Refresh this page once added.'
      ]
    )).setTitle('Evidence — No access');
  }
  var t = HtmlService.createTemplateFromFile('Admin');
  t.appUrl = ScriptApp.getService().getUrl();
  try { t.masterFormId = getMasterFormId_(); }
  catch (ex) { t.masterFormId = '(not set — run setupSystem())'; }
  return t.evaluate()
    .setTitle('Evidence Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ── Portal context ──────────────────────────────────────────────────────── */

function getPortalContext_() {
  if (_portalCtxCache_) return _portalCtxCache_;
  var email = Session.getActiveUser().getEmail();
  var isOrgEmail = isAllowedOrgEmail_(email);
  var isAdmin = false, name = '';
  if (email && isOrgEmail) {
    var admin = findRow_(EV.SHEETS.ADMINS, function (r) { return eqi_(r.email, email); });
    if (admin) { isAdmin = true; name = admin.name || ''; }
  }
  var ctx = { email: email || '', isAdmin: isAdmin, isOrgEmail: isOrgEmail, name: name || email || '' };
  _portalCtxCache_ = ctx;
  return ctx;
}

function requireAdmin_() {
  var ctx = getPortalContext_();
  if (!ctx.isAdmin) throw new Error('Administrator access required.');
  return ctx;
}

function getContext(mode) {
  var ctx = getPortalContext_();
  return { email: ctx.email, name: ctx.name, isAdmin: ctx.isAdmin };
}

/* ── Entity config ───────────────────────────────────────────────────────── */

var ENTITY_CFG_ = {
  programmes: { sheet: 'Programmes', key: 'programme_id', autoId: true },
  classes:    { sheet: 'Classes',    key: 'class_id',     autoId: true },
  units:      { sheet: 'Units',      key: 'unit_id',      autoId: true },
  students:   { sheet: 'Students',   key: 'student_id',   autoId: true }
};

function nextAutoId_(sheetName, keyField) {
  var rows = readTable_(sheetName).rows;
  var max = 0;
  rows.forEach(function (r) {
    var n = parseInt(r[keyField], 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return max + 1;
}

/* ── Reference data CRUD ─────────────────────────────────────────────────── */

function adminGetAllData() {
  requireAdmin_();
  var out = {};
  Object.keys(ENTITY_CFG_).forEach(function (k) {
    out[k] = readTable_(ENTITY_CFG_[k].sheet).rows.map(stripMeta_);
  });
  return out;
}

function adminSaveRow(entity, obj) {
  requireAdmin_();
  var cfg = ENTITY_CFG_[entity];
  if (!cfg) throw new Error('Unknown entity: ' + entity);
  var row = {};
  Object.keys(obj).forEach(function (k) { row[k] = obj[k]; });
  if (!row[cfg.key] && cfg.autoId) row[cfg.key] = String(nextAutoId_(cfg.sheet, cfg.key));
  if (!row[cfg.key]) throw new Error('Missing required key: ' + cfg.key);
  var existing = findRow_(cfg.sheet, function (r) {
    return String(r[cfg.key]) === String(row[cfg.key]);
  });
  if (existing) updateRow_(cfg.sheet, existing.__row, row);
  else appendObject_(cfg.sheet, row);
  if (entity === 'classes') refreshRegistrationFormSafe_();
  return row;
}

function checkDeleteConstraints_(entity, keyValue) {
  var rules = {
    programmes: [
      { sheet: EV.SHEETS.CLASSES,   field: 'programme_id', msg: 'Remove all classes for this programme first.'  },
      { sheet: EV.SHEETS.UNITS,     field: 'programme_id', msg: 'Remove all units for this programme first.'    },
      { sheet: EV.SHEETS.STUDENTS,  field: 'programme_id', msg: 'Remove all students for this programme first.' }
    ],
    classes: [
      { sheet: EV.SHEETS.STUDENTS, field: 'class_id', msg: 'Remove all students in this class first.' }
    ],
    units: [],
    students: []
  };
  var list = rules[entity];
  if (!list) return;
  list.forEach(function (c) {
    var found = findRow_(c.sheet, function (r) { return String(r[c.field]) === String(keyValue); });
    if (found) throw new Error(c.msg);
  });
}

function adminDeleteRow(entity, keyValue) {
  requireAdmin_();
  var cfg = ENTITY_CFG_[entity];
  if (!cfg) throw new Error('Unknown entity: ' + entity);
  checkDeleteConstraints_(entity, keyValue);
  var existing = findRow_(cfg.sheet, function (r) {
    return String(r[cfg.key]) === String(keyValue);
  });
  if (!existing) throw new Error('Row not found.');
  getSheet_(cfg.sheet).deleteRow(existing.__row);
  invalidateTableCache_(cfg.sheet);
  if (entity === 'classes') refreshRegistrationFormSafe_();
  return { ok: true };
}

function adminBulkImport(entity, text) {
  requireAdmin_();
  var cfg = ENTITY_CFG_[entity];
  if (!cfg) throw new Error('Unknown entity: ' + entity);
  var parsed = parseDelimited_(text);
  if (parsed.length < 2) throw new Error('Need a header row and at least one data row.');
  var inHeaders = parsed[0].map(function (h) { return String(h).trim(); });
  var sheetCols = EV_HEADERS[cfg.sheet];
  var sheet = getSheet_(cfg.sheet);
  var added = 0, updated = 0, errors = [], newRows = [], pendingKeys = {};
  var autoIdCounter = cfg.autoId ? nextAutoId_(cfg.sheet, cfg.key) : null;

  for (var i = 1; i < parsed.length; i++) {
    var cells = parsed[i];
    if (!cells.length || cells.join('').trim() === '') continue;
    var obj = {};
    inHeaders.forEach(function (h, idx) {
      if (sheetCols.indexOf(h) >= 0) obj[h] = cells[idx] != null ? cells[idx] : '';
    });
    if (!obj[cfg.key] && cfg.autoId) obj[cfg.key] = String(autoIdCounter++);
    if (!obj[cfg.key]) { errors.push('Row ' + i + ': missing ' + cfg.key); continue; }

    // Derive programme_id from class_id when importing students without it.
    if (entity === 'students' && obj.class_id && !obj.programme_id) {
      var cls = findRow_(EV.SHEETS.CLASSES, function (c) { return String(c.class_id) === String(obj.class_id); });
      if (cls) obj.programme_id = String(cls.programme_id);
    }

    var keyStr = String(obj[cfg.key]);
    var ex = findRow_(cfg.sheet, function (r) { return String(r[cfg.key]) === keyStr; });
    if (ex) {
      var current = sheet.getRange(ex.__row, 1, 1, sheetCols.length).getValues()[0];
      var merged = sheetCols.map(function (h, c) { return obj[h] !== undefined ? obj[h] : current[c]; });
      sheet.getRange(ex.__row, 1, 1, sheetCols.length).setValues([merged]);
      updated++;
    } else if (pendingKeys[keyStr]) {
      errors.push('Row ' + i + ': duplicate key "' + keyStr + '" — skipped.');
    } else {
      newRows.push(sheetCols.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
      pendingKeys[keyStr] = true;
      added++;
    }
  }
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, sheetCols.length).setValues(newRows);
  }
  invalidateTableCache_(cfg.sheet);
  if (entity === 'classes' && (added > 0 || updated > 0)) refreshRegistrationFormSafe_();
  return { added: added, updated: updated, errors: errors };
}

/* ── Registration form ───────────────────────────────────────────────────── */

function adminGetOrCreateRegistrationForm() {
  requireAdmin_();
  var props = PropertiesService.getScriptProperties();
  var formId = props.getProperty(EV.PROP_REGISTRATION_FORM_ID);
  var form;
  if (formId) {
    try { form = FormApp.openById(formId); } catch (e) { formId = null; }
  }
  if (!form) {
    form = createRegistrationForm_();
    formId = form.getId();
  }
  installRegistrationTrigger_(formId);
  return {
    formId:  formId,
    url:     form.getPublishedUrl(),
    editUrl: 'https://docs.google.com/forms/d/' + formId + '/edit'
  };
}

function installRegistrationTrigger_(formId) {
  if (!formId) return;
  var triggers = ScriptApp.getProjectTriggers();
  var already = triggers.some(function (t) {
    return t.getHandlerFunction() === 'onRegistrationFormSubmit' && t.getTriggerSourceId() === formId;
  });
  if (already) return;
  ScriptApp.newTrigger('onRegistrationFormSubmit').forForm(formId).onFormSubmit().create();
  evLog_('INFO', 'installTrigger', 'Installed onRegistrationFormSubmit for formId=' + formId);
}

/**
 * Refreshes the Class dropdown on the existing registration form from the
 * current Classes sheet, without recreating the form. Callable from the
 * Admin portal. Throws if no registration form has been created yet.
 */
function adminRefreshRegistrationForm() {
  requireAdmin_();
  var formId = PropertiesService.getScriptProperties().getProperty(EV.PROP_REGISTRATION_FORM_ID);
  if (!formId) throw new Error('No registration form exists yet. Create it first.');
  var form;
  try { form = FormApp.openById(formId); }
  catch (e) { throw new Error('Saved registration form could not be opened: ' + e.message); }
  var count = refreshRegistrationClassChoices_(form);
  evLog_('INFO', 'refreshRegistrationForm', 'Updated Class choices count=' + count);
  return { ok: true, classes: count, url: form.getPublishedUrl() };
}

/**
 * Best-effort refresh of the registration form's Class dropdown after a
 * class change. Never throws — a form hiccup must not fail the data write.
 */
function refreshRegistrationFormSafe_() {
  try {
    var formId = PropertiesService.getScriptProperties().getProperty(EV.PROP_REGISTRATION_FORM_ID);
    if (!formId) return;
    refreshRegistrationClassChoices_(FormApp.openById(formId));
  } catch (e) {
    evLog_('WARN', 'refreshRegistrationForm', 'Auto-refresh skipped: ' + e.message);
  }
}

/* ── Programme forms ─────────────────────────────────────────────────────── */

function progFormsRead_() {
  var raw = PropertiesService.getScriptProperties().getProperty(EV.PROP_PROGRAMME_FORMS);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function progFormsWrite_(map) {
  PropertiesService.getScriptProperties().setProperty(EV.PROP_PROGRAMME_FORMS, JSON.stringify(map));
}

function adminGetProgrammeForms() {
  requireAdmin_();
  var map = progFormsRead_();
  return Object.keys(map).map(function (pid) {
    var r = map[pid];
    return {
      programmeId:   pid,
      programmeName: r.programmeName,
      formId:        r.formId,
      url:           r.url,
      shortUrl:      r.shortUrl || r.url,
      editUrl:       'https://docs.google.com/forms/d/' + r.formId + '/edit',
      uploadFixed:   r.uploadFixed !== false
    };
  });
}

function adminMarkFormFixed(programmeId) {
  requireAdmin_();
  var map = progFormsRead_();
  if (!map[programmeId]) throw new Error('No form found for this programme.');
  map[programmeId].uploadFixed = true;
  progFormsWrite_(map);
  return { ok: true };
}

function adminCreateProgrammeForm(programmeId) {
  requireAdmin_();
  if (!programmeId) throw new Error('Select a programme.');
  var prog = findRow_('Programmes', function (p) { return String(p.programme_id) === String(programmeId); });
  if (!prog) throw new Error('Programme not found.');

  evLog_('INFO', 'createForm', 'START progId=' + programmeId);
  var formId = createProgrammeFormCopy_(programmeId);
  var url = FormApp.openById(formId).getPublishedUrl();
  var shortUrl = shortenUrl_(url, prog.programme_name);

  var map = progFormsRead_();
  map[programmeId] = {
    programmeName: prog.programme_name,
    formId:        formId,
    url:           url,
    shortUrl:      shortUrl,
    createdAt:     new Date().toISOString(),
    uploadFixed:   false
  };
  progFormsWrite_(map);
  installFormSubmitTrigger_(formId);
  var editUrl = 'https://docs.google.com/forms/d/' + formId + '/edit';
  evLog_('INFO', 'createForm', 'DONE formId=' + formId);
  return { ok: true, url: url, shortUrl: shortUrl, formId: formId, editUrl: editUrl };
}

function adminUpdateProgrammeForm(programmeId) {
  requireAdmin_();
  if (!programmeId) throw new Error('Select a programme.');
  var map = progFormsRead_();
  if (!map[programmeId]) throw new Error('No form found for this programme. Create one first.');
  prepareProgrammeForm(map[programmeId].formId, programmeId);
  return { ok: true, formId: map[programmeId].formId };
}

function adminDeleteProgrammeForm(programmeId) {
  requireAdmin_();
  var map = progFormsRead_();
  if (!map[programmeId]) throw new Error('No form saved for that programme.');
  deleteProgrammeFormTrigger_(map[programmeId].formId);
  delete map[programmeId];
  progFormsWrite_(map);
  return { ok: true };
}

function installFormSubmitTrigger_(formId) {
  if (!formId) return;
  var triggers = ScriptApp.getProjectTriggers();
  var total = triggers.filter(function (t) { return t.getHandlerFunction() === 'onEvFormSubmit'; }).length;
  if (total >= 20) {
    evLog_('WARN', 'installTrigger',
      'Trigger limit reached (20). Real-time trigger NOT installed for formId=' + formId +
      '. Polling sync will handle submissions instead.');
    return;
  }
  var already = triggers.some(function (t) {
    return t.getHandlerFunction() === 'onEvFormSubmit' && t.getTriggerSourceId() === formId;
  });
  if (already) return;
  ScriptApp.newTrigger('onEvFormSubmit').forForm(formId).onFormSubmit().create();
  evLog_('INFO', 'installTrigger', 'Installed onEvFormSubmit for formId=' + formId);
}

function adminInstallFormTriggers() {
  requireAdmin_();
  var map = progFormsRead_();
  var installed = 0, skipped = 0;
  Object.keys(map).forEach(function (pid) {
    var formId = map[pid] && map[pid].formId;
    if (!formId) return;
    var before = ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction() === 'onEvFormSubmit' && t.getTriggerSourceId() === formId;
    }).length;
    installFormSubmitTrigger_(formId);
    var after = ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction() === 'onEvFormSubmit' && t.getTriggerSourceId() === formId;
    }).length;
    if (after > before) installed++; else skipped++;
  });
  return { ok: true, installed: installed, skipped: skipped };
}

function deleteProgrammeFormTrigger_(formId) {
  if (!formId) return;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onEvFormSubmit' && t.getTriggerSourceId() === formId) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/* ── Sync ────────────────────────────────────────────────────────────────── */

function adminSyncNow() {
  requireAdmin_();
  return syncProgrammeFormSubmissions();
}

function adminGetSyncSettings() {
  requireAdmin_();
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(EV.PROP_SYNC_SETTINGS);
  var settings = {};
  if (raw) { try { settings = JSON.parse(raw); } catch (e) { settings = {}; } }
  var trigger = getSyncTrigger_();
  settings.enabled = !!trigger;
  settings.lastSyncAt = props.getProperty('EV_LAST_SYNC_AT') || '';
  settings.triggerId = trigger ? trigger.getUniqueId() : '';
  return settings;
}

function adminSaveSyncSettings(settings) {
  requireAdmin_();
  settings = settings || {};
  var enabled       = String(settings.enabled) === 'true' || settings.enabled === true;
  var frequency     = String(settings.frequency || 'daily');
  var hour          = Number(settings.hour);
  var minute        = Number(settings.minute);
  var intervalHours = Number(settings.intervalHours);

  if (frequency === 'hourly') {
    if ([1, 2, 4, 6, 12].indexOf(intervalHours) < 0) {
      throw new Error('Interval hours must be 1, 2, 4, 6, or 12.');
    }
  } else {
    frequency = 'daily';
    if (isNaN(hour)   || hour   < 0 || hour   > 23) throw new Error('Hour must be 0–23.');
    if (isNaN(minute) || minute < 0 || minute > 59) throw new Error('Minute must be 0–59.');
  }

  deleteSyncTriggers_();

  var saved = {
    enabled: enabled, frequency: frequency,
    hour: hour, minute: minute, intervalHours: intervalHours,
    updatedAt: new Date().toISOString()
  };
  PropertiesService.getScriptProperties()
    .setProperty(EV.PROP_SYNC_SETTINGS, JSON.stringify(saved));

  if (enabled) {
    var tb = ScriptApp.newTrigger('pollProgrammeFormSubmissions').timeBased();
    if (frequency === 'hourly') tb.everyHours(intervalHours);
    else tb.atHour(hour).nearMinute(minute).everyDays(1);
    tb.create();
  }
  return adminGetSyncSettings();
}

function getSyncTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'pollProgrammeFormSubmissions') return triggers[i];
  }
  return null;
}

function deleteSyncTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollProgrammeFormSubmissions') ScriptApp.deleteTrigger(t);
  });
}

function deleteLegacyFormSubmitTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onEvFormSubmit') ScriptApp.deleteTrigger(t);
  });
}

/* ── Reports ─────────────────────────────────────────────────────────────── */

function adminReports() {
  requireAdmin_();
  var students   = readTable_(EV.SHEETS.STUDENTS).rows;
  var classes    = readTable_(EV.SHEETS.CLASSES).rows;
  var units      = readTable_(EV.SHEETS.UNITS).rows;
  var programmes = readTable_(EV.SHEETS.PROGRAMMES).rows;

  var progById = {};
  programmes.forEach(function (p) { progById[p.programme_id] = p; });

  var studByClass = {};
  students.forEach(function (s) {
    studByClass[s.class_id] = (studByClass[s.class_id] || 0) + 1;
  });

  var byClass = classes.map(function (c) {
    var prog = (progById[c.programme_id] || {}).programme_name || '';
    return {
      className:   c.class_name,
      programme:   prog,
      students:    studByClass[c.class_id] || 0
    };
  });

  var trackerUrl = '';
  try { trackerUrl = getTrackerSpreadsheet_().getUrl(); } catch (e) {}

  return {
    totalStudents:   students.length,
    totalClasses:    classes.length,
    totalUnits:      units.length,
    totalProgrammes: programmes.length,
    byClass:         byClass,
    trackerUrl:      trackerUrl
  };
}

/* ── Evidence viewer ────────────────────────────────────────────────────── */

function adminGetEvidenceStudents(programmeId, classId, unitId) {
  requireAdmin_();
  if (!unitId) throw new Error('Unit is required.');
  if (!programmeId && !classId) throw new Error('Select a programme or class.');

  var prog  = programmeId
    ? findRow_(EV.SHEETS.PROGRAMMES, function (p) { return String(p.programme_id) === String(programmeId); })
    : null;
  var klass = classId
    ? findRow_(EV.SHEETS.CLASSES, function (c) { return String(c.class_id) === String(classId); })
    : null;

  var tracker = getTrackerSpreadsheet_();
  var sheets  = tracker.getSheets();
  var students = [];

  sheets.forEach(function (sheet) {
    if (sheet.getName() === '_index') return;
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return;
    var headers = data[0].map(function (h) { return String(h).trim(); });
    var col = {};
    headers.forEach(function (h, i) { col[h] = i; });
    if (col['student_id'] === undefined || col['folder_url'] === undefined) return;

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row[col['student_id']]) continue;
      var rowClass = String(row[col['class']] || '').trim();
      var rowProg  = String(row[col['programme']] || '').trim();

      if (klass && !eqi_(rowClass, klass.class_name)) continue;
      if (!klass && prog && !eqi_(rowProg, prog.programme_name)) continue;

      students.push({
        studentId:           String(row[col['student_id']]),
        name:                String(row[col['name']]        || ''),
        email:               String(row[col['email']]       || ''),
        admissionNo:         String(row[col['admission_no']]|| ''),
        className:           rowClass,
        programme:           rowProg,
        folderUrl:           String(row[col['folder_url']]  || ''),
        firstSubmissionDate: String(row[col['first_submission_date']] || '')
      });
    }
  });

  students.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return students;
}

function adminGetStudentUnitFiles(studentId, unitId) {
  requireAdmin_();
  var unit = findRow_(EV.SHEETS.UNITS, function (u) { return String(u.unit_id) === String(unitId); });
  if (!unit) throw new Error('Unit not found.');

  var folderUrl = findTrackerFolderUrl_(studentId);
  if (!folderUrl) throw new Error('No tracker record found for this student.');

  var studentFolder;
  try { studentFolder = DriveApp.getFolderById(extractFolderId_(folderUrl)); }
  catch (e) { throw new Error('Cannot access student folder: ' + e.message); }

  var it = studentFolder.getFoldersByName(sanitize_(unit.unit_name));
  if (!it.hasNext()) return [];
  var unitFolder = it.next();

  var files = [];
  var fileIt = unitFolder.getFiles();
  while (fileIt.hasNext()) {
    var file = fileIt.next();
    var parsed = parseSubmissionFileName_(file.getName());
    if (!parsed.assessment) continue;
    files.push({
      fileId:     file.getId(),
      label:      parsed.assessment + ' — v' + parsed.version,
      assessment: parsed.assessment,
      version:    parsed.version,
      previewUrl: 'https://drive.google.com/file/d/' + file.getId() + '/preview',
      driveUrl:   file.getUrl()
    });
  }

  files.sort(function (a, b) {
    if (a.assessment !== b.assessment) return a.assessment.localeCompare(b.assessment);
    return b.version - a.version;
  });
  return files;
}

function findTrackerFolderUrl_(studentId) {
  var sheets = getTrackerSpreadsheet_().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var data = sheets[i].getDataRange().getValues();
    if (data.length < 2) continue;
    var headers = data[0].map(function (h) { return String(h).trim(); });
    var sidIdx  = headers.indexOf('student_id');
    var urlIdx  = headers.indexOf('folder_url');
    if (sidIdx < 0 || urlIdx < 0) continue;
    for (var j = 1; j < data.length; j++) {
      if (String(data[j][sidIdx]) === String(studentId)) return String(data[j][urlIdx]);
    }
  }
  return null;
}

function extractFolderId_(url) {
  var m = String(url).match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  throw new Error('Cannot extract folder ID from URL: ' + url);
}

/* ── Domain settings ─────────────────────────────────────────────────────── */

function adminGetOrgDomains() {
  requireAdmin_();
  return getOrgEmailDomains_();
}

function adminSaveOrgDomains(domains) {
  requireAdmin_();
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error('At least one domain is required.');
  }
  var clean = domains.map(function (d) {
    return String(d).trim().toLowerCase().replace(/^@/, '');
  }).filter(function (d) { return d.length > 0; });
  if (clean.length === 0) throw new Error('No valid domains provided.');
  PropertiesService.getScriptProperties()
    .setProperty(EV.PROP_ORG_EMAIL_DOMAINS, JSON.stringify(clean));
  evLog_('INFO', 'adminSaveOrgDomains', 'Domains updated: ' + clean.join(', '));
  return { ok: true, domains: clean };
}

/* ── File cleanup ────────────────────────────────────────────────────────── */

function adminRunFileCleanup(retentionMonths) {
  requireAdmin_();
  return cleanupOldSubmissionFiles(retentionMonths || 24);
}

/* ── Logs & diagnostics ──────────────────────────────────────────────────── */

function adminGetLogs() {
  requireAdmin_();
  var raw = PropertiesService.getScriptProperties().getProperty(EV.PROP_SYSTEM_LOG) || '[]';
  var buf;
  try { buf = JSON.parse(raw); if (!Array.isArray(buf)) buf = []; } catch (e) { buf = []; }
  return buf.slice().reverse();
}

function adminClearLogs() {
  requireAdmin_();
  PropertiesService.getScriptProperties().deleteProperty(EV.PROP_SYSTEM_LOG);
  return { ok: true };
}

function adminGetSystemInfo() {
  requireAdmin_();
  var props = PropertiesService.getScriptProperties();

  var ssId = props.getProperty(EV.PROP_SPREADSHEET_ID) || '';
  var ssOk = false;
  try { SpreadsheetApp.openById(ssId); ssOk = true; } catch (e) {}

  var rootId = props.getProperty(EV.PROP_ROOT_FOLDER_ID) || '';
  var rootOk = false, rootUrl = '';
  try { var rf = DriveApp.getFolderById(rootId); rootOk = true; rootUrl = rf.getUrl(); } catch (e) {}

  var trackerId = props.getProperty(EV.PROP_TRACKER_SHEET_ID) || '';
  var trackerOk = false, trackerUrl = '';
  try { var tr = SpreadsheetApp.openById(trackerId); trackerOk = true; trackerUrl = tr.getUrl(); } catch (e) {}

  var masterFormId = '';
  try { masterFormId = getMasterFormId_(); } catch (e) {}
  var masterOk = false;
  try { if (masterFormId) { FormApp.openById(masterFormId); masterOk = true; } } catch (e) {}

  var counts = {};
  Object.keys(EV.SHEETS).forEach(function (k) {
    var sName = EV.SHEETS[k];
    try { counts[sName] = readTable_(sName).rows.length; } catch (e) { counts[sName] = '!err'; }
  });

  var formsMap = {};
  try {
    var rawForms = props.getProperty(EV.PROP_PROGRAMME_FORMS);
    if (rawForms) formsMap = JSON.parse(rawForms);
  } catch (e) {}
  var formsList = Object.keys(formsMap).map(function (pid) {
    var f = formsMap[pid];
    return { programmeId: pid, programmeName: f.programmeName || '', formId: f.formId || '', uploadFixed: f.uploadFixed !== false, createdAt: f.createdAt || '' };
  });

  return {
    spreadsheetId:       ssId,    spreadsheetOk:   ssOk,
    rootFolderId:        rootId,  rootFolderOk:    rootOk,   rootFolderUrl: rootUrl,
    trackerSheetId:      trackerId, trackerSheetOk: trackerOk, trackerUrl:  trackerUrl,
    masterFormId:        masterFormId, masterFormOk: masterOk,
    orgDomains:          getOrgEmailDomains_(),
    sheetCounts:         counts,
    lastSync:            props.getProperty('EV_LAST_SYNC_AT') || 'Never',
    programmeFormsCount: formsList.length,
    programmeForms:      formsList
  };
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function stripMeta_(r) {
  var o = {};
  Object.keys(r).forEach(function (k) { if (k !== '__row') o[k] = r[k]; });
  return o;
}

function parseDelimited_(text) {
  var normalised = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var lines = normalised.split('\n').filter(function (l) { return l.length; });
  if (!lines.length) return [];
  var delim = (lines[0].indexOf('\t') >= 0) ? '\t' : ',';
  if (delim === '\t') {
    return lines.map(function (l) {
      return l.split('\t').map(function (c) { return c.trim(); });
    });
  }
  var rows = [];
  lines.forEach(function (line) {
    var fields = [], field = '', inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { field += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === delim && !inQuote) {
        fields.push(field.trim()); field = '';
      } else {
        field += ch;
      }
    }
    fields.push(field.trim());
    rows.push(fields);
  });
  return rows;
}

/* ── Import template ─────────────────────────────────────────────────────── */

function adminCreateImportTemplate() {
  requireAdmin_();
  var progs   = readTable_(EV.SHEETS.PROGRAMMES).rows;
  var classes = readTable_(EV.SHEETS.CLASSES).rows;
  var units   = readTable_(EV.SHEETS.UNITS).rows;
  var BLANK   = 50;
  var TEAL = '#0f5c52', WHITE = '#ffffff', FORMULA_BG = '#eaf0ef', AUTO_BG = '#f5f2ea';

  var ss  = SpreadsheetApp.create('Evidence Import Template');
  var def = ss.getSheets()[0];
  var pSh = ss.insertSheet('Programmes', 0);
  var cSh = ss.insertSheet('Classes',    1);
  var uSh = ss.insertSheet('Units',      2);
  var sSh = ss.insertSheet('Students',   3);
  try { ss.deleteSheet(def); } catch (e) {}

  // ── Programmes ────────────────────────────────────────────────
  tplHeaders_(pSh, ['programme_id', 'programme_name'], TEAL, WHITE);
  pSh.getRange('A1').setNote('Leave programme_id blank — auto-assigned on import.');
  progs.forEach(function (p, i) {
    pSh.getRange(i + 2, 1, 1, 2).setValues([[p.programme_id, p.programme_name]]);
  });
  var pBlank = [];
  for (var i = 0; i < BLANK; i++) pBlank.push(['', '']);
  var pStart = progs.length + 2;
  pSh.getRange(pStart, 1, BLANK, 2).setValues(pBlank);
  pSh.getRange(pStart, 1, BLANK, 1).setFontColor('#aaa').setBackground(AUTO_BG);
  [120, 280].forEach(function (w, c) { pSh.setColumnWidth(c + 1, w); });

  // ── Classes ───────────────────────────────────────────────────
  tplHeaders_(cSh, ['class_id', 'class_name', 'Programme ▼', 'programme_id'], TEAL, WHITE);
  cSh.getRange('C1').setNote('Pick a programme name — the ID fills automatically.');
  cSh.getRange('D1').setNote('Auto-filled by formula — do not edit.');
  cSh.getRange(1, 3, 1, 2).setBackground(FORMULA_BG);
  classes.forEach(function (c, i) {
    var pName = (progs.filter(function (p) { return String(p.programme_id) === String(c.programme_id); })[0] || {}).programme_name || '';
    cSh.getRange(i + 2, 1, 1, 4).setValues([[c.class_id, c.class_name, pName, c.programme_id]]);
  });
  var cStart = classes.length + 2;
  for (var r = cStart; r < cStart + BLANK; r++) {
    cSh.getRange(r, 4).setFormula('=IFERROR(INDEX(Programmes!$A:$A,MATCH(C' + r + ',Programmes!$B:$B,0)),"")');
  }
  tplDropdown_(cSh, 'C' + cStart + ':C' + (cStart + BLANK - 1), 'Programmes', 'B2:B' + (progs.length + 1 + BLANK));
  cSh.getRange(cStart, 1, BLANK, 1).setFontColor('#aaa').setBackground(AUTO_BG);
  cSh.getRange(cStart, 3, BLANK, 2).setBackground(FORMULA_BG);
  tplLock_(cSh, 'D' + cStart + ':D' + (cStart + BLANK - 1));
  [120, 240, 220, 120].forEach(function (w, c) { cSh.setColumnWidth(c + 1, w); });

  // ── Units ─────────────────────────────────────────────────────
  tplHeaders_(uSh, ['unit_id', 'unit_code', 'unit_name', 'Programme ▼', 'programme_id'], TEAL, WHITE);
  uSh.getRange('D1').setNote('Pick a programme name — the ID fills automatically.');
  uSh.getRange('E1').setNote('Auto-filled by formula — do not edit.');
  uSh.getRange(1, 4, 1, 2).setBackground(FORMULA_BG);
  units.forEach(function (u, i) {
    var pName = (progs.filter(function (p) { return String(p.programme_id) === String(u.programme_id); })[0] || {}).programme_name || '';
    uSh.getRange(i + 2, 1, 1, 5).setValues([[u.unit_id, u.unit_code, u.unit_name, pName, u.programme_id]]);
  });
  var uStart = units.length + 2;
  for (var r = uStart; r < uStart + BLANK; r++) {
    uSh.getRange(r, 5).setFormula('=IFERROR(INDEX(Programmes!$A:$A,MATCH(D' + r + ',Programmes!$B:$B,0)),"")');
  }
  tplDropdown_(uSh, 'D' + uStart + ':D' + (uStart + BLANK - 1), 'Programmes', 'B2:B' + (progs.length + 1 + BLANK));
  uSh.getRange(uStart, 1, BLANK, 1).setFontColor('#aaa').setBackground(AUTO_BG);
  uSh.getRange(uStart, 4, BLANK, 2).setBackground(FORMULA_BG);
  tplLock_(uSh, 'E' + uStart + ':E' + (uStart + BLANK - 1));
  [80, 120, 280, 220, 120].forEach(function (w, c) { uSh.setColumnWidth(c + 1, w); });

  // ── Students ──────────────────────────────────────────────────
  // No programme_id column — derived from class on import.
  tplHeaders_(sSh, ['student_id', 'name', 'email', 'admission_no', 'Class ▼', 'class_id'], TEAL, WHITE);
  sSh.getRange('E1').setNote('Pick a class name — the ID fills automatically.');
  sSh.getRange('F1').setNote('Auto-filled by formula — do not edit.');
  sSh.getRange(1, 5, 1, 2).setBackground(FORMULA_BG);
  for (var r = 2; r < 2 + BLANK; r++) {
    sSh.getRange(r, 6).setFormula('=IFERROR(INDEX(Classes!$A:$A,MATCH(E' + r + ',Classes!$B:$B,0)),"")');
  }
  var allClassEnd = classes.length + 1 + BLANK;
  tplDropdown_(sSh, 'E2:E' + (1 + BLANK), 'Classes', 'B2:B' + allClassEnd);
  sSh.getRange(2, 1, BLANK, 1).setFontColor('#aaa').setBackground(AUTO_BG);
  sSh.getRange(2, 5, BLANK, 2).setBackground(FORMULA_BG);
  tplLock_(sSh, 'F2:F' + (1 + BLANK));
  [100, 200, 220, 160, 220, 100].forEach(function (w, c) { sSh.setColumnWidth(c + 1, w); });

  evLog_('INFO', 'importTemplate', 'Created: ' + ss.getUrl());
  return { url: ss.getUrl() };
}

function tplHeaders_(sheet, headers, bg, fg) {
  var r = sheet.getRange(1, 1, 1, headers.length);
  r.setValues([headers]).setFontWeight('bold').setBackground(bg).setFontColor(fg);
  sheet.setFrozenRows(1);
}

function tplDropdown_(sheet, rangeA1, srcSheetName, srcRangeA1) {
  var srcRange = sheet.getParent().getSheetByName(srcSheetName).getRange(srcRangeA1);
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(srcRange, true).setAllowInvalid(false).build();
  sheet.getRange(rangeA1).setDataValidation(rule);
}

function tplLock_(sheet, rangeA1) {
  var p = sheet.getRange(rangeA1).protect().setDescription('Auto-filled — do not edit');
  p.setWarningOnly(true);
}

function shortenUrl_(longUrl, alias) {
  var BASE = 'https://tinyurl.com/api-create.php';

  function makeAlias(raw) {
    var words = String(raw || '').trim().toLowerCase().split(/\s+/);
    var parts = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i].replace(/[^a-z0-9]/g, '');
      if (!w) continue;
      if (w === 'level' && i + 1 < words.length) {
        parts.push('l' + words[i + 1].replace(/[^a-z0-9]/g, ''));
        i++;
      } else {
        parts.push(w.slice(0, 4));
      }
    }
    return parts.join('-').slice(0, 22);
  }

  function rand3() { return Math.floor(Math.random() * 900) + 100; }

  function tryOne(shortAlias) {
    var apiUrl = BASE + '?url=' + encodeURIComponent(longUrl);
    if (shortAlias) apiUrl += '&alias=' + encodeURIComponent(shortAlias);
    try {
      var r = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true });
      var body = r.getContentText().trim();
      if (r.getResponseCode() === 200 && body.indexOf('https://') === 0) return { ok: true, url: body };
      return { ok: false, network: false };
    } catch (e) {
      return { ok: false, network: true };
    }
  }

  if (alias) {
    var clean = '042-' + makeAlias(alias);
    var r = tryOne(clean);
    if (r.ok) return r.url;
    if (r.network) return longUrl;
    var tried = {};
    for (var attempt = 0; attempt < 15; attempt++) {
      var n; do { n = rand3(); } while (tried[n]); tried[n] = true;
      r = tryOne(clean + '-' + n);
      if (r.ok) return r.url;
      if (r.network) return longUrl;
    }
  }
  var rf = tryOne(null);
  return rf.ok ? rf.url : longUrl;
}
