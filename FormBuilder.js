/**
 * FormBuilder.gs — one form PER PROGRAMME, created by copying the master form.
 *
 * The master form is a template that already contains the 7 file-upload
 * questions. We copy it once per programme, then configure the copy:
 * Programme locked, Unit dropdown scoped to that programme.
 *
 * Layout of each programme form:
 *   [Email auto-collected]
 *   Form description — registration link guidance
 *   Programme (locked to this programme)
 *   Unit (this programme's units)
 *   7 file-upload questions
 *
 * NOTE — one-time fix after each new form is created:
 * When a form is copied, Google Forms loses the file-upload folder reference.
 * The Admin portal automatically opens the form editor after creation.
 * Click the yellow "Fix file upload settings" banner at the top of the editor.
 * Takes ~3 seconds. Only needed once per programme form.
 */

function createProgrammeFormCopy_(programmeId) {
  var prog = findRow_(EV.SHEETS.PROGRAMMES, function (p) {
    return String(p.programme_id) === String(programmeId);
  });
  if (!prog) throw new Error('Programme not found: ' + programmeId);

  var copy = DriveApp.getFileById(getMasterFormId_()).makeCopy('Evidence - ' + prog.programme_name);
  var formId = copy.getId();
  prepareProgrammeForm(formId, programmeId);
  return formId;
}

function prepareProgrammeForm(formId, programmeId) {
  var prog = findRow_(EV.SHEETS.PROGRAMMES, function (p) {
    return String(p.programme_id) === String(programmeId);
  });
  if (!prog) throw new Error('Programme not found: ' + programmeId);

  var form = FormApp.openById(formId);
  form.setTitle('POE Submission - ' + prog.programme_name);

  try { form.setAcceptingResponses(true); } catch (e0) {}
  try { form.removeDestination(); }         catch (e1) {}
  // Collect the respondent's email automatically (verified — captured on submit).
  try { form.setCollectEmail(true); }
  catch (e2) {
    try { form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED); }
    catch (e3) { Logger.log('Email collection not set: ' + e3.message); }
  }

  // Keep the 7 file-upload questions and section page breaks; delete everything else.
  var fileUploadCount = 0, toDelete = [];
  form.getItems().forEach(function (item) {
    if (item.getType() === FormApp.ItemType.FILE_UPLOAD) fileUploadCount++;
    else if (item.getType() !== FormApp.ItemType.PAGE_BREAK) toDelete.push(item);
  });
  if (fileUploadCount === 0) {
    throw new Error('No file-upload questions found in the master form. Add the 7 uploads first.');
  }
  toDelete.forEach(function (item) { try { form.deleteItem(item); } catch (e) {} });

  // Inject Programme (locked) and Unit — appended last, then moved into position.
  var progItem = form.addListItem().setTitle('Programme').setRequired(true)
    .setHelpText('Your programme.');
  progItem.setChoices([progItem.createChoice(prog.programme_name)]);
  var unitItem = form.addListItem().setTitle('Unit').setRequired(true);
  setChoicesFrom_(unitItem, readTable_(EV.SHEETS.UNITS).rows
    .filter(function (u) { return String(u.programme_id) === String(programmeId); })
    .map(function (u) { return u.unit_code + ' - ' + u.unit_name; }));

  // Slide Programme and Unit to just after the section break (index 0),
  // so the order in section 2 is: Programme → Unit → CAT/PRAC uploads.
  var total = form.getItems().length;
  form.moveItem(total - 2, 1); // Programme → index 1
  form.moveItem(total - 1, 2); // Unit      → index 2

  try { form.setPublished(true); } catch (e4) {}
  setFormAudienceAnyone_(formId); // responders: Anyone with the link
  Logger.log('Configured programme form ' + formId + ' (' + fileUploadCount + ' uploads).');
}

function createRegistrationForm_() {
  var form = FormApp.create('Student Registration');

  // Collect the respondent's email automatically (verified — captured on submit).
  try { form.setCollectEmail(true); }
  catch (e2) {
    try { form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED); } catch (e3) {}
  }

  form.addTextItem().setTitle('Official Names').setRequired(true)
    .setHelpText('Enter your full official name as it appears on your ID.');
  form.addTextItem().setTitle('Admission Number').setRequired(true)
    .setHelpText('Your institution admission number.');

  form.addListItem().setTitle('Class').setRequired(true);
  refreshRegistrationClassChoices_(form);

  var formId = form.getId();
  PropertiesService.getScriptProperties().setProperty(EV.PROP_REGISTRATION_FORM_ID, formId);
  try { form.setPublished(true); } catch (eP) {}
  setFormAudienceAnyone_(formId); // responders: Anyone with the link
  evLog_('INFO', 'createRegistrationForm', 'Created formId=' + formId);
  return form;
}

/**
 * Re-populates the "Class" dropdown on the registration form from the
 * current Classes sheet, in place (same form ID/URL). Returns the number
 * of class choices set. Throws if the form has no "Class" question.
 */
function refreshRegistrationClassChoices_(form) {
  var classItem = findListItemByTitle_(form, 'Class');
  if (!classItem) throw new Error('No "Class" question found on the registration form.');
  var classes = readTable_(EV.SHEETS.CLASSES).rows.slice()
    .sort(function (a, b) { return String(a.class_name).localeCompare(String(b.class_name)); });
  return setChoicesFrom_(classItem, classes.map(function (c) { return c.class_name; }));
}

function findListItemByTitle_(form, title) {
  var items = form.getItems(FormApp.ItemType.LIST);
  for (var i = 0; i < items.length; i++) {
    if (items[i].getTitle() === title) return items[i].asListItem();
  }
  return null;
}

function setChoicesFrom_(listItem, values) {
  var seen = {};
  var unique = (values || []).filter(function (v) {
    var key = String(v == null ? '' : v).trim();
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
  if (unique.length) {
    listItem.setChoices(unique.map(function (v) { return listItem.createChoice(v); }));
  }
  return unique.length;
}

/**
 * Sets a form's responder audience to "Anyone with the link".
 *
 * The Apps Script Form class exposes no audience setting (setRequireLogin is
 * deprecated), so we add a Drive permission with the special published-responder
 * "view", per Google's publish-form guide:
 *   https://developers.google.com/workspace/forms/api/guides/publish-form
 *
 * Requires the Drive advanced service (v3) enabled in appsscript.json.
 * Best-effort: logs and continues on failure so form creation still succeeds.
 */
function setFormAudienceAnyone_(formId) {
  try {
    Drive.Permissions.create(
      { type: 'anyone', role: 'reader', view: 'published' },
      formId,
      { supportsAllDrives: true }
    );
    evLog_('INFO', 'formAudience', 'Set Anyone-with-link for formId=' + formId);
  } catch (e) {
    Logger.log('setFormAudienceAnyone_: ' + formId + ' — ' + e.message);
    evLog_('WARN', 'formAudience', 'Could not set Anyone-with-link for formId=' + formId + ': ' + e.message);
  }
}
