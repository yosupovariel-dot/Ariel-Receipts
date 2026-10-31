// חיבור ל-Google Drive דרך Google Apps Script (רץ בחשבון הגוגל של אריאל, ניגש רק לתיקיית הקבלות)

import { CONFIG } from './config.js';

const LS_URL = 'ar_drive_url_v1';

/** קוד הגישה (נגזר מהסיסמה בזמן הכניסה) */
export const drive = { secret: null };

export function driveUrl() {
  let u = '';
  try {
    u = localStorage.getItem(LS_URL) || '';
  } catch {}
  return (u || CONFIG.driveUrl || '').trim();
}

export function saveDriveUrl(url) {
  try {
    if (url) localStorage.setItem(LS_URL, url.trim());
    else localStorage.removeItem(LS_URL);
  } catch {}
}

export const driveConfigured = () => !!(driveUrl() && drive.secret);

export async function driveCall(payload, url = driveUrl()) {
  if (!url || !drive.secret) throw new Error('Google Drive לא מחובר');
  // text/plain כדי להימנע מבקשת preflight שלא נתמכת ב-Apps Script
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret: drive.secret }),
    redirect: 'follow',
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('Drive ' + r.status);
  let j;
  try {
    j = await r.json();
  } catch {
    throw new Error('תשובה לא צפויה מ-Drive — בדוק שהכתובת מסתיימת ב-/exec ושהפריסה היא "כל אחד"');
  }
  if (!j.ok) {
    const e = new Error(j.error || 'שגיאה ב-Drive');
    e.auth = j.auth === false;
    e.conflict = !!j.conflict;
    e.result = j;
    throw e;
  }
  return j;
}

export const drivePing = (url) => driveCall({ action: 'ping' }, url);

/** רשימת קבלות לפי שנים: { years: { '2025': [{id,name,url,created,size}] } } */
export const driveList = () => driveCall({ action: 'list' });

export const driveGetData = () => driveCall({ action: 'getData' });
export const drivePutData = (data, baseVersion) => driveCall({ action: 'putData', data, baseVersion });
export const driveRotate = (newSecret) => driveCall({ action: 'rotate', newSecret });

export async function driveUpload(blob, fileName, year) {
  const base64 = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
  return driveCall({ action: 'upload', fileName, year: String(year), mimeType: 'application/pdf', data: base64 });
}

/** מוריד קובץ מתיקיית הקבלות (base64) */
export const driveGetFile = (id) => driveCall({ action: 'getFile', id });
