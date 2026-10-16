// Wall display: read-only calendar for a touchscreen, with a task drawer,
// check-in, chimes, auto-rotate, idle return to today and night dimming.
import { esc, toast, openSheet, addDays, addMonths, weekStart, daysBetween, fmtDate, fmtRange, fmtMonth, fmtTime, fromMin, toMin, isoDate } from "./util.js";
import { get } from "./api.js";
import { renderDay, renderWeek, renderMonth, detailHTML, whoText } from "./views.js";
import { TaskPanel } from "./tasks.js";
import { Checkin } from "./checkin.js";
import { initDrag } from "./drag.js";
import { openSchedule } from "./editor.js";
import { showItemDetail, addAtEmptySpot, applyDrop } from "./calendar-edit.js";
import { CHIMES, playSequence, unlockAudio, audioReady, chimeLength } from "./chime.js";
import { MoneyPanel } from "./money.js";
import { openReport } from "./report.js";

const $ = (s) => document.querySelector(s);
const IDLE_MS = 120_000;
const DRAWER_IDLE_MS = 60_000;
const ALERT_MS = 60_000;

const S = {
  tab: "cal", editing: false, lastSwipe: 0, view: "day", date: null, data: null, todayData: null, settings: {}, members: [], byId: new Map(), items: new Map(),
  offset: 0, lastTouch: Date.now(), fired: new Set(), rotateAt: 0, drawerOpen: false, loadedDate: null,
};

// The server's clock decides the date and time (it knows the family's timezone).
const nowDate = () => new Date(Date.now() + S.offset);
const nowISO = () => { const d = nowDate(); return `${isoDate(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const todayStr = () => isoDate(nowDate());
const idleFor = () => Date.now() - S.lastTouch;

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

function syncClock(serverNow) {
  const [d, t] = serverNow.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  const server = new Date(y, m - 1, day, hh, mm, new Date().getSeconds());
  S.offset = server - Date.now();
}

async function loadToday() {
  const t = todayStr();
  S.todayData = await get(`/api/calendar?start=${t}&end=${t}`);
  syncClock(S.todayData.now);
  S.settings = S.todayData.settings;
  S.members = S.todayData.members;
  S.byId = new Map(S.members.map((m) => [m.id, m]));
}

async function loadView() {
  const r = range();
  S.data = await get(`/api/calendar?start=${r.start}&end=${r.end}`);
  S.items = new Map(S.data.items.map((i) => [i.key, i]));
  const r2 = range();
  if (r2.start !== r.start) return loadView();
}

async function refresh() {
  if (S.tab === "money" && !document.querySelector(".ovl")) moneyPanel.load();
  try {
    await loadToday();
    if (!S.date) S.date = todayStr();
    await loadView();
    render();
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------- rendering
function render() {
  if (S.tab === "money") return;
  const r = range(), today = todayStr();
  $("#w-title").textContent = S.view === "day" ? (S.date === today ? fmtDate(S.date, { long: true }) : fmtDate(S.date, { long: true }))
    : S.view === "week" ? `Week of ${fmtRange(r.start, r.end)}` : fmtMonth(r.first);
  document.querySelectorAll("#w-seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === S.view));
  const n = S.todayData.checkin_count;
  const ci = $("#w-ci");
  ci.hidden = !S.settings.checkin_on_display;
  ci.dataset.zero = n === 0;
  ci.querySelector(".count").textContent = n;
  $("#w-legend").innerHTML = S.members.map((m) => `<span><i class="sw" style="--c:${m.color}"></i>${esc(m.name)}</span>`).join("")
    + '<span><i class="sw" style="--c:var(--accent)"></i>Everyone</span>';
  const cal = $("#w-cal");
  const now = nowISO();
  if (!S.members.length) {
    cal.innerHTML = '<div class="pad"><div class="panel"><h2>No family members yet</h2><p>Add them in Settings on a phone or computer.</p></div></div>';
  } else if (S.view === "day") {
    renderDay(cal, { date: S.date, items: S.data.items, members: S.members, byId: S.byId, now, hh: 52,
      startHour: S.settings.start_hour, endHour: S.settings.end_hour, editable: S.editing });
  } else if (S.view === "week") {
    renderWeek(cal, { start: r.start, items: S.data.items, members: S.members, byId: S.byId, todayStr: today, editable: S.editing });
  } else {
    renderMonth(cal, { monthStr: r.first, gridStart: r.start, weeks: r.weeks, items: S.data.items, byId: S.byId, todayStr: today,
      weekStartsOn: S.settings.week_starts_on, editable: S.editing });
  }
  if (S.loadedDate !== `${S.view}${S.date}`) { S.loadedDate = `${S.view}${S.date}`; scrollToNow(); }
  tick();
}

function scrollToNow() {
  const lanes = $("#w-cal [data-lanes]");
  const body = $("#w-body");
  if (!lanes) { body.scrollTop = 0; return; }
  const hh = +lanes.dataset.hh, start = +lanes.dataset.start;
  const target = S.date === todayStr() ? toMin(nowISO().slice(11, 16)) / 60 - 1.5 : 7;
  body.scrollTop = Math.max(0, (target - start) * hh);
}

function nextUp() {
  if (!S.todayData) return "";
  const m = toMin(nowISO().slice(11, 16));
  const up = S.todayData.items.filter((i) => i.start && !i.all_day && !i.end_date && toMin(i.start) > m && i.check_status !== "rescheduled")
    .sort((a, b) => toMin(a.start) - toMin(b.start));
  if (!up.length) return "";
  const first = up[0].start, grp = up.filter((i) => i.start === first);
  const mins = toMin(first) - m;
  const when = mins <= 60 ? `in ${mins} min` : `at ${fmtTime(first)}`;
  return `Next: ${grp.map((i) => `<b>${esc(i.title)}</b> (${esc(whoText(i, S.byId))})`).join(", ")} · ${when}`;
}

function tick() {
  const d = nowDate();
  const h = d.getHours(), ap = h >= 12 ? "pm" : "am";
  $("#w-clock").innerHTML = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}<small> ${ap}</small>`;
  if (S.tab !== "money") $("#w-next").innerHTML = nextUp();
}

// ---------------------------------------------------------------- navigation
function go(view, date) {
  if (view) S.view = view;
  if (date) S.date = date;
  loadView().then(render).catch((err) => toast(err.message, true));
}
function step(dir) {
  if (S.view === "day") go(null, addDays(S.date, dir));
  else if (S.view === "week") go(null, addDays(S.date, 7 * dir));
  else go(null, addMonths(S.date, dir));
}
function setTab(tab) {
  S.tab = tab;
  document.body.classList.toggle("tab-money", tab === "money");
  document.querySelectorAll("#w-tabs [data-tab]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tab === tab));
  if (tab === "money") { if (S.editing) setEditing(false); setDrawer(false); $("#w-title").textContent = "Pocket money"; $("#w-next").innerHTML = ""; moneyPanel.load(); }
  else { moneyPanel.lock(); render(); }
}

function goHome(view) {
  closeSheets();
  setDrawer(false);
  if (S.tab === "money") setTab("cal");
  go(view || S.view, todayStr());
}

// ---------------------------------------------------------------- touch, idle, rotate, dim
function touched() {
  S.lastTouch = Date.now();
  S.rotateAt = 0;
  unlockAudio();
  setTimeout(updateSound, 300);
  const dim = $("#w-dim");
  if (!dim.hidden) { dim.hidden = true; S.swallowClick = true; }
}
function closeSheets() { document.querySelectorAll(".ovl").forEach((o) => o.remove()); }

function inWindow(m, from, to) {
  const a = toMin(from), b = toMin(to);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

function everyFewSeconds() {
  const idle = idleFor();
  if (S.drawerOpen && idle > DRAWER_IDLE_MS && !drag.isDragging()) setDrawer(false);
  if (idle > IDLE_MS && !drag.isDragging()) {
    if (S.editing && !document.querySelector(".ovl")) setEditing(false);
    const views = S.settings.rotate_views?.length ? S.settings.rotate_views : ["day"];
    const today = todayStr();
    const rotate = S.settings.rotate_seconds > 0 && views.length > 1;
    if (rotate && Date.now() >= S.rotateAt) {
      const next = S.rotateAt === 0 && views.includes(S.view) ? S.view : views[(views.indexOf(S.view) + 1) % views.length];
      S.rotateAt = Date.now() + S.settings.rotate_seconds * 1000;
      if (next !== S.view || S.date !== today || document.querySelector(".ovl") || S.tab === "money") goHome(next);
    } else if (!rotate && (S.date !== today || document.querySelector(".ovl") || S.tab === "money")) {
      goHome(views.includes(S.view) ? S.view : views[0]);
    }
    const m = toMin(nowISO().slice(11, 16));
    $("#w-dim").hidden = !inWindow(m, S.settings.night_dim_start || "21:00", S.settings.night_dim_end || "06:00");
  }
  checkChimes();
  updateSound();
}

// ---------------------------------------------------------------- chimes
// Sound is on by default; the speaker button mutes this wall (remembered in this browser).
// Browsers keep audio blocked until the first touch (unless the kiosk allows autoplay),
// so the speaker shows an amber dot until then.
const MUTE_KEY = "fs.muted";
S.muted = (() => { try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; } })();
function inQuietHours() {
  const m = toMin(nowISO().slice(11, 16));
  return inWindow(m, S.settings.quiet_start || "20:30", S.settings.quiet_end || "07:00");
}
const fmtHM = (t) => fmtTime(t || "00:00");
function updateSound() {
  const b = $("#w-sound");
  b.hidden = !S.settings.chime_enabled;
  const quiet = !S.muted && inQuietHours();
  const blocked = !S.muted && !quiet && !audioReady();
  b.textContent = S.muted ? "🔇" : quiet ? "🌙" : "🔊";
  b.setAttribute("aria-pressed", S.muted);
  b.setAttribute("aria-label", S.muted ? "Unmute chimes" : "Mute chimes");
  b.title = S.muted ? "Chimes muted. Tap to turn them back on."
    : quiet ? `Quiet hours (${fmtHM(S.settings.quiet_start)} – ${fmtHM(S.settings.quiet_end)}): alerts show but don't chime. Change them in Settings → Display & chimes. Tap to mute.`
    : blocked ? "Chimes on, but the browser needs one touch on the screen before it will play sound." : "Chimes on. Tap to mute.";
  b.classList.toggle("blocked", blocked);
}
function toggleMute() {
  S.muted = !S.muted;
  try { localStorage.setItem(MUTE_KEY, S.muted ? "1" : "0"); } catch { /* private mode */ }
  unlockAudio();
  setTimeout(updateSound, 300);
  updateSound();
  toast(S.muted ? "Chimes muted on this screen" : "Chimes on");
}

function chimeKeys(items) {
  const keys = [];
  for (const it of items) {
    if (it.everyone) keys.push("family");
    else it.member_ids.forEach((id) => keys.push(S.byId.get(id)?.chime_sound || "bells"));
  }
  return [...new Set(keys)];
}

function checkChimes() {
  if (!S.todayData || !S.settings.chime_enabled) return;
  const today = todayStr(), m = toMin(nowISO().slice(11, 16));
  const starting = [], reminders = [];
  for (const it of S.todayData.items) {
    if (it.date !== today || !it.start || it.all_day || it.end_date || !it.chime || it.check_status) continue;
    const s = toMin(it.start);
    const sk = `s:${it.key}:${today}`;
    if (m >= s && m < s + 2 && !S.fired.has(sk)) { S.fired.add(sk); starting.push(it); }
    if (it.remind_minutes) {
      const r = s - it.remind_minutes, rk = `r:${it.key}:${today}`;
      if (m >= r && m < r + 2 && !S.fired.has(rk)) { S.fired.add(rk); reminders.push(it); }
    }
  }
  if (!starting.length && !reminders.length) return;
  showAlert(starting, reminders);
}

function alertRows(items) {
  return items.map((it) => `<div class="ai" style="--c:${it.everyone ? "var(--accent)" : S.byId.get(it.member_ids[0])?.color}">${esc(it.title)}
    <small>${esc(whoText(it, S.byId))}${it.kind === "flexible" ? " · flexible job" : ""}${it.location ? ` · ${esc(it.location)}` : ""}</small></div>`).join("");
}

function showAlert(starting, reminders) {
  const vol = S.settings.chime_volume ?? 70;
  const startKeys = chimeKeys(starting), remindKeys = chimeKeys(reminders);
  const names = (keys) => keys.map((k) => CHIMES[k]?.name.toLowerCase()).join(", then ");
  let html = "";
  if (starting.length) {
    html += `<div class="ah"><span class="bell">🔔</span><div><b>${fmtTime(starting[0].start)} · Starting now</b><span>Time to start · ♪ ${esc(names(startKeys))}</span></div></div>${alertRows(starting)}`;
  }
  if (reminders.length) {
    const r = reminders[0];
    html += `<div class="ah"><span class="bell">⏰</span><div><b>In ${r.remind_minutes} minutes · ${fmtTime(r.start)}</b><span>Time to get ready</span></div></div>${alertRows(reminders)}`;
  }
  const box = $("#w-alert");
  box.innerHTML = `<div class="alert" role="alert">${html}<button class="btn pri" data-alert-ok>OK</button></div>`;
  $("#w-dim").hidden = true;
  // Muted or quiet hours: the card still shows, just without sound.
  if (S.muted || inQuietHours()) startKeys.length = remindKeys.length = 0;
  playSequence(startKeys, { volume: vol });
  if (remindKeys.length) {
    const after = startKeys.reduce((t, k) => t + chimeLength(k) + 0.35, 0);
    setTimeout(() => playSequence(remindKeys, { volume: vol, remind: true }), after * 1000);
  }
  clearTimeout(showAlert.t);
  showAlert.t = setTimeout(() => (box.innerHTML = ""), ALERT_MS);
}

// ---------------------------------------------------------------- edit mode (no PIN; just guards against stray taps)
function startEditing() {
  setEditing(true);
  toast("Editing on. It turns off after 2 minutes without a touch.");
}
function setEditing(on) {
  S.editing = on;
  document.body.classList.toggle("editing", on);
  $("#w-edit").setAttribute("aria-pressed", on);
  $("#w-edit").textContent = on ? "✏️ Editing" : "✏️ Edit";
  $("#w-editbar").hidden = !on;
  panel.editable = on;
  panel.allowFolderDrop = on;
  if (S.drawerOpen) panel.render();
  render();
}

const editCtx = {
  lanes: () => S.members, members: () => S.members, byId: () => S.byId, settings: () => S.settings,
  nextHour: () => { const m = toMin(nowISO().slice(11, 16)); return fromMin(Math.min(Math.ceil((m + 1) / 60) * 60, 22 * 60)); },
  refreshAll: () => afterChange(), reload: () => refresh(), get panel() { return panel; },
};

// ---------------------------------------------------------------- tasks drawer & check-in
const panel = new TaskPanel($("#w-tasks-host"), {
  big: true,
  members: () => S.members,
  onSchedule: (task) => openSchedule(task, { members: S.members, onSaved: afterChange,
    defaults: { date: S.view === "day" ? S.date : todayStr(), start: S.settings.default_task_time || "09:00" } }),
  onChanged: afterChange,
});
async function afterChange() { await Promise.all([refresh(), panel.load()]); }

function setDrawer(open) {
  S.drawerOpen = open;
  const dr = $("#w-drawer");
  dr.hidden = !open;
  dr.style.top = $(".wtop").offsetHeight + "px";
  $("#w-tasks").setAttribute("aria-expanded", open);
  if (open) panel.load().catch((err) => toast(err.message, true));
}

const drag = initDrag({
  getItem: (k) => (S.editing ? S.items.get(k) : null),
  getTask: (id) => panel.task(id),
  laneName: (li) => S.members[li]?.name,
  allowFolderDrop: false,
  scrollers: () => [$("#w-body"), $("#w-tasks-host .tasks-body")],
  onStart: (p) => {
    $("#w-drawer").classList.add("dragging");
    if (p.type === "task" && S.view !== "day") go("day", S.date || todayStr());
  },
  onEnd: () => $("#w-drawer").classList.remove("dragging"),
  onCancel: () => refresh(),
  onDrop: (p, t) => {
    if (p.type !== "task" && !S.editing) return;
    applyDrop(p, t, editCtx).catch((err) => toast(err.message, true));
  },
});

const moneyPanel = new MoneyPanel($("#w-money"), { big: true, today: todayStr });
moneyPanel.onBooked = refresh;

function openCheckin() {
  const s = openSheet('<div data-ci-host></div>', { onClose: refresh });
  new Checkin(s.body.querySelector("[data-ci-host]"), { today: todayStr, onChange: () => {} }).load().catch((err) => toast(err.message, true));
}

// ---------------------------------------------------------------- wiring
function enableSwipe(el) {
  let x0 = null, y0 = 0, t0 = 0;
  el.addEventListener("pointerdown", (e) => { x0 = e.clientX; y0 = e.clientY; t0 = Date.now(); });
  el.addEventListener("pointerup", (e) => {
    if (x0 === null || drag.isDragging()) { x0 = null; return; }
    const dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (Date.now() - t0 < 700 && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.8) { S.lastSwipe = Date.now(); step(dx < 0 ? 1 : -1); }
  });
}

document.addEventListener("pointerdown", touched, true);
// The first touch on a dimmed screen only wakes it.
document.addEventListener("click", (e) => { if (S.swallowClick) { S.swallowClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
$("#w-tabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]")?.dataset.tab; if (t && t !== S.tab) setTab(t); });
$("#w-seg").addEventListener("click", (e) => { const v = e.target.closest("[data-view]")?.dataset.view; if (v) go(v); });
$("#w-prev").addEventListener("click", () => step(-1));
$("#w-fwd").addEventListener("click", () => step(1));
$("#w-today").addEventListener("click", () => go(null, todayStr()));
$("#w-tasks").addEventListener("click", () => setDrawer(!S.drawerOpen));
$("#w-edit").addEventListener("click", () => (S.editing ? setEditing(false) : startEditing()));
$("#w-edit-done").addEventListener("click", () => setEditing(false));
$("#w-drawer-x").addEventListener("click", () => setDrawer(false));
$("#w-ci").addEventListener("click", openCheckin);
$("#w-sound").addEventListener("click", toggleMute);
$("#w-alert").addEventListener("click", (e) => { if (e.target.closest("[data-alert-ok]")) $("#w-alert").innerHTML = ""; });
$("#w-cal").addEventListener("click", (e) => {
  if (Date.now() - S.lastSwipe < 400) return;
  const rep = e.target.closest("[data-report]");
  if (rep) return openReport(S.byId.get(+rep.dataset.report), { today: todayStr() });
  const k = e.target.closest("[data-key]");
  if (S.editing) {
    const it = k && S.items.get(k.dataset.key);
    if (it && !it.read_only) return showItemDetail(it, editCtx);
    if (!k) {
      const gd0 = e.target.closest("[data-goto-day]");
      if (gd0) return go("day", gd0.dataset.gotoDay);
      if (addAtEmptySpot(e, editCtx)) return;
      const md = e.target.closest("[data-month-day]");
      if (md) return go("day", md.dataset.monthDay);
      return;
    }
  }
  if (k) { const it = S.items.get(k.dataset.key); if (it) openSheet(detailHTML(it, S.byId, { editable: false }) + '<p class="muted" style="margin:14px 0 0;font-size:13.5px">The wall is view-only. Change things from a phone or computer.</p>'); return; }
  const gd = e.target.closest("[data-goto-day]") || e.target.closest("[data-month-day]");
  if (gd) go("day", gd.dataset.gotoDay || gd.dataset.monthDay);
});
enableSwipe($("#w-body"));

// Wake lock keeps the screen on where the browser allows it.
async function keepAwake() { try { await navigator.wakeLock?.request("screen"); } catch { /* not allowed; kiosk settings handle it */ } }
document.addEventListener("visibilitychange", () => { if (!document.hidden) { keepAwake(); refresh(); } });

await refresh();
if (location.hash === "#money") setTab("money");
if (S.settings.rotate_views?.length && !S.settings.rotate_views.includes("day") && S.settings.rotate_seconds > 0) go(S.settings.rotate_views[0]);
updateSound();
keepAwake();
setInterval(tick, 1000);
setInterval(everyFewSeconds, 5000);
let lastDay = todayStr();
setInterval(async () => {
  if (drag.isDragging()) return;
  await refresh();
if (location.hash === "#money") setTab("money");
  if (todayStr() !== lastDay) { lastDay = todayStr(); S.fired.clear(); if (idleFor() > IDLE_MS) goHome(); }
}, 60_000);
