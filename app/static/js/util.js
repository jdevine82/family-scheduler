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

// ---------- Australian date boxes ----------
// Native <input type="date"> shows the *browser's* format (mm/dd/yyyy on US-English
// browsers, whatever the page says). Every date input is wrapped automatically: a text
// box that shows and accepts dd/mm/yyyy, plus a 📅 button that opens the native picker.
// The original input stays in the form (hidden) and keeps its name, id and ISO value,
// so code reading `input.value` is unchanged.
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
const toAU = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

export function parseAUDate(text) {
  const t = text.trim();
  if (!t) return "";
  let d, m, y;
  const digits = t.replace(/\D/g, "");
  const parts = t.split(/[^\d]+/).filter(Boolean);
  if (parts.length === 3 && parts[0].length === 4) [y, m, d] = parts; // 2026-10-16
  else if (parts.length >= 2) [d, m, y] = parts;
  else if (digits.length === 8) [d, m, y] = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)];
  else if (digits.length === 6) [d, m, y] = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)];
  else if (digits.length === 4) [d, m] = [digits.slice(0, 2), digits.slice(2)];
  else return null;
  y = y ? (y.length === 2 ? 2000 + +y : +y) : new Date().getFullYear();
  d = +d; m = +m;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return isoDate(dt);
}

export function auDateInput(input) {
  if (input.dataset.au) return;
  input.dataset.au = "1";
  const wrap = document.createElement("span");
  wrap.className = "audate";
  const text = document.createElement("input");
  text.type = "text";
  text.inputMode = "numeric";
  text.placeholder = "dd/mm/yyyy";
  text.autocomplete = "off";
  text.setAttribute("aria-label", (input.closest("label")?.textContent.trim() || "Date") + " (day/month/year)");
  if (input.required) text.required = true;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn";
  btn.textContent = "📅";
  btn.setAttribute("aria-label", "Pick a date");
  input.replaceWith(wrap);
  wrap.append(text, btn, input);
  input.classList.add("audate-native");
  input.tabIndex = -1;

  const show = () => { text.value = toAU(nativeValue.get.call(input)); text.classList.remove("bad"); };
  // Catch value changes made by code (input.value = "2026-10-17") as well as the picker.
  Object.defineProperty(input, "value", {
    get() { return nativeValue.get.call(this); },
    set(v) { nativeValue.set.call(this, v); show(); },
    configurable: true,
  });
  input.addEventListener("change", show);
  input.addEventListener("input", show);
  const commit = () => {
    const iso = parseAUDate(text.value);
    if (iso === null) { text.classList.add("bad"); toast("Type the date as day/month/year, e.g. 16/10/2026", true); return; }
    if (iso === nativeValue.get.call(input)) { show(); return; }
    nativeValue.set.call(input, iso);
    show();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  text.addEventListener("change", commit);
  text.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
  btn.addEventListener("click", () => {
    try { input.showPicker(); } catch { input.focus(); input.click(); }
  });
  show();
}

function enhanceDates(root) {
  if (root.matches?.('input[type="date"]')) auDateInput(root);
  root.querySelectorAll?.('input[type="date"]:not([data-au])').forEach(auDateInput);
}
if (typeof document !== "undefined") {
  const start = () => {
    enhanceDates(document.body);
    new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => n.nodeType === 1 && enhanceDates(n))))
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
}
