// יצירת קובץ נתונים מוצפן ריק (פעם אחת, או לאיפוס).
// שימוש:  RECEIPTS_PASSWORD='...' node tools/create-data.mjs [data/receipts.enc.json]
// הסיסמה לא נשמרת בשום מקום — רק משמשת לגזירת מפתח ההצפנה.
import { writeFileSync, existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;

const { deriveRaw, importAes, encryptJson, randomBytes } = await import('../assets/js/crypto.js');
const { emptyData } = await import('../assets/js/model.js');

const password = process.env.RECEIPTS_PASSWORD;
const out = process.argv[2] || 'data/receipts.enc.json';
if (!password) {
  console.error('חסר RECEIPTS_PASSWORD');
  process.exit(1);
}
if (existsSync(out) && !process.env.FORCE) {
  console.error(`${out} כבר קיים. להחלפה: FORCE=1`);
  process.exit(1);
}
const salt = randomBytes(16);
const key = await importAes(await deriveRaw(password, salt));
const env = await encryptJson(emptyData(), key, salt);
writeFileSync(out, JSON.stringify(env, null, 1));
console.log('נוצר', out);
