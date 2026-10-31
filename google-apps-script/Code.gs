/**
 * מערכת הקבלות של אריאל — גשר ל-Google Drive
 * ------------------------------------------------
 * הסקריפט רץ בחשבון הגוגל שלך, וניגש רק לתיקייה שהגדרת ב-FOLDER_ID.
 * הוא שומר את קובץ הנתונים (מוצפן) של המערכת, מעלה כל קבלה כ-PDF לתיקיית
 * השנה המתאימה, מציג את הקבלות הקיימות, ושומר גיבוי יומי של הנתונים.
 *
 * את הקוד המלא עם הערכים הנכונים מקבלים מתוך האתר: עמוד Drive.
 */

// 1) מזהה תיקיית הקבלות הראשית — החלק שאחרי folders/ בכתובת התיקייה
const FOLDER_ID = 'PASTE_FOLDER_ID_HERE';

// 2) קוד הגישה — מוצג באתר בעמוד Drive (נגזר מהסיסמה; לא לשתף)
const SECRET = 'PASTE_SECRET_FROM_SITE';

const SYSTEM_FOLDER = '_גיבוי נתוני מערכת';
const DATA_FILE = 'receipts-data.enc.json';
const KEEP_DAILY_DAYS = 60;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const secret = currentSecret_();
    if (!secret || secret.indexOf('PASTE_') === 0 || body.secret !== secret) {
      return json_({ ok: false, auth: false, error: 'קוד סודי שגוי' });
    }
    const root = DriveApp.getFolderById(FOLDER_ID);
    switch (body.action) {
      case 'ping':
        return json_({ ok: true, folder: root.getName() });
      case 'list':
        return json_({ ok: true, folder: root.getName(), years: list_(root) });
      case 'upload':
        return json_(Object.assign({ ok: true }, upload_(root, body)));
      case 'getFile':
        return json_(Object.assign({ ok: true }, getFile_(root, body)));
      case 'getData':
        return json_(Object.assign({ ok: true }, getData_(root)));
      case 'putData':
        return json_(putData_(root, body));
      case 'rotate':
        if (!body.newSecret || String(body.newSecret).length < 32) return json_({ ok: false, error: 'קוד חדש לא תקין' });
        PropertiesService.getScriptProperties().setProperty('SECRET', String(body.newSecret));
        return json_({ ok: true });
      default:
        return json_({ ok: false, error: 'פעולה לא מוכרת' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return json_({ ok: true, service: 'ariel-receipts-drive' });
}

function currentSecret_() {
  return PropertiesService.getScriptProperties().getProperty('SECRET') || SECRET;
}

function systemFolder_(root) {
  const it = root.getFoldersByName(SYSTEM_FOLDER);
  return it.hasNext() ? it.next() : root.createFolder(SYSTEM_FOLDER);
}

function dataFile_(root) {
  const it = systemFolder_(root).getFilesByName(DATA_FILE);
  return it.hasNext() ? it.next() : null;
}

function version_() {
  return PropertiesService.getScriptProperties().getProperty('DATA_VERSION') || '0';
}

function getData_(root) {
  const f = dataFile_(root);
  return { data: f ? f.getBlob().getDataAsString('UTF-8') : null, version: version_() };
}

function putData_(root, body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const f = dataFile_(root);
    const cur = version_();
    // מישהו שמר בינתיים ממכשיר אחר — הלקוח ימזג וינסה שוב
    if (f && body.baseVersion !== undefined && body.baseVersion !== null && String(body.baseVersion) !== cur) {
      return { ok: false, conflict: true, version: cur };
    }
    const text = String(body.data || '');
    if (!text) return { ok: false, error: 'נתונים ריקים' };
    if (f) f.setContent(text);
    else systemFolder_(root).createFile(DATA_FILE, text, 'application/json');
    const next = String(Number(cur) + 1);
    PropertiesService.getScriptProperties().setProperty('DATA_VERSION', next);
    dailyBackup_(root, text);
    return { ok: true, version: next };
  } finally {
    lock.releaseLock();
  }
}

/** עותק גיבוי אחד לכל יום; שומר 60 יום אחרונים + את ה-1 לכל חודש לתמיד */
function dailyBackup_(root, text) {
  const folder = systemFolder_(root);
  const tz = 'Asia/Jerusalem';
  const name = 'backup-' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd') + '.enc.json';
  const ex = folder.getFilesByName(name);
  if (ex.hasNext()) ex.next().setContent(text);
  else folder.createFile(name, text, 'application/json');
  const cutoff = Date.now() - KEEP_DAILY_DAYS * 86400000;
  const all = folder.getFiles();
  while (all.hasNext()) {
    const f = all.next();
    const m = f.getName().match(/^backup-(\d{4})-(\d{2})-(\d{2})\.enc\.json$/);
    if (m && m[3] !== '01' && new Date(m[1] + '-' + m[2] + '-' + m[3]).getTime() < cutoff) f.setTrashed(true);
  }
}

function list_(root) {
  const years = {};
  const add = (year, f) => {
    if (f.getMimeType() === MimeType.FOLDER) return;
    (years[year] = years[year] || []).push({
      id: f.getId(),
      name: f.getName(),
      url: f.getUrl(),
      mime: f.getMimeType(),
      created: f.getDateCreated().toISOString(),
      size: f.getSize(),
    });
  };
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const sub = folders.next();
    const name = sub.getName();
    if (name === SYSTEM_FOLDER) continue;
    const m = name.match(/(19|20)\d{2}/);
    const label = m ? m[0] : name;
    const files = sub.getFiles();
    while (files.hasNext()) add(label, files.next());
  }
  const loose = root.getFiles();
  while (loose.hasNext()) add('ללא שנה', loose.next());
  Object.keys(years).forEach((y) => years[y].sort((a, b) => (a.name < b.name ? 1 : -1)));
  return years;
}

/** מוצא תיקיית שנה קיימת (למשל "2025" או "קבלות 2025"), ואם אין — יוצר "קבלות <שנה>" */
function yearFolder_(root, year) {
  const exact = root.getFoldersByName(year);
  if (exact.hasNext()) return exact.next();
  const all = root.getFolders();
  while (all.hasNext()) {
    const f = all.next();
    if (new RegExp('(^|\\D)' + year + '(\\D|$)').test(f.getName())) return f;
  }
  return root.createFolder('קבלות ' + year);
}

function upload_(root, body) {
  const year = String(body.year || new Date().getFullYear()).replace(/[^0-9]/g, '').slice(0, 4);
  const folder = yearFolder_(root, year);
  const name = String(body.fileName || 'קבלה.pdf').replace(/[\\/:*?"<>|]/g, ' ');
  const existing = folder.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);
  const blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mimeType || 'application/pdf', name);
  const file = folder.createFile(blob);
  return { id: file.getId(), url: file.getUrl(), year: year };
}

/** מחזיר קובץ (PDF) מתוך תיקיית הקבלות בלבד — לצורך ייבוא הפרטים לאתר */
function getFile_(root, body) {
  const file = DriveApp.getFileById(String(body.id || ''));
  if (!inside_(file, root.getId(), 3)) throw new Error('הקובץ לא נמצא בתיקיית הקבלות');
  const blob = file.getBlob();
  return { name: file.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

function inside_(item, rootId, depth) {
  if (depth < 0) return false;
  const parents = item.getParents();
  while (parents.hasNext()) {
    const p = parents.next();
    if (p.getId() === rootId || inside_(p, rootId, depth - 1)) return true;
  }
  return false;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** הרץ פעם אחת מתוך העורך כדי לאשר הרשאות ולבדוק שהתיקייה נכונה */
function testSetup() {
  const root = DriveApp.getFolderById(FOLDER_ID);
  Logger.log('התיקייה נמצאה: ' + root.getName());
  Logger.log(JSON.stringify(list_(root), null, 2));
}
