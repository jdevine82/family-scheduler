// Weekly report: one person's last 7 days, every item marked done / not done.
// On screen only. Closes itself after 2 minutes without a touch.
import { esc, openSheet, toast, addDays, fmtDate, fmtTime } from "./util.js";
import { get } from "./api.js";
import { coversDate, isDone } from "./views.js";

const TIMEOUT_MS = 120_000;

function statusOf(it) {
  if (it.check_status === "rescheduled") return it.money_cents ? "notdone" : "moved";
  if (isDone(it)) return "done";
  if (it.check_status === "underway") return "underway";
  if (!it.past) return "later";
  return "notdone";
}

const LABEL = {
  done: ["✓", "Done"], notdone: ["✗", "Not done"], underway: ["🔧", "Underway"],
  later: ["⏳", "Still to come"], moved: ["↩", "Moved to another day"],
};

export async function openReport(member, { today }) {
  const start = addDays(today, -6);
  let data;
  try {
    data = await get(`/api/calendar?start=${start}&end=${today}`);
  } catch (err) { toast(err.message, true); return; }
  const mine = data.items.filter((it) => it.everyone || it.member_ids.includes(member.id));
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i)).reverse(); // newest first
  const count = { done: 0, notdone: 0, underway: 0, later: 0, moved: 0 };
  const dayBlocks = days.map((d) => {
    // Multi-day items count once, on the day they start or the first day of the report.
    const list = mine.filter((it) => coversDate(it, d) && (it.date === d || (d === start && it.date < start)));
    let done = 0, counted = 0;
    const rows = list.map((it) => {
      const st = statusOf(it);
      count[st]++;
      if (st !== "moved" && st !== "later") counted++;
      if (st === "done") done++;
      const when = it.start && !it.all_day ? fmtTime(it.start) : "All day";
      const tags = [
        it.kind === "flexible" ? "Flexible" : "",
        it.money_cents ? `💰$${(it.money_cents / 100).toFixed(2)}` : "",
        it.everyone ? "Everyone" : "",
        it.source === "external" || it.from_google ? "Google" : "",
      ].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
      return `<div class="rrow st-${st}"><span class="ricon" title="${LABEL[st][1]}">${LABEL[st][0]}</span>
        <span class="rtime mono">${when}</span><span class="rtitle">${esc(it.title)}</span><span class="tags">${tags}</span>
        <span class="rstate">${LABEL[st][1]}</span></div>`;
    }).join("");
    const pct = counted ? Math.round((done / counted) * 100) : null;
    return `<section class="rday"><h3>${d === today ? "Today · " : ""}${fmtDate(d, { long: true })}
        <span class="rsum">${counted ? `${done}/${counted} done` : list.length ? "" : "Nothing planned"}</span></h3>
      ${pct !== null ? `<span class="rbar"><i style="width:${pct}%"></i></span>` : ""}
      ${rows}</section>`;
  }).join("");
  const counted = count.done + count.notdone + count.underway;
  const pct = counted ? Math.round((count.done / counted) * 100) : 0;
  const s = openSheet(`<div class="report" style="--c:${member.color}">
      <div class="rhead"><span class="av">${esc(member.short_label || member.name[0])}</span>
        <div><h2>${esc(member.name)} · last 7 days</h2>
        <p class="muted">${fmtDate(start)} – ${fmtDate(today)} · <span data-countdown>Goes back to the calendar in 2:00</span></p></div>
        <div class="rpct"><b>${counted ? pct + "%" : "–"}</b><small>done</small></div></div>
      <div class="rtotals">
        <span class="st-done">✓ ${count.done} done</span><span class="st-notdone">✗ ${count.notdone} not done</span>
        ${count.underway ? `<span class="st-underway">🔧 ${count.underway} underway</span>` : ""}
        ${count.later ? `<span class="st-later">⏳ ${count.later} still to come</span>` : ""}
        ${count.moved ? `<span class="st-moved">↩ ${count.moved} moved</span>` : ""}</div>
      ${dayBlocks}
    </div>`, { wide: true, onClose: () => clearInterval(timer) });

  // Time out: back to the normal display after 2 minutes without a touch.
  let last = Date.now();
  s.el.addEventListener("pointerdown", () => (last = Date.now()), true);
  s.el.addEventListener("scroll", () => (last = Date.now()), true);
  const cd = s.body.querySelector("[data-countdown]");
  const timer = setInterval(() => {
    const left = Math.max(0, TIMEOUT_MS - (Date.now() - last));
    if (!left) { clearInterval(timer); s.close(); return; }
    const sec = Math.ceil(left / 1000);
    cd.textContent = `Goes back to the calendar in ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }, 1000);
}

// "Whose report?" picker, for places with no name to tap (phone More tab).
export function pickReport(members, opts) {
  const s = openSheet(`<h2>Weekly report</h2><p class="muted" style="margin:-6px 0 14px">Last 7 days, done and not done.</p>
    <div class="who">${members.map((m) => `<button data-m="${m.id}"><span class="av" style="--c:${m.color}">${esc(m.short_label || m.name[0])}</span><span class="nm">${esc(m.name)}</span></button>`).join("")}</div>`);
  s.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    s.close();
    openReport(members.find((m) => m.id === +b.dataset.m), opts);
  });
}
