// מבנה הנתונים ופונקציות עסקיות

import { round2, todayISO } from './util.js';

export const PAYMENT_METHODS = {
  bit: { label: 'ביט (Bit)', fields: ['ref'] },
  paybox: { label: 'פייבוקס (PayBox)', fields: ['ref'] },
  transfer: { label: 'העברה בנקאית', fields: ['bank', 'branch', 'account', 'ref'] },
  cash: { label: 'מזומן', fields: [] },
  credit: { label: 'כרטיס אשראי', fields: ['cardType', 'last4', 'installments'] },
  cheque: { label: "צ'ק", fields: ['bank', 'branch', 'account', 'chequeNo'] },
  paypal: { label: 'PayPal', fields: ['ref'] },
  app: { label: 'אפליקציית תשלום אחרת', fields: ['appName', 'ref'] },
  other: { label: 'אחר', fields: ['ref'] },
};

export const FIELD_LABELS = {
  ref: 'אסמכתא / מס׳ עסקה',
  bank: 'בנק',
  branch: 'סניף',
  account: 'מס׳ חשבון',
  chequeNo: 'מס׳ צ׳ק',
  cardType: 'סוג כרטיס',
  last4: '4 ספרות אחרונות',
  installments: 'מס׳ תשלומים',
  appName: 'שם האפליקציה',
};

/** טקסט פירוט לשורת תשלום (כפי שיופיע בקבלה) */
export function paymentDetails(p) {
  const parts = [];
  switch (p.method) {
    case 'bit':
      parts.push('bit');
      break;
    case 'paybox':
      parts.push('PayBox');
      break;
    case 'paypal':
      parts.push('PayPal');
      break;
    case 'app':
      if (p.appName) parts.push(p.appName);
      break;
    case 'credit':
      if (p.cardType) parts.push(p.cardType);
      if (p.last4) parts.push('**** ' + p.last4);
      if (Number(p.installments) > 1) parts.push(p.installments + ' תשלומים');
      break;
    case 'cheque':
      if (p.chequeNo) parts.push('צ׳ק ' + p.chequeNo);
      break;
  }
  if (p.bank) parts.push('בנק ' + p.bank);
  if (p.branch) parts.push('סניף ' + p.branch);
  if (p.account) parts.push('חשבון ' + p.account);
  if (p.ref) parts.push('אסמכתא ' + p.ref);
  return parts.join(' | ');
}

export function methodLabel(m) {
  if (m === 'bit' || m === 'paybox' || m === 'app' || m === 'paypal') return 'אפליקציית תשלום';
  return PAYMENT_METHODS[m]?.label || 'אחר';
}

export const DEFAULT_BUSINESS = {
  name: 'אריאל יוסופוב- עיצוב אתרים',
  nameEn: 'ArielYosupov-WebDesign',
  type: 'עוסק פטור',
  taxId: '216193482',
  address: 'משה גבין 19, ראשון לציון',
  phone: '0556658131',
  email: '',
  website: '',
};

export function emptyData() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    business: { ...DEFAULT_BUSINESS },
    settings: {
      nextNumber: 80018,
      numberConfirmed: false,
      ceiling: 120000,
      driveUrl: '',
      driveSecret: '',
      driveAutoUpload: true,
      defaultSubject: '',
    },
    clients: [],
    receipts: [],
    audit: [],
  };
}

/** משלים שדות חסרים לנתונים ישנים */
export function normalize(data) {
  const base = emptyData();
  data = data || {};
  data.business = { ...base.business, ...(data.business || {}) };
  data.settings = { ...base.settings, ...(data.settings || {}) };
  data.clients = data.clients || [];
  data.receipts = data.receipts || [];
  data.audit = data.audit || [];
  data.version = data.version || 1;
  return data;
}

export const receiptTotal = (r) => round2((r.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));

export const isActive = (r) => r.status !== 'cancelled';

/** המספר הבא לקבלה — לעולם לא נמוך מהמספר הגבוה ביותר שהופק + 1 */
export function nextNumber(data) {
  const max = data.receipts.reduce((m, r) => Math.max(m, Number(r.number) || 0), 0);
  return Math.max(Number(data.settings.nextNumber) || 1, max + 1);
}

export function yearOf(r) {
  return Number(String(r.date || '').slice(0, 4)) || new Date().getFullYear();
}

export function sortedReceipts(data) {
  return [...data.receipts].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (Number(b.number) || 0) - (Number(a.number) || 0));
}

export function totalsForYear(data, year) {
  const list = data.receipts.filter((r) => yearOf(r) === year && isActive(r));
  return {
    count: list.length,
    sum: round2(list.reduce((s, r) => s + receiptTotal(r), 0)),
  };
}

export function lastIssuedDate(data) {
  return data.receipts
    .filter((r) => r.source !== 'archive')
    .reduce((m, r) => (r.date > m ? r.date : m), '');
}

/** שומר/מעדכן לקוח לפי שם */
export function upsertClient(data, c) {
  if (!c.name) return;
  const key = c.name.trim();
  let found = data.clients.find((x) => x.name.trim() === key);
  if (!found) {
    found = { id: crypto.randomUUID(), name: key };
    data.clients.push(found);
  }
  for (const f of ['taxId', 'phone', 'email', 'address']) if (c[f]) found[f] = c[f];
  found.lastUsed = todayISO();
}

export function audit(data, action, details = '') {
  data.audit.push({ ts: new Date().toISOString(), action, details });
  if (data.audit.length > 2000) data.audit = data.audit.slice(-2000);
}

/** מיזוג גרסה מקומית ומרוחקת (אם נשמר ממכשיר אחר במקביל) */
export function mergeData(local, remote) {
  const out = normalize(JSON.parse(JSON.stringify(remote)));
  const byId = new Map(out.receipts.map((r) => [r.id, r]));
  for (const r of local.receipts) {
    const o = byId.get(r.id);
    if (!o) out.receipts.push(r);
    else if ((r.updatedAt || '') > (o.updatedAt || '')) Object.assign(o, r);
  }
  // התנגשות מספרים (שני מכשירים הפיקו אותו מספר) — נדיר; מסמנים לבדיקה
  const seen = new Map();
  for (const r of out.receipts) {
    if (r.source === 'archive') continue;
    if (seen.has(r.number)) r.conflict = true;
    seen.set(r.number, r);
  }
  const cById = new Map(out.clients.map((c) => [c.name, c]));
  for (const c of local.clients) if (!cById.has(c.name)) out.clients.push(c);
  out.settings = { ...out.settings, ...local.settings };
  out.business = { ...out.business, ...local.business };
  out.settings.nextNumber = Math.max(Number(local.settings.nextNumber) || 0, Number(remote.settings?.nextNumber) || 0);
  const auditKeys = new Set(out.audit.map((a) => a.ts + a.action));
  for (const a of local.audit) if (!auditKeys.has(a.ts + a.action)) out.audit.push(a);
  out.audit.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}
