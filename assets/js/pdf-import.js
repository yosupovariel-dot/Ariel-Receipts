// קריאת קבלות PDF קיימות (למשל מ-morning / חשבונית ירוקה) וחילוץ הפרטים שלהן

let loader;
function loadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  loader ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'assets/vendor/pdfjs/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdfjs/pdf.worker.min.js';
      res(window.pdfjsLib);
    };
    s.onerror = () => rej(new Error('טעינת קורא ה-PDF נכשלה'));
    document.head.appendChild(s);
  });
  return loader;
}

const HEB = /[֐-׿]/;
const KNOWN = ['קבלה', 'לכבוד', 'תאריך', 'סכום', 'תשלום', 'עוסק'];

/** מחזיר את שורות הטקסט של ה-PDF בסדר קריאה (מלמעלה למטה, מימין לשמאל) */
export async function pdfLines(bytes) {
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
  const items = [];
  for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      items.push({ s: it.str, x: it.transform[4], y: it.transform[5] - p * 10000, w: it.width || 0 });
    }
  }
  // האם הטקסט העברי שמור הפוך (סדר ויזואלי)?
  const joined = items.map((i) => i.s).join(' ');
  const rev = (t) => [...t].reverse().join('');
  const score = (t) => KNOWN.reduce((n, w) => n + (t.split(w).length - 1), 0);
  const reversed = score(rev(joined)) > score(joined);
  if (reversed) for (const i of items) if (HEB.test(i.s)) i.s = fixVisual(i.s);

  items.sort((a, b) => b.y - a.y);
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < 3.5);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((l) =>
      l.items
        .sort((a, b) => b.x + b.w - (a.x + a.w))
        .map((i) => i.s.trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
}

/** הופך מחרוזת ויזואלית לסדר לוגי, בלי להפוך מספרים */
function fixVisual(s) {
  return [...s]
    .reverse()
    .join('')
    .replace(/[0-9][0-9.,/:\-₪]*[0-9]|[0-9]/g, (m) => [...m].reverse().join(''));
}

const toISO = (d, m, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const DATE_RE = /(\d{1,2})[/.](\d{1,2})[/.](20\d{2})/g;
const MONEY_RE = /(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}|\d+)/g;
const money = (s) => Number(String(s).replace(/,/g, ''));

/**
 * מחלץ פרטי קבלה משורות הטקסט.
 * biz: פרטי העסק — כדי לא לבלבל בין הטלפון/מספר העוסק שלך לאלה של הלקוח
 */
export function parseReceipt(lines, fileName = '', biz = {}) {
  const text = lines.join('\n');
  const bizDigits = [biz.phone, biz.taxId].filter(Boolean).map((v) => String(v).replace(/\D/g, ''));
  const out = { number: '', date: '', client: '', taxId: '', phone: '', subject: '', amount: '', method: '' };

  // מספר קבלה
  const mNum = text.match(/קבלה\s*(?:מס(?:פר|['׳"״])?\.?\s*)?:?\s*(\d{3,7})/) || text.match(/(\d{3,7})\s*קבלה/);
  const fNum = fileName.match(/(\d{4,7})/);
  out.number = (mNum && mNum[1]) || (fNum && fNum[1]) || '';

  // לקוח ותאריך — בשורת "לכבוד"
  const toIdx = lines.findIndex((l) => /לכבוד/.test(l));
  const dateOf = (l) => {
    DATE_RE.lastIndex = 0;
    const m = DATE_RE.exec(l);
    return m ? toISO(m[1], m[2], m[3]) : '';
  };
  if (toIdx >= 0) {
    const l = lines[toIdx];
    out.date = dateOf(l);
    out.client = l
      .replace(DATE_RE, '')
      .replace(/לכבוד\s*:?/, '')
      .replace(/^[\s:|,-]+|[\s:|,-]+$/g, '')
      .trim();
    if (!out.client && lines[toIdx + 1] && !/\d{5,}/.test(lines[toIdx + 1])) out.client = lines[toIdx + 1].replace(DATE_RE, '').trim();
    // ת.ז / טלפון של הלקוח בשורות שאחרי
    for (const nl of lines.slice(toIdx, toIdx + 6)) {
      const id = nl.match(/(?:ח\.?\s*פ|ת\.?\s*ז|ע\.?\s*מ)[^\d]{0,8}(\d{5,9})/);
      if (id && !bizDigits.includes(id[1]) && !out.taxId) out.taxId = id[1];
      const ph = nl.match(/(0\d{1,2}-?\d{7}|05\d-?\d{7})/);
      if (/טלפון|נייד|טל/.test(nl) && ph && !bizDigits.includes(ph[1].replace(/\D/g, '')) && !out.phone) out.phone = ph[1];
    }
  }
  if (!out.date) {
    // תאריך ראשון שאינו בשורת "הופק"
    for (const l of lines) {
      if (/הופק/.test(l)) continue;
      const d = dateOf(l);
      if (d) {
        out.date = d;
        break;
      }
    }
  }

  // סכום — בשורת סה"כ, אחרת הסכום הגבוה ביותר עם ₪
  const totalLine = lines.find((l) => /סה["״']?כ|סהכ|סך הכל|סה"כ/.test(l));
  const amounts = (l) => (l.replace(DATE_RE, ' ').match(MONEY_RE) || []).map(money).filter((n) => n > 0 && n < 10000000);
  if (totalLine && amounts(totalLine).length) out.amount = Math.max(...amounts(totalLine));
  else {
    const withShekel = lines.filter((l) => /₪|ש["״]ח|ILS/.test(l)).flatMap(amounts);
    if (withShekel.length) out.amount = Math.max(...withShekel);
  }

  // תיאור — השורה שלפני "פרטי תשלומים"
  const payIdx = lines.findIndex((l) => /פרטי\s*תשלומים|פרטי\s*תשלום/.test(l));
  if (payIdx > 0) {
    for (let i = payIdx - 1; i > Math.max(toIdx, payIdx - 4); i--) {
      const l = lines[i];
      if (l && !/טלפון|ח\.?\s*פ|ת\.?\s*ז|לכבוד/.test(l) && !/^\d[\d\s-]*$/.test(l)) {
        out.subject = l.trim();
        break;
      }
    }
  }

  // אמצעי תשלום
  const payText = (payIdx >= 0 ? lines.slice(payIdx) : lines).join(' ').toLowerCase();
  const rules = [
    ['bit', /\bbit\b|ביט/],
    ['paybox', /paybox|פייבוקס|פיי בוקס/],
    ['paypal', /paypal|פייפאל/],
    ['credit', /אשראי|ויזה|visa|mastercard|מאסטרקארד|ישראכרט|אמריקן/],
    ['cheque', /צ['׳]ק|שיק|המחאה/],
    ['transfer', /העברה\s*בנקאית|העברה/],
    ['cash', /מזומן/],
  ];
  out.method = (rules.find(([, re]) => re.test(payText)) || ['other'])[0];
  return out;
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
