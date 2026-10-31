// הצפנת הנתונים: PBKDF2-SHA256 (600,000 סבבים) + AES-256-GCM
// הסיסמה לעולם לא נשמרת — ממנה נגזר מפתח ההצפנה בלבד.

export const FORMAT = 'ariel-receipts/1';
export const ITERATIONS = 600000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** גוזר מפתח גולמי (32 בתים) מהסיסמה והמלח */
export async function deriveRaw(password, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    256
  );
  return new Uint8Array(bits);
}

export async function importAes(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(obj, key, salt, iterations = ITERATIONS) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return {
    format: FORMAT,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) },
    cipher: { name: 'AES-GCM', iv: b64(iv) },
    data: b64(ct),
    updatedAt: new Date().toISOString(),
  };
}

export async function decryptJson(envelope, key) {
  const iv = unb64(envelope.cipher.iv);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, unb64(envelope.data));
  return JSON.parse(dec.decode(pt));
}

/** הצפנת מחרוזת קצרה (למשל טוקן GitHub שנשמר במכשיר) */
export async function encryptString(str, key) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(str));
  return b64(iv) + '.' + b64(ct);
}

export async function decryptString(packed, key) {
  const [iv, ct] = packed.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return dec.decode(pt);
}
