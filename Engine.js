/**
 * Engine.gs — submission processing core.
 *
 * Evidence files are stored under:
 *   Evidence Repository / Programme / Class / Student / Unit
 *
 * On the first submission for a student, their details and folder URL are
 * written to the tracker spreadsheet (one tab per programme) via Tracker.gs.
 */

function processSubmission(payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    evLog_('INFO', 'processSubmission',
      'START studentId=' + (payload && payload.studentId) +
      ' unitId=' + (payload && payload.unitId) +
      ' assessment=' + (payload && payload.assessmentType) +
      ' fileId=' + (payload && payload.fileId));

    var v = validatePayload_(payload);
    if (!v.ok) {
      evLog_('ERROR', 'processSubmission', 'INVALID payload — ' + v.error);
      return { ok: false, error: v.error };
    }

    var student = v.student;
    var ctx = v.context;
    evLog_('INFO', 'processSubmission',
      'Validated student=' + student.student_id +
      ' programme=' + ctx.programme.programme_name +
      ' class=' + ctx.class.class_name +
      ' unit=' + ctx.unit.unit_name);

    var folder = buildStudentUnitFolder_(ctx, student);
    evLog_('INFO', 'processSubmission', 'Folder=' + folder.getName() + ' id=' + folder.getId());

    var existing = findExistingSubmissionInFolder_(folder, payload.assessmentType);
    var version = existing ? existing.version + 1 : 1;
    if (existing && existing.fileId && existing.fileId !== payload.fileId) {
      try { DriveApp.getFileById(existing.fileId).setTrashed(true); }
      catch (e) { evLog_('WARN', 'processSubmission', 'Could not trash old file: ' + e.message); }
    }

    var file = DriveApp.getFileById(payload.fileId);
    var newName = buildSubmissionFileName_(payload.assessmentType, version);
    file.setName(newName);
    file.moveTo(folder);
    evLog_('INFO', 'processSubmission',
      'File moved name=' + newName + ' version=' + version);

    // Write to tracker spreadsheet on first submission (guarded internally).
    var studentFolder = folder.getParents().hasNext() ? folder.getParents().next() : folder;
    trackStudentFolderOnce_(student, ctx, studentFolder);

    // Give the student view-only access to their own evidence folder.
    try { if (student.email) studentFolder.addViewer(String(student.email)); }
    catch (e) { evLog_('WARN', 'processSubmission', 'Could not grant folder view access: ' + e.message); }

    evLog_('INFO', 'processSubmission',
      'DONE ok=true fileId=' + payload.fileId + ' version=' + version);
    return {
      ok: true,
      fileId: payload.fileId,
      version: version,
      fileUrl: file.getUrl(),
      studentFolderUrl: studentFolder.getUrl()
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * File retention: trash evidence files older than retentionMonths.
 */
function cleanupOldSubmissionFiles(retentionMonths) {
  retentionMonths = retentionMonths || 24;
  var cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);

  var all = listAllSubmissionFiles_();
  var checked = 0, deleted = 0, errors = 0;
  all.forEach(function (s) {
    checked++;
    try {
      if (s.updatedAtDate && s.updatedAtDate < cutoff) {
        DriveApp.getFileById(s.fileId).setTrashed(true);
        deleted++;
      }
    } catch (e) {
      errors++;
      Logger.log('Cleanup error ' + s.fileId + ': ' + e.message);
    }
  });
  Logger.log('Cleanup — checked:' + checked + ' deleted:' + deleted + ' errors:' + errors);
  return { checked: checked, deleted: deleted, errors: errors, cutoffDate: cutoff.toISOString() };
}

/**
 * Walks the full Drive repository tree and returns all evidence files.
 * Used by cleanupOldSubmissionFiles and adminReports.
 */
function listAllSubmissionFiles_() {
  var root = getRootFolder_();
  var out = [];
  var pFolders = root.getFolders();
  while (pFolders.hasNext()) {
    var pFolder = pFolders.next();
    var cFolders = pFolder.getFolders();
    while (cFolders.hasNext()) {
      var cFolder = cFolders.next();
      var sFolders = cFolder.getFolders();
      while (sFolders.hasNext()) {
        var sFolder = sFolders.next();
        var uFolders = sFolder.getFolders();
        while (uFolders.hasNext()) {
          var uFolder = uFolders.next();
          var files = uFolder.getFiles();
          while (files.hasNext()) {
            var file = files.next();
            var parsed = parseSubmissionFileName_(file.getName());
            if (!parsed.assessment) continue;
            out.push({
              fileId:       file.getId(),
              programme:    pFolder.getName(),
              klass:        cFolder.getName(),
              student:      sFolder.getName(),
              unit:         uFolder.getName(),
              assessment:   parsed.assessment,
              version:      parsed.version || 1,
              updatedAtDate: file.getLastUpdated()
            });
          }
        }
      }
    }
  }
  return out;
}

/* ── Validation ──────────────────────────────────────────────────────────── */

function validatePayload_(p) {
  function fail(msg) {
    evLog_('WARN', 'validatePayload_', 'FAIL ' + msg);
    return { ok: false, error: msg };
  }

  if (!p) return fail('Empty payload.');
  var required = ['programmeId', 'classId', 'unitId', 'assessmentType', 'fileId'];
  for (var i = 0; i < required.length; i++) {
    if (!p[required[i]]) return fail('Missing field: ' + required[i]);
  }
  if (EV.ASSESSMENT_TYPES.indexOf(p.assessmentType) === -1) {
    return fail('Invalid assessment type: ' + p.assessmentType);
  }

  var student = null;
  if (p.studentId) {
    student = findRow_(EV.SHEETS.STUDENTS, function (r) {
      return String(r.student_id) === String(p.studentId);
    });
  }
  if (!student && p.studentEmail) {
    student = findRow_(EV.SHEETS.STUDENTS, function (r) {
      return String(r.email).toLowerCase() === String(p.studentEmail).toLowerCase();
    });
  }
  if (!student) return fail('Student not found.');

  try { DriveApp.getFileById(p.fileId); }
  catch (e) { return fail('File not accessible: ' + p.fileId + ' — ' + e.message); }

  var programme = findRow_(EV.SHEETS.PROGRAMMES, function (r) {
    return String(r.programme_id) === String(p.programmeId);
  });
  var klass = findRow_(EV.SHEETS.CLASSES, function (r) {
    return String(r.class_id) === String(p.classId);
  });
  var unit = findRow_(EV.SHEETS.UNITS, function (r) {
    return String(r.unit_id) === String(p.unitId);
  });
  if (!programme) return fail('Programme not found: ' + p.programmeId);
  if (!klass)     return fail('Class not found: ' + p.classId);
  if (!unit)      return fail('Unit not found: ' + p.unitId);
  if (String(klass.programme_id) !== String(programme.programme_id)) {
    return fail('Class does not belong to this programme.');
  }
  if (String(unit.programme_id) !== String(programme.programme_id)) {
    return fail('Unit does not belong to this programme.');
  }
  if (String(student.class_id) !== String(klass.class_id)) {
    return fail('Student class does not match the submitted class.');
  }

  return { ok: true, student: student, context: { programme: programme, class: klass, unit: unit } };
}

/* ── Drive folder helpers ────────────────────────────────────────────────── */

function buildStudentUnitFolder_(ctx, student) {
  var root = getRootFolder_();
  var pFolder = getOrCreateFolder_(root, sanitize_(ctx.programme.programme_name));
  var cFolder = getOrCreateFolder_(pFolder, sanitize_(ctx.class.class_name));
  var studentKey = (student.admission_no || student.student_id) + ' - ' + student.name;
  var sFolder = getOrCreateFolder_(cFolder, sanitize_(studentKey));
  var uFolder = getOrCreateFolder_(sFolder, sanitize_(ctx.unit.unit_name));
  return uFolder;
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ── File naming ─────────────────────────────────────────────────────────── */

function findExistingSubmissionInFolder_(folder, assessment) {
  var files = folder.getFiles();
  var latest = null;
  while (files.hasNext()) {
    var file = files.next();
    var parsed = parseSubmissionFileName_(file.getName());
    if (parsed.assessment !== assessment) continue;
    if (!latest || parsed.version > latest.version) {
      latest = {
        fileId:  file.getId(),
        version: parsed.version || 1,
        updatedAtDate: file.getLastUpdated()
      };
    }
  }
  return latest;
}

function buildSubmissionFileName_(assessment, version) {
  return assessment + ' - v' + version;
}

function parseSubmissionFileName_(name) {
  var out = { assessment: '', version: 1 };
  var s = String(name || '').trim();

  var m = s.match(/^(CAT[1-4]|PRACTICAL[1-3])\s*-\s*v(\d+)$/i);
  if (m) {
    out.assessment = m[1].toUpperCase();
    out.version    = Number(m[2]);
    return out;
  }

  // Legacy format support.
  s = s.replace(/^\[(PENDING|APPROVED|DISAPPROVED)\]\s+/i, '');
  m = s.match(/^(CAT[1-4]|PRACTICAL[1-3])(?:\s+v(\d+))?\s*-\s*/i);
  if (m) {
    out.assessment = m[1].toUpperCase();
    out.version    = Number(m[2] || 1);
    return out;
  }
  m = s.match(/^(CAT[1-4]|PRACTICAL[1-3])\b/i);
  if (m) out.assessment = m[1].toUpperCase();
  return out;
}
