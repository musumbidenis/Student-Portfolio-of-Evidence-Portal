/**
 * Tracker.gs — writes student details and folder links to the tracking spreadsheet.
 *
 * The tracker spreadsheet is separate from the admin data spreadsheet.
 * It has one tab per programme. Each row records a student's details
 * and their Drive folder URL.
 *
 * Written once per student on their first form submission, guarded by
 * EV.PROP_STUDENT_TRACKED_PREFIX + student_id in Script Properties.
 */

var TRACKER_HEADERS_ = [
  'student_id', 'name', 'email', 'admission_no',
  'class', 'programme', 'folder_url', 'first_submission_date'
];

/**
 * Writes student details and folder URL to the tracker spreadsheet.
 * Called from processSubmission() on every submission; the Script Property
 * guard ensures the row is only written once per student.
 *
 * @param {object} student     - Student row object from the Students sheet.
 * @param {object} ctx         - { programme, class, unit } row objects.
 * @param {Folder} studentFolder - The student's Drive folder (one level above unit folder).
 */
function trackStudentFolderOnce_(student, ctx, studentFolder) {
  if (!student || !student.student_id) return;

  var props = PropertiesService.getScriptProperties();
  var key = EV.PROP_STUDENT_TRACKED_PREFIX + student.student_id;
  if (props.getProperty(key)) return;

  try {
    var tracker = getTrackerSpreadsheet_();
    var programmeName = ctx.programme.programme_name;
    var sheet = getOrCreateTrackerTab_(tracker, programmeName);

    sheet.appendRow([
      student.student_id,
      student.name        || '',
      student.email       || '',
      student.admission_no || '',
      ctx.class.class_name || '',
      programmeName,
      studentFolder.getUrl(),
      new Date().toISOString()
    ]);

    props.setProperty(key, new Date().toISOString());
    evLog_('INFO', 'trackStudentFolder',
      'Tracked studentId=' + student.student_id + ' programme=' + programmeName);
  } catch (e) {
    evLog_('ERROR', 'trackStudentFolder',
      'Failed for studentId=' + student.student_id + ': ' + e.message);
  }
}

/**
 * Returns the tracker tab for a programme, creating it (with headers) if absent.
 * Tab name is the sanitized programme name, capped at 100 characters to stay
 * within Google Sheets' 100-character sheet-name limit.
 */
function getOrCreateTrackerTab_(tracker, programmeName) {
  var tabName = sanitize_(programmeName).slice(0, 100);
  var sheet = tracker.getSheetByName(tabName);
  if (!sheet) {
    sheet = tracker.insertSheet(tabName);
    var headerRange = sheet.getRange(1, 1, 1, TRACKER_HEADERS_.length);
    headerRange.setValues([TRACKER_HEADERS_]);
    headerRange.setFontWeight('bold').setBackground('#0f5c52').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    evLog_('INFO', 'trackerTab', 'Created tab "' + tabName + '" in tracker spreadsheet.');
  }
  return sheet;
}
