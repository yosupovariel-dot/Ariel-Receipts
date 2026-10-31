/**
 * מערכת הקבלות של אריאל — גשר ל-Google Drive
 * ------------------------------------------------
 * הסקריפט רץ בחשבון הגוגל שלך, וניגש רק לתיקייה שהגדרת ב-FOLDER_ID.
 * הוא יודע: לרשום את הקבלות שכבר יש בתיקייה (לפי שנים), להעלות קבלה חדשה
 * לתיקיית השנה המתאימה (ויוצר אותה אם חסרה), ולשמור גיבוי מוצפן של הנתונים.
 *
 * הוראות התקנה מלאות: בקובץ README.md במאגר (סעיף "חיבור Google Drive").
 */

// 1) מזהה תיקיית הקבלות הראשית — החלק שאחרי folders/ בכתובת התיקייה
const FOLDER_ID = 'PASTE_FOLDER_ID_HERE';

// 2) קוד סודי — אותו קוד מדביקים בהגדרות האתר. אל תשתף אותו.
const SECRET = 'PASTE_A_LONG_RANDOM_SECRET_HERE';

const BACKUP_FOLDER = '_גיבוי נתוני מערכת';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (!SECRET || SECRET.indexOf('PASTE_') === 0 || body.secret !== SECRET) {
      return json_({ ok: false, error: 'קוד סודי שגוי' });
    }
    const root = DriveApp.getFolderById(FOLDER_ID);
    switch (body.action) {
      case 'ping':
        return json_({ ok: true, folder: root.getName() });
      case 'list':
        return json_({ ok: true, folder: root.getName(), years: list_(root) });
      case 'upload':
        return json_(Object.assign({ ok: true }, upload_(root, body)));
      case 'backup':
        return json_(Object.assign({ ok: true }, backup_(root, body)));
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
    if (name === BACKUP_FOLDER) continue;
    const files = sub.getFiles();
    while (files.hasNext()) add(name, files.next());
  }
  const loose = root.getFiles();
  while (loose.hasNext()) add('ללא שנה', loose.next());
  Object.keys(years).forEach((y) => years[y].sort((a, b) => (a.name < b.name ? 1 : -1)));
  return years;
}

function yearFolder_(root, year) {
  const it = root.getFoldersByName(year);
  return it.hasNext() ? it.next() : root.createFolder(year);
}

function upload_(root, body) {
  const year = String(body.year || new Date().getFullYear()).replace(/[^0-9]/g, '').slice(0, 4);
  const folder = yearFolder_(root, year);
  const name = String(body.fileName || 'קבלה.pdf').replace(/[\\/:*?"<>|]/g, ' ');
  // קובץ קיים באותו שם — מעבירים לאשפה ומחליפים
  const existing = folder.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);
  const blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mimeType || 'application/pdf', name);
  const file = folder.createFile(blob);
  return { id: file.getId(), url: file.getUrl(), year: year };
}

function backup_(root, body) {
  const folder = yearFolder_(root, BACKUP_FOLDER);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM');
  const name = 'receipts-backup-' + stamp + '.enc.json';
  const existing = folder.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);
  const file = folder.createFile(name, String(body.data || ''), 'application/json');
  return { id: file.getId(), name: name };
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
