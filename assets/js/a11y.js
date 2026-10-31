// תפריט נגישות: הגדלת טקסט, ניגודיות גבוהה, הדגשת קישורים, גופן קריא, עצירת אנימציות

const KEY = 'ar_a11y_v1';
const OPTIONS = [
  { id: 'contrast', label: 'ניגודיות גבוהה' },
  { id: 'links', label: 'הדגשת קישורים וכפתורים' },
  { id: 'readable', label: 'גופן קריא' },
  { id: 'still', label: 'עצירת אנימציות' },
  { id: 'cursor', label: 'סמן עכבר גדול' },
];

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function store(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

function apply(s) {
  const root = document.documentElement;
  root.style.fontSize = s.scale ? `${100 * s.scale}%` : '';
  for (const o of OPTIONS) root.classList.toggle('a11y-' + o.id, !!s[o.id]);
}

export function initA11y() {
  const s = load();
  apply(s);

  const btn = document.getElementById('a11y-toggle');
  const panel = document.getElementById('a11y-panel');
  if (!btn || !panel) return;

  panel.innerHTML = `
    <h2 id="a11y-title">תפריט נגישות</h2>
    <div class="a11y-row" role="group" aria-label="גודל טקסט">
      <button type="button" data-a="smaller" aria-label="הקטנת טקסט">א-</button>
      <span>גודל טקסט</span>
      <button type="button" data-a="bigger" aria-label="הגדלת טקסט">א+</button>
    </div>
    ${OPTIONS.map(
      (o) => `<label class="a11y-opt"><input type="checkbox" data-o="${o.id}" ${s[o.id] ? 'checked' : ''}> ${o.label}</label>`
    ).join('')}
    <button type="button" class="btn btn-ghost btn-sm" data-a="reset">איפוס הגדרות</button>
    <a href="#/legal/accessibility" class="a11y-link">הצהרת נגישות</a>
  `;

  const open = (v) => {
    panel.hidden = !v;
    btn.setAttribute('aria-expanded', String(v));
    if (v) panel.querySelector('button, input')?.focus();
  };
  btn.addEventListener('click', () => open(panel.hidden));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      open(false);
      btn.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) open(false);
  });
  panel.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const cur = load();
    if (a === 'bigger') cur.scale = Math.min(1.6, (cur.scale || 1) + 0.1);
    if (a === 'smaller') cur.scale = Math.max(0.8, (cur.scale || 1) - 0.1);
    if (a === 'reset') {
      for (const k of Object.keys(cur)) delete cur[k];
      panel.querySelectorAll('input[data-o]').forEach((i) => (i.checked = false));
    }
    store(cur);
    apply(cur);
  });
  panel.addEventListener('change', (e) => {
    const o = e.target.dataset.o;
    if (!o) return;
    const cur = load();
    cur[o] = e.target.checked;
    store(cur);
    apply(cur);
  });
}
