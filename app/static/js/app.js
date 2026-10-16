// Phone app: calendar, tasks, check-in and money with a bottom nav. (Computers are sent to the wall view.)
import { esc, toast, openSheet, isPhone, addDays, addMonths, weekStart, daysBetween, fmtDate, fmtRange, fmtMonth, fromMin, toMin } from "./util.js";
import { get } from "./api.js";
import { renderDay, renderWeek, renderMonth, renderAgenda } from "./views.js";
import { TaskPanel } from "./tasks.js";
import { Checkin } from "./checkin.js";
import { initDrag } from "./drag.js";
import { openEditor, openSchedule, openTaskEditor } from "./editor.js";
import { showItemDetail, addAtEmptySpot, applyDrop } from "./calendar-edit.js";
import { MoneyPanel } from "./money.js";
import { openReport, pickReport } from "./report.js";

const $ = (s) => document.querySelector(s);
const S = {
  view: "day", date: null, filter: "all", screen: "cal",
  data: null, items: new Map(), byId: new Map(), members: [], settings: {}, today: null, scrolledFor: null,
};

// ---------------------------------------------------------------- routing (#day/2026-10-16)
function readHash() {
  const [view, date] = location.hash.slice(1).split("/");
  if (view === "money") { S.screen = "money"; return; }
  if (["day", "week", "month"].includes(view)) S.view = view;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || "")) S.date = date;
}
function writeHash() { history.replaceState(null, "", S.screen === "money" ? "#money" : `#${S.view}/${S.date}`); }

function range() {
  const wso = S.settings.week_starts_on ?? 0;
  if (S.view === "day") return { start: S.date, end: S.date };
  if (S.view === "week") { const s = weekStart(S.date, wso); return { start: s, end: addDays(s, 6) }; }
  const first = S.date.slice(0, 8) + "01";
  const gridStart = weekStart(first, wso);
  const last = addDays(addMonths(first, 1), -1);
  const weeks = Math.ceil((daysBetween(gridStart, last) + 1) / 7);
  return { start: gridStart, end: addDays(gridStart, weeks * 7 - 1), weeks, first };
}

// ---------------------------------------------------------------- loading
async function load() {
  const r = range();
  try {
    const data = await get(`/api/calendar?start=${r.start}&end=${r.end}`);
    S.data = data;
    S.settings = data.settings;
    S.members = data.members;
    S.byId = new Map(data.members.map((m) => [m.id, m]));
    S.items = new Map(data.items.map((i) => [i.key, i]));
    S.today = data.now.slice(0, 10);
    // Week start may have changed the range; reload once with the right one.
    const r2 = range();
    if (r2.start !== r.start || r2.end !== r.end) return load();
    render();
  } catch (err) { toast(err.message, true); }
}
async function refreshAll() { await Promise.all([load(), panel.load()]); }

// ---------------------------------------------------------------- rendering
function visibleMembers() {
  if (isPhone() && S.view === "day" && S.filter !== "all") return S.members.filter((m) => m.id === S.filter);
  return S.members;
}

function render() {
  const r = range();
  $("#title").textContent = S.view === "day" ? (S.date === S.today ? `Today · ${fmtDate(S.date)}` : fmtDate(S.date, { long: true }))
    : S.view === "week" ? fmtRange(r.start, r.end) : fmtMonth(r.first);
  document.querySelectorAll("#viewseg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === S.view));
  const n = S.data.checkin_count;
  $("#ci-btn").dataset.zero = n === 0;
  $("#ci-btn .count").textContent = n;
  const badge = $("#nav-ci .badge");
  badge.hidden = !n;
  badge.textContent = n;

  const bar = $("#memberbar");
  bar.hidden = S.view === "month";
  bar.innerHTML = [{ id: "all", name: "All", color: "var(--accent)" }, ...S.members].map((m) =>
    `<button data-filter="${m.id}" aria-pressed="${S.filter === m.id}" style="--c:${m.color}">${m.id === "all" ? "" : `<i class="sw" style="--c:${m.color}"></i>`}${esc(m.name)}</button>`).join("");

  const cal = $("#cal");
  const phone = isPhone();
  const now = S.data.now;
  const items = S.data.items;
  if (!S.members.length) {
    cal.innerHTML = `<div class="pad"><div class="panel"><h2>Add your family first</h2><p>Each person gets their own lane on the calendar.</p>
      <a class="btn pri" href="/settings/members">Add family members</a></div></div>`;
    return;
  }
  if (S.view === "day") {
    if (phone && S.filter === "all") renderAgenda(cal, { dates: [S.date], items, byId: S.byId, now, filter: "all", todayStr: S.today });
    else renderDay(cal, { date: S.date, items, members: visibleMembers(), byId: S.byId, now, hh: phone ? 50 : 44,
      startHour: S.settings.start_hour, endHour: S.settings.end_hour, editable: true });
    scrollToNow();
  } else if (S.view === "week") {
    if (phone) renderAgenda(cal, { dates: Array.from({ length: 7 }, (_, i) => addDays(r.start, i)), items, byId: S.byId, now, filter: S.filter, todayStr: S.today });
    else renderWeek(cal, { start: r.start, items, members: S.members, byId: S.byId, todayStr: S.today });
  } else {
    renderMonth(cal, { monthStr: r.first, gridStart: r.start, weeks: r.weeks, items, byId: S.byId, todayStr: S.today, weekStartsOn: S.settings.week_starts_on });
  }
}

function scrollToNow() {
  const key = `${S.view}/${S.date}/${S.filter}`;
  if (S.scrolledFor === key) return;
  S.scrolledFor = key;
  const lanes = $("#cal [data-lanes]");
  if (!lanes) return;
  const hh = +lanes.dataset.hh, start = +lanes.dataset.start;
  const target = S.date === S.today ? toMin(S.data.now.slice(11, 16)) / 60 - 1.5 : 7.5;
  $("#main").scrollTop = Math.max(0, (target - start) * hh);
}

// ---------------------------------------------------------------- navigation
function go(view, date) {
  if (view) S.view = view;
  if (date) S.date = date;
  writeHash();
  load();
}
function step(dir) {
  if (S.view === "day") go(null, addDays(S.date, dir));
  else if (S.view === "week") go(null, addDays(S.date, 7 * dir));
  else go(null, addMonths(S.date, dir));
}

function setScreen(name) {
  if (S.screen === "money" && name !== "money") moneyPanel.lock();
  S.screen = name;
  document.body.classList.toggle("tab-money", name === "money");
  document.querySelectorAll("#apptabs [data-tab]").forEach((b) => b.setAttribute("aria-pressed", (b.dataset.tab === "money") === (name === "money")));
  if (name === "money") moneyPanel.load();
  writeHash();
  document.querySelectorAll("[data-screen]").forEach((el) => (el.hidden = el.dataset.screen !== name));
  document.querySelectorAll(".bottomnav [data-nav]").forEach((b) => b.toggleAttribute("aria-current", b.dataset.nav === name));
  $("#fab").hidden = name !== "cal";
  if (name === "checkin") checkin.load();
  if (name === "tasks") panel.load();
  placePanel();
}

function placePanel() {
  const host = isPhone() ? $("#tasks-screen") : $("#sidebar");
  if (panelEl.parentElement !== host) host.appendChild(panelEl);
}

// ---------------------------------------------------------------- calendar clicks
function calClick(e) {
  const rep = e.target.closest("[data-report]");
  if (rep) return openReport(S.byId.get(+rep.dataset.report), { today: S.today });
  const keyEl = e.target.closest("[data-key]");
  if (keyEl) { const it = S.items.get(keyEl.dataset.key); if (it) showItemDetail(it, editCtx); return; }
  const dayHead = e.target.closest("[data-goto-day]");
  if (dayHead) return go("day", dayHead.dataset.gotoDay);
  const monthDay = e.target.closest("[data-month-day]");
  if (monthDay) return go("day", monthDay.dataset.monthDay);
  addAtEmptySpot(e, editCtx);
}

function nextHour() {
  const m = toMin(S.data.now.slice(11, 16));
  return fromMin(Math.min(Math.ceil((m + 1) / 60) * 60, 22 * 60));
}

// ---------------------------------------------------------------- swipe between days/weeks on phones
function enableSwipe(el) {
  let x0 = null, y0 = 0, t0 = 0;
  el.addEventListener("touchstart", (e) => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); } }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (x0 === null || drag.isDragging()) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Date.now() - t0 < 600 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) step(dx < 0 ? 1 : -1);
  });
}

// ---------------------------------------------------------------- setup
const panelEl = document.createElement("div");
panelEl.className = "screen";
panelEl.id = "taskpanel";
const panel = new TaskPanel(panelEl, {
  editable: true,
  members: () => S.members,
  onSchedule: (task) => openSchedule(task, { members: S.members, onSaved: refreshAll,
    defaults: { date: S.view === "day" ? S.date : S.today, start: S.settings.default_task_time || "09:00" } }),
  onEdit: (task) => openTaskEditor(task, { folders: panel.folders, members: S.members, onSaved: refreshAll }),
  onChanged: load,
});
panel.allowFolderDrop = true;
const checkin = new Checkin($("#checkin-screen"), { onChange: () => refreshAll(), today: () => S.today });
const moneyPanel = new MoneyPanel($("#money-screen"), { today: () => S.today || document.body.dataset.today });
moneyPanel.onBooked = load;

const editCtx = {
  lanes: visibleMembers, members: () => S.members, byId: () => S.byId, settings: () => S.settings,
  nextHour, filter: () => S.filter, refreshAll, reload: load, panel,
};

const drag = initDrag({
  getItem: (k) => S.items.get(k),
  getTask: (id) => panel.task(id),
  laneName: (li) => visibleMembers()[li]?.name,
  allowFolderDrop: true,
  scrollers: () => [$("#main"), panelEl.querySelector(".tasks-body")],
  onDrop: (p, t) => applyDrop(p, t, editCtx).catch((err) => toast(err.message, true)),
  onCancel: load,
  onStart: (p) => { if (p.type === "task" && isPhone()) setScreen("cal"); },
});

S.date = document.body.dataset.today;
const startScreen = location.hash === "#money" ? "money" : "cal";
readHash();
S.screen = "cal";
$("#cal").addEventListener("click", calClick);
$("#viewseg").addEventListener("click", (e) => { const v = e.target.closest("[data-view]")?.dataset.view; if (v) go(v); });
$("#prev").addEventListener("click", () => step(-1));
$("#next").addEventListener("click", () => step(1));
$("#today").addEventListener("click", () => go(null, S.today));
$("#memberbar").addEventListener("click", (e) => {
  const f = e.target.closest("[data-filter]")?.dataset.filter;
  if (!f) return;
  S.filter = f === "all" ? "all" : +f;
  render();
});
$("#ci-btn").addEventListener("click", () => {
  if (isPhone()) return setScreen("checkin");
  const s = openSheet('<div data-ci-host></div>', { onClose: refreshAll });
  new Checkin(s.body.querySelector("[data-ci-host]"), { today: () => S.today, onChange: () => {} }).load();
});
$("#more-report").addEventListener("click", () => pickReport(S.members, { today: S.today }));
$("#fab").addEventListener("click", () => openEditor({ defaults: { date: S.date, start: nextHour(), member_ids: S.filter !== "all" ? [S.filter] : [] }, members: S.members, onSaved: refreshAll }));
document.querySelector(".bottomnav").addEventListener("click", (e) => { const n = e.target.closest("[data-nav]")?.dataset.nav; if (n) setScreen(n); });
window.addEventListener("hashchange", () => { if (location.hash === "#money") return setScreen("money"); readHash(); load(); });
let wasPhone = isPhone();
window.addEventListener("resize", () => {
  if (isPhone() === wasPhone) return;
  wasPhone = isPhone();
  if (!wasPhone && !["cal", "money"].includes(S.screen)) setScreen("cal");
  placePanel();
  render();
});
enableSwipe($("#main"));
placePanel();
setScreen(startScreen);
load();
$("#apptabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]")?.dataset.tab; if (t) setScreen(t); });
panel.load().catch((err) => toast(err.message, true));
// Keep the time line, past/flexible states and check-in count current.
setInterval(() => { if (!document.querySelector(".ovl") && !drag.isDragging() && !document.hidden) load(); }, 60000);
