// עיצוב מסמך הקבלה (A4), הדפסה ויצירת PDF

import { html, fmtMoney, fmtDate, fmtDateTime, safeName } from './util.js';
import { methodLabel, paymentDetails, receiptTotal } from './model.js';

/**
 * מחזיר HTML של הקבלה.
 * copy: 'original' | 'copy' | 'draft'
 */
export function receiptHTML(r, { copy = 'copy' } = {}) {
  const b = r.business;
  const c = r.client || {};
  const total = receiptTotal(r);
  const copyLabel = copy === 'original' ? 'מקור' : copy === 'draft' ? 'טיוטה — תצוגה מקדימה' : 'העתק נאמן למקור';
  const cancelled = r.status === 'cancelled';
  return html`
  <article class="rdoc ${cancelled ? 'is-cancelled' : ''} ${copy === 'draft' ? 'is-draft' : ''}" dir="rtl" lang="he" aria-label="קבלה מספר ${r.number}">
    <div class="rdoc-frame">
      <header class="rdoc-head">
        <div class="rdoc-biz">
          <h1 class="rdoc-biz-name">${b.name}</h1>
          ${b.nameEn ? html`<div class="rdoc-biz-en" dir="ltr">${b.nameEn}</div>` : ''}
          <dl class="rdoc-biz-meta">
            <div><dt>${b.type || 'עוסק פטור'}:</dt><dd>${b.taxId}</dd></div>
            ${b.address ? html`<div><dt class="sr-only">כתובת:</dt><dd>${b.address}</dd></div>` : ''}
            ${b.phone ? html`<div><dt>טלפון</dt><dd dir="ltr">${b.phone}</dd></div>` : ''}
            ${b.email ? html`<div><dt>דוא״ל</dt><dd dir="ltr">${b.email}</dd></div>` : ''}
            ${b.website ? html`<div><dt class="sr-only">אתר:</dt><dd dir="ltr">${b.website}</dd></div>` : ''}
          </dl>
        </div>
        <div class="rdoc-logo"><img src="assets/img/logo.jpg" alt="לוגו ${b.nameEn || b.name}" crossorigin="anonymous"></div>
      </header>

      <div class="rdoc-titlebar">
        <h2 class="rdoc-title">קבלה <span class="rdoc-num">${r.number}</span></h2>
        <div class="rdoc-copy">${copyLabel}</div>
      </div>
      <div class="rdoc-rule" aria-hidden="true"><span></span></div>

      <section class="rdoc-parties">
        <div class="rdoc-client">
          <div class="rdoc-label">לכבוד</div>
          <div class="rdoc-client-name">${c.name}</div>
          ${c.taxId ? html`<div>ח.פ/ת.ז ${c.taxId}</div>` : ''}
          ${c.address ? html`<div>${c.address}</div>` : ''}
          ${c.phone ? html`<div>טלפון <span dir="ltr">${c.phone}</span></div>` : ''}
          ${c.email ? html`<div dir="ltr" class="rdoc-ltr">${c.email}</div>` : ''}
        </div>
        <div class="rdoc-dates">
          <div><span class="rdoc-label">תאריך</span><strong>${fmtDate(r.date)}</strong></div>
        </div>
      </section>

      <section class="rdoc-subject">
        <div class="rdoc-band">${r.subject || 'תשלום עבור שירותים'}</div>
        ${r.notes ? html`<p class="rdoc-notes">${r.notes}</p>` : ''}
      </section>

      <section class="rdoc-payments">
        <div class="rdoc-band">פרטי תשלומים</div>
        <table>
          <thead>
            <tr><th scope="col">אמצעי תשלום</th><th scope="col">פירוט</th><th scope="col">תאריך</th><th scope="col" class="num">סכום</th></tr>
          </thead>
          <tbody>
            ${(r.payments || []).map(
              (p) => html`<tr>
                <td>${methodLabel(p.method)}</td>
                <td>${paymentDetails(p) || '—'}</td>
                <td>${fmtDate(p.date || r.date)}</td>
                <td class="num">${fmtMoney(p.amount)}</td>
              </tr>`
            )}
          </tbody>
        </table>
        <div class="rdoc-total">
          <span>סה״כ התקבל</span>
          <strong>${fmtMoney(total)}</strong>
        </div>
        <p class="rdoc-vat">${(b.type || '').includes('פטור') ? 'עוסק פטור — המסמך אינו חשבונית מס ואינו כולל מע״מ.' : ''}</p>
      </section>

      <section class="rdoc-sign">
        <span>חתימה:</span>
        <img src="assets/img/signature.png" alt="חתימת ${b.name}">
      </section>

      ${cancelled
        ? html`<div class="rdoc-stamp" role="note">מבוטלת<small>${fmtDate(r.cancel?.date)}${r.cancel?.reason ? ' · ' + r.cancel.reason : ''}</small></div>`
        : ''}

      <footer class="rdoc-foot">
        <div class="rdoc-foot-main">
          <strong>מסמך ממוחשב</strong>
          <span>הופק באמצעות מערכת הקבלות של ${b.nameEn || b.name}</span>
        </div>
        <div class="rdoc-foot-meta">הופק ב־${fmtDateTime(r.issuedAt)} | קבלה ${r.number} | עמוד 1 מתוך 1</div>
      </footer>
    </div>
  </article>`.__html;
}

/** שם קובץ: בעברית ל-Drive; באנגלית להורדה/שיתוף (תאימות מלאה לכל הדפדפנים והאפליקציות) */
export const pdfFileName = (r, hebrew = false) =>
  hebrew ? safeName(`קבלה ${r.number} - ${r.client?.name || ''}`) + '.pdf' : `Receipt-${r.number}-ArielYosupov.pdf`;

let h2pPromise;
function loadHtml2pdf() {
  if (window.html2pdf) return Promise.resolve(window.html2pdf);
  h2pPromise ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'assets/vendor/html2pdf.bundle.min.js';
    s.onload = () => res(window.html2pdf);
    s.onerror = () => rej(new Error('טעינת מחולל ה-PDF נכשלה'));
    document.head.appendChild(s);
  });
  return h2pPromise;
}

/** עוטף כל מילה ב-span — עוקף באג של html2canvas שמדביק מילים בעברית */
function wrapWords(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of n.nodeValue.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) frag.appendChild(document.createTextNode(part));
      else {
        // מפרידים אותיות עבריות מסימני פיסוק/ספרות, כדי שהדפדפן ימקם כל חלק נכון (bidi)
        for (const run of part.split(/([\u0590-\u05FF\uFB1D-\uFB4F]+)/)) {
          if (!run) continue;
          const sp = document.createElement('span');
          sp.textContent = run;
          frag.appendChild(sp);
        }
      }
    }
    n.parentNode.replaceChild(frag, n);
  }
}

/** יוצר PDF כ-Blob */
export async function receiptPdf(r, copy = 'copy') {
  const html2pdf = await loadHtml2pdf();
  await document.fonts.ready;
  const host = document.createElement('div');
  host.className = 'pdf-host';
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = receiptHTML(r, { copy });
  document.body.appendChild(host);
  const el = host.firstElementChild;
  wrapWords(el);
  await Promise.all([...el.querySelectorAll('img')].map((img) => (img.complete ? 0 : new Promise((ok) => (img.onload = img.onerror = ok)))));
  try {
    const worker = html2pdf()
      .set({
        margin: 0,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2.5, useCORS: true, backgroundColor: '#ffffff', width: 794, height: 1123, windowWidth: 794, scrollX: 0, scrollY: 0, x: 0, y: 0 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
      })
      .from(el);
    const canvas = await worker.toCanvas().get('canvas');
    const pdf = await worker.toPdf().get('pdf');
    // בונים מחדש עמוד יחיד בגודל A4 מדויק מהקנבס
    const out = pdf;
    out.addPage('a4', 'portrait');
    while (out.getNumberOfPages() > 1) out.deletePage(1);
    out.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, 297);
    out.setProperties({ title: `קבלה ${r.number}`, subject: 'קבלה', author: r.business?.nameEn || '', creator: 'Ariel Receipts' });
    return out.output('blob');
  } finally {
    host.remove();
  }
}

/** הדפסה דרך חלון ההדפסה של הדפדפן */
export function printReceipt(r, copy = 'copy') {
  let root = document.getElementById('print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    document.body.appendChild(root);
  }
  root.innerHTML = receiptHTML(r, { copy });
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    root.innerHTML = '';
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  const imgs = [...root.querySelectorAll('img')];
  Promise.all(imgs.map((img) => (img.complete ? 0 : new Promise((ok) => (img.onload = img.onerror = ok))))).then(() => {
    setTimeout(() => window.print(), 50);
  });
}
