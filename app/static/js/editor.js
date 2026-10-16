// Sheets for creating/editing calendar items and tasks, plus the
// "this one / future / all" question for routines.
import { esc, openSheet, choose, toast, fmtDate, toMin, fromMin, weekdayIdx, addDays, DAY_SHORT } from "./util.js";
import { post, patch, del } from "./api.js";

const REMIND = [[0, "No reminder"], [5, "5 min before"], [10, "10 min before"], [15, "15 min before"], [30, "30 min before"], [60, "1 hour before"]];
const LENGTHS = [[15, "15 min"], [30, "30 min"], [45, "45 min"], [60, "1 hour"], [90, "1½ hours"], [120, "2 hours"], [180, "3 hours"], [240, "Half day"]];

function whoChips(members, everyone, ids) {
  return `<div class="chips" data-who>
    <button type="button" data-everyone aria-pressed="${everyone}" style="--c:var(--accent)"><i class="sw" style="--c:var(--accent)"></i>Everyone</button>
    ${members.map((m) => `<button type="button" data-mid="${m.id}" aria-pressed="${!everyone && ids.includes(m.id)}" style="--c:${m.color}"><i class="sw" style="--c:${m.color}"></i>${esc(m.name)}</button>`).join("")}
  </div>`;
}
function wireWho(root, { single = false } = {}) {
  const box = root.querySelector("[data-who]");
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const ev = box.querySelector("[data-everyone]");
    if (b === ev) {
      const on = b.getAttribute("aria-pressed") !== "true";
      ev.setAttribute("aria-pressed", on);
      if (on) box.querySelectorAll("[data-mid]").forEach((x) => x.setAttribute("aria-pressed", "false"));
    } else {
      const on = b.getAttribute("aria-pressed") !== "true";
      if (single) box.querySelectorAll("[data-mid]").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", on || single);
      ev.setAttribute("aria-pressed", "false");
    }
  });
  return () => ({
    everyone: box.querySelector("[data-everyone]").getAttribute("aria-pressed") === "true",
    member_ids: [...box.querySelectorAll('[data-mid][aria-pressed="true"]')].map((b) => +b.dataset.mid),
  });
}
const sameIds = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function scopeQuestion(item, { allowThis = true, verb = "Change" } = {}) {
  const choices = [];
  if (allowThis) choices.push({ label: `Just this one (${fmtDate(item.original_date)})`, value: "this", primary: true });
  choices.push({ label: "This and all future weeks", value: "future", primary: !allowThis });
  choices.push({ label: "Every week, past and future", value: "all" });
  return choose(`${verb} “${item.title}”`, choices, "This repeats every week.");
}

// ---------------------------------------------------------------- item editor

// seriesOnly: editing a routine as a whole (Settings → Routines). No "this day" field and
// no "this one / future / all" question; changes always apply to every week.
export function openEditor({ item = null, defaults = {}, members, onSaved, seriesOnly = false }) {
  const it = item || {
    title: "", notes: "", location: "", date: defaults.date, end_date: null, start: defaults.start ?? "09:00",
    end: defaults.end ?? (defaults.start ? fromMin(Math.min(toMin(defaults.start) + 60, 23 * 60 + 59)) : "10:00"),
    all_day: !!defaults.all_day, everyone: !!defaults.everyone, member_ids: defaults.member_ids || [], kind: "fixed",
    chime_setting: "default", remind_minutes: null,
  };
  const isRec = it.source === "recurring";
  const rep = it.repeat || { weekdays: [weekdayIdx(it.date)], interval_weeks: 1, valid_until: null };
  const startRepeating = !item && defaults.repeat;
  const s = openSheet(`<h2>${item ? "Edit" : "New"} ${isRec ? "routine" : "item"}</h2>
    <form class="stack" novalidate>
      <label class="field">What<input type="text" name="title" value="${esc(it.title)}" maxlength="200" required ${item ? "" : "autofocus"} placeholder="e.g. Swimming, Dentist, Clean gutters"></label>
      <div class="field"><b style="font-size:14px">Who</b>${whoChips(members, it.everyone, it.member_ids)}</div>
      <div class="field"><b style="font-size:14px">Type</b>
        <div class="seg" data-kind><button type="button" data-k="fixed" aria-pressed="${it.kind === "fixed"}">Fixed event</button><button type="button" data-k="flexible" aria-pressed="${it.kind === "flexible"}">Flexible job</button></div>
        <small class="muted" data-kind-help></small></div>
      <div class="row"${seriesOnly ? ' style="display:none"' : ""}>
        <label class="field"><span data-datelabel>${isRec ? "This day" : "Date"}</span><input type="date" name="date" value="${it.date}" required></label>
        <label class="check" style="flex:0 0 auto"><input type="checkbox" name="all_day" ${it.all_day ? "checked" : ""}> All day</label>
      </div>
      <div class="row" data-times>
        <label class="field">Starts<input type="time" name="start" value="${it.start || "09:00"}" step="300"></label>
        <label class="field">Ends<input type="time" name="end" value="${it.end || "10:00"}" step="300"></label>
      </div>
      <div class="row" data-lastday ${isRec ? "hidden" : ""}><label class="field">Last day (for trips, camps…)<input type="date" name="end_date" value="${it.end_date || ""}"></label></div>
      <label class="check"${seriesOnly ? ' style="display:none"' : ""}><input type="checkbox" name="repeats" ${isRec || startRepeating ? "checked" : ""} ${isRec ? "disabled" : ""} ${it.task_id ? "disabled" : ""}> Repeats every week</label>
      <div class="stack" data-repeat hidden>
        ${isRec ? `<label class="field">Starting from<input type="date" name="from" value="${rep.valid_from}"></label>` : ""}
        <div class="daypick">${DAY_SHORT.map((d, i) => `<button type="button" data-wd="${i}" aria-pressed="${rep.weekdays.includes(i)}">${d}</button>`).join("")}</div>
        <div class="row">
          <label class="field">How often<select name="interval">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${rep.interval_weeks === n ? "selected" : ""}>${n === 1 ? "Every week" : n === 2 ? "Every second week" : `Every ${n} weeks`}</option>`).join("")}</select></label>
          <label class="field">Until (optional)<input type="date" name="until" value="${rep.valid_until || ""}"></label>
        </div>
        <small class="muted" data-firsthint></small>
      </div>
      <details class="more-opts" ${it.location || it.notes || it.remind_minutes || it.chime_setting !== "default" ? "open" : ""}><summary>Location, notes and chime</summary>
        <div class="stack" style="margin-top:10px">
          <label class="field">Location<input type="text" name="location" value="${esc(it.location)}" maxlength="200"></label>
          <label class="field">Notes<textarea name="notes" maxlength="2000">${esc(it.notes)}</textarea></label>
          <div class="row">
            <label class="field">Chime on the wall<select name="chime"><option value="default">Default (on)</option><option value="on">On</option><option value="off">Off</option></select></label>
            <label class="field">Reminder chime<select name="remind">${REMIND.map(([v, l]) => `<option value="${v}" ${(it.remind_minutes || 0) === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          </div>
        </div></details>
      <div class="actions">${item ? '<button type="button" class="btn danger" data-delete>Delete</button>' : ""}<span class="spacer"></span>
        <button type="button" class="btn" data-close>Cancel</button><button class="btn pri" type="submit">Save</button></div>
    </form>`);
  const f = s.body.querySelector("form");
  f.chime.value = it.chime_setting || "default";
  const getWho = wireWho(s.body);
  let kind = it.kind;
  const kindHelp = () => {
    s.body.querySelector("[data-kind-help]").textContent = kind === "flexible"
      ? "A plan, not a commitment. Once its time passes it comes up in check-in."
      : "Counts as done once its time has passed.";
  };
  s.body.querySelector("[data-kind]").addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]");
    if (!b) return;
    kind = b.dataset.k;
    s.body.querySelectorAll("[data-k]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    kindHelp();
  });
  kindHelp();
  // "First one: Sat 31 Oct" — the first chosen weekday on or after the start date.
  const firstHint = () => {
    const el = s.body.querySelector("[data-firsthint]");
    const start = (isRec ? f.from.value : f.date.value) || f.date.value;
    const wds = [...s.body.querySelectorAll('[data-wd][aria-pressed="true"]')].map((b) => +b.dataset.wd);
    if (!start || !wds.length) { el.textContent = ""; return; }
    let d = start;
    for (let i = 0; i < 7 && !wds.includes(weekdayIdx(d)); i++) d = addDays(d, 1);
    el.textContent = `First one: ${fmtDate(d, { long: true })}`;
  };
  const sync = () => {
    if (!isRec) s.body.querySelector("[data-datelabel]").textContent = f.repeats.checked ? "Starting from" : "Date";
    firstHint();
    s.body.querySelector("[data-times]").hidden = f.all_day.checked;
    s.body.querySelector("[data-repeat]").hidden = !f.repeats.checked;
    s.body.querySelector("[data-lastday]").hidden = isRec || f.repeats.checked || !f.all_day.checked;
  };
  f.all_day.addEventListener("change", sync);
  f.repeats.addEventListener("change", sync);
  sync();
  s.body.querySelector(".daypick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-wd]");
    if (b) b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
    firstHint();
  });
  f.date.addEventListener("change", sync);
  f.from?.addEventListener("change", firstHint);
  if (seriesOnly) {
    const allDay = s.body.querySelector("input[name=all_day]").closest("label");
    s.body.querySelector("[data-times]").before(allDay);
  }
  s.body.querySelector("[data-delete]")?.addEventListener("click", async () => {
    if (seriesOnly) {
      const ok = await choose(`Delete “${item.title}”?`, [{ label: "Delete every week", value: true, danger: true }, { label: "Keep it", value: false }]);
      if (!ok) return;
      try { await del(`/api/recurring/${item.recurring_id}?scope=all`); toast("Deleted"); s.close(); onSaved && onSaved(); }
      catch (err) { toast(err.message, true); }
      return;
    }
    if (await deleteItem(item)) { s.close(); onSaved && onSaved(); }
  });

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const who = getWho();
    const body = {
      title: f.title.value.trim(), date: f.date.value, all_day: f.all_day.checked, everyone: who.everyone, member_ids: who.member_ids,
      kind, location: f.location.value.trim(), notes: f.notes.value, chime: f.chime.value, remind_minutes: +f.remind.value || null,
    };
    if (!body.title) { toast("Give it a name.", true); f.title.focus(); return; }
    if (!body.date) { toast("Pick a date.", true); return; }
    if (!body.everyone && !body.member_ids.length) { toast("Choose who it's for, or Everyone.", true); return; }
    if (!body.all_day) { body.start = f.start.value; body.end = f.end.value; }
    if (!isRec && body.all_day && f.end_date.value) body.end_date = f.end_date.value;
    if (!isRec && item && !body.end_date) body.end_date = null;
    if (f.repeats.checked) {
      const wds = [...s.body.querySelectorAll('[data-wd][aria-pressed="true"]')].map((b) => +b.dataset.wd);
      if (!wds.length) { toast("Pick at least one day of the week.", true); return; }
      body.repeat = { weekdays: wds, interval_weeks: +f.interval.value, valid_until: f.until.value || null };
      if (isRec && f.from.value) body.repeat.valid_from = f.from.value;
    }
    try {
      if (!item) {
        await post("/api/events", body);
        toast(body.repeat ? "Routine added" : "Added");
      } else if (item.source === "event") {
        await patch(`/api/events/${item.event_id}`, body);
        toast("Saved");
      } else if (item.source === "external") {
        await patch(`/api/external/${item.external_id}`, body);
        toast("Saved in the planner (Google isn't changed)");
      } else {
        const r = item.repeat;
        const startChanged = body.repeat.valid_from && body.repeat.valid_from !== r.valid_from;
        const repeatChanged = startChanged || !sameIds(body.repeat.weekdays, r.weekdays) || body.repeat.interval_weeks !== r.interval_weeks || (body.repeat.valid_until || null) !== r.valid_until;
        const big = repeatChanged || body.everyone !== item.everyone || !sameIds(body.member_ids, item.member_ids) || body.kind !== item.kind
          || body.all_day !== item.all_day || body.location !== (item.location || "") || body.chime !== item.chime_setting || (body.remind_minutes || null) !== (item.remind_minutes || null);
        // A new start date applies to the whole routine, so don't ask.
        const scope = startChanged || seriesOnly ? "all" : await scopeQuestion(item, { allowThis: !big, verb: "Save" });
        if (!scope) return;
        if (scope === "this") {
          const small = { scope, original_date: item.original_date, title: body.title, notes: body.notes, date: body.date };
          if (!item.all_day) Object.assign(small, { start: body.start, end: body.end });
          await patch(`/api/recurring/${item.recurring_id}`, small);
        } else {
          if (!repeatChanged) delete body.repeat;
          if (body.date === item.date || seriesOnly) delete body.date;
          await patch(`/api/recurring/${item.recurring_id}`, { ...body, scope, original_date: item.original_date });
        }
        toast("Saved");
      }
      s.close();
      onSaved && onSaved();
    } catch (err) { toast(err.message, true); }
  });
  return s;
}

export async function deleteItem(item) {
  try {
    if (item.source === "recurring") {
      const scope = await scopeQuestion(item, { verb: "Delete" });
      if (!scope) return false;
      await del(`/api/recurring/${item.recurring_id}?scope=${scope}&original_date=${item.original_date}`);
    } else if (item.source === "external") {
      const ok = await choose(`Remove “${item.title}” from the planner?`, [{ label: "Remove", value: true, danger: true }, { label: "Keep it", value: false }],
        "It stays in Google calendar.");
      if (!ok) return false;
      await del(`/api/external/${item.external_id}`);
    } else {
      const ok = await choose(`Delete “${item.title}”?`, [{ label: "Delete", value: true, danger: true }, { label: "Keep it", value: false }],
        item.task_id ? "The task stays in its folder." : "");
      if (!ok) return false;
      await del(`/api/events/${item.event_id}`);
    }
    toast("Deleted");
    return true;
  } catch (err) { toast(err.message, true); return false; }
}

// Save a drag (move / resize / change person). Asks about routines first.
export async function saveMove(item, changes, { personChanged = false } = {}) {
  try {
    if (item.source === "event") {
      await patch(`/api/events/${item.event_id}`, changes);
    } else if (item.source === "external") {
      await patch(`/api/external/${item.external_id}`, changes);
    } else if (item.source === "recurring") {
      const scope = await scopeQuestion(item, { allowThis: !personChanged, verb: "Move" });
      if (!scope) return false;
      await patch(`/api/recurring/${item.recurring_id}`, { ...changes, scope, original_date: item.original_date });
    } else return false;
    return true;
  } catch (err) { toast(err.message, true); return false; }
}

// ---------------------------------------------------------------- schedule a task

export function openSchedule(task, { members, defaults = {}, onSaved }) {
  const ids = defaults.member_ids || (task.default_member_id ? [task.default_member_id] : []);
  const len = task.est_duration_minutes || 60;
  const lengths = LENGTHS.some(([v]) => v === len) ? LENGTHS : [...LENGTHS, [len, `${len} min`]].sort((a, b) => a[0] - b[0]);
  const s = openSheet(`<h2>Schedule “${esc(task.title)}”</h2>
    <form class="stack">
      <div class="field"><b style="font-size:14px">Who</b>${whoChips(members, !!defaults.everyone, ids)}</div>
      <div class="row">
        <label class="field">Day<input type="date" name="date" value="${defaults.date}" required></label>
        <label class="field">Time<input type="time" name="start" value="${defaults.start}" step="900"></label>
        <label class="field">How long<select name="len">${lengths.map(([v, l]) => `<option value="${v}" ${v === len ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="all_day"> Any time that day (all day)</label>
      <small class="muted">${task.kind === "flexible" ? "Flexible job: it comes up in check-in once the time has passed." : "Fixed event: it counts as done once the time has passed."}</small>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn pri">Put it on the calendar</button></div>
    </form>`);
  const f = s.body.querySelector("form");
  const getWho = wireWho(s.body);
  f.all_day.addEventListener("change", () => { f.start.disabled = f.len.disabled = f.all_day.checked; });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const who = getWho();
    if (!who.everyone && !who.member_ids.length) { toast("Choose who it's for.", true); return; }
    try {
      await post(`/api/tasks/${task.id}/schedule`, { ...who, date: f.date.value, start: f.all_day.checked ? null : f.start.value,
        minutes: +f.len.value, all_day: f.all_day.checked });
      toast(`Scheduled ${fmtDate(f.date.value)}`);
      s.close();
      onSaved && onSaved();
    } catch (err) { toast(err.message, true); }
  });
  return s;
}

export async function scheduleDirect(task, body) {
  try {
    await post(`/api/tasks/${task.id}/schedule`, body);
    return true;
  } catch (err) { toast(err.message, true); return false; }
}

// ---------------------------------------------------------------- edit a task

export function openTaskEditor(task, { folders, members, onSaved }) {
  const s = openSheet(`<h2>Edit task</h2>
    <form class="stack">
      <label class="field">Task<input type="text" name="title" value="${esc(task.title)}" maxlength="200" required></label>
      <div class="row">
        <label class="field">Folder<select name="folder">${folders.map((f) => `<option value="${f.id}" ${f.id === task.folder_id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label>
        <label class="field">Usually done by<select name="member"><option value="">Anyone</option>${members.map((m) => `<option value="${m.id}" ${m.id === task.default_member_id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
      </div>
      <div class="row">
        <label class="field">Type<select name="kind"><option value="flexible" ${task.kind === "flexible" ? "selected" : ""}>Flexible job</option><option value="fixed" ${task.kind === "fixed" ? "selected" : ""}>Fixed event</option></select></label>
        <label class="field">Usually takes<select name="len">${LENGTHS.map(([v, l]) => `<option value="${v}" ${v === task.est_duration_minutes ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <label class="field">Notes<textarea name="notes" maxlength="2000">${esc(task.notes)}</textarea></label>
      <div class="actions"><button type="button" class="btn danger" data-delete>Delete</button>${task.status === "scheduled" ? '<button type="button" class="btn" data-unschedule>Take off calendar</button>' : ""}<span class="spacer"></span>
        <button type="button" class="btn" data-close>Cancel</button><button class="btn pri">Save</button></div>
    </form>`);
  const f = s.body.querySelector("form");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await patch(`/api/tasks/${task.id}`, { title: f.title.value.trim(), folder_id: +f.folder.value, default_member_id: f.member.value ? +f.member.value : null,
        kind: f.kind.value, est_duration_minutes: +f.len.value, notes: f.notes.value });
      toast("Saved");
      s.close();
      onSaved && onSaved();
    } catch (err) { toast(err.message, true); }
  });
  s.body.querySelector("[data-delete]").addEventListener("click", async () => {
    const ok = await choose(`Delete “${task.title}”?`, [{ label: "Delete task", value: true, danger: true }, { label: "Keep it", value: false }]);
    if (!ok) return;
    try { await del(`/api/tasks/${task.id}`); toast("Task deleted"); s.close(); onSaved && onSaved(); } catch (err) { toast(err.message, true); }
  });
  s.body.querySelector("[data-unschedule]")?.addEventListener("click", async () => {
    try { await post(`/api/tasks/${task.id}/unschedule`); toast("Back in the task list"); s.close(); onSaved && onSaved(); } catch (err) { toast(err.message, true); }
  });
  return s;
}
