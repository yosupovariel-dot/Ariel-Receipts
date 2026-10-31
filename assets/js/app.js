// מערכת הקבלות — ממשק המשתמש

import { CONFIG } from './config.js';
import { html, raw, esc, $, $$, uid, fmtMoney, fmtDate, fmtDateTime, todayISO, MONTHS, round2, download, waPhone, validIsraeliId, csvEscape, debounce } from './util.js';
import {
  PAYMENT_METHODS, FIELD_LABELS, paymentDetails, methodLabel, receiptTotal, isActive, nextNumber, yearOf,
  sortedReceipts, totalsForYear, lastIssuedDate, upsertClient, audit, mergeData,
} from './model.js';
import * as store from './store.js';
import { session } from './store.js';
import { receiptHTML, receiptPdf, printReceipt, pdfFileName } from './receipt-doc.js';
import { drive, driveUrl, driveConfigured, drivePing, driveList, driveUpload, driveGetFile } from './drive.js';
import { pdfLines, parseReceipt, base64ToBytes } from './pdf-import.js';
import { LEGAL } from './legal.js';
import { initA11y } from './a11y.js';

let main = $('#main');
const cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);
const D = () => session.data;

/* ───────────────────────── הודעות וחלונות ───────────────────────── */

function toast(msg, type = 'ok', ms = 3800) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, ms);
}

function announce(msg) {
  const live = $('#live');
  live.textContent = '';
  setTimeout(() => (live.textContent = msg), 30);
}

/** חלון דיאלוג נגיש. מחזיר את ערך הכפתור שנלחץ, או אובייקט ערכי הטופס */
function modal({ title, body = '', actions = [{ label: 'סגירה', value: null }], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    const prev = document.activeElement;
    dlg.className = wide ? 'modal modal-wide' : 'modal';
    dlg.innerHTML = `
      <form method="dialog" class="modal-inner" novalidate>
        <header class="modal-head">
          <h2 id="modal-title">${esc(title)}</h2>
          <button type="button" class="icon-btn" data-close aria-label="סגירת החלון">✕</button>
        </header>
        <div class="modal-body">${body.__html ?? body}</div>
        <footer class="modal-actions">
          ${actions
            .map(
              (a, i) =>
                `<button type="${a.submit ? 'submit' : 'button'}" class="btn ${a.class || (i === actions.length - 1 ? 'btn-primary' : 'btn-ghost')}" data-i="${i}">${esc(a.label)}</button>`
            )
            .join('')}
        </footer>
      </form>`;
    dlg.setAttribute('aria-labelledby', 'modal-title');
    const form = dlg.querySelector('form');
    const finish = (v) => {
      dlg.close();
      prev?.focus?.();
      resolve(v);
    };
    dlg.querySelector('[data-close]').onclick = () => finish(null);
    dlg.oncancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const btn = e.submitter || form.querySelector('[type=submit]');
      const a = actions[Number(btn?.dataset.i ?? actions.length - 1)];
      if (!form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form).entries());
      if (a.validate) {
        const err = a.validate(values, form);
        if (err) return;
      }
      finish(a.value === undefined ? values : { ...values, __action: a.value });
    };
    dlg.querySelectorAll('button[data-i]').forEach((b) => {
      if (b.type === 'button') b.onclick = () => finish(actions[Number(b.dataset.i)].value);
    });
    dlg.showModal();
    onOpen?.(dlg);
    (dlg.querySelector('[autofocus]') || dlg.querySelector('input,select,textarea') || dlg.querySelector('.modal-actions .btn-primary'))?.focus();
  });
}

const confirmBox = (title, text, okLabel = 'אישור', danger = false) =>
  modal({
    title,
    body: html`<p>${text}</p>`,
    actions: [
      { label: 'ביטול', value: false },
      { label: okLabel, value: true, class: danger ? 'btn-danger' : 'btn-primary' },
    ],
  });

/* ───────────────────────── כניסה ───────────────────────── */

const LS_ATTEMPTS = 'ar_attempts_v1';
function attempts() {
  try {
    return JSON.parse(localStorage.getItem(LS_ATTEMPTS) || '{"n":0,"until":0}');
  } catch {
    return { n: 0, until: 0 };
  }
}
function setAttempts(a) {
  try {
    localStorage.setItem(LS_ATTEMPTS, JSON.stringify(a));
  } catch {}
}

function showLogin(msg) {
  if (!msg && pendingLoginMsg) msg = pendingLoginMsg;
  pendingLoginMsg = '';
  if (!$('#login-view').hidden && $('#login-form') && !msg) return;
  document.body.classList.remove('authed');
  $('#app').hidden = true;
  const view = $('#login-view');
  view.hidden = false;
  view.innerHTML = html`
    <div class="login-card">
      <img src="assets/img/logo.jpg" alt="לוגו אריאל יוסופוב עיצוב אתרים" class="login-logo">
      <h1>מערכת הקבלות</h1>
      <p class="muted">אריאל יוסופוב — עיצוב אתרים</p>
      <form id="login-form" novalidate>
        <div class="field">
          <label for="lg-user">שם משתמש</label>
          <input id="lg-user" name="user" autocomplete="username" required autocapitalize="off" spellcheck="false">
        </div>
        <div class="field">
          <label for="lg-pass">סיסמה</label>
          <div class="input-with-btn">
            <input id="lg-pass" name="pass" type="password" autocomplete="current-password" required inputmode="numeric">
            <button type="button" class="icon-btn" id="lg-eye" aria-label="הצגת הסיסמה" aria-pressed="false">👁</button>
          </div>
        </div>
        <p id="lg-err" class="form-error" role="alert">${msg || ''}</p>
        <button class="btn btn-primary btn-block btn-lg" id="lg-btn">כניסה</button>
      </form>
      <p class="secure-note"><span aria-hidden="true">🔒</span> הנתונים מוצפנים בתקן AES-256 ונפתחים רק עם הסיסמה שלך</p>
      <nav class="login-legal" aria-label="מידע משפטי">
        <a href="#/legal/terms">תנאי שימוש</a> · <a href="#/legal/privacy">פרטיות</a> · <a href="#/legal/accessibility">הצהרת נגישות</a>
      </nav>
    </div>`.__html;

  const form = $('#login-form');
  const err = $('#lg-err');
  const btn = $('#lg-btn');
  $('#lg-eye').onclick = (e) => {
    const p = $('#lg-pass');
    const show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.setAttribute('aria-label', show ? 'הסתרת הסיסמה' : 'הצגת הסיסמה');
  };
  $('#lg-user').focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const a = attempts();
    if (a.until > Date.now()) {
      err.textContent = `יותר מדי ניסיונות. נסה שוב בעוד ${Math.ceil((a.until - Date.now()) / 1000)} שניות.`;
      return;
    }
    const user = $('#lg-user').value.trim().toLowerCase();
    const pass = $('#lg-pass').value;
    if (!user || !pass) {
      err.textContent = 'נא למלא שם משתמש וסיסמה.';
      (user ? $('#lg-pass') : $('#lg-user')).focus();
      return;
    }
    const fail = (text) => {
      a.n++;
      if (a.n >= CONFIG.maxAttempts) {
        a.until = Date.now() + CONFIG.lockSeconds * 1000;
        a.n = 0;
      }
      setAttempts(a);
      err.textContent = text;
      $('#lg-pass').select();
    };
    if (!CONFIG.usernames.map((u) => u.toLowerCase()).includes(user)) return fail('שם המשתמש או הסיסמה שגויים.');
    btn.disabled = true;
    btn.textContent = 'מאמת ופותח הצפנה…';
    err.textContent = '';
    try {
      await store.login(pass);
      setAttempts({ n: 0, until: 0 });
      enterApp();
    } catch (ex) {
      if (ex.message === 'bad-password') fail('שם המשתמש או הסיסמה שגויים.');
      else if (ex.message === 'no-data') err.textContent = 'לא נמצא קובץ נתונים. בדוק חיבור לאינטרנט.';
      else err.textContent = 'שגיאה: ' + ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'כניסה';
    }
  };
}

function enterApp() {
  const imported = session.importedNow;
  session.importedNow = 0;
  if (imported) setTimeout(() => toast(`${imported} קבלות היסטוריות נוספו למערכת (2025–2026)`, 'ok', 6000), 400);
  $('#login-view').hidden = true;
  $('#login-view').innerHTML = '';
  $('#app').hidden = false;
  document.body.classList.add('authed');
  renderSync(store.state());
  if (!location.hash || location.hash === '#/login') location.hash = '#/';
  else route();
}

function logout(msg) {
  store.logout();
  if (location.hash !== '#/login') {
    pendingLoginMsg = msg;
    location.hash = '#/login'; // route() יציג את מסך הכניסה
  } else showLogin(msg);
}
let pendingLoginMsg = '';

// ניתוק אוטומטי
let lastTouch = 0;
['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) =>
  window.addEventListener(
    ev,
    () => {
      if (Date.now() - lastTouch > 15000 && session.key) {
        lastTouch = Date.now();
        store.touchSession();
      }
    },
    { passive: true }
  )
);
setInterval(() => {
  if (!session.key) return;
  try {
    const s = JSON.parse(sessionStorage.getItem('ar_session_v1') || 'null');
    if (!s || s.exp < Date.now()) logout('נותקת אוטומטית לאחר חוסר פעילות. יש להתחבר מחדש.');
  } catch {}
}, 20000);

/* ───────────────────────── סטטוס סנכרון ───────────────────────── */

function renderSync(st) {
  const el = $('#sync');
  if (!el) return;
  let cls = 'ok', text = 'שמור ב-Drive';
  if (st.saving) (cls = 'busy'), (text = 'שומר…');
  else if (!st.configured) (cls = 'warn'), (text = 'Drive לא מחובר');
  else if (st.authError) (cls = 'err'), (text = 'צריך לעדכן קוד ב-Drive');
  else if (!st.connected) (cls = 'warn'), (text = 'אין חיבור ל-Drive');
  else if (st.error) (cls = 'err'), (text = 'שגיאת שמירה');
  else if (st.pending) (cls = 'warn'), (text = 'ממתין לסנכרון');
  el.className = 'sync sync-' + cls;
  el.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${esc(text)}</span>`;
  el.title = st.lastSync ? 'סונכרן לאחרונה: ' + fmtDateTime(st.lastSync) : '';
}
store.onSyncChange(renderSync);

async function persist(message) {
  const res = await store.save(message);
  if (!res.synced && res.reason === 'no-drive') toast('נשמר במכשיר. חבר את Google Drive כדי שהנתונים יישמרו גם שם.', 'warn', 5000);
  else if (!res.synced) toast('נשמר במכשיר, אך השמירה ל-Drive נכשלה: ' + res.reason, 'error', 6000);
  return res;
}

/* ───────────────────────── ניתוב ───────────────────────── */

function parseHash() {
  const h = location.hash.replace(/^#/, '').split('#')[0] || '/';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}

const titles = { '': 'ראשי', new: 'קבלה חדשה', receipts: 'קבלות', r: 'קבלה', archive: 'ארכיון Drive', clients: 'לקוחות', settings: 'הגדרות', legal: 'מידע משפטי' };

function route() {
  const { parts, q } = parseHash();
  const page = parts[0] || '';

  if (page === 'legal') return renderLegal(parts[1] || 'terms');
  if (!session.key) return showLogin();
  $('#app').hidden = false;
  $('#login-view').hidden = true;

  $$('.nav a').forEach((a) => {
    const target = a.getAttribute('href').replace('#/', '');
    const active = target === page || (page === 'r' && target === 'receipts');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  const views = { '': viewDashboard, new: viewNew, receipts: viewReceipts, r: viewReceipt, archive: viewArchive, clients: viewClients, settings: viewSettings };
  const fn = views[page] || viewDashboard;
  document.title = `${titles[page] || 'ראשי'} | מערכת הקבלות — אריאל יוסופוב`;
  while (cleanups.length) cleanups.pop()();
  const fresh = main.cloneNode(false);
  main.replaceWith(fresh);
  main = fresh;
  fn(parts, q);
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

/* ───────────────────────── עמודים משפטיים ───────────────────────── */

function renderLegal(key) {
  const page = LEGAL[key] || LEGAL.terms;
  document.title = page.title + ' | מערכת הקבלות';
  const tabs = Object.entries(LEGAL)
    .map(([k, v]) => `<a href="#/legal/${k}" class="tab ${k === key ? 'active' : ''}" ${k === key ? 'aria-current="page"' : ''}>${esc(v.title)}</a>`)
    .join('');
  const content = `
    <div class="page legal">
      <nav class="tabs" aria-label="עמודים משפטיים">${tabs}</nav>
      <article class="card prose"><h1>${esc(page.title)}</h1>${page.body}</article>
      ${session.key ? '' : '<p class="center"><a class="btn btn-primary" href="#/login">חזרה למסך הכניסה</a></p>'}
    </div>`;
  if (session.key) {
    $('#app').hidden = false;
    $('#login-view').hidden = true;
    main.innerHTML = content;
    $$('.nav a').forEach((a) => a.classList.remove('active'));
  } else {
    $('#app').hidden = true;
    const v = $('#login-view');
    v.hidden = false;
    v.innerHTML = `<div class="legal-public">${content}</div>`;
  }
  window.scrollTo(0, 0);
}

/* ───────────────────────── ראשי ───────────────────────── */

function viewDashboard() {
  const data = D();
  const year = new Date().getFullYear();
  const month = todayISO().slice(0, 7);
  const yt = totalsForYear(data, year);
  const monthSum = round2(data.receipts.filter((r) => isActive(r) && (r.date || '').startsWith(month)).reduce((s, r) => s + receiptTotal(r), 0));
  const ceiling = Number(data.settings.ceiling) || 0;
  const pct = ceiling ? Math.min(100, (yt.sum / ceiling) * 100) : 0;
  const recent = sortedReceipts(data).slice(0, 6);
  const st = store.state();

  const banners = [];
  if (!st.configured)
    banners.push(html`<div class="banner banner-warn"><strong>הנתונים נשמרים כרגע רק במכשיר הזה.</strong> כדי שאף קבלה לא תאבד — <a href="#/archive">חבר את Google Drive</a>.</div>`);
  else if (st.authError)
    banners.push(html`<div class="banner banner-err"><strong>החיבור ל-Drive לא עובד:</strong> הקוד שב-Apps Script לא תואם. <a href="#/archive">לתיקון</a></div>`);
  else if (st.pending) banners.push(html`<div class="banner banner-warn">יש שינויים שטרם נשמרו ב-Drive. <button class="link-btn" data-act="sync">שמירה עכשיו</button></div>`);
  if (!data.settings.numberConfirmed) banners.push(html`<div class="banner banner-info">הקבלה הבאה תקבל את המספר <strong>${nextNumber(data)}</strong>. לשינוי — <a href="#/settings#numbering">הגדרות מספור</a>.</div>`);
  if (ceiling && pct >= 85) banners.push(html`<div class="banner banner-err">שים לב: הגעת ל-${pct.toFixed(0)}% מתקרת המחזור של עוסק פטור לשנת ${year}. כדאי להתייעץ עם רואה חשבון.</div>`);

  main.innerHTML = html`
  <div class="page">
    <div class="page-head">
      <div>
        <h1>שלום אריאל</h1>
        <p class="muted">${new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</p>
      </div>
      <a href="#/new" class="btn btn-primary btn-lg" aria-keyshortcuts="n"><span aria-hidden="true">＋</span> קבלה חדשה</a>
    </div>
    ${banners}
    <section class="kpis" aria-label="נתונים עיקריים">
      <div class="kpi kpi-blue"><span class="kpi-label">הכנסות ${year}</span><strong class="kpi-value">${fmtMoney(yt.sum)}</strong></div>
      <div class="kpi kpi-mint"><span class="kpi-label">החודש (${MONTHS[new Date().getMonth()]})</span><strong class="kpi-value">${fmtMoney(monthSum)}</strong></div>
      <div class="kpi kpi-lav"><span class="kpi-label">קבלות השנה</span><strong class="kpi-value">${yt.count}</strong></div>
      <div class="kpi kpi-sky"><span class="kpi-label">הקבלה הבאה</span><strong class="kpi-value">${nextNumber(data)}</strong></div>
    </section>
    ${ceiling
      ? html`<section class="card ceiling" aria-label="תקרת עוסק פטור">
        <div class="ceiling-head"><span>תקרת עוסק פטור ${year}</span><span>${fmtMoney(yt.sum)} מתוך ${fmtMoney(ceiling)}</span></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(0)}" aria-label="ניצול התקרה">
          <span style="width:${pct.toFixed(1)}%" class="${pct >= 85 ? 'hot' : ''}"></span>
        </div>
        <small class="muted">נותרו ${fmtMoney(Math.max(0, ceiling - yt.sum))} עד התקרה</small>
      </section>`
      : ''}
    <section class="card">
      <div class="card-head"><h2>קבלות אחרונות</h2><a href="#/receipts">לכל הקבלות ←</a></div>
      ${recent.length ? receiptList(recent) : html`<div class="empty"><p>עוד לא הופקו קבלות במערכת.</p><a class="btn btn-primary" href="#/new">הפקת הקבלה הראשונה</a></div>`}
    </section>
  </div>`.__html;

  main.querySelector('[data-act=sync]')?.addEventListener('click', async () => {
    try {
      await store.sync();
      toast('נשמר ב-Drive');
      route();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

function statusChip(r) {
  if (r.status === 'cancelled') return html`<span class="chip chip-err">מבוטלת</span>`;
  if (r.source === 'archive') return html`<span class="chip chip-lav">ארכיון</span>`;
  if (r.conflict) return html`<span class="chip chip-err">כפילות מספר</span>`;
  return html`<span class="chip chip-ok">הופקה</span>`;
}

function receiptList(list) {
  return html`<ul class="rlist">
    ${list.map(
      (r) => html`<li>
        <a href="#/r/${r.id}" class="rrow">
          <span class="rrow-num">#${r.number}</span>
          <span class="rrow-main"><strong>${r.client?.name || '—'}</strong><small>${r.subject || ''}</small></span>
          <span class="rrow-date">${fmtDate(r.date)}</span>
          <span class="rrow-amt ${r.status === 'cancelled' ? 'strike' : ''}">${fmtMoney(receiptTotal(r))}</span>
          ${statusChip(r)}
        </a>
      </li>`
    )}
  </ul>`;
}

/* ───────────────────────── קבלה חדשה ───────────────────────── */

const DRAFT_KEY = 'ar_draft_v1';

function blankPayment(date) {
  return { id: uid(), method: 'bit', amount: '', date: date || todayISO() };
}

function viewNew(parts, q) {
  const data = D();
  let draft;
  try {
    draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
  } catch {}
  const from = q.get('from') && data.receipts.find((r) => r.id === q.get('from'));
  const client = q.get('client') && data.clients.find((c) => c.id === q.get('client'));
  if (from) {
    draft = {
      client: { ...from.client },
      subject: from.subject,
      notes: from.notes || '',
      date: todayISO(),
      payments: (from.payments || []).map((p) => ({ ...p, id: uid(), date: todayISO() })),
    };
  } else if (client) {
    draft = { client: { name: client.name, taxId: client.taxId || '', phone: client.phone || '', email: client.email || '', address: client.address || '' }, subject: data.settings.defaultSubject || '', notes: '', date: todayISO(), payments: [blankPayment()] };
  }
  if (!draft) draft = { client: { name: '', taxId: '', phone: '', email: '', address: '' }, subject: data.settings.defaultSubject || '', notes: '', date: todayISO(), payments: [blankPayment()] };

  const subjects = [...new Set(data.receipts.map((r) => r.subject).filter(Boolean))].slice(0, 40);
  const number = nextNumber(data);

  main.innerHTML = html`
  <div class="page page-new">
    <div class="page-head">
      <div><h1>קבלה חדשה <span class="muted num-badge">מס׳ ${number}</span></h1>
      <p class="muted">ממלאים משמאל לימין — התצוגה המקדימה מתעדכנת בזמן אמת.</p></div>
      ${draft.client.name ? html`<button type="button" class="btn btn-ghost" id="clear-draft">ניקוי הטופס</button>` : ''}
    </div>
    <div class="new-grid">
      <form id="rform" class="card form" novalidate aria-describedby="form-help">
        <p id="form-help" class="sr-only">שדות המסומנים בכוכבית הם חובה. Ctrl+Enter להפקה.</p>

        <fieldset>
          <legend><span class="step">1</span> פרטי הלקוח</legend>
          <div class="field">
            <label for="c-name">שם הלקוח / המשלם <span class="req" aria-hidden="true">*</span></label>
            <input id="c-name" name="name" list="clients-dl" required autocomplete="off" value="${draft.client.name}" placeholder="התחל להקליד — לקוחות קיימים יופיעו">
            <datalist id="clients-dl">${data.clients.map((c) => html`<option value="${c.name}"></option>`)}</datalist>
          </div>
          <div class="grid2">
            <div class="field"><label for="c-phone">טלפון</label><input id="c-phone" name="phone" type="tel" inputmode="tel" dir="ltr" value="${draft.client.phone}"></div>
            <div class="field"><label for="c-tax">ח.פ / ת.ז</label><input id="c-tax" name="taxId" inputmode="numeric" dir="ltr" value="${draft.client.taxId}" aria-describedby="c-tax-hint"><small id="c-tax-hint" class="hint"></small></div>
          </div>
          <details ${draft.client.email || draft.client.address ? 'open' : ''}>
            <summary>פרטים נוספים (דוא״ל, כתובת)</summary>
            <div class="grid2">
              <div class="field"><label for="c-email">דוא״ל</label><input id="c-email" name="email" type="email" dir="ltr" value="${draft.client.email}"></div>
              <div class="field"><label for="c-addr">כתובת</label><input id="c-addr" name="address" value="${draft.client.address}"></div>
            </div>
          </details>
        </fieldset>

        <fieldset>
          <legend><span class="step">2</span> עבור מה התשלום</legend>
          <div class="field">
            <label for="r-subject">תיאור השירות <span class="req" aria-hidden="true">*</span></label>
            <input id="r-subject" name="subject" list="subjects-dl" required value="${draft.subject}" placeholder="לדוגמה: שיווק ופרסום - דף נחיתה">
            <datalist id="subjects-dl">${subjects.map((s) => html`<option value="${s}"></option>`)}</datalist>
            <div class="quick" aria-label="תיאורים נפוצים">
              ${['בניית אתר תדמית', 'דף נחיתה', 'חנות אונליין', 'תחזוקת אתר', 'עיצוב לוגו'].map((s) => html`<button type="button" class="pill" data-subject="${s}">${s}</button>`)}
            </div>
          </div>
          <div class="grid2">
            <div class="field"><label for="r-date">תאריך הקבלה <span class="req" aria-hidden="true">*</span></label><input id="r-date" name="date" type="date" required value="${draft.date}"></div>
          </div>
          <div class="field"><label for="r-notes">הערות (יופיעו בקבלה)</label><textarea id="r-notes" name="notes" rows="2">${draft.notes}</textarea></div>
        </fieldset>

        <fieldset>
          <legend><span class="step">3</span> פרטי התשלום</legend>
          <div id="payments"></div>
          <button type="button" class="btn btn-ghost btn-sm" id="add-pay"><span aria-hidden="true">＋</span> הוספת אמצעי תשלום נוסף</button>
          <div class="total-line" aria-live="polite">סה״כ: <strong id="total">₪0.00</strong></div>
        </fieldset>

        <p class="form-error" id="form-err" role="alert"></p>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary btn-lg btn-block" aria-keyshortcuts="Control+Enter">הפקת קבלה מס׳ ${number}</button>
        </div>
      </form>

      <aside class="preview-wrap" aria-label="תצוגה מקדימה של הקבלה">
        <div class="preview-sticky">
          <div class="preview-label">תצוגה מקדימה</div>
          <div class="preview" id="preview"><div class="preview-scale" id="preview-scale"></div></div>
        </div>
      </aside>
    </div>
  </div>`.__html;

  const form = $('#rform');
  const paysEl = $('#payments');
  let payments = draft.payments.length ? draft.payments : [blankPayment()];

  function paymentRow(p, i) {
    const def = PAYMENT_METHODS[p.method] || PAYMENT_METHODS.other;
    return html`<div class="pay-row" data-id="${p.id}">
      <div class="pay-row-head">
        <span class="pay-idx">תשלום ${i + 1}</span>
        ${payments.length > 1 ? html`<button type="button" class="icon-btn" data-del="${p.id}" aria-label="הסרת תשלום ${i + 1}">✕</button>` : ''}
      </div>
      <div class="grid3">
        <div class="field"><label for="pm-${p.id}">אמצעי תשלום</label>
          <select id="pm-${p.id}" data-f="method">${Object.entries(PAYMENT_METHODS).map(([k, v]) => html`<option value="${k}" ${k === p.method ? 'selected' : ''}>${v.label}</option>`)}</select></div>
        <div class="field"><label for="pa-${p.id}">סכום (₪) <span class="req" aria-hidden="true">*</span></label>
          <input id="pa-${p.id}" data-f="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required dir="ltr" value="${p.amount}" placeholder="0.00"></div>
        <div class="field"><label for="pd-${p.id}">תאריך התשלום</label>
          <input id="pd-${p.id}" data-f="date" type="date" value="${p.date}"></div>
      </div>
      ${def.fields.length
        ? html`<div class="grid3">${def.fields.map(
            (f) => html`<div class="field"><label for="pf-${f}-${p.id}">${FIELD_LABELS[f]}</label>
              <input id="pf-${f}-${p.id}" data-f="${f}" value="${p[f] || ''}" ${['last4', 'installments', 'chequeNo', 'branch', 'account'].includes(f) ? 'inputmode="numeric" dir="ltr"' : ''} ${f === 'last4' ? 'maxlength="4" pattern="\\d{4}"' : ''}></div>`
          )}</div>`
        : ''}
    </div>`;
  }

  function renderPayments() {
    paysEl.innerHTML = payments.map((p, i) => paymentRow(p, i).__html).join('');
  }

  function collect() {
    const fd = new FormData(form);
    return {
      client: { name: fd.get('name').trim(), taxId: fd.get('taxId').trim(), phone: fd.get('phone').trim(), email: fd.get('email').trim(), address: fd.get('address').trim() },
      subject: fd.get('subject').trim(),
      notes: fd.get('notes').trim(),
      date: fd.get('date'),
      payments: payments.map((p) => ({ ...p })),
    };
  }

  function draftReceipt(d) {
    return { number, date: d.date, issuedAt: new Date().toISOString(), business: { ...data.business }, client: d.client, subject: d.subject, notes: d.notes, payments: d.payments.map((p) => ({ ...p, amount: Number(p.amount) || 0 })) };
  }

  const scale = $('#preview-scale');
  const update = () => {
    if (!document.contains(form)) return;
    const d = collect();
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {}
    const r = draftReceipt(d);
    $('#total').textContent = fmtMoney(receiptTotal(r));
    scale.innerHTML = receiptHTML(r, { copy: 'draft' });
    fitPreview();
  };
  const updateSoon = debounce(update, 120);

  function fitPreview() {
    const wrap = $('#preview');
    if (!wrap) return;
    const s = wrap.clientWidth / 794;
    scale.style.transform = `scale(${s})`;
    wrap.style.height = 1123 * s + 'px';
  }
  window.addEventListener('resize', fitPreview);
  onCleanup(() => window.removeEventListener('resize', fitPreview));

  paysEl.addEventListener('input', (e) => {
    const row = e.target.closest('.pay-row');
    const f = e.target.dataset.f;
    if (!row || !f) return;
    const p = payments.find((x) => x.id === row.dataset.id);
    p[f] = e.target.value;
    if (f === 'method') {
      renderPayments();
      $(`#pm-${p.id}`).focus();
    }
    updateSoon();
  });
  paysEl.addEventListener('click', (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id) return;
    payments = payments.filter((p) => p.id !== id);
    renderPayments();
    update();
    announce('התשלום הוסר');
  });
  $('#add-pay').onclick = () => {
    const p = blankPayment($('#r-date').value);
    payments.push(p);
    renderPayments();
    update();
    $(`#pm-${p.id}`).focus();
  };
  form.addEventListener('input', (e) => {
    if (!e.target.closest('#payments')) updateSoon();
  });
  form.addEventListener('click', (e) => {
    const s = e.target.closest('[data-subject]')?.dataset.subject;
    if (s) {
      $('#r-subject').value = s;
      update();
    }
  });
  // בחירת לקוח קיים ממלאת את פרטיו
  $('#c-name').addEventListener('change', (e) => {
    const c = data.clients.find((x) => x.name === e.target.value.trim());
    if (!c) return;
    for (const [id, f] of [['c-phone', 'phone'], ['c-tax', 'taxId'], ['c-email', 'email'], ['c-addr', 'address']]) if (c[f] && !$('#' + id).value) $('#' + id).value = c[f];
    if (c.email || c.address) form.querySelector('details').open = true;
    toast('פרטי הלקוח מולאו אוטומטית', 'ok', 2000);
    update();
  });
  $('#c-tax').addEventListener('blur', (e) => {
    const v = e.target.value.trim();
    $('#c-tax-hint').textContent = v && /^\d+$/.test(v) && !validIsraeliId(v) ? 'שים לב: ספרת הביקורת לא תקינה' : '';
  });
  $('#r-date').addEventListener('change', (e) => {
    // תאריך התשלום עוקב אחרי תאריך הקבלה אם לא שונה
    payments.forEach((p) => (p.date = e.target.value));
    renderPayments();
    update();
  });
  $('#clear-draft')?.addEventListener('click', () => {
    sessionStorage.removeItem(DRAFT_KEY);
    location.hash = '#/new?' + Date.now();
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#form-err');
    err.textContent = '';
    const d = collect();
    const fail = (msg, sel) => {
      err.textContent = msg;
      if (sel) {
        const el = $(sel);
        el?.setAttribute('aria-invalid', 'true');
        el?.focus();
      }
    };
    $$('[aria-invalid]', form).forEach((x) => x.removeAttribute('aria-invalid'));
    if (!d.client.name) return fail('נא למלא את שם הלקוח.', '#c-name');
    if (!d.subject) return fail('נא לתאר עבור מה התקבל התשלום.', '#r-subject');
    if (!d.date) return fail('נא לבחור תאריך.', '#r-date');
    for (const p of d.payments) {
      if (!(Number(p.amount) > 0)) return fail('נא להזין סכום חיובי לכל תשלום.', `#pa-${p.id}`);
      if (p.method === 'credit' && p.last4 && !/^\d{4}$/.test(p.last4)) return fail('4 ספרות אחרונות של הכרטיס — בדיוק 4 ספרות.', `#pf-last4-${p.id}`);
    }
    if (d.client.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.client.email)) return fail('כתובת הדוא״ל לא תקינה.', '#c-email');

    const last = lastIssuedDate(data);
    if (last && d.date < last) {
      const ok = await confirmBox('תאריך מוקדם', `תאריך הקבלה (${fmtDate(d.date)}) מוקדם מהקבלה האחרונה שהופקה (${fmtDate(last)}). לפי כללי ניהול ספרים, הקבלות צריכות להיות בסדר כרונולוגי. להמשיך בכל זאת?`, 'כן, להמשיך');
      if (!ok) return;
    }
    if (d.date > todayISO()) {
      const ok = await confirmBox('תאריך עתידי', 'תאריך הקבלה הוא בעתיד. קבלה מוציאים בעת קבלת התשלום. להמשיך?', 'כן, להמשיך');
      if (!ok) return;
    }
    const num = nextNumber(data);
    const total = round2(d.payments.reduce((s, p) => s + Number(p.amount), 0));
    const ok = await modal({
      title: 'אישור הפקת קבלה',
      body: html`<div class="confirm-sum">
        <div><span>מספר קבלה</span><strong>${num}</strong></div>
        <div><span>לקוח</span><strong>${d.client.name}</strong></div>
        <div><span>עבור</span><strong>${d.subject}</strong></div>
        <div><span>תאריך</span><strong>${fmtDate(d.date)}</strong></div>
        <div><span>סכום</span><strong>${fmtMoney(total)}</strong></div>
      </div>
      <p class="muted small">לאחר ההפקה לא ניתן לערוך או למחוק את הקבלה (לפי החוק). ניתן רק לבטל ולהפיק חדשה.</p>
      ${!data.settings.numberConfirmed ? html`<p class="notice small">זו הקבלה הראשונה במערכת: ודא שהמספר <strong>${num}</strong> ממשיך נכון את רצף הקבלות שלך.</p>` : ''}`,
      actions: [
        { label: 'חזרה לעריכה', value: false },
        { label: 'הפקה', value: true },
      ],
    });
    if (!ok) return;

    const r = {
      id: crypto.randomUUID(),
      number: num,
      date: d.date,
      issuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      business: { ...data.business },
      client: d.client,
      subject: d.subject,
      notes: d.notes,
      payments: d.payments.map(({ id, ...p }) => {
        const clean = { method: p.method, amount: round2(p.amount), date: p.date || d.date };
        for (const f of PAYMENT_METHODS[p.method]?.fields || []) if (p[f]) clean[f] = String(p[f]).trim();
        return clean;
      }),
      status: 'issued',
      source: 'app',
      originalGiven: false,
    };
    r.total = receiptTotal(r);
    data.receipts.push(r);
    data.settings.nextNumber = num + 1;
    data.settings.numberConfirmed = true;
    upsertClient(data, d.client);
    audit(data, 'issue', `קבלה ${num}`);
    sessionStorage.removeItem(DRAFT_KEY);
    await persist(`קבלה ${num} הופקה`);
    toast(`קבלה ${num} הופקה בהצלחה`);
    location.hash = `#/r/${r.id}?new=1`;
    if (driveConfigured() && data.settings.driveAutoUpload) uploadToDrive(r, true);
  };

  renderPayments();
  update();
  setTimeout(() => (draft.client.name ? $('#r-subject') : $('#c-name')).focus(), 50);
}

/* ───────────────────────── Drive ───────────────────────── */

async function uploadToDrive(r, silent = false) {
  try {
    if (!silent) toast('מעלה ל-Google Drive…', 'ok', 2000);
    const blob = await receiptPdf(r, 'copy');
    const res = await driveUpload(blob, pdfFileName(r, true), yearOf(r));
    r.driveFileId = res.id;
    r.driveUrl = res.url;
    r.updatedAt = new Date().toISOString();
    audit(D(), 'drive', `קבלה ${r.number}`);
    await store.save(`קבלה ${r.number} נשמרה ב-Drive`);
    toast(`קבלה ${r.number} נשמרה ב-Google Drive`);
    if (location.hash.startsWith('#/r/' + r.id)) route();
  } catch (e) {
    toast('ההעלאה ל-Drive נכשלה: ' + e.message, 'error', 6000);
  }
}

/* ───────────────────────── צפייה בקבלה ───────────────────────── */

function viewReceipt(parts, q) {
  const r = D().receipts.find((x) => x.id === parts[1]);
  if (!r) {
    main.innerHTML = html`<div class="page"><div class="card empty"><p>הקבלה לא נמצאה.</p><a class="btn btn-primary" href="#/receipts">לרשימת הקבלות</a></div></div>`.__html;
    return;
  }
  const isArchive = r.source === 'archive';
  const defCopy = r.originalGiven ? 'copy' : 'original';

  main.innerHTML = html`
  <div class="page">
    <nav class="crumbs" aria-label="פירורי לחם"><a href="#/receipts?year=${yearOf(r)}">קבלות ${yearOf(r)}</a> <span aria-hidden="true">/</span> <span>קבלה ${r.number}</span></nav>
    ${q.get('new') ? html`<div class="banner banner-ok success-banner" role="status"><strong>הקבלה הופקה ונשמרה!</strong> מה עכשיו? שלח ללקוח או הדפס.</div>` : ''}
    <div class="page-head">
      <div><h1>קבלה ${r.number} ${statusChip(r)}</h1>
      <p class="muted">${r.client?.name} · ${fmtDate(r.date)} · ${fmtMoney(receiptTotal(r))}</p></div>
    </div>

    ${isArchive
      ? html`<div class="card">
          <p>קבלה מהארכיון (הופקה לפני המערכת).</p>
          <dl class="kv">
            <div><dt>עבור</dt><dd>${r.subject || '—'}</dd></div>
            <div><dt>אמצעי תשלום</dt><dd>${(r.payments || []).map((p) => methodLabel(p.method) + (paymentDetails(p) ? ' — ' + paymentDetails(p) : '')).join(', ') || '—'}</dd></div>
          </dl>
          ${r.driveUrl ? html`<a class="btn btn-primary" href="${r.driveUrl}" target="_blank" rel="noopener noreferrer">פתיחת הקבלה המקורית ב-Drive ↗</a>` : html`<span id="drive-find" class="muted">${driveUrl() ? 'מחפש את הקובץ ב-Drive…' : 'הקובץ המקורי שמור בתיקיית הקבלות ב-Drive.'}</span>`}
          <button class="btn btn-ghost" data-act="edit-archive">עריכת הרשומה</button>
        </div>`
      : html`
    <div class="view-grid">
      <div class="actions-panel card">
        <div class="field">
          <label for="copy-sel">סוג העותק</label>
          <select id="copy-sel">
            <option value="original" ${defCopy === 'original' ? 'selected' : ''}>מקור (ללקוח)</option>
            <option value="copy" ${defCopy === 'copy' ? 'selected' : ''}>העתק נאמן למקור</option>
          </select>
          ${r.originalGiven ? html`<small class="hint">המקור כבר נמסר — מומלץ "העתק נאמן למקור".</small>` : ''}
        </div>
        <div class="action-grid">
          <button class="action" data-act="share"><span aria-hidden="true">📤</span>שליחה / שיתוף</button>
          <button class="action" data-act="whatsapp"><span aria-hidden="true">💬</span>וואטסאפ</button>
          <button class="action" data-act="email"><span aria-hidden="true">✉️</span>דוא״ל</button>
          <button class="action" data-act="pdf"><span aria-hidden="true">⬇️</span>הורדת PDF</button>
          <button class="action" data-act="print"><span aria-hidden="true">🖨️</span>הדפסה</button>
          ${r.driveUrl
            ? html`<a class="action" href="${r.driveUrl}" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">📁</span>פתיחה ב-Drive</a>`
            : html`<button class="action" data-act="drive"><span aria-hidden="true">☁️</span>שמירה ב-Drive</button>`}
          <a class="action" href="#/new?from=${r.id}"><span aria-hidden="true">⧉</span>שכפול לקבלה חדשה</a>
          ${r.status !== 'cancelled' ? html`<button class="action action-danger" data-act="cancel"><span aria-hidden="true">⊘</span>ביטול קבלה</button>` : ''}
        </div>
        <p class="muted small">הופקה ב־${fmtDateTime(r.issuedAt)}${r.driveUrl ? ' · שמורה ב-Drive' : ''}</p>
      </div>
      <div class="preview" id="preview"><div class="preview-scale" id="preview-scale"></div></div>
    </div>`}
  </div>`.__html;

  if (isArchive && !r.driveUrl && driveUrl()) {
    driveList()
      .then((res) => {
        const f = Object.values(res.years || {}).flat().find((x) => x.name.includes(String(r.number)));
        const el = $('#drive-find');
        if (!el) return;
        if (f) el.outerHTML = html`<a class="btn btn-primary" href="${f.url}" target="_blank" rel="noopener noreferrer">פתיחת הקבלה המקורית ב-Drive ↗</a>`.__html;
        else el.textContent = 'הקובץ לא נמצא ב-Drive.';
      })
      .catch(() => $('#drive-find') && ($('#drive-find').textContent = 'הקובץ המקורי שמור בתיקיית הקבלות ב-Drive.'));
  }
  if (!isArchive) {
    const scale = $('#preview-scale');
    const render = () => {
      scale.innerHTML = receiptHTML(r, { copy: $('#copy-sel').value });
      const wrap = $('#preview');
      const s = wrap.clientWidth / 794;
      scale.style.transform = `scale(${s})`;
      wrap.style.height = 1123 * s + 'px';
    };
    render();
    $('#copy-sel').onchange = render;
    const ro = new ResizeObserver(() => document.contains(scale) && render());
    ro.observe($('#preview'));
    onCleanup(() => ro.disconnect());
  }

  const copy = () => $('#copy-sel')?.value || 'copy';
  const markOriginal = async () => {
    if (copy() === 'original' && !r.originalGiven) {
      r.originalGiven = true;
      r.updatedAt = new Date().toISOString();
      audit(D(), 'original', `קבלה ${r.number}`);
      await store.save(`קבלה ${r.number}: נמסר מקור`);
    }
  };
  const withBusy = async (btn, fn) => {
    if (btn) {
      btn.disabled = true;
      btn.classList.add('busy');
    }
    try {
      await fn();
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message || 'שגיאה', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('busy');
      }
    }
  };
  const msgText = () =>
    `שלום ${r.client?.name || ''},\nמצורפת קבלה מס׳ ${r.number} על סך ${fmtMoney(receiptTotal(r))} עבור ${r.subject || 'שירותים'}.\nתודה רבה!\n${r.business.name}`;

  main.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'print') {
      await markOriginal();
      printReceipt(r, copy());
    }
    if (act === 'pdf')
      withBusy(btn, async () => {
        const blob = await receiptPdf(r, copy());
        download(pdfFileName(r), blob);
        await markOriginal();
        toast('קובץ ה-PDF הורד');
      });
    if (act === 'share' || act === 'whatsapp' || act === 'email')
      withBusy(btn, async () => {
        const blob = await receiptPdf(r, copy());
        const file = new File([blob], pdfFileName(r), { type: 'application/pdf' });
        if ((act === 'share' || /Android|iPhone|iPad/i.test(navigator.userAgent)) && navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: `קבלה ${r.number}`, text: msgText() });
          await markOriginal();
          return;
        }
        download(file.name, blob);
        await markOriginal();
        if (act === 'whatsapp') {
          const phone = waPhone(r.client?.phone);
          window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msgText())}`, '_blank', 'noopener');
          toast('ה-PDF הורד — צרף אותו בשיחת הוואטסאפ שנפתחה', 'ok', 6000);
        } else if (act === 'email') {
          location.href = `mailto:${encodeURIComponent(r.client?.email || '')}?subject=${encodeURIComponent(`קבלה מס׳ ${r.number} - ${r.business.name}`)}&body=${encodeURIComponent(msgText())}`;
          toast('ה-PDF הורד — צרף אותו להודעת הדוא״ל', 'ok', 6000);
        } else toast('השיתוף לא נתמך בדפדפן זה — ה-PDF הורד למכשיר', 'warn', 5000);
      });
    if (act === 'drive') {
      if (!driveConfigured()) {
        location.hash = '#/archive';
        return;
      }
      withBusy(btn, () => uploadToDrive(r));
    }
    if (act === 'cancel') {
      const res = await modal({
        title: `ביטול קבלה ${r.number}`,
        body: html`<p>הקבלה תסומן כ"מבוטלת" ותישאר בארכיון (לפי החוק אין למחוק קבלות). הסכום לא ייכלל בסיכומים.</p>
          <div class="field"><label for="cancel-reason">סיבת הביטול <span class="req">*</span></label><input id="cancel-reason" name="reason" required autofocus placeholder="לדוגמה: טעות בסכום, הוחלפה בקבלה חדשה"></div>`,
        actions: [
          { label: 'חזרה', value: null },
          { label: 'ביטול הקבלה', submit: true, class: 'btn-danger' },
        ],
      });
      if (!res || !res.reason) return;
      r.status = 'cancelled';
      r.cancel = { date: todayISO(), reason: res.reason.trim() };
      r.updatedAt = new Date().toISOString();
      audit(D(), 'cancel', `קבלה ${r.number}: ${res.reason}`);
      await persist(`קבלה ${r.number} בוטלה`);
      toast(`קבלה ${r.number} בוטלה`);
      route();
      if (r.driveFileId && driveConfigured()) uploadToDrive(r, true);
    }
    if (act === 'edit-archive') {
      const updated = await archiveForm(r);
      if (updated) route();
    }
  });
}

/* ───────────────────────── רשימת קבלות ───────────────────────── */

function viewReceipts(parts, q) {
  const data = D();
  const years = [...new Set([new Date().getFullYear(), ...data.receipts.map(yearOf)])].sort((a, b) => b - a);
  let year = Number(q.get('year')) || years[0];
  let term = '';
  let filter = 'all';

  main.innerHTML = html`
  <div class="page">
    <div class="page-head">
      <h1>הקבלות שלי</h1>
      <div class="head-actions">
        <a class="btn btn-ghost" href="#/archive/import">ייבוא קבלות ישנות</a>
        <button class="btn btn-ghost" id="add-archive">הוספה ידנית</button>
        <button class="btn btn-ghost" id="export-csv">ייצוא לאקסל</button>
        <a href="#/new" class="btn btn-primary">＋ קבלה חדשה</a>
      </div>
    </div>
    <nav class="tabs" aria-label="בחירת שנה">${years.map((y) => html`<button class="tab" data-year="${y}">${y}</button>`)}</nav>
    <div class="toolbar card">
      <div class="field grow"><label for="search" class="sr-only">חיפוש</label>
        <input id="search" type="search" placeholder="חיפוש לפי לקוח, מספר, תיאור או סכום…"></div>
      <div class="field"><label for="filter" class="sr-only">סינון</label>
        <select id="filter"><option value="all">הכל</option><option value="issued">הופקו במערכת</option><option value="archive">ארכיון</option><option value="cancelled">מבוטלות</option></select></div>
    </div>
    <div id="year-summary"></div>
    <div id="list"></div>
  </div>`.__html;

  function render() {
    $$('[data-year]').forEach((b) => {
      const on = Number(b.dataset.year) === year;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const t = term.trim().toLowerCase();
    const list = sortedReceipts(data).filter((r) => {
      if (yearOf(r) !== year) return false;
      if (filter === 'issued' && (r.source === 'archive' || r.status === 'cancelled')) return false;
      if (filter === 'archive' && r.source !== 'archive') return false;
      if (filter === 'cancelled' && r.status !== 'cancelled') return false;
      if (!t) return true;
      return [r.number, r.client?.name, r.subject, r.client?.phone, receiptTotal(r)].join(' ').toLowerCase().includes(t);
    });
    const tot = totalsForYear(data, year);
    $('#year-summary').innerHTML = html`<div class="summary-strip">
      <div><span>סה״כ ${year}</span><strong>${fmtMoney(tot.sum)}</strong></div>
      <div><span>קבלות פעילות</span><strong>${tot.count}</strong></div>
      <div><span>מוצגות</span><strong>${list.length}</strong></div>
    </div>`.__html;
    if (!list.length) {
      $('#list').innerHTML = html`<div class="card empty"><p>${t ? 'לא נמצאו קבלות מתאימות.' : `אין קבלות בשנת ${year}.`}</p></div>`.__html;
      return;
    }
    const byMonth = new Map();
    for (const r of list) {
      const m = Number((r.date || '').slice(5, 7)) - 1;
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(r);
    }
    $('#list').innerHTML = [...byMonth.entries()]
      .map(([m, rs]) => {
        const sum = round2(rs.filter(isActive).reduce((s, r) => s + receiptTotal(r), 0));
        return html`<section class="card month">
          <div class="card-head"><h2>${MONTHS[m] || '—'} ${year}</h2><span class="muted">${rs.length} קבלות · ${fmtMoney(sum)}</span></div>
          ${receiptList(rs)}
        </section>`.__html;
      })
      .join('');
  }

  main.addEventListener('click', (e) => {
    const y = e.target.closest('[data-year]')?.dataset.year;
    if (y) {
      year = Number(y);
      history.replaceState(null, '', `#/receipts?year=${year}`);
      render();
    }
  });
  $('#search').addEventListener('input', debounce((e) => ((term = e.target.value), render()), 150));
  $('#filter').onchange = (e) => ((filter = e.target.value), render());
  $('#export-csv').onclick = () => exportCsv(data.receipts.filter((r) => yearOf(r) === year), `קבלות-${year}.csv`);
  $('#add-archive').onclick = async () => {
    if (await archiveForm()) render();
  };
  render();
}

function exportCsv(list, name) {
  const rows = [['מספר', 'תאריך', 'לקוח', 'ח.פ/ת.ז', 'טלפון', 'תיאור', 'אמצעי תשלום', 'פירוט', 'סכום', 'סטטוס', 'מקור']];
  for (const r of [...list].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0)))
    rows.push([
      r.number, fmtDate(r.date), r.client?.name, r.client?.taxId, r.client?.phone, r.subject,
      (r.payments || []).map((p) => methodLabel(p.method)).join(' + '),
      (r.payments || []).map(paymentDetails).join(' + '),
      receiptTotal(r).toFixed(2), r.status === 'cancelled' ? 'מבוטלת' : 'פעילה', r.source === 'archive' ? 'ארכיון' : 'מערכת',
    ]);
  const csv = '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  download(name, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  toast('הקובץ יוצא');
}

/** טופס קבלה ישנה (ארכיון) — הוספה או עריכה */
async function archiveForm(existing, prefill = {}) {
  const data = D();
  const r = existing || {};
  const p0 = r.payments?.[0] || {};
  const v = { number: r.number ?? prefill.number ?? '', date: r.date || prefill.date || '', name: r.client?.name || '', taxId: r.client?.taxId || '', phone: r.client?.phone || '', subject: r.subject || '', amount: p0.amount ?? '', method: p0.method || 'bit', driveUrl: r.driveUrl || prefill.driveUrl || '' };
  const res = await modal({
    title: existing ? `עריכת קבלה ${r.number} (ארכיון)` : 'הוספת קבלה ישנה לארכיון',
    wide: true,
    body: html`<p class="muted small">לקבלות שהופקו לפני המערכת (למשל ב-morning), כדי שהסיכומים השנתיים יהיו מלאים.</p>
      <div class="grid3">
        <div class="field"><label for="a-num">מספר קבלה *</label><input id="a-num" name="number" required inputmode="numeric" dir="ltr" value="${v.number}"></div>
        <div class="field"><label for="a-date">תאריך *</label><input id="a-date" name="date" type="date" required value="${v.date}"></div>
        <div class="field"><label for="a-amt">סכום (₪) *</label><input id="a-amt" name="amount" type="number" step="0.01" min="0" required dir="ltr" value="${v.amount}"></div>
      </div>
      <div class="grid3">
        <div class="field"><label for="a-name">לקוח *</label><input id="a-name" name="name" required list="clients-dl2" value="${v.name}"><datalist id="clients-dl2">${data.clients.map((c) => html`<option value="${c.name}"></option>`)}</datalist></div>
        <div class="field"><label for="a-tax">ח.פ / ת.ז</label><input id="a-tax" name="taxId" dir="ltr" value="${v.taxId}"></div>
        <div class="field"><label for="a-phone">טלפון</label><input id="a-phone" name="phone" dir="ltr" value="${v.phone}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="a-sub">עבור</label><input id="a-sub" name="subject" value="${v.subject}"></div>
        <div class="field"><label for="a-method">אמצעי תשלום</label><select id="a-method" name="method">${Object.entries(PAYMENT_METHODS).map(([k, m]) => html`<option value="${k}" ${k === v.method ? 'selected' : ''}>${m.label}</option>`)}</select></div>
      </div>
      <div class="field"><label for="a-url">קישור לקובץ ב-Drive</label><input id="a-url" name="driveUrl" type="url" dir="ltr" value="${v.driveUrl}" placeholder="https://drive.google.com/…"></div>`,
    actions: [
      { label: 'ביטול', value: null },
      {
        label: 'שמירה',
        submit: true,
        validate: (vals, form) => {
          const n = Number(vals.number);
          const dup = data.receipts.find((x) => Number(x.number) === n && x.id !== r.id);
          if (dup) {
            form.querySelector('#a-num').setCustomValidity('מספר קבלה זה כבר קיים');
            form.reportValidity();
            form.querySelector('#a-num').setCustomValidity('');
            return 'dup';
          }
        },
      },
    ],
  });
  if (!res) return false;
  const rec = existing || { id: crypto.randomUUID(), source: 'archive', status: 'issued', business: { ...data.business } };
  Object.assign(rec, {
    number: Number(res.number),
    date: res.date,
    issuedAt: rec.issuedAt || res.date + 'T12:00:00',
    updatedAt: new Date().toISOString(),
    client: { ...(rec.client || {}), name: res.name.trim(), taxId: res.taxId.trim(), phone: res.phone.trim() },
    subject: res.subject.trim(),
    payments: [{ method: res.method, amount: round2(res.amount), date: res.date }],
    driveUrl: res.driveUrl.trim() || undefined,
    driveFileId: prefill.driveFileId || rec.driveFileId,
  });
  rec.total = receiptTotal(rec);
  if (!existing) data.receipts.push(rec);
  upsertClient(data, rec.client);
  audit(data, existing ? 'archive-edit' : 'archive-add', `קבלה ${rec.number}`);
  await persist(`ארכיון: קבלה ${rec.number}`);
  toast('הרשומה נשמרה');
  return true;
}

/* ───────────────────────── ארכיון Drive ───────────────────────── */

function viewArchive(parts, q) {
  const data = D();
  const st = store.state();
  if (parts[1] === 'import') return viewImport();
  if (!driveUrl() || st.authError || q.get('setup')) return driveSetup(st);
  main.innerHTML = html`<div class="page">
    <div class="page-head"><h1>ארכיון Google Drive</h1>
      <div class="head-actions"><a class="btn btn-ghost" href="#/archive?setup=1">הגדרות חיבור</a><button class="btn btn-ghost" id="reload">רענון</button><a class="btn btn-primary" href="#/archive/import">ייבוא אוטומטי של הקבלות</a></div></div>
    <p class="muted">כל קובצי הקבלות בתיקיית ה-Drive שלך, מסודרים לפי שנים. קבצים שאינם רשומים במערכת אפשר להוסיף לסיכומים בלחיצה.</p>
    <div id="drive-list"><div class="card loading" aria-busy="true">טוען מ-Google Drive…</div></div>
  </div>`.__html;

  const load = async () => {
    if (!$('#drive-list')) return;
    $('#drive-list').innerHTML = '<div class="card loading" aria-busy="true">טוען מ-Google Drive…</div>';
    try {
      const res = await driveList();
      if (!$('#drive-list')) return;
      const years = Object.keys(res.years || {}).sort((a, b) => b.localeCompare(a));
      if (!years.length) {
        $('#drive-list').innerHTML = html`<div class="card empty"><p>התיקייה "${res.folder}" ריקה.</p></div>`.__html;
        return;
      }
      const linked = new Set(data.receipts.map((r) => r.driveFileId).filter(Boolean));
      const byNum = new Map(data.receipts.map((r) => [String(r.number), r]));
      $('#drive-list').innerHTML = years
        .map((y) => {
          const files = res.years[y];
          return html`<section class="card">
            <div class="card-head"><h2>${y}</h2><span class="muted">${files.length} קבצים</span></div>
            <ul class="flist">${files.map((f) => {
              const num = (f.name.match(/\d{4,6}/) || [])[0];
              const rec = linked.has(f.id) ? data.receipts.find((r) => r.driveFileId === f.id) : num && byNum.get(num);
              return html`<li>
                <span class="ficon" aria-hidden="true">📄</span>
                <a href="${f.url}" target="_blank" rel="noopener noreferrer" class="fname">${f.name}</a>
                <span class="muted small">${fmtDate(f.created.slice(0, 10))}</span>
                ${rec ? html`<a href="#/r/${rec.id}" class="chip chip-ok">במערכת #${rec.number}</a>` : html`<button class="btn btn-ghost btn-sm" data-add='${JSON.stringify({ id: f.id, url: f.url, num: num || '', date: f.created.slice(0, 10) })}'>הוספה לסיכומים</button>`}
              </li>`;
            })}</ul>
          </section>`.__html;
        })
        .join('');
    } catch (e) {
      $('#drive-list').innerHTML = html`<div class="card banner-err"><p>לא ניתן לטעון מ-Drive: ${e.message}</p><p><a href="#/settings#drive">בדיקת הגדרות Drive</a></p></div>`.__html;
    }
  };
  main.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const f = JSON.parse(add.dataset.add);
      if (await archiveForm(null, { number: f.num, date: f.date, driveUrl: f.url, driveFileId: f.id })) load();
    }
  });
  $('#reload').onclick = load;
  load();
}

/* ───────────────────────── ייבוא אוטומטי של קבלות קיימות ───────────────────────── */

const scriptCache = {};
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return (scriptCache[src] ||= new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => res(window[globalName]);
    el.onerror = () => rej(new Error('טעינה נכשלה: ' + src));
    document.head.appendChild(el);
  }));
}

function viewImport() {
  const data = D();
  main.innerHTML = html`<div class="page">
    <nav class="crumbs"><a href="#/archive">ארכיון Drive</a> <span aria-hidden="true">/</span> <span>ייבוא אוטומטי</span></nav>
    <div class="page-head"><div><h1>ייבוא הקבלות מ-Drive</h1>
      <p class="muted">המערכת קוראת את קובצי ה-PDF של הקבלות ומחלצת מספר, תאריך, לקוח, סכום ואמצעי תשלום. בודקים את הטבלה, מתקנים אם צריך — ומייבאים.</p></div></div>
    <div class="card imp-drop" id="imp-status">
      <label class="btn btn-primary btn-lg file-btn">בחירת קבצים מהמחשב (PDF או ZIP)
        <input type="file" id="imp-files" accept=".pdf,.zip,application/pdf,application/zip" multiple class="sr-only"></label>
      <p class="muted small">אפשר לבחור את קובץ ה-ZIP כמו שהוא, או לסמן כמה קובצי PDF ביחד (Ctrl+A בתיקייה). אפשר גם לגרור את הקבצים לכאן.</p>
      ${driveUrl() ? html`<button class="link-btn" id="imp-start">או: סריקה ישירה מתיקיית ה-Drive</button>` : ''}
    </div>
    <div id="imp-rows"></div>
  </div>`.__html;

  let rows = [];
  const existingNums = new Set(data.receipts.map((r) => String(r.number)));
  const linkedIds = new Set(data.receipts.map((r) => r.driveFileId).filter(Boolean));

  const methodOpts = (sel) => Object.entries(PAYMENT_METHODS).map(([k, m]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(m.label)}</option>`).join('');

  function renderRows() {
    const box = $('#imp-rows');
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = '';
      return;
    }
    const sel = rows.filter((r) => r.include).length;
    box.innerHTML = `
      <div class="card imp-bar">
        <span><strong>${rows.length}</strong> קבצים · <strong id="imp-count">${sel}</strong> מסומנים לייבוא</span>
        <button class="btn btn-primary" id="imp-go" ${sel ? '' : 'disabled'}>ייבוא הקבלות המסומנות</button>
      </div>
      ${rows
        .map(
          (r, i) => `<div class="card imp-row ${r.include ? '' : 'off'} ${r.missing.length ? 'warn' : ''}" data-i="${i}">
          <div class="imp-head">
            <label class="switch"><input type="checkbox" data-f="include" ${r.include ? 'checked' : ''}> ייבוא</label>
            ${r.file.url ? `<a href="${esc(r.file.url)}" target="_blank" rel="noopener noreferrer" class="fname">${esc(r.file.name)} ↗</a>` : `<span class="fname">${esc(r.file.name)}</span>`}
            ${r.note ? `<span class="chip ${r.dup ? 'chip-lav' : 'chip-err'}">${esc(r.note)}</span>` : ''}
          </div>
          <div class="grid3">
            <div class="field"><label>מספר קבלה</label><input data-f="number" dir="ltr" inputmode="numeric" value="${esc(r.number)}" ${!r.number ? 'aria-invalid="true"' : ''}></div>
            <div class="field"><label>תאריך</label><input data-f="date" type="date" value="${esc(r.date)}" ${!r.date ? 'aria-invalid="true"' : ''}></div>
            <div class="field"><label>סכום (₪)</label><input data-f="amount" type="number" step="0.01" dir="ltr" value="${esc(r.amount)}" ${!r.amount ? 'aria-invalid="true"' : ''}></div>
          </div>
          <div class="grid3">
            <div class="field"><label>לקוח</label><input data-f="client" value="${esc(r.client)}" ${!r.client ? 'aria-invalid="true"' : ''}></div>
            <div class="field"><label>עבור</label><input data-f="subject" value="${esc(r.subject)}"></div>
            <div class="field"><label>אמצעי תשלום</label><select data-f="method">${methodOpts(r.method)}</select></div>
          </div>
        </div>`
        )
        .join('')}
      <div class="card imp-bar"><span></span><button class="btn btn-primary" id="imp-go2" ${sel ? '' : 'disabled'}>ייבוא הקבלות המסומנות</button></div>`;
  }

  main.addEventListener('input', (e) => {
    const card = e.target.closest('.imp-row');
    const f = e.target.dataset.f;
    if (!card || !f) return;
    const r = rows[Number(card.dataset.i)];
    r[f] = f === 'include' ? e.target.checked : e.target.value;
    if (f === 'include') {
      card.classList.toggle('off', !r.include);
      const n = rows.filter((x) => x.include).length;
      $('#imp-count').textContent = n;
      $$('#imp-go, #imp-go2').forEach((b) => (b.disabled = !n));
    } else e.target.removeAttribute('aria-invalid');
  });

  main.addEventListener('click', async (e) => {
    if (e.target.id === 'imp-start') return scanDrive(e.target);
    if (e.target.id === 'imp-go' || e.target.id === 'imp-go2') return doImport();
  });

  main.addEventListener('change', (e) => {
    if (e.target.id === 'imp-files' && e.target.files.length) scanLocal([...e.target.files]);
  });
  main.addEventListener('dragover', (e) => {
    if (e.target.closest('#imp-status')) e.preventDefault();
  });
  main.addEventListener('drop', (e) => {
    if (!e.target.closest('#imp-status')) return;
    e.preventDefault();
    if (e.dataTransfer.files.length) scanLocal([...e.dataTransfer.files]);
  });

  /** קבצים מהמחשב (כולל פריסת ZIP) */
  async function scanLocal(picked) {
    const status = $('#imp-status');
    status.innerHTML = '<p aria-live="polite" id="imp-msg">פותח את הקבצים…</p><div class="progress"><span id="imp-prog" style="width:0%"></span></div>';
    const entries = [];
    for (const f of picked) {
      if (/\.zip$/i.test(f.name) || /zip/.test(f.type)) {
        const JSZip = await loadScript('assets/vendor/jszip.min.js', 'JSZip');
        const zip = await JSZip.loadAsync(f);
        for (const z of Object.values(zip.files)) {
          if (z.dir || !/\.pdf$/i.test(z.name) || /(^|\/)(__MACOSX|\.)/.test(z.name)) continue;
          entries.push({ name: z.name.split('/').pop(), folder: z.name, created: (z.date ? new Date(z.date) : new Date()).toISOString(), bytes: () => z.async('uint8array') });
        }
      } else if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        entries.push({ name: f.name, created: new Date(f.lastModified || Date.now()).toISOString(), bytes: async () => new Uint8Array(await f.arrayBuffer()) });
      }
    }
    if (!entries.length) {
      status.innerHTML = '<p class="form-error">לא נמצאו קובצי PDF בקבצים שנבחרו.</p><label class="btn btn-primary file-btn">בחירה מחדש<input type="file" id="imp-files" accept=".pdf,.zip" multiple class="sr-only"></label>';
      return;
    }
    // אם Drive מחובר — מקשרים כל קבלה לקובץ שלה ב-Drive לפי השם (לא חובה)
    let byName = new Map();
    if (driveUrl()) {
      try {
        const list = await driveList();
        byName = new Map(Object.values(list.years || {}).flat().map((f) => [f.name, f]));
      } catch {}
    }
    const files = entries.map((en) => {
      const d = byName.get(en.name);
      return { name: en.name, url: d?.url || '', id: d?.id || null, created: en.created, getBytes: en.bytes };
    }).filter((f) => !f.id || !linkedIds.has(f.id));
    return processFiles(files, false);
  }

  /** סריקה ישירה מתיקיית ה-Drive (דורש את גרסת הסקריפט העדכנית) */
  async function scanDrive(btn) {
    btn.disabled = true;
    const status = $('#imp-status');
    status.innerHTML = '<p aria-live="polite" id="imp-msg">טוען את רשימת הקבצים מ-Drive…</p><div class="progress"><span id="imp-prog" style="width:0%"></span></div>';
    let list;
    try {
      list = await driveList();
    } catch (ex) {
      status.innerHTML = html`<p class="form-error">לא ניתן לטעון מ-Drive: ${ex.message}</p>`.__html;
      return;
    }
    const files = Object.values(list.years || {})
      .flat()
      .filter((f) => /pdf/i.test(f.mime || '') || /\.pdf$/i.test(f.name))
      .filter((f) => !linkedIds.has(f.id))
      .map((f) => ({ ...f, getBytes: async () => base64ToBytes((await driveGetFile(f.id)).data) }));
    return processFiles(files, true);
  }

  async function processFiles(files, fromDrive) {
    const status = $('#imp-status');
    if (!files.length) {
      status.innerHTML = '<p>כל הקבלות כבר רשומות במערכת. 🎉</p><a class="btn btn-ghost" href="#/receipts">לרשימת הקבלות</a>';
      return;
    }
    let done = 0;
    const results = new Array(files.length);
    let failedApi = false;
    const worker = async (startAt) => {
      for (let i = startAt; i < files.length; i += 3) {
        const f = files[i];
        let parsed = {};
        let note = '';
        try {
          const lines = await pdfLines(await f.getBytes());
          parsed = parseReceipt(lines, f.name, data.business);
          if (!lines.length) note = 'קובץ סרוק — יש למלא ידנית';
        } catch (ex) {
          if (/פעולה לא מוכרת/.test(ex.message)) failedApi = true;
          note = 'לא נקרא — יש למלא ידנית';
          const n = f.name.match(/(\d{4,7})/);
          parsed = { number: n ? n[1] : '', date: f.created.slice(0, 10), method: 'other' };
        }
        const row = { file: f, number: '', date: '', client: '', taxId: '', phone: '', subject: '', amount: '', method: 'other', ...parsed, note };
        row.dup = !!row.number && existingNums.has(String(row.number));
        if (row.dup) row.note = 'כבר קיימת במערכת';
        row.missing = ['number', 'date', 'client', 'amount'].filter((k) => !row[k]);
        row.include = !row.dup;
        results[i] = row;
        done++;
        const prog = $('#imp-prog');
        if (prog) prog.style.width = ((done / files.length) * 100).toFixed(0) + '%';
        const msg = $('#imp-msg');
        if (msg) msg.textContent = `קורא קבצים… ${done} מתוך ${files.length}`;
      }
    };
    await Promise.all([0, 1, 2].map(worker));
    if (!$('#imp-status')) return;
    rows = results.sort((a, b) => (b.date || '').localeCompare(a.date || '') || Number(b.number) - Number(a.number));
    const missing = rows.filter((r) => r.missing.length && !r.dup).length;
    status.innerHTML = failedApi && fromDrive
      ? html`<div class="banner banner-err"><strong>הסריקה הישירה מ-Drive לא זמינה בגרסת הסקריפט שלך.</strong> פשוט רענן את העמוד ובחר את הקבצים (או את ה-ZIP) מהמחשב.</div>`.__html
      : html`<p><strong>הסריקה הסתיימה.</strong> ${rows.length} קבצים נקראו${missing ? html` — ב-<strong>${missing}</strong> חסרים פרטים (מסומנים באדום), כדאי להשלים לפני הייבוא` : ' — כל הפרטים זוהו'}.</p>`.__html;
    renderRows();
  }

  async function doImport() {
    const chosen = rows.filter((r) => r.include);
    const bad = chosen.filter((r) => !r.number || !r.date || !(Number(r.amount) > 0) || !String(r.client).trim());
    if (bad.length) {
      const ok = await confirmBox('חסרים פרטים', `ב-${bad.length} קבלות חסר מספר, תאריך, לקוח או סכום. הן ייובאו עם מה שיש (אפשר לערוך אחר כך מתוך הקבלה). להמשיך?`, 'כן, לייבא');
      if (!ok) return;
    }
    const nums = new Set(data.receipts.map((r) => String(r.number)));
    let added = 0;
    for (const r of chosen) {
      const num = Number(r.number) || 0;
      if (num && nums.has(String(num))) continue;
      nums.add(String(num));
      const rec = {
        id: crypto.randomUUID(),
        source: 'archive',
        status: 'issued',
        number: num,
        date: r.date || r.file.created.slice(0, 10),
        issuedAt: (r.date || r.file.created.slice(0, 10)) + 'T12:00:00',
        updatedAt: new Date().toISOString(),
        business: { ...data.business },
        client: { name: String(r.client || '').trim() || 'לא זוהה', taxId: r.taxId || '', phone: r.phone || '' },
        subject: String(r.subject || '').trim(),
        payments: [{ method: r.method || 'other', amount: round2(r.amount), date: r.date }],
        driveUrl: r.file.url || undefined,
        driveFileId: r.file.id || undefined,
      };
      rec.total = receiptTotal(rec);
      data.receipts.push(rec);
      if (rec.client.name !== 'לא זוהה') upsertClient(data, rec.client);
      added++;
    }
    audit(data, 'archive-add', `ייבוא אוטומטי של ${added} קבלות מ-Drive`);
    await persist('ייבוא קבלות');
    const maxNum = data.receipts.reduce((m, r) => Math.max(m, Number(r.number) || 0), 0);
    await modal({
      title: 'הייבוא הושלם',
      body: html`<p><strong>${added}</strong> קבלות נוספו למערכת. הסיכומים בדף הראשי מעודכנים.</p>
        <p>המספר הגבוה ביותר במערכת: <strong>${maxNum}</strong>. הקבלה הבאה תקבל את המספר <strong>${nextNumber(data)}</strong>.</p>
        <p class="muted small">אם זה לא המספר הנכון — אפשר לשנות בהגדרות ← מספור.</p>`,
      actions: [{ label: 'לרשימת הקבלות', value: true }],
    });
    location.hash = '#/receipts';
  }
}

/** מסך חיבור Drive: מייצר קוד Apps Script מוכן להדבקה */
const LS_FOLDER = 'ar_drive_folder_v1';
function driveSetup(st) {
  let folder = '';
  try {
    folder = localStorage.getItem(LS_FOLDER) || '';
  } catch {}
  main.innerHTML = html`<div class="page">
    <div class="page-head"><h1>חיבור Google Drive</h1></div>
    ${st.authError ? html`<div class="banner banner-err"><strong>הקוד שב-Apps Script לא תואם לסיסמה.</strong> צור את הקוד מחדש כאן (שלב 1), הדבק אותו ב-Apps Script במקום הקוד הקיים, ופרסם גרסה חדשה (שלב 3).</div>` : ''}
    <section class="card prose">
      <p>כל הנתונים של המערכת (מוצפנים) וכל קובצי ה-PDF של הקבלות יישמרו בתיקיית הקבלות שלך ב-Drive, עם גיבוי יומי אוטומטי. הסקריפט רץ בחשבון הגוגל שלך וניגש <strong>רק</strong> לתיקייה הזו.</p>

      <h3>שלב 1 — יצירת הקוד</h3>
      <div class="field"><label for="d-folder">הקישור לתיקיית הקבלות הראשית ב-Drive (או המזהה שלה)</label>
        <input id="d-folder" dir="ltr" value="${folder}" placeholder="https://drive.google.com/drive/folders/…"></div>
      <button type="button" class="btn btn-primary" id="gen-code">יצירת הקוד</button>
      <div id="code-box" hidden>
        <div class="field"><label for="d-code">הקוד המוכן (כבר כולל את התיקייה וקוד הגישה שלך)</label>
          <textarea id="d-code" dir="ltr" rows="8" readonly spellcheck="false" class="code-area"></textarea></div>
        <button type="button" class="btn btn-primary" id="copy-code">העתקת הקוד</button>
      </div>

      <h3>שלב 2 — הדבקה ב-Apps Script</h3>
      <ol class="steps">
        <li>פתח את <a href="https://script.google.com/home" target="_blank" rel="noopener noreferrer">script.google.com</a> ואת הפרויקט שיצרת (או צור פרויקט חדש).</li>
        <li>מחק את כל הקוד שבעורך, הדבק את הקוד שהעתקת, ושמור (Ctrl+S).</li>
        <li>בחר למעלה בפונקציה <code dir="ltr">testSetup</code> ולחץ <strong>"הפעלה"</strong>. אם מבקשים הרשאות — אשר (במסך "Google לא אימתה" לחץ "מתקדם" ← "מעבר אל…").</li>
      </ol>

      <h3>שלב 3 — פרסום</h3>
      <ol class="steps">
        <li><strong>בפעם הראשונה:</strong> "לפריסה" ← "פריסה חדשה" ← גלגל השיניים ← "אפליקציית אינטרנט". הפעלה בתור: <strong>אני</strong>. למי יש גישה: <strong>כל אחד</strong> ← "פריסה". העתק את הכתובת שמסתיימת ב-<code dir="ltr">/exec</code>.</li>
        <li><strong>אם כבר פרסמת בעבר:</strong> "לפריסה" ← "ניהול פריסות" ← עיפרון ✏️ ← גרסה: <strong>"גרסה חדשה"</strong> ← "פריסה". הכתובת נשארת אותה כתובת.</li>
      </ol>

      <h3>שלב 4 — חיבור</h3>
      <form id="drive-form" class="drive-form">
        <div class="field"><label for="d-url">כתובת ה-Web app</label><input id="d-url" type="url" dir="ltr" required value="${driveUrl()}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <button class="btn btn-primary">חיבור ובדיקה</button>
      </form>
    </section>
  </div>`.__html;

  const parseFolder = (v) => {
    v = v.trim();
    const m = v.match(/folders\/([\w-]+)/) || v.match(/[?&]id=([\w-]+)/);
    return m ? m[1] : /^[\w-]{15,}$/.test(v) ? v : '';
  };
  $('#gen-code').onclick = async () => {
    const id = parseFolder($('#d-folder').value);
    if (!id) return toast('לא זוהה מזהה תיקייה. הדבק את הכתובת המלאה מ-Drive.', 'error');
    try {
      localStorage.setItem(LS_FOLDER, $('#d-folder').value.trim());
    } catch {}
    const r = await fetch('google-apps-script/Code.gs?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return toast('לא ניתן לטעון את הקוד', 'error');
    const code = (await r.text()).replace("'PASTE_FOLDER_ID_HERE'", `'${id}'`).replace("'PASTE_SECRET_FROM_SITE'", `'${drive.secret}'`);
    $('#d-code').value = code;
    $('#code-box').hidden = false;
    $('#copy-code').focus();
  };
  $('#copy-code').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#d-code').value);
    } catch {
      $('#d-code').select();
      document.execCommand('copy');
    }
    toast('הקוד הועתק — הדבק אותו ב-Apps Script');
  };
  $('#drive-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    btn.textContent = 'מתחבר…';
    try {
      const res = await store.connectDrive($('#d-url').value);
      audit(D(), 'drive-connect', res.folder);
      await store.save();
      toast(`מחובר לתיקייה "${res.folder}" — הנתונים נשמרים ב-Drive`);
      location.hash = '#/archive';
      route();
    } catch (ex) {
      toast('החיבור נכשל: ' + ex.message, 'error', 9000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'חיבור ובדיקה';
    }
  };
}

/* ───────────────────────── לקוחות ───────────────────────── */

function viewClients() {
  const data = D();
  main.innerHTML = html`<div class="page">
    <div class="page-head"><h1>לקוחות</h1></div>
    <div class="toolbar card"><div class="field grow"><label for="csearch" class="sr-only">חיפוש לקוח</label><input id="csearch" type="search" placeholder="חיפוש לקוח…"></div></div>
    <div id="clist"></div>
  </div>`.__html;
  const render = (t = '') => {
    const stats = new Map();
    for (const r of data.receipts) {
      if (!isActive(r)) continue;
      const k = r.client?.name?.trim();
      const s = stats.get(k) || { n: 0, sum: 0, last: '' };
      s.n++;
      s.sum += receiptTotal(r);
      if (r.date > s.last) s.last = r.date;
      stats.set(k, s);
    }
    const list = data.clients.filter((c) => !t || [c.name, c.phone, c.taxId].join(' ').toLowerCase().includes(t.toLowerCase())).sort((a, b) => (stats.get(b.name)?.last || '').localeCompare(stats.get(a.name)?.last || ''));
    $('#clist').innerHTML = list.length
      ? html`<div class="card"><ul class="clist">${list.map((c) => {
          const s = stats.get(c.name) || { n: 0, sum: 0 };
          return html`<li>
            <div class="cmain"><strong>${c.name}</strong><small class="muted">${[c.phone, c.taxId && 'ח.פ ' + c.taxId, c.email].filter(Boolean).join(' · ')}</small></div>
            <div class="cstats"><span>${s.n} קבלות</span><strong>${fmtMoney(s.sum)}</strong></div>
            <div class="cact">
              <a class="btn btn-primary btn-sm" href="#/new?client=${c.id}">קבלה חדשה</a>
              <button class="btn btn-ghost btn-sm" data-edit="${c.id}">עריכה</button>
            </div>
          </li>`;
        })}</ul></div>`.__html
      : html`<div class="card empty"><p>${t ? 'לא נמצאו לקוחות.' : 'לקוחות נשמרים אוטומטית בכל הפקת קבלה.'}</p></div>`.__html;
  };
  $('#csearch').addEventListener('input', debounce((e) => render(e.target.value), 150));
  main.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-edit]')?.dataset.edit;
    if (!id) return;
    const c = data.clients.find((x) => x.id === id);
    const res = await modal({
      title: 'עריכת לקוח',
      body: html`<p class="muted small">השינוי ישפיע על קבלות עתידיות בלבד — קבלות שהופקו לא משתנות.</p>
        <div class="field"><label for="e-name">שם</label><input id="e-name" name="name" required value="${c.name}"></div>
        <div class="grid2"><div class="field"><label for="e-phone">טלפון</label><input id="e-phone" name="phone" dir="ltr" value="${c.phone || ''}"></div>
        <div class="field"><label for="e-tax">ח.פ / ת.ז</label><input id="e-tax" name="taxId" dir="ltr" value="${c.taxId || ''}"></div></div>
        <div class="grid2"><div class="field"><label for="e-email">דוא״ל</label><input id="e-email" name="email" type="email" dir="ltr" value="${c.email || ''}"></div>
        <div class="field"><label for="e-addr">כתובת</label><input id="e-addr" name="address" value="${c.address || ''}"></div></div>`,
      actions: [
        { label: 'מחיקת לקוח', value: 'delete', class: 'btn-danger-ghost' },
        { label: 'ביטול', value: null },
        { label: 'שמירה', submit: true },
      ],
    });
    if (!res) return;
    if (res === 'delete') {
      if (!(await confirmBox('מחיקת לקוח', `למחוק את "${c.name}" מרשימת הלקוחות? (הקבלות שלו יישארו)`, 'מחיקה', true))) return;
      data.clients = data.clients.filter((x) => x.id !== id);
    } else Object.assign(c, { name: res.name.trim(), phone: res.phone.trim(), taxId: res.taxId.trim(), email: res.email.trim(), address: res.address.trim() });
    await persist('עדכון לקוחות');
    render($('#csearch').value);
  });
  render();
}

/* ───────────────────────── הגדרות ───────────────────────── */

function viewSettings() {
  const data = D();
  const b = data.business;
  const s = data.settings;
  const st = store.state();
  const maxNum = data.receipts.reduce((m, r) => Math.max(m, Number(r.number) || 0), 0);

  main.innerHTML = html`<div class="page settings">
    <div class="page-head"><h1>הגדרות</h1></div>

    <section class="card" id="business">
      <h2>פרטי העסק</h2>
      <p class="muted small">יופיעו בקבלות חדשות. קבלות שכבר הופקו נשארות כפי שהיו.</p>
      <form id="biz-form">
        <div class="grid2">
          <div class="field"><label for="b-name">שם העסק</label><input id="b-name" name="name" required value="${b.name}"></div>
          <div class="field"><label for="b-en">שם באנגלית</label><input id="b-en" name="nameEn" dir="ltr" value="${b.nameEn}"></div>
        </div>
        <div class="grid3">
          <div class="field"><label for="b-type">סוג עוסק</label><select id="b-type" name="type">${['עוסק פטור', 'עוסק מורשה', 'חברה בע״מ'].map((t) => html`<option ${t === b.type ? 'selected' : ''}>${t}</option>`)}</select></div>
          <div class="field"><label for="b-tax">מספר עוסק</label><input id="b-tax" name="taxId" required dir="ltr" inputmode="numeric" value="${b.taxId}"></div>
          <div class="field"><label for="b-phone">טלפון</label><input id="b-phone" name="phone" dir="ltr" value="${b.phone}"></div>
        </div>
        <div class="grid3">
          <div class="field"><label for="b-addr">כתובת</label><input id="b-addr" name="address" value="${b.address}"></div>
          <div class="field"><label for="b-email">דוא״ל</label><input id="b-email" name="email" type="email" dir="ltr" value="${b.email}"></div>
          <div class="field"><label for="b-web">אתר</label><input id="b-web" name="website" dir="ltr" value="${b.website}"></div>
        </div>
        <button class="btn btn-primary">שמירת פרטי העסק</button>
      </form>
    </section>

    <section class="card" id="numbering">
      <h2>מספור והגדרות קבלה</h2>
      <form id="num-form">
        <div class="grid3">
          <div class="field"><label for="n-next">מספר הקבלה הבאה</label><input id="n-next" name="next" type="number" min="${maxNum + 1}" dir="ltr" value="${nextNumber(data)}" aria-describedby="n-hint">
            <small class="hint" id="n-hint">${maxNum ? `הגבוה ביותר שהופק: ${maxNum}. אי אפשר לרדת מתחת.` : 'ודא שהמספר ממשיך את רצף הקבלות הקודמות שלך.'}</small></div>
          <div class="field"><label for="n-ceil">תקרת עוסק פטור (₪ לשנה)</label><input id="n-ceil" name="ceiling" type="number" min="0" dir="ltr" value="${s.ceiling}"><small class="hint">לבדוק מול רשות המסים בכל שנה.</small></div>
          <div class="field"><label for="n-subj">תיאור ברירת מחדל</label><input id="n-subj" name="subject" value="${s.defaultSubject}"></div>
        </div>
        <button class="btn btn-primary">שמירה</button>
      </form>
    </section>

    <section class="card" id="drive">
      <h2>שמירה ב-Google Drive ${st.configured && st.connected ? html`<span class="chip chip-ok">מחובר</span>` : st.authError ? html`<span class="chip chip-err">צריך לעדכן קוד</span>` : html`<span class="chip chip-err">לא מחובר</span>`}</h2>
      <p>כל הנתונים נשמרים <strong>מוצפנים</strong> בתיקיית הקבלות שלך ב-Drive, עם גיבוי יומי אוטומטי, ונשמר גם עותק מוצפן בדפדפן.</p>
      ${st.lastSync ? html`<p class="muted small">נשמר לאחרונה: ${fmtDateTime(st.lastSync)}</p>` : ''}
      ${st.configured
        ? html`<label class="switch"><input type="checkbox" id="drive-auto" ${s.driveAutoUpload ? 'checked' : ''}> שמירת PDF של כל קבלה חדשה בתיקיית השנה</label>
          <div class="btn-row"><button class="btn btn-ghost" id="drive-sync">שמירה עכשיו</button><button class="btn btn-ghost" id="drive-test">בדיקת חיבור</button><a class="btn btn-ghost" href="#/archive?setup=1">הגדרות חיבור</a><button class="btn btn-danger-ghost" id="drive-off">ניתוק מכשיר זה</button></div>`
        : html`<p><a class="btn btn-primary" href="#/archive">לחיבור Drive</a></p>`}
    </section>

    <section class="card" id="backup">
      <h2>גיבוי ושחזור</h2>
      <p class="muted small">הנתונים נשמרים ב-Drive עם גיבוי יומי. אפשר בנוסף להוריד גיבוי מוצפן למחשב.</p>
      <div class="btn-row">
        <button class="btn btn-ghost" id="bk-export">הורדת גיבוי מוצפן</button>
        <button class="btn btn-ghost" id="bk-csv">ייצוא כל הקבלות לאקסל</button>
        <label class="btn btn-ghost file-btn">שחזור/מיזוג מגיבוי<input type="file" id="bk-import" accept=".json,application/json" class="sr-only"></label>
      </div>
    </section>

    <section class="card" id="security">
      <h2>אבטחה</h2>
      <form id="pw-form">
        <div class="grid3">
          <div class="field"><label for="pw-cur">סיסמה נוכחית</label><input id="pw-cur" name="cur" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="pw-new">סיסמה חדשה</label><input id="pw-new" name="new1" type="password" autocomplete="new-password" minlength="8" required></div>
          <div class="field"><label for="pw-new2">אימות סיסמה חדשה</label><input id="pw-new2" name="new2" type="password" autocomplete="new-password" minlength="8" required></div>
        </div>
        <p class="notice small">אין שחזור סיסמה — הסיסמה היא מפתח ההצפנה. רשום אותה במקום בטוח. הקוד ב-Drive מתעדכן אוטומטית; במכשירים אחרים פשוט נכנסים עם הסיסמה החדשה.</p>
        <button class="btn btn-primary">החלפת סיסמה</button>
      </form>
      <hr>
      <button class="btn btn-danger-ghost" id="logout2">יציאה מהמערכת</button>
    </section>

    <section class="card">
      <h2>יומן פעולות</h2>
      <ul class="audit">${[...data.audit].reverse().slice(0, 40).map((a) => html`<li><span class="muted">${fmtDateTime(a.ts)}</span> ${auditLabel(a.action)} ${a.details}</li>`)}</ul>
    </section>
  </div>`.__html;

  if (location.hash.includes('#', 1)) {
    const id = location.hash.split('#')[2];
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 60);
  }

  $('#drive-sync')?.addEventListener('click', async () => {
    try {
      await store.sync();
      toast('נשמר ב-Drive');
      route();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  $('#biz-form').onsubmit = async (e) => {
    e.preventDefault();
    Object.assign(data.business, Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, String(v).trim()])));
    audit(data, 'business', '');
    await persist('עדכון פרטי עסק');
    toast('פרטי העסק נשמרו');
  };
  $('#num-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const next = Number(fd.get('next'));
    if (!(next > maxNum)) return toast(`המספר חייב להיות גדול מ-${maxNum}`, 'error');
    if (next !== nextNumber(data)) audit(data, 'numbering', `${nextNumber(data)} → ${next}`);
    data.settings.nextNumber = next;
    data.settings.numberConfirmed = true;
    data.settings.ceiling = Number(fd.get('ceiling')) || 0;
    data.settings.defaultSubject = String(fd.get('subject')).trim();
    await persist('עדכון הגדרות מספור');
    toast('נשמר');
  };
  $('#drive-auto')?.addEventListener('change', async (e) => {
    data.settings.driveAutoUpload = e.target.checked;
    await persist('הגדרות Drive');
  });
  $('#drive-test')?.addEventListener('click', async () => {
    try {
      const r = await drivePing();
      toast(`מחובר לתיקייה "${r.folder}"`);
    } catch (e) {
      toast('החיבור נכשל: ' + e.message, 'error');
    }
  });
  $('#drive-off')?.addEventListener('click', async () => {
    if (!(await confirmBox('ניתוק Drive', 'המכשיר הזה יפסיק לשמור ב-Drive (הנתונים ב-Drive לא יימחקו). אפשר לחבר מחדש בכל רגע.', 'ניתוק', true))) return;
    store.disconnectDrive();
    route();
  });
  $('#bk-export').onclick = async () => {
    download(`גיבוי-קבלות-${todayISO()}.enc.json`, new Blob([await store.exportEncrypted()], { type: 'application/json' }));
    toast('הגיבוי המוצפן הורד (נפתח עם הסיסמה שלך)');
  };
  $('#bk-csv').onclick = () => exportCsv(data.receipts, `כל-הקבלות-${todayISO()}.csv`);
  $('#bk-import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const res = await modal({
      title: 'שחזור מגיבוי',
      body: html`<p>הקבלות מהגיבוי ימוזגו עם הקיימות (שום דבר לא יימחק).</p><div class="field"><label for="imp-pw">הסיסמה שאיתה נוצר הגיבוי</label><input id="imp-pw" name="pw" type="password" required></div>`,
      actions: [{ label: 'ביטול', value: null }, { label: 'מיזוג', submit: true }],
    });
    e.target.value = '';
    if (!res) return;
    try {
      const imported = await store.importEncrypted(await file.text(), res.pw);
      session.data = mergeData(imported, session.data);
      audit(session.data, 'import', file.name);
      await persist('מיזוג גיבוי');
      toast(`מוזגו ${imported.receipts.length} קבלות מהגיבוי`);
      route();
    } catch {
      toast('לא ניתן לפתוח את הגיבוי — סיסמה שגויה או קובץ פגום', 'error');
    }
  };
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get('new1') !== fd.get('new2')) return toast('הסיסמאות החדשות אינן זהות', 'error');
    try {
      const { deriveRaw } = await import('./crypto.js');
      const chk = await deriveRaw(fd.get('cur'), session.salt, session.iterations);
      if (chk.join() !== session.raw.join()) return toast('הסיסמה הנוכחית שגויה', 'error');
      if (!(await confirmBox('החלפת סיסמה', 'להחליף את הסיסמה? רשום את החדשה במקום בטוח — אין דרך לשחזר אותה.', 'החלפה'))) return;
      audit(data, 'password', '');
      await store.changePassword(fd.get('new1'));
      toast('הסיסמה הוחלפה והנתונים הוצפנו מחדש');
      e.target.reset();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  };
  $('#logout2').onclick = () => logout();
}

function auditLabel(a) {
  return (
    { issue: 'הפקה:', cancel: 'ביטול:', original: 'מסירת מקור:', drive: 'Drive:', 'drive-connect': 'חיבור Drive:', business: 'עדכון פרטי עסק', numbering: 'שינוי מספור:', password: 'החלפת סיסמה', import: 'מיזוג גיבוי:', 'archive-add': 'ארכיון — הוספה:', 'archive-edit': 'ארכיון — עריכה:' }[a] || a
  );
}

/* ───────────────────────── אתחול ───────────────────────── */

document.addEventListener('keydown', (e) => {
  if (!session.key) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || e.ctrlKey || e.metaKey || e.altKey || $('#modal').open) return;
  if (e.key === 'n' || e.key === 'מ') location.hash = '#/new';
});

$('#logout').addEventListener('click', () => logout());

// כפתור "קבלה חדשה" בתפריט — לא שומר טיוטה ישנה כשנכנסים טרי
initA11y();

(async () => {
  const { parts } = parseHash();
  if (parts[0] === 'legal') {
    if (await store.restoreSession().catch(() => false)) {
      document.body.classList.add('authed');
      renderSync(store.state());
    }
    return route();
  }
  $('#boot').hidden = false;
  const ok = await store.restoreSession().catch(() => false);
  $('#boot').hidden = true;
  if (ok) enterApp();
  else showLogin();
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
