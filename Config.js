/**
 * Config.gs — central configuration for the Evidence Submission System.
 *
 * Holds names, keys, and constants only. No business logic lives here.
 *
 * Email domain restriction is configurable: stored in Script Properties
 * (EV.PROP_ORG_EMAIL_DOMAINS) as a JSON array. Managed via the Admin
 * portal Settings tab. Default is seeded by setupSystem().
 */

const EV = {
  PROP_MASTER_FORM_ID:    'EV_MASTER_FORM_ID',
  DEFAULT_MASTER_FORM_ID: '',

  PROP_SPREADSHEET_ID:   'EV_SPREADSHEET_ID',
  PROP_ROOT_FOLDER_ID:   'EV_ROOT_FOLDER_ID',
  PROP_TRACKER_SHEET_ID: 'EV_TRACKER_SHEET_ID',

  PROP_REGISTRATION_FORM_ID: 'EV_REGISTRATION_FORM_ID',
  PROP_PROGRAMME_FORMS: 'EV_PROGRAMME_FORMS',
  PROP_SYNC_SETTINGS:   'EV_SYNC_SETTINGS',
  PROP_SYNC_PREFIX:     'EV_SYNCED_RESPONSES_',

  PROP_STUDENT_TRACKED_PREFIX: 'EV_STUDENT_TRACKED_',

  PROP_SYSTEM_LOG: 'EV_SYSTEM_LOG',

  // Allowed email domains — stored as JSON array in Script Properties.
  // getOrgEmailDomains_() reads this at runtime so it can be changed
  // without touching code.
  PROP_ORG_EMAIL_DOMAINS:    'EV_ORG_EMAIL_DOMAINS',
  DEFAULT_ORG_EMAIL_DOMAINS: ['rvnp.ac.ke', 'gmail.com'],

  ROOT_FOLDER_NAME: 'Evidence Repository',

  ASSESSMENT_TYPES: ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'PRAC1', 'PRAC2', 'PRAC3'],

  SHEETS: {
    PROGRAMMES: 'Programmes',
    CLASSES:    'Classes',
    UNITS:      'Units',
    STUDENTS:   'Students',
    ADMINS:     'Admins'
  }
};

const EV_HEADERS = {
  Programmes: ['programme_id', 'programme_name'],
  Classes:    ['class_id', 'class_name', 'programme_id'],
  Units:      ['unit_id', 'unit_code', 'unit_name', 'programme_id'],
  Students:   ['student_id', 'name', 'email', 'admission_no', 'class_id', 'programme_id'],
  Admins:     ['email', 'name']
};

/**
 * Returns the allowed email domains from Script Properties.
 * Falls back to DEFAULT_ORG_EMAIL_DOMAINS if the property is not set.
 */
function getOrgEmailDomains_() {
  var raw = PropertiesService.getScriptProperties().getProperty(EV.PROP_ORG_EMAIL_DOMAINS);
  if (!raw) return EV.DEFAULT_ORG_EMAIL_DOMAINS.slice();
  try {
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (e) {}
  return EV.DEFAULT_ORG_EMAIL_DOMAINS.slice();
}
