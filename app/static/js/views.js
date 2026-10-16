// Calendar renderers shared by the editing app and the wall display.
// Every item element carries data-key so callers can look the item up.
import { esc, toMin, fmtTime, fmtHour, addDays, fmtDate, DAY_SHORT, parseDate, weekdayIdx } from "./util.js";

export const coversDate = (it, d) => it.date <= d && (it.end_date || it.date) >= d;
const isTimed = (it) => !it.all_day && !it.end_date && it.start;

export function itemColor(it, byId) {
  if (it.everyone) return "var(--accent)";
  const m = byId.get(it.member_ids[0]);
  return m ? m.color : "var(--mute)";
}

export function itemClasses(it) {
  return [
    it.kind === "flexible" ? "is-flex" : "",
    it.everyone ? "is-everyone" : "",
    it.read_only ? "is-ext" : "",
    it.past && it.kind === "fixed" ? "is-past" : "",
    it.check_status === "rescheduled" ? "is-resched" : "",
  ].join(" ");
}

export function marks(it) {
  let s = "";
  if (it.source === "recurring") s += '<b class="bdg" title="Repeats weekly">↻</b>';
  if (it.read_only) s += '<b class="bdg" title="From Google calendar">G</b>';
  if (it.money_cents) s += `<b class="bdg cash" title="Paid job">💰$${(it.money_cents / 100).toFixed(2).replace(/\.00$/, "")}</b>`;
  return s;
}

export function statusHTML(it, short = false) {
  if (it.needs_checkin) return `<span class="st check"><i class="dot-amber"></i>${short ? "" : "<span>Needs check-in</span>"}</span>`;
  if (it.check_status === "done" || (it.past && it.kind === "fixed")) return `<span class="st done">✓${short || it.kind === "fixed" ? "" : " <span>Done</span>"}</span>`;
  if (it.check_status === "underway") return `<span class="st underway">🔧${short ? "" : " <span>Underway</span>"}</span>`;
  if (it.check_status === "rescheduled") return `<span class="st check">${short ? "↩" : "<span>Moved</span>"}</span>`;
  return "";
}

export const whoText = (it, byId) => it.everyone ? "Everyone" : it.member_ids.map((id) => byId.get(id)?.name).filter(Boolean).join(" & ");

// ---------------------------------------------------------------- day progress (bar under each name)

// Done = checked in as done, or a fixed event whose time has passed. Anything
// flexible that hasn't been checked in counts as not done.
export const isDone = (it) => it.check_status === "done" || (it.kind === "fixed" && it.past);

export function dayProgress(member, dayItems, date, now, endHour) {
  const mine = dayItems.filter((it) => (it.everyone || it.member_ids.includes(member.id)) && it.check_status !== "rescheduled");
  const total = mine.length, done = mine.filter(isDone).length;
  // Urgency 0..1 drives colour: grey while there's plenty of day left for what's
  // unfinished, full green/red as time runs out (and on past days).
  const nowDate = now.slice(0, 10), nowMin = toMin(now.slice(11, 16));
  let urgency;
  if (total && done === total) urgency = 1;
  else if (date < nowDate) urgency = 1;
  else if (date > nowDate) urgency = 0;
  else {
    const left = endHour * 60 - nowMin;
    let need = 0;
    for (const it of mine) {
      if (isDone(it)) continue;
      if (isTimed(it)) {
        const s = toMin(it.start), e = toMin(it.end || it.start) || s + 30;
        need += it.past ? e - s : Math.max(0, e - Math.max(s, nowMin));
      } else need += 30;
    }
    urgency = left <= 0 ? 1 : Math.min(1, need / left);
  }
  return { total, done, urgency };
}

function progressHTML(p) {
  if (!p.total) return '<span class="prog empty" aria-hidden="true"></span>';
  const pct = (p.done / p.total) * 100;
  return `<span class="prog" style="--u:${p.urgency.toFixed(2)}" title="${p.done} of ${p.total} done today" aria-label="${p.done} of ${p.total} done">
    <span class="pbar"><i class="pdone" style="width:${pct}%"></i><i class="pleft" style="width:${100 - pct}%"></i></span><span class="pnum">${p.done}/${p.total}</span></span>`;
}

// ---------------------------------------------------------------- day view (member lanes)

function layoutLanes(timed, members, startMin, endMin) {
  const N = members.length;
  const idx = new Map(members.map((m, i) => [m.id, i]));
  const lanes = members.map(() => []);
  const byItem = new Map();
  for (const it of timed) {
    const laneIdx = it.everyone ? members.map((_, i) => i) : it.member_ids.map((id) => idx.get(id)).filter((i) => i !== undefined);
    if (!laneIdx.length) continue;
    let s = Math.max(toMin(it.start), startMin);
    let e = Math.min(toMin(it.end || it.start), endMin);
    if (s >= endMin) s = endMin - 15;
    if (e <= s) e = s + 15;
    const pieces = laneIdx.map((li) => ({ it, li, s, e, col: 0, cols: 1 }));
    pieces.forEach((p) => lanes[p.li].push(p));
    byItem.set(it.key, pieces);
  }
  for (const lane of lanes) {
    lane.sort((a, b) => a.s - b.s || b.e - a.e);
    let cluster = [], colsEnd = [], clusterEnd = -1;
    const finish = () => cluster.forEach((p) => (p.cols = colsEnd.length));
    for (const p of lane) {
      if (cluster.length && p.s >= clusterEnd) { finish(); cluster = []; colsEnd = []; clusterEnd = -1; }
      let c = colsEnd.findIndex((end) => end <= p.s);
      if (c < 0) { c = colsEnd.length; colsEnd.push(p.e); } else colsEnd[c] = p.e;
      p.col = c;
      cluster.push(p);
      clusterEnd = Math.max(clusterEnd, p.e);
    }
    finish();
  }
  // An item in neighbouring lanes with nothing else beside it draws as one wide block.
  const blocks = [];
  for (const pieces of byItem.values()) {
    pieces.sort((a, b) => a.li - b.li);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      if (run.length > 1 && run.every((p) => p.cols === 1)) blocks.push({ ...run[0], span: run.length });
      else run.forEach((p) => blocks.push({ ...p, span: 1 }));
      run = [];
    };
    for (const p of pieces) {
      if (run.length && p.li !== run[run.length - 1].li + 1) flush();
      run.push(p);
    }
    flush();
  }
  return { blocks, N };
}

function allDayRuns(it, members) {
  if (it.everyone) return [[0, members.length]];
  const idx = members.map((m) => m.id);
  const lis = it.member_ids.map((id) => idx.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b);
  const runs = [];
  for (const li of lis) {
    const last = runs[runs.length - 1];
    if (last && li === last[0] + last[1]) last[1]++;
    else runs.push([li, 1]);
  }
  return runs;
}

export function renderDay(root, { date, items, members, byId, now, hh, startHour, endHour, editable }) {
  const N = Math.max(members.length, 1);
  const startMin = startHour * 60, endMin = endHour * 60;
  const dayItems = items.filter((it) => coversDate(it, date));
  const allday = dayItems.filter((it) => !isTimed(it));
  const timed = dayItems.filter(isTimed);
  const px = (m) => ((m - startMin) / 60) * hh;

  const adHTML = allday.flatMap((it) => allDayRuns(it, members).map(([li, span]) =>
    `<button class="adchip ${itemClasses(it)}" data-key="${esc(it.key)}" style="grid-column:${li + 1} / span ${span};--c:${itemColor(it, byId)}">
      <span style="overflow:hidden;text-overflow:ellipsis">${esc(it.title)}</span>${marks(it)}${it.everyone ? '<span class="muted" style="font-weight:500">· Everyone</span>' : ""}${statusHTML(it, true)}</button>`)).join("");

  const { blocks } = layoutLanes(timed, members, startMin, endMin);
  const evHTML = blocks.map((b) => {
    const it = b.it;
    const top = px(b.s), height = Math.max(px(b.e) - top - 2, 16);
    const left = ((b.li + b.col / b.cols) / N) * 100, width = (b.span / N / b.cols) * 100;
    const wide = it.everyone && b.span === N;
    const tiny = height < 34;
    const who = it.member_ids.length > 1 && !wide ? `<span class="sub">${esc(whoText(it, byId))}</span>` : "";
    const body = wide
      ? `<span class="et"><span>${esc(it.title)}</span>${marks(it)}</span><span class="tm">${fmtTime(it.start)} – ${fmtTime(it.end)}</span><span class="sub">Everyone</span>${statusHTML(it, true)}`
      : `<span class="et"><span>${esc(it.title)}</span>${marks(it)}${statusHTML(it, true)}</span>${tiny ? "" : `<span class="tm">${fmtTime(it.start)} – ${fmtTime(it.end)}</span>`}${height > 58 ? who : ""}${height > 76 && it.location ? `<span class="sub">📍 ${esc(it.location)}</span>` : ""}`;
    const canEdit = editable && !it.read_only;
    return `<button class="ev ${itemClasses(it)}${tiny ? " tiny" : ""}" data-key="${esc(it.key)}" data-lane="${b.li}" ${canEdit ? "data-move" : ""}
      style="--c:${itemColor(it, byId)};top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px)">${body}${canEdit && it.source !== "external" ? '<span class="rs" data-resize></span>' : ""}</button>`;
  }).join("");

  const hours = [];
  for (let hr = startHour + 1; hr < endHour; hr++) hours.push(`<span style="top:${(hr - startHour) * hh}px">${fmtHour(hr)}</span>`);
  let nowHTML = "";
  const nowDate = now.slice(0, 10), nowMin = toMin(now.slice(11, 16));
  if (nowDate === date && nowMin >= startMin && nowMin <= endMin) {
    nowHTML = `<div class="nowline" style="top:${px(nowMin)}px"></div>`;
    hours.push(`<span class="nowlab" style="top:${px(nowMin)}px">${fmtTime(now.slice(11, 16)).replace(/ [ap]m/, "")}</span>`);
  }
  root.innerHTML = `<div class="day" style="--hh:${hh}px">
    <div class="corner"></div>
    <div class="lanehead" style="grid-template-columns:repeat(${N},minmax(0,1fr))">${members.map((m) => `<div><button class="lh-name" data-report="${m.id}" title="${esc(m.name)}'s week"><i class="sw" style="--c:${m.color}"></i>${esc(m.name)}</button>${progressHTML(dayProgress(m, dayItems, date, now, endHour))}</div>`).join("")}</div>
    <div class="allday-lab">All day</div>
    <div class="allday" data-allday data-date="${date}" style="grid-template-columns:repeat(${N},minmax(0,1fr))">${adHTML}</div>
    <div class="gutter" style="height:${(endHour - startHour) * hh}px">${hours.join("")}</div>
    <div class="lanes" data-lanes data-date="${date}" data-hh="${hh}" data-start="${startHour}" data-end="${endHour}" data-n="${N}"
      style="height:${(endHour - startHour) * hh}px">${members.map((_, i) => (i ? `<div class="lanecol" style="left:${(i / N) * 100}%"></div>` : "")).join("")}${evHTML}${nowHTML}</div>
  </div>`;
}

// ---------------------------------------------------------------- list (phone day "All", phone week)

export function renderAgenda(root, { dates, items, byId, now, filter, todayStr }) {
  const nowMin = toMin(now.slice(11, 16));
  const show = (it) => filter === "all" || it.everyone || it.member_ids.includes(filter);
  const parts = [];
  for (const d of dates) {
    const list = items.filter((it) => coversDate(it, d) && show(it));
    const label = d === todayStr ? `Today · ${fmtDate(d)}` : fmtDate(d, { long: dates.length > 1 });
    if (dates.length > 1 || list.length) parts.push(`<div class="sec${d === todayStr ? " today" : ""}" data-date="${d}">${esc(label)}</div>`);
    if (!list.length) { parts.push(`<div class="empty" data-agenda-day="${d}">Nothing planned</div>`); continue; }
    let nowShown = d !== todayStr;
    for (const it of list) {
      if (!nowShown && isTimed(it) && toMin(it.start) > nowMin) { parts.push(`<div class="nowrow">${fmtTime(now.slice(11, 16))}</div>`); nowShown = true; }
      const ids = it.everyone ? [null] : it.member_ids;
      parts.push(`<button class="li ${itemClasses(it)}" data-key="${esc(it.key)}" style="--c:${itemColor(it, byId)}">
        <span class="bars">${ids.map((id) => `<i class="bar" style="--c:${id === null ? "var(--accent)" : byId.get(id)?.color}"></i>`).join("")}</span>
        <span class="t">${isTimed(it) ? fmtTime(it.start) : "All day"}</span>
        <span class="b"><strong>${esc(it.title)}</strong><small>${esc(whoText(it, byId))}${isTimed(it) && it.end ? ` · until ${fmtTime(it.end)}` : ""}${it.end_date ? ` · until ${fmtDate(it.end_date)}` : ""} ${marks(it)} ${statusHTML(it)}</small></span></button>`);
    }
    if (!nowShown) parts.push(`<div class="nowrow">${fmtTime(now.slice(11, 16))}</div>`);
  }
  root.innerHTML = `<div class="agenda">${parts.join("")}</div>`;
}

// ---------------------------------------------------------------- week (people × days)

export function renderWeek(root, { start, items, members, byId, todayStr, editable = true }) {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const rows = [{ id: "everyone", name: "Everyone", color: "var(--accent)" }, ...members];
  const chip = (it) => {
    const mk = it.needs_checkin ? '<span class="mk"><i class="dot-amber"></i></span>' : statusHTML(it, true) ? `<span class="mk">${statusHTML(it, true)}</span>` : "";
    return `<button class="chip ${itemClasses(it)}" data-key="${esc(it.key)}" ${it.read_only || !editable ? "" : "data-move"} style="--c:${itemColor(it, byId)}">${mk}<span class="tm">${isTimed(it) ? fmtTime(it.start) : "All day"}${it.source === "recurring" ? " · ↻" : ""}${it.read_only ? " · G" : ""}</span>${esc(it.title)}</button>`;
  };
  let html = `<div class="week"><div class="wh" style="cursor:default"></div>${dates.map((d) => `<div class="wh${d === todayStr ? " today" : ""}" data-goto-day="${d}">${DAY_SHORT[weekdayIdx(d)]}<small>${parseDate(d).getDate()} ${fmtDate(d).split(" ")[2]}</small></div>`).join("")}`;
  for (const r of rows) {
    html += r.id === "everyone" ? `<div class="rl"><i class="sw" style="--c:${r.color}"></i>${esc(r.name)}</div>`
      : `<div class="rl"><button class="lh-name" data-report="${r.id}" title="${esc(r.name)}'s week"><i class="sw" style="--c:${r.color}"></i>${esc(r.name)}</button></div>`;
    for (const d of dates) {
      const list = items.filter((it) => coversDate(it, d) && (r.id === "everyone" ? it.everyone : !it.everyone && it.member_ids.includes(r.id)));
      html += `<div class="cell${d === todayStr ? " today" : ""}" data-cell data-date="${d}" data-member="${r.id}">${list.map(chip).join("")}</div>`;
    }
  }
  root.innerHTML = html + "</div>";
}

// ---------------------------------------------------------------- month

export function renderMonth(root, { monthStr, gridStart, weeks, items, byId, todayStr, weekStartsOn, editable = true }) {
  const heads = Array.from({ length: 7 }, (_, i) => DAY_SHORT[(i + weekStartsOn) % 7]);
  let html = `<div class="month">${heads.map((d) => `<div class="mh">${d}</div>`).join("")}`;
  const month = monthStr.slice(0, 7);
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(gridStart, i);
    const list = items.filter((it) => coversDate(it, d));
    const bars = list.filter((it) => it.end_date);
    const routine = list.filter((it) => !it.end_date && it.source === "recurring");
    const chips = list.filter((it) => !it.end_date && it.source !== "recurring");
    let cell = "";
    for (const it of bars) {
      const pos = [it.date === d || i === 0 ? "start" : "", (it.end_date === d) ? "end" : "", i % 7 === 0 ? "wkstart" : ""].join(" ");
      cell += `<button class="mchip bar ${pos} ${itemClasses(it)}" data-key="${esc(it.key)}" style="--c:${itemColor(it, byId)}"><span class="lbl">${esc(it.title)}</span></button>`;
    }
    chips.slice(0, 3).forEach((it) => {
      cell += `<button class="mchip ${itemClasses(it)}" data-key="${esc(it.key)}" ${it.read_only || !editable ? "" : "data-move"} style="--c:${itemColor(it, byId)}">${isTimed(it) ? `<span class="mono" style="font-size:11px">${fmtTime(it.start).replace(":00", "").replace(" ", "")}</span> ` : ""}${esc(it.title)}</button>`;
    });
    if (chips.length > 3) cell += `<div class="more">+${chips.length - 3} more</div>`;
    const dotColors = (arr) => [...new Set(arr.flatMap((it) => it.everyone ? ["var(--accent)"] : it.member_ids.map((id) => byId.get(id)?.color)).filter(Boolean))];
    const rd = dotColors(routine), all = dotColors([...routine, ...chips]);
    html += `<div class="mc${d.slice(0, 7) !== month ? " other" : ""}${d === todayStr ? " today" : ""}" data-cell data-date="${d}" data-month-day="${d}">
      <div class="dn"><b>${parseDate(d).getDate()}</b></div>${cell}
      ${rd.length ? `<div class="rdots desk-dots" title="Weekly routines">${rd.map((c) => `<i style="--c:${c}"></i>`).join("")}</div>` : ""}
      ${all.length ? `<div class="rdots phone-dots">${all.map((c) => `<i style="--c:${c}"></i>`).join("")}</div>` : ""}</div>`;
  }
  root.innerHTML = html + "</div>";
}

// ---------------------------------------------------------------- detail sheet content

export function detailHTML(it, byId, { editable }) {
  const who = it.everyone
    ? `<span class="pill" style="--c:var(--accent)"><i class="sw" style="--c:var(--accent)"></i>Everyone</span>`
    : it.member_ids.map((id) => { const m = byId.get(id); return m ? `<span class="pill" style="--c:${m.color}"><i class="sw" style="--c:${m.color}"></i>${esc(m.name)}</span>` : ""; }).join("");
  const when = isTimed(it) ? `${fmtTime(it.start)} – ${fmtTime(it.end)}` : "All day";
  const days = it.end_date ? `${fmtDate(it.date, { long: true })} – ${fmtDate(it.end_date, { long: true })}` : fmtDate(it.date, { long: true });
  const repeat = it.repeat ? ` · ↻ Repeats ${it.repeat.weekdays.map((d) => DAY_SHORT[d]).join(", ")}${it.repeat.interval_weeks > 1 ? `, every ${it.repeat.interval_weeks} weeks` : ""}` : "";
  const kind = it.read_only ? `From Google calendar “${esc(it.feed_label)}” (read-only)`
    : it.money_cents ? `💰 Paid job · $${(it.money_cents / 100).toFixed(2)} once a parent approves it on the Money tab`
    : it.kind === "flexible" ? `Flexible job${it.task_id ? " · from the task list" : ""}` : "Fixed event";
  const remind = it.remind_minutes ? ` · 🔔 reminder ${it.remind_minutes} min before` : "";
  return `<div class="detail stack">
    <h2 style="margin:0 52px 0 0">${esc(it.title)}</h2>
    <div class="meta-row">${who}</div>
    <div class="meta-row"><span class="mono" style="color:var(--fg);font-size:16px">${when}</span> · ${days}</div>
    <div class="meta-row">${kind}${repeat}${remind}</div>
    ${it.location ? `<div class="meta-row">📍 ${esc(it.location)}</div>` : ""}
    ${it.notes ? `<div style="white-space:pre-wrap">${esc(it.notes)}</div>` : ""}
    ${statusHTML(it) ? `<div class="meta-row">${statusHTML(it)}</div>` : ""}
    ${editable && !it.read_only ? `<div class="actions"><button class="btn danger" data-act="delete">Delete</button><span class="spacer"></span>${it.task_id && !it.check_status ? '<button class="btn" data-act="unschedule">Back to task list</button>' : ""}<button class="btn pri" data-act="edit">Edit</button></div>` : ""}
  </div>`;
}
