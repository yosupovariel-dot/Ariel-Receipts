// שמירה וטעינה: GitHub (מקור האמת) + עותק מוצפן מקומי לגיבוי ולעבודה ללא רשת

import { CONFIG } from './config.js';
import { b64, unb64, deriveRaw, importAes, encryptJson, decryptJson, encryptString, decryptString, ITERATIONS } from './crypto.js';
import { normalize, mergeData } from './model.js';

const LS_CACHE = 'ar_cache_v1';
const LS_PENDING = 'ar_pending_v1';
const LS_TOKEN = 'ar_token_v1';
const SS_SESSION = 'ar_session_v1';

const API = 'https://api.github.com';

export const session = {
  key: null,
  raw: null,
  salt: null,
  iterations: ITERATIONS,
  data: null,
  sha: null,
  token: null,
  branch: null,
  online: true,
  lastSync: null,
};

const listeners = new Set();
export const onSyncChange = (fn) => listeners.add(fn);
const emit = (state) => listeners.forEach((fn) => fn(state));

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

function ghHeaders(json = true) {
  const h = { Accept: json ? 'application/vnd.github+json' : 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (session.token) h.Authorization = 'Bearer ' + session.token;
  return h;
}

async function getBranch() {
  if (session.branch) return session.branch;
  if (CONFIG.branch) return (session.branch = CONFIG.branch);
  try {
    const r = await fetch(`${API}/repos/${CONFIG.owner}/${CONFIG.repo}`, { headers: ghHeaders(), cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      return (session.branch = j.default_branch);
    }
  } catch {}
  return 'main';
}

/** מביא את הקובץ המוצפן מ-GitHub. מחזיר {envelope, sha} או null */
async function fetchRemote() {
  const branch = await getBranch();
  const url = `${API}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.dataPath}?ref=${encodeURIComponent(branch)}&t=${Date.now()}`;
  const r = await fetch(url, { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) return { envelope: null, sha: null };
  if (!r.ok) throw new Error('github ' + r.status);
  const j = await r.json();
  let content = j.content;
  if (!content && j.sha) {
    const b = await fetch(`${API}/repos/${CONFIG.owner}/${CONFIG.repo}/git/blobs/${j.sha}`, { headers: ghHeaders(), cache: 'no-store' });
    content = (await b.json()).content;
  }
  const text = new TextDecoder().decode(unb64(content.replace(/\s/g, '')));
  return { envelope: JSON.parse(text), sha: j.sha };
}

/** טעינה עם נפילה לאחור: GitHub API → קובץ באתר → עותק מקומי */
async function loadEnvelope() {
  try {
    const res = await fetchRemote();
    if (res.envelope) {
      session.online = true;
      return { ...res, from: 'github' };
    }
  } catch (e) {
    console.warn('GitHub API לא זמין', e);
  }
  try {
    const r = await fetch(CONFIG.dataPath + '?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) return { envelope: await r.json(), sha: null, from: 'site' };
  } catch {}
  const cached = lsGet(LS_CACHE);
  if (cached) {
    session.online = false;
    return { envelope: JSON.parse(cached), sha: null, from: 'cache' };
  }
  return { envelope: null, sha: null, from: 'none' };
}

async function decryptWithSession(envelope) {
  return normalize(await decryptJson(envelope, session.key));
}

/** כניסה למערכת. זורק Error('bad-password') אם הסיסמה שגויה */
export async function login(password) {
  const { envelope, sha, from } = await loadEnvelope();
  if (!envelope) throw new Error('no-data');
  const salt = unb64(envelope.kdf.salt);
  const iterations = envelope.kdf.iterations || ITERATIONS;
  const raw = await deriveRaw(password, salt, iterations);
  const key = await importAes(raw);
  let data;
  try {
    data = normalize(await decryptJson(envelope, key));
  } catch {
    throw new Error('bad-password');
  }
  Object.assign(session, { key, raw, salt, iterations, data, sha });
  await afterUnlock(from);
  saveSession();
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
  if (!s || s.exp < Date.now()) {
    clearSession();
    return false;
  }
  session.raw = unb64(s.raw);
  session.salt = unb64(s.salt);
  session.iterations = s.iterations;
  session.key = await importAes(session.raw);
  const { envelope, sha, from } = await loadEnvelope();
  if (!envelope) return false;
  try {
    session.data = await decryptWithSession(envelope);
  } catch {
    clearSession();
    return false;
  }
  session.sha = sha;
  await afterUnlock(from);
  return true;
}

async function afterUnlock(from) {
  // טוקן GitHub מקומי (מוצפן במפתח הסיסמה)
  const packed = lsGet(LS_TOKEN);
  session.token = null;
  if (packed) {
    try {
      session.token = await decryptString(packed, session.key);
    } catch {
      lsSet(LS_TOKEN, null);
    }
  }
  // אם יש טוקן — נטען שוב עם הרשאה כדי לקבל גרסה עדכנית ו-sha
  if (session.token && from !== 'github-auth') {
    try {
      const res = await fetchRemote();
      if (res.envelope) {
        session.data = await decryptWithSession(res.envelope);
        session.sha = res.sha;
        session.online = true;
      }
    } catch {}
  }
  // שינויים מקומיים שטרם סונכרנו
  const cached = lsGet(LS_CACHE);
  if (cached && hasPending()) {
    try {
      const local = await decryptWithSession(JSON.parse(cached));
      session.data = mergeData(local, session.data);
    } catch {}
  }
  await writeCache();
  if (hasPending() && session.token) sync().catch(() => {});
  emit(state());
}

export function saveSession() {
  try {
    sessionStorage.setItem(
      SS_SESSION,
      JSON.stringify({ raw: b64(session.raw), salt: b64(session.salt), iterations: session.iterations, exp: Date.now() + CONFIG.idleMinutes * 60000 })
    );
  } catch {}
}

export function touchSession() {
  if (session.key) saveSession();
}

export function clearSession() {
  try {
    sessionStorage.removeItem(SS_SESSION);
  } catch {}
}

export function logout() {
  clearSession();
  Object.assign(session, { key: null, raw: null, data: null, sha: null, token: null });
}

async function makeEnvelope() {
  return encryptJson(session.data, session.key, session.salt, session.iterations);
}

async function writeCache() {
  lsSet(LS_CACHE, JSON.stringify(await makeEnvelope()));
}

export function state() {
  return {
    connected: !!session.token,
    pending: hasPending(),
    online: session.online,
    lastSync: session.lastSync,
  };
}

/** שמירת הנתונים: מקומית מיד, ול-GitHub אם יש טוקן */
export async function save(message = 'עדכון נתונים') {
  session.data.updatedAt = new Date().toISOString();
  lsSet(LS_PENDING, '1');
  await writeCache();
  emit({ ...state(), saving: true });
  if (!session.token) {
    emit(state());
    return { synced: false, reason: 'no-token' };
  }
  try {
    await sync(message);
    return { synced: true };
  } catch (e) {
    console.error(e);
    emit({ ...state(), error: e.message });
    return { synced: false, reason: e.message };
  }
}

async function putRemote(message) {
  const branch = await getBranch();
  const envelope = await makeEnvelope();
  const content = b64(new TextEncoder().encode(JSON.stringify(envelope, null, 1)));
  const body = { message, content, branch };
  if (session.sha) body.sha = session.sha;
  const r = await fetch(`${API}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.dataPath}`, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r;
}

export async function sync(message = 'עדכון נתונים') {
  if (!session.token) throw new Error('no-token');
  let r = await putRemote(message);
  if (r.status === 409 || r.status === 422) {
    // מישהו שמר במקביל — ממזגים ומנסים שוב
    const res = await fetchRemote();
    if (res.envelope) {
      const remote = await decryptWithSession(res.envelope);
      session.data = mergeData(session.data, remote);
      session.sha = res.sha;
    } else session.sha = null;
    r = await putRemote(message);
  }
  if (r.status === 401 || r.status === 403) throw new Error('הטוקן של GitHub לא תקין או חסרות לו הרשאות');
  if (!r.ok) throw new Error('שגיאת GitHub ' + r.status);
  const j = await r.json();
  session.sha = j.content.sha;
  session.online = true;
  session.lastSync = new Date().toISOString();
  lsSet(LS_PENDING, null);
  await writeCache();
  emit(state());
}

/** שמירת/בדיקת טוקן GitHub */
export async function setToken(token) {
  token = (token || '').trim();
  if (!token) {
    session.token = null;
    lsSet(LS_TOKEN, null);
    emit(state());
    return true;
  }
  const r = await fetch(`${API}/repos/${CONFIG.owner}/${CONFIG.repo}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error('הטוקן לא תקין (' + r.status + ')');
  const j = await r.json();
  if (j.permissions && !j.permissions.push) throw new Error('לטוקן אין הרשאת כתיבה (Contents: Read and write)');
  session.token = token;
  session.branch = j.default_branch;
  lsSet(LS_TOKEN, await encryptString(token, session.key));
  // מושכים את הגרסה העדכנית לפני סנכרון
  try {
    const res = await fetchRemote();
    if (res.envelope) {
      const remote = await decryptWithSession(res.envelope);
      session.data = hasPending() ? mergeData(session.data, remote) : remote;
      session.sha = res.sha;
    }
  } catch {}
  if (hasPending()) await sync('סנכרון שינויים מקומיים');
  emit(state());
  return true;
}

/** החלפת סיסמה — מצפין מחדש עם מלח חדש */
export async function changePassword(newPassword) {
  const { randomBytes } = await import('./crypto.js');
  const salt = randomBytes(16);
  const raw = await deriveRaw(newPassword, salt, ITERATIONS);
  const key = await importAes(raw);
  const token = session.token;
  Object.assign(session, { salt, raw, key, iterations: ITERATIONS });
  if (token) lsSet(LS_TOKEN, await encryptString(token, key));
  saveSession();
  return save('החלפת מפתח הצפנה');
}

export async function exportEncrypted() {
  return JSON.stringify(await makeEnvelope(), null, 1);
}

export async function importEncrypted(text, password) {
  const env = JSON.parse(text);
  const raw = await deriveRaw(password, unb64(env.kdf.salt), env.kdf.iterations);
  const key = await importAes(raw);
  return normalize(await decryptJson(env, key));
}
