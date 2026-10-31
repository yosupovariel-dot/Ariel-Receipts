// שמירה וטעינה: Google Drive (מקור האמת) + עותק מוצפן מקומי לגיבוי ולעבודה ללא רשת

import { CONFIG } from './config.js';
import { b64, unb64, deriveRaw, deriveAuth, importAes, encryptJson, decryptJson, ITERATIONS, randomBytes } from './crypto.js';
import { normalize, mergeData, upsertClient, audit } from './model.js';
import { drive, driveUrl, saveDriveUrl, drivePing, driveGetData, drivePutData, driveRotate } from './drive.js';

const LS_CACHE = 'ar_cache_v1';
const LS_PENDING = 'ar_pending_v1';
const SS_SESSION = 'ar_session_v1';

export const session = {
  key: null,
  raw: null,
  salt: null,
  iterations: ITERATIONS,
  data: null,
  version: null, // גרסת הקובץ ב-Drive
  driveOk: false,
  driveError: null, // 'auth' | 'network' | null
  lastSync: null,
};

const listeners = new Set();
export const onSyncChange = (fn) => listeners.add(fn);
const emit = (extra = {}) => listeners.forEach((fn) => fn({ ...state(), ...extra }));

function lsGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k, v) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
}

export const hasPending = () => lsGet(LS_PENDING) === '1';
const driveUsable = () => !!(driveUrl() && drive.secret && session.driveError !== 'auth');

export function state() {
  return {
    configured: !!driveUrl(),
    connected: session.driveOk,
    authError: session.driveError === 'auth',
    pending: hasPending(),
    lastSync: session.lastSync,
  };
}

/** מביא את הנתונים מ-Drive. מחזיר {envelope, version} או null אם אין עדיין קובץ */
async function fetchDrive() {
  const res = await driveGetData();
  session.driveOk = true;
  session.driveError = null;
  return { envelope: res.data ? JSON.parse(res.data) : null, version: res.version };
}

/** טעינה: Drive → עותק מקומי → קובץ התחלתי */
async function loadEnvelope() {
  let driveEmpty = false;
  if (driveUrl() && drive.secret) {
    try {
      const res = await fetchDrive();
      if (res.envelope) return { envelope: res.envelope, version: res.version, from: 'drive' };
      driveEmpty = true;
      session.version = res.version;
    } catch (e) {
      session.driveOk = false;
      session.driveError = e.auth ? 'auth' : 'network';
      console.warn('Drive לא זמין', e);
    }
  }
  const cached = lsGet(LS_CACHE);
  if (cached) return { envelope: JSON.parse(cached), version: null, from: 'cache', driveEmpty };
  try {
    const r = await fetch(CONFIG.seedPath + '?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) return { envelope: await r.json(), version: null, from: 'seed', driveEmpty };
  } catch {}
  return { envelope: null };
}

const decryptWithSession = async (envelope) => normalize(await decryptJson(envelope, session.key));

/** כניסה למערכת. זורק Error('bad-password') אם הסיסמה שגויה */
export async function login(password) {
  drive.secret = await deriveAuth(password);
  const res = await loadEnvelope();
  if (!res.envelope) throw new Error('no-data');
  const salt = unb64(res.envelope.kdf.salt);
  const iterations = res.envelope.kdf.iterations || ITERATIONS;
  const raw = await deriveRaw(password, salt, iterations);
  const key = await importAes(raw);
  let data;
  try {
    data = normalize(await decryptJson(res.envelope, key));
  } catch {
    drive.secret = null;
    throw new Error('bad-password');
  }
  Object.assign(session, { key, raw, salt, iterations, data });
  if (res.from === 'drive') session.version = res.version;
  saveSession();
  await afterUnlock(res, password);
  return session.data;
}

/** שחזור חיבור לאחר רענון הדף (בתוך אותה לשונית בלבד) */
export async function restoreSession() {
  let s;
  try {
    s = JSON.parse(sessionStorage.getItem(SS_SESSION) || 'null');
  } catch {
    return false;
  }
  if (!s || s.exp < Date.now() || !s.auth) {
    clearSession();
    return false;
  }
  session.raw = unb64(s.raw);
  session.salt = unb64(s.salt);
  session.iterations = s.iterations;
  session.key = await importAes(session.raw);
  drive.secret = s.auth;
  const res = await loadEnvelope();
  if (!res.envelope) return false;
  try {
    session.data = await decryptWithSession(res.envelope);
  } catch {
    // הקובץ הוצפן מחדש בסיסמה אחרת (החלפת סיסמה במכשיר אחר)
    clearSession();
    return false;
  }
  if (res.from === 'drive') session.version = res.version;
  await afterUnlock(res);
  return true;
}

/** קבלות היסטוריות שהוכנו מראש (מוצפנות בסיסמה) — מתמזגות אוטומטית פעם אחת */
async function mergeBundledArchive(password) {
  let env;
  try {
    const r = await fetch('data/archive.enc.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return 0;
    env = await r.json();
  } catch {
    return 0;
  }
  let bundle;
  try {
    bundle = await decryptJson(env, session.key);
  } catch {
    if (!password) return 0;
    try {
      const raw = await deriveRaw(password, unb64(env.kdf.salt), env.kdf.iterations);
      bundle = await decryptJson(env, await importAes(raw));
    } catch {
      return 0;
    }
  }
  const d = session.data;
  if ((Number(d.settings.archiveImportVersion) || 0) >= bundle.version) return 0;
  const byNum = new Map(d.receipts.map((r) => [String(r.number), r]));
  let added = 0;
  for (const r of bundle.receipts) {
    const ex = byNum.get(String(r.number));
    if (ex && (ex.source === 'archive' || ex.id === r.id)) continue;
    const rec = { ...r };
    if (ex) rec.conflict = ex.conflict = true; // מספר זהה לקבלה שהופקה במערכת — לבדיקה
    d.receipts.push(rec);
    upsertClient(d, rec.client);
    added++;
  }
  // תיקונים לרשומות ארכיון שכבר יובאו בגרסה קודמת
  for (const pt of bundle.patches || []) {
    const r = d.receipts.find((x) => x.id === pt.id && x.source === 'archive');
    if (!r || (r.patched || []).includes(pt.key)) continue;
    Object.assign(r, pt.set, { updatedAt: new Date().toISOString(), patched: [...(r.patched || []), pt.key] });
    r.total = (r.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    added++;
  }
  const ledgerIds = new Set((d.ledger || []).map((e) => e.id));
  for (const e of bundle.ledger || []) {
    if (ledgerIds.has(e.id)) continue;
    (d.ledger ||= []).push({ ...e });
    added++;
  }
  d.settings.nextNumber = Math.max(Number(d.settings.nextNumber) || 0, Number(bundle.minNextNumber) || 0);
  d.settings.archiveImportVersion = bundle.version;
  if (added) audit(d, 'archive-add', `ייבוא ${added} קבלות היסטוריות (2025–2026)`);
  return added;
}

async function afterUnlock(res, password) {
  session.importedNow = await mergeBundledArchive(password);
  if (session.importedNow) lsSet(LS_PENDING, '1');
  // שינויים מקומיים שטרם נשמרו ב-Drive
  if (res.from === 'drive') {
    const cached = lsGet(LS_CACHE);
    if (cached && hasPending()) {
      try {
        session.data = mergeData(await decryptWithSession(JSON.parse(cached)), session.data);
      } catch {}
    }
  } else if (res.driveEmpty) {
    // Drive מחובר אבל עוד אין בו קובץ נתונים — נעלה את מה שיש
    lsSet(LS_PENDING, '1');
  }
  await writeCache();
  emit();
  if (hasPending() && driveUsable() && session.driveError !== 'network') sync().catch((e) => emit({ error: e.message }));
}

export function saveSession() {
  try {
    sessionStorage.setItem(
      SS_SESSION,
      JSON.stringify({ raw: b64(session.raw), salt: b64(session.salt), iterations: session.iterations, auth: drive.secret, exp: Date.now() + CONFIG.idleMinutes * 60000 })
    );
  } catch {}
}

export const touchSession = () => session.key && saveSession();

export function clearSession() {
  try {
    sessionStorage.removeItem(SS_SESSION);
  } catch {}
}

export function logout() {
  clearSession();
  drive.secret = null;
  Object.assign(session, { key: null, raw: null, data: null, version: null, driveOk: false, driveError: null });
}

const makeEnvelope = () => encryptJson(session.data, session.key, session.salt, session.iterations);

async function writeCache() {
  lsSet(LS_CACHE, JSON.stringify(await makeEnvelope()));
}

/** שמירת הנתונים: מקומית מיד, ול-Drive אם מחובר */
export async function save() {
  session.data.updatedAt = new Date().toISOString();
  lsSet(LS_PENDING, '1');
  await writeCache();
  if (!driveUsable()) {
    emit();
    return { synced: false, reason: 'no-drive' };
  }
  emit({ saving: true });
  try {
    await sync();
    return { synced: true };
  } catch (e) {
    console.error(e);
    emit({ error: e.message });
    return { synced: false, reason: e.message };
  }
}

/** העלאת הנתונים ל-Drive, כולל מיזוג אם נשמרו שינויים ממכשיר אחר */
export async function sync() {
  if (!driveUrl() || !drive.secret) throw new Error('Drive לא מחובר');
  const put = async () => drivePutData(JSON.stringify(await makeEnvelope()), session.version);
  let res;
  try {
    res = await put();
  } catch (e) {
    if (e.auth) {
      session.driveError = 'auth';
      session.driveOk = false;
      emit();
      throw new Error('קוד הגישה ב-Apps Script לא תואם — ראה עמוד Drive');
    }
    if (!e.conflict) {
      session.driveOk = false;
      session.driveError = 'network';
      emit();
      throw e;
    }
    const remote = await fetchDrive();
    if (remote.envelope) session.data = mergeData(session.data, await decryptWithSession(remote.envelope));
    session.version = remote.version;
    res = await put();
  }
  session.version = res.version;
  session.driveOk = true;
  session.driveError = null;
  session.lastSync = new Date().toISOString();
  lsSet(LS_PENDING, null);
  await writeCache();
  emit();
}

/** חיבור (או החלפה) של כתובת ה-Web app */
export async function connectDrive(url) {
  url = (url || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('הכתובת צריכה להתחיל ב-https://script.google.com/macros/s/ ולהסתיים ב-/exec');
  const ping = await drivePing(url).catch((e) => {
    throw new Error(e.auth ? 'קוד הגישה בסקריפט לא תואם. ודא שהדבקת את הקוד המלא מהאתר, שמרת, ופרסמת גרסה חדשה.' : e.message);
  });
  saveDriveUrl(url);
  session.driveOk = true;
  session.driveError = null;
  // אם כבר יש נתונים ב-Drive — ממזגים איתם
  const remote = await fetchDrive();
  session.version = remote.version;
  if (remote.envelope) {
    try {
      session.data = mergeData(session.data, await decryptWithSession(remote.envelope));
    } catch {
      throw new Error('ב-Drive יש קובץ נתונים שהוצפן בסיסמה אחרת');
    }
  }
  lsSet(LS_PENDING, '1');
  await sync();
  return ping;
}

export function disconnectDrive() {
  saveDriveUrl('');
  session.driveOk = false;
  emit();
}

/** החלפת סיסמה — מצפין מחדש ומעדכן את קוד הגישה בסקריפט */
export async function changePassword(newPassword) {
  const newAuth = await deriveAuth(newPassword);
  if (driveUsable()) await driveRotate(newAuth);
  drive.secret = newAuth;
  const salt = randomBytes(16);
  const raw = await deriveRaw(newPassword, salt, ITERATIONS);
  Object.assign(session, { salt, raw, key: await importAes(raw), iterations: ITERATIONS });
  saveSession();
  return save();
}

export async function exportEncrypted() {
  return JSON.stringify(await makeEnvelope(), null, 1);
}

export async function importEncrypted(text, password) {
  const env = JSON.parse(text);
  const raw = await deriveRaw(password, unb64(env.kdf.salt), env.kdf.iterations);
  return normalize(await decryptJson(env, await importAes(raw)));
}
