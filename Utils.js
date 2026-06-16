/**
 * Utils.gs — shared pure-utility functions used across all modules.
 */

function sanitize_(s) { return String(s).replace(/[\/\\:*?"<>|]/g, '-').trim(); }

function eqi_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}


/**
 * True when the email's domain is in the configurable org domain allowlist.
 * Domains are read from Script Properties at runtime via getOrgEmailDomains_().
 */
function isAllowedOrgEmail_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 0) return false;
  var domain = email.split('@').pop();
  return getOrgEmailDomains_().some(function (d) {
    return domain === String(d).toLowerCase();
  });
}

function allowedDomainText_() {
  return '@' + getOrgEmailDomains_().join(' or @');
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function toIso_(v) {
  if (!v) return '';
  try { return new Date(v).toISOString(); } catch (e) { return ''; }
}

/* ── Persistent activity logger ─────────────────────────────────────────── */

function evLog_(level, tag, msg) {
  Logger.log('[EV][' + level + '][' + tag + '] ' + msg);
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(EV.PROP_SYSTEM_LOG) || '[]';
    var buf;
    try { buf = JSON.parse(raw); if (!Array.isArray(buf)) buf = []; }
    catch (pe) { buf = []; }
    buf.push({
      ts: new Date().toISOString(),
      lv: level,
      tg: String(tag).slice(0, 24),
      ms: String(msg || '').slice(0, 120)
    });
    if (buf.length > 40) buf = buf.slice(buf.length - 40);
    props.setProperty(EV.PROP_SYSTEM_LOG, JSON.stringify(buf));
  } catch (le) {}
}

/**
 * Renders a styled full-page error screen for portal access problems.
 */
function portalErrorPage_(title, icon, detail1, detail2, steps) {
  var stepsHtml = steps.map(function (s) {
    return '<li style="margin-bottom:8px">' + s + '</li>';
  }).join('');
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">',
    '<style>',
    '*{box-sizing:border-box}',
    'body{margin:0;min-height:100vh;background:#f5f2ea;display:flex;align-items:center;justify-content:center;font-family:"IBM Plex Sans",system-ui,sans-serif;font-size:14px;color:#1d1b16}',
    '.card{background:#fffdf8;border:1px solid #e6dfd0;border-radius:18px;padding:40px 44px;max-width:520px;width:90%;box-shadow:0 1px 2px rgba(29,27,22,.04),0 10px 30px rgba(29,27,22,.10)}',
    '.icon{font-size:48px;margin-bottom:16px}',
    'h1{font-size:22px;font-weight:600;margin:0 0 12px;color:#0a463d}',
    '.detail{color:#4a4640;line-height:1.55;margin-bottom:8px}',
    '.steps-head{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#726c61;margin:20px 0 8px}',
    'ol{margin:0;padding-left:22px;color:#4a4640;line-height:1.6}',
    '</style></head><body>',
    '<div class="card">',
    '<div class="icon">' + icon + '</div>',
    '<h1>' + escapeHtml_(title) + '</h1>',
    '<p class="detail">' + detail1 + '</p>',
    '<p class="detail">' + detail2 + '</p>',
    '<div class="steps-head">What to do</div>',
    '<ol>' + stepsHtml + '</ol>',
    '</div></body></html>'
  ].join('');
}
