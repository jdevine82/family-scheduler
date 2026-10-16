// Small shared helpers: dates as "YYYY-MM-DD" strings, times as "HH:MM".

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export function fmtTime(t) {
  if (!t) return "";
  let [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}
export const fmtHour = (h) => `${h % 12 || 12} ${h >= 12 && h < 24 ? "pm" : "am"}`;

export function parseDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
export function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
export function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); }
export function addMonths(s, n) { const d = parseDate(s); d.setDate(1); d.setMonth(d.getMonth() + n); return isoDate(d); }
export function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
export function weekStart(s, startsOn = 0) {
  // startsOn: 0 = Monday … 6 = Sunday (Python weekday numbering)
  const d = parseDate(s);
  const wd = (d.getDay() + 6) % 7;
  return addDays(s, -((wd - startsOn + 7) % 7));
}
export const weekdayIdx = (s) => (parseDate(s).getDay() + 6) % 7; // Monday = 0
export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function fmtDate(s, opts = {}) {
  const d = parseDate(s);
  const wd = DAY_SHORT[(d.getDay() + 6) % 7];
  if (opts.long) return `${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${wd} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}
export const fmtMonth = (s) => { const d = parseDate(s); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
export function fmtRange(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (da.getMonth() === db.getMonth()) return `${da.getDate()} – ${db.getDate()} ${MONTHS[db.getMonth()]}`;
  return `${da.getDate()} ${MONTHS[da.getMonth()].slice(0, 3)} – ${db.getDate()} ${MONTHS[db.getMonth()].slice(0, 3)}`;
}

export function h(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

// ---------- toasts ----------
let toastRoot;
export function toast(msg, err = false) {
  if (!toastRoot) { toastRoot = h('<div class="toast-root" aria-live="polite"></div>'); document.body.appendChild(toastRoot); }
  const el = h(`<div class="toast${err ? " err" : ""}">${esc(msg)}</div>`);
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), err ? 4500 : 2600);
}

// ---------- sheets (bottom sheet on phones, centred dialog on wider screens) ----------
export function openSheet(innerHTML, { onClose, wide } = {}) {
  const ovl = h(`<div class="ovl"><div class="sheet" role="dialog" aria-modal="true"${wide ? ' style="width:min(760px,100%)"' : ""}>
    <button class="x" aria-label="Close" data-close>✕</button><div class="sheet-body"></div></div></div>`);
  const body = ovl.querySelector(".sheet-body");
  body.innerHTML = innerHTML;
  const close = () => { if (!ovl.isConnected) return; ovl.remove(); document.removeEventListener("keydown", onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  ovl.addEventListener("click", (e) => { if (e.target === ovl || e.target.closest("[data-close]")) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(ovl);
  const first = body.querySelector("input[autofocus]");
  if (first) setTimeout(() => first.focus(), 30);
  return { el: ovl, body, close };
}

// In-page choice dialog (the wall kiosk shouldn't rely on browser confirm()).
export function choose(title, choices, text = "") {
  return new Promise((resolve) => {
    const s = openSheet(`<h2>${esc(title)}</h2>${text ? `<p class="muted" style="margin:-6px 0 14px">${esc(text)}</p>` : ""}
      <div class="scope-list">${choices.map((c, i) => `<button class="btn${c.primary ? " pri" : ""}${c.danger ? " danger" : ""}" data-i="${i}">${esc(c.label)}</button>`).join("")}</div>`,
      { onClose: () => resolve(null) });
    s.body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      // Resolve before closing: closing runs onClose, which would otherwise answer "cancelled" first.
      resolve(choices[+b.dataset.i].value);
      s.close();
    });
  });
}

export const isPhone = () => window.matchMedia("(max-width: 899px)").matches;
