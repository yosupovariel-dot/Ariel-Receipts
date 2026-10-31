// חיבור ל-Google Drive דרך Google Apps Script (רץ בחשבון הגוגל של אריאל, ניגש רק לתיקיית הקבלות)

import { session } from './store.js';

function cfg() {
  const s = session.data?.settings || {};
  return { url: (s.driveUrl || '').trim(), secret: (s.driveSecret || '').trim() };
}

export const driveConfigured = () => {
  const { url, secret } = cfg();
  return !!(url && secret);
};

async function call(payload) {
  const { url, secret } = cfg();
  if (!url || !secret) throw new Error('Google Drive לא מחובר');
  // text/plain כדי להימנע מבקשת preflight שלא נתמכת ב-Apps Script
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret }),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error('Drive ' + r.status);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'שגיאה ב-Drive');
  return j;
}

export const drivePing = () => call({ action: 'ping' });

/** רשימת קבלות לפי שנים: { years: { '2025': [{id,name,url,created,size}] } } */
export const driveList = () => call({ action: 'list' });

export async function driveUpload(blob, fileName, year) {
  const base64 = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
  return call({ action: 'upload', fileName, year: String(year), mimeType: 'application/pdf', data: base64 });
}

/** גיבוי של קובץ הנתונים המוצפן לתוך Drive */
export const driveBackup = (text) => call({ action: 'backup', data: text });
