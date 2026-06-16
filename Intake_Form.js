/**
 * Intake_Form.gs — handles evidence submissions from Google Forms.
 *
 * On each form response:
 *   1. Identifies or registers the student.
 *   2. Routes uploaded files to Drive: Repository / Programme / Class / Student / Unit
 *   3. On the student's first submission, writes their details and folder URL
 *      to the programme tab in the tracker spreadsheet (via Tracker.gs).
 *
 * The system does not link forms to a response spreadsheet.
 */

/* ── Shared email signature ──────────────────────────────────────────────── */

var EV_EMAIL_SIGNATURE =
  'Kind regards,\n\n' +
  'ICT Department - MIS Officer,\n' +
  'The Rift Valley National Polytechnic.\n\n\n' +
  'This is an automated message — please do not reply directly to this email.\n' +
  'For assistance, contact the administrator.';

/** Submission form link for a programme (short link preferred), or '' if none. */
function programmeFormLink_(programmeId) {
  try {
    var rec = progFormsRead_()[String(programmeId)];
    if (rec) return rec.shortUrl || rec.url || '';
  } catch (e) {}
  return '';
}

/** Published URL of the registration form, or '' if not created/openable. */
function registrationFormLink_() {
  try {
    var formId = PropertiesService.getScriptProperties().getProperty(EV.PROP_REGISTRATION_FORM_ID);
    if (formId) return FormApp.openById(formId).getPublishedUrl();
  } catch (e) {}
  return '';
}

function onEvFormSubmit(e) {
  try {
    var response = e && e.response;
    if (!response) throw new Error('Missing form response.');
    processEvFormResponse_(response);
  } catch (err) {
    Logger.log('Form error: ' + err.message);
    try {
      var email = String((e && e.response && e.response.getRespondentEmail()) || '').trim();
      if (email) notifySubmissionError_(email, err.message);
    } catch (ne) { Logger.log('Could not send error notification: ' + ne.message); }
  }
}

/* ── Registration form handler ───────────────────────────────────────────── */

function onRegistrationFormSubmit(e) {
  try {
    var response = e && e.response;
    if (!response) throw new Error('Missing form response.');
    processRegistrationResponse_(response);
  } catch (err) {
    Logger.log('Registration error: ' + err.message);
    try {
      var email = String((e && e.response && e.response.getRespondentEmail()) || '').trim();
      if (email) notifyRegistrationError_(email, err.message);
    } catch (ne) { Logger.log('Could not send registration error notification: ' + ne.message); }
  }
}

function processRegistrationResponse_(response) {
  var answers = itemsToMap_(response.getItemResponses());
  var email   = String(response.getRespondentEmail() || '').trim();

  if (!email) throw new Error('Could not read your email. Ensure the form collects emails.');

  var name        = String(answers['Official Names']   || '').trim();
  var admissionNo = String(answers['Admission Number'] || '').trim();
  var className   = String(answers['Class']            || '').trim();

  if (!name)        throw new Error('Official names are required.');
  if (!admissionNo) throw new Error('Admission Number is required.');
  if (!className)   throw new Error('Class is required.');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (findRow_(EV.SHEETS.STUDENTS, function (s) { return eqi_(s.email, email); })) {
      throw new Error('"' + email + '" is already registered.');
    }
    var classRow = findRow_(EV.SHEETS.CLASSES, function (c) { return eqi_(c.class_name, className); });
    if (!classRow) throw new Error('Class not recognised: "' + className + '".');

    var programmeId = String(classRow.programme_id || '').trim();
    if (!programmeId) throw new Error('Class "' + className + '" has no programme assigned. Contact your administrator.');

    var studentId = String(nextAutoId_(EV.SHEETS.STUDENTS, 'student_id'));
    appendObject_(EV.SHEETS.STUDENTS, {
      student_id:   studentId,
      name:         name,
      email:        email,
      admission_no: admissionNo,
      class_id:     String(classRow.class_id),
      programme_id: programmeId
    });
    evLog_('INFO', 'registration', 'Registered studentId=' + studentId + ' email=' + email);
    notifyRegistrationSuccess_(email, name, programmeId);
  } finally {
    lock.releaseLock();
  }
}

function notifyRegistrationSuccess_(toEmail, name, programmeId) {
  var link = programmeFormLink_(programmeId);
  var linkBlock = link
    ? 'Use the link below to access your evidence submission form:\n' + link + '\n\n' +
      'We recommend bookmarking this link for easy access throughout the term.'
    : 'Your evidence submission form link is not yet available — please contact ' +
      'your programme coordinator to obtain it.';
  try {
    MailApp.sendEmail({
      to: toEmail,
      subject: 'Registration Confirmed — Evidence Submission',
      body: 'Hello ' + name + ',\n\n' +
            'Your registration has been confirmed, and you are now set up to begin ' +
            'submitting evidence for your programme.\n\n' +
            linkBlock + '\n\n' +
            EV_EMAIL_SIGNATURE
    });
  } catch (e) {
    Logger.log('notifyRegistrationSuccess_: could not email ' + toEmail + ': ' + e.message);
  }
}

function notifyRegistrationError_(toEmail, errorMessage) {
  var msg = errorMessage || '';
  var intro, steps;

  if (msg.indexOf('already registered') >= 0) {
    intro = 'The email address ' + toEmail + ' is already registered in the system, so no new\n' +
            'registration is required.';
    steps = 'Your account is active — simply open your programme submission form to begin\n' +
            'submitting evidence. No further action is needed.';
  } else {
    intro = 'Your registration could not be completed due to an unexpected issue.';
    steps = 'Please contact your administrator and quote the following reference so the\n' +
            'issue can be resolved quickly: "' + msg + '"';
  }

  try {
    MailApp.sendEmail({
      to: toEmail,
      subject: 'Registration — Action Required',
      body: 'Hello,\n\n' +
            'We were unable to complete your registration. Please review the details\n' +
            'below and take the recommended steps.\n\n' +
            'What happened:\n' + intro + '\n\n' +
            'What to do next:\n' + steps + '\n\n' +
            EV_EMAIL_SIGNATURE
    });
  } catch (e) {
    Logger.log('notifyRegistrationError_: could not email ' + toEmail + ': ' + e.message);
  }
}

/**
 * Manual and scheduled sync entry point.
 * Scans every saved programme form and processes unsynced responses.
 */
function syncProgrammeFormSubmissions() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var map = progFormsRead_();
    var totals = { forms: 0, checked: 0, processed: 0, skipped: 0, errors: 0, details: [] };
    Object.keys(map).forEach(function (programmeId) {
      var formId = map[programmeId] && map[programmeId].formId;
      if (!formId) return;
      totals.forms++;
      var r = syncSingleProgrammeForm_(formId, programmeId);
      totals.checked   += r.checked;
      totals.processed += r.processed;
      totals.skipped   += r.skipped;
      totals.errors    += r.errors;
      totals.details.push(r);
    });
    PropertiesService.getScriptProperties().setProperty('EV_LAST_SYNC_AT', new Date().toISOString());
    return totals;
  } finally {
    lock.releaseLock();
  }
}

function pollProgrammeFormSubmissions() {
  return syncProgrammeFormSubmissions();
}

function syncSingleProgrammeForm_(formId, programmeId) {
  var result = { formId: formId, programmeId: programmeId, checked: 0, processed: 0, skipped: 0, errors: 0 };
  var runStarted = new Date();
  var state = readProcessedResponseSet_(formId);
  var processed = state.ids || {};
  var form;
  try {
    form = FormApp.openById(formId);
  } catch (fe) {
    evLog_('ERROR', 'syncForm', 'Cannot open formId=' + formId + ': ' + fe.message);
    return result;
  }
  var responses = state.cutoff
    ? form.getResponses(new Date(Number(state.cutoff)))
    : form.getResponses();
  responses.sort(function (a, b) { return a.getTimestamp() - b.getTimestamp(); });

  evLog_('INFO', 'syncForm',
    'START formId=' + formId + ' responses=' + responses.length);

  responses.forEach(function (response) {
    result.checked++;
    var responseId = getResponseKey_(response);
    if (processed[responseId]) { result.skipped++; return; }
    try {
      processEvFormResponse_(response);
      processed[responseId] = new Date().toISOString();
      result.processed++;
      evLog_('INFO', 'syncForm', 'OK responseId=' + responseId);
    } catch (e) {
      result.errors++;
      evLog_('ERROR', 'syncForm', 'FAIL responseId=' + responseId + ' — ' + e.message);
      try {
        var rEmail = String(response.getRespondentEmail() || '').trim();
        if (rEmail) notifySubmissionError_(rEmail, e.message);
      } catch (ne) { Logger.log('Could not send error notification: ' + ne.message); }
    }
  });

  evLog_('INFO', 'syncForm',
    'DONE formId=' + formId +
    ' checked=' + result.checked +
    ' processed=' + result.processed +
    ' errors=' + result.errors);

  if (result.errors === 0) {
    writeProcessedResponseSet_(formId, { cutoff: runStarted.getTime(), ids: {} });
  } else {
    writeProcessedResponseSet_(formId, { cutoff: state.cutoff || 0, ids: processed });
  }
  return result;
}

function processEvFormResponse_(response) {
  var answers = itemsToMap_(response.getItemResponses());
  var email = String(
    response.getRespondentEmail() || answers['Email address'] || answers['Email Address'] || answers['Email'] || ''
  ).trim();
  var uploads = responseUploads_(response);
  handleEvSubmission_(answers, email, uploads);
}

function handleEvSubmission_(answers, email, uploads) {
  evLog_('INFO', 'handleEvSubmission', 'START email=' + email + ' uploads=' + uploads.length);

  if (!email) throw new Error('Could not read your email. Ensure the form collects emails.');

  var ctx = resolveRegistered_(email);

  evLog_('INFO', 'handleEvSubmission',
    'studentId=' + ctx.student_id + ' classId=' + ctx.class_id);

  var unitCode = parseUnitCode_(answers['Unit']);
  if (!unitCode) throw new Error('Please select a unit.');
  var unitRow = findRow_(EV.SHEETS.UNITS, function (u) { return eqi_(u.unit_code, unitCode); });
  if (!unitRow) throw new Error('Unit not found: ' + unitCode);
  if (String(unitRow.programme_id) !== String(ctx.programme_id)) {
    throw new Error('The selected unit does not belong to your programme.');
  }

  var submitted = 0;
  var submittedTypes = [];
  var studentFolderUrl = '';
  uploads.forEach(function (u, idx) {
    var fileId = Array.isArray(u.ids) ? u.ids[0] : u.ids;
    if (!fileId) return;
    var aType = matchAssessment_(u.title) || EV.ASSESSMENT_TYPES[idx] || null;
    if (!aType) {
      evLog_('WARN', 'handleEvSubmission',
        'Upload[' + idx + '] title="' + u.title + '" could not match assessment type — skipped');
      return;
    }
    var result = processSubmission({
      studentId:      ctx.student_id,
      studentEmail:   ctx.student_email,
      programmeId:    ctx.programme_id,
      classId:        ctx.class_id,
      unitId:         unitRow.unit_id,
      assessmentType: aType,
      fileId:         fileId
    });
    if (!result || !result.ok) {
      throw new Error((result && result.error) || 'Could not process uploaded file.');
    }
    if (result.studentFolderUrl) studentFolderUrl = result.studentFolderUrl;
    submitted++;
    submittedTypes.push(aType);
  });

  if (submitted === 0) throw new Error('No files were uploaded. Attach at least one evidence file.');
  evLog_('INFO', 'handleEvSubmission',
    'DONE studentId=' + ctx.student_id + ' filesSubmitted=' + submitted);
  notifySubmissionSuccess_(email, ctx.student_name, unitRow, submittedTypes, studentFolderUrl);
}

function notifySubmissionSuccess_(toEmail, studentName, unitRow, assessmentTypes, folderUrl) {
  try {
    var unitLabel = unitRow.unit_code + ' — ' + unitRow.unit_name;
    var typesList = assessmentTypes.map(function (t) { return '    • ' + t; }).join('\n');
    var folderLine = folderUrl ? 'Evidence folder: ' + folderUrl + '\n' : '';
    MailApp.sendEmail({
      to: toEmail,
      subject: 'Evidence Received — ' + unitLabel,
      body: 'Hello ' + (studentName || toEmail) + ',\n\n' +
            'Your evidence has been received and saved successfully. Please retain this\n' +
            'email as confirmation of your submission.\n\n' +
            folderLine +
            'Submission summary\n' +
            '  Unit:   ' + unitLabel + '\n' +
            '  Files:  ' + assessmentTypes.length + ' received\n' + typesList + '\n\n' +
            'If any file appears to be missing or incorrect, please contact the administrator as soon as possible.\n\n' +
            EV_EMAIL_SIGNATURE
    });
  } catch (e) {
    Logger.log('notifySubmissionSuccess_: could not email ' + toEmail + ': ' + e.message);
  }
}

/* ── Routing ─────────────────────────────────────────────────────────────── */

function resolveRegistered_(email) {
  var row = findRow_(EV.SHEETS.STUDENTS, function (s) { return eqi_(s.email, email); });
  if (!row) {
    throw new Error('"' + email + '" is not registered. Complete registration first, then return to submit evidence.');
  }
  if (!row.class_id || !row.programme_id) {
    throw new Error('Your student record is missing a class/programme. Contact your administrator.');
  }
  return { student_id: row.student_id, student_name: row.name, student_email: row.email, class_id: row.class_id, programme_id: row.programme_id };
}

/* ── Utilities ───────────────────────────────────────────────────────────── */

function itemsToMap_(itemResponses) {
  var m = {};
  itemResponses.forEach(function (ir) { m[ir.getItem().getTitle()] = ir.getResponse(); });
  return m;
}

function responseUploads_(response) {
  var uploads = [];
  response.getItemResponses().forEach(function (ir) {
    if (ir.getItem().getType() === FormApp.ItemType.FILE_UPLOAD) {
      var r = ir.getResponse();
      uploads.push({ title: ir.getItem().getTitle(), ids: Array.isArray(r) ? r : [r] });
    }
  });
  return uploads;
}

function getResponseKey_(response) {
  try { var id = response.getId(); if (id) return String(id); } catch (e) {}
  return String(response.getTimestamp().getTime());
}

function readProcessedResponseSet_(formId) {
  var raw = PropertiesService.getScriptProperties().getProperty(EV.PROP_SYNC_PREFIX + formId);
  if (!raw) return { cutoff: 0, ids: {} };
  try {
    var parsed = JSON.parse(raw);
    if (parsed && parsed.ids) return parsed;
    return { cutoff: 0, ids: parsed || {} };
  } catch (e) {
    return { cutoff: 0, ids: {} };
  }
}

function writeProcessedResponseSet_(formId, state) {
  state = state || { cutoff: 0, ids: {} };
  var ids = state.ids || {};
  var keys = Object.keys(ids).sort(function (a, b) {
    return String(ids[a]).localeCompare(String(ids[b]));
  });
  if (keys.length > 150) {
    var keep = {};
    keys.slice(keys.length - 150).forEach(function (k) { keep[k] = ids[k]; });
    state.ids = keep;
  }
  PropertiesService.getScriptProperties()
    .setProperty(EV.PROP_SYNC_PREFIX + formId, JSON.stringify(state));
}

function matchAssessment_(title) {
  var norm = String(title || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (var i = 0; i < EV.ASSESSMENT_TYPES.length; i++) {
    if (norm.indexOf(EV.ASSESSMENT_TYPES[i]) >= 0) return EV.ASSESSMENT_TYPES[i];
  }
  return null;
}

function parseUnitCode_(value) {
  return String(value || '').split(/\s+(?:–|—|-)\s+/)[0].trim();
}

function notifySubmissionError_(toEmail, errorMessage) {
  var msg = errorMessage || '';
  var intro, steps;

  if (msg.indexOf('not registered') >= 0) {
    var regLink = registrationFormLink_();
    intro = 'The email address ' + toEmail + ' was not found in the student register, so your\n' +
            'evidence could not be linked to a record.';
    steps = '1. Complete your registration using this link: ' +
            (regLink || 'contact your programme coordinator for the registration link') + '\n' +
            '2. Once registered, re-open the submission form and submit your evidence again.';
  } else if (msg.indexOf('No files were uploaded') >= 0) {
    intro = 'Your submission was received, but no files were attached.';
    steps = '1. Re-open the submission form.\n' +
            '2. Attach at least one file in the upload section.\n' +
            '3. Submit again.';
  } else {
    intro = 'Your submission could not be processed due to an unexpected issue.';
    steps = 'Please contact the administrator and quote the following reference so the\n' +
            'issue can be resolved quickly: "' + msg + '"';
  }

  var body =
    'Hello,\n\n' +
    'Your submission was received but could not be processed. Please review the\n' +
    'details below and take the recommended steps.\n\n' +
    'What happened:\n' + intro + '\n\n' +
    'What to do next:\n' + steps + '\n\n' +
    EV_EMAIL_SIGNATURE;

  try {
    MailApp.sendEmail({ to: toEmail, subject: 'Evidence Submission — Action Required', body: body });
  } catch (e) {
    Logger.log('notifySubmissionError_: could not email ' + toEmail + ': ' + e.message);
  }
}
