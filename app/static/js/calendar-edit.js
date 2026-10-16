// Calendar editing actions shared by the editing app and the wall's edit mode:
// tap an item for details, tap empty space to add, and handle drops.
import { toast, openSheet, fmtDate, fromMin, toMin } from "./util.js";
import { post, patch } from "./api.js";
import { detailHTML } from "./views.js";
import { openEditor, deleteItem, saveMove, openSchedule, scheduleDirect } from "./editor.js";

// ctx: { lanes() → members shown as lanes, members() → all members, byId(), settings(), nextHour(),
//        filter() → "all" or a member id, refreshAll(), reload(), panel, note }

export function showItemDetail(item, ctx) {
  const s = openSheet(detailHTML(item, ctx.byId(), { editable: true }));
  s.body.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "edit") { s.close(); openEditor({ item, members: ctx.members(), onSaved: ctx.refreshAll }); }
    if (act === "delete") { if (await deleteItem(item)) { s.close(); ctx.refreshAll(); } }
    if (act === "unschedule") {
      try { await post(`/api/tasks/${item.task_id}/unschedule`); toast("Back in the task list"); s.close(); ctx.refreshAll(); }
      catch (err) { toast(err.message, true); }
    }
  });
}

function laneAt(el, x, n) {
  const r = el.getBoundingClientRect();
  return Math.min(n - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * n)));
}

// Tap on empty calendar space → add something there. Returns true if it handled the tap.
export function addAtEmptySpot(e, ctx) {
  const lanes = ctx.lanes();
  const open = (defaults) => { openEditor({ defaults, members: ctx.members(), onSaved: ctx.refreshAll }); return true; };
  const laneEl = e.target.closest("[data-lanes]");
  if (laneEl) {
    const hh = +laneEl.dataset.hh, start = +laneEl.dataset.start;
    const r = laneEl.getBoundingClientRect();
    const mins = Math.min(start * 60 + Math.floor(((e.clientY - r.top) / hh) * 2) * 30, 23 * 60);
    return open({ date: laneEl.dataset.date, start: fromMin(mins), member_ids: [lanes[laneAt(laneEl, e.clientX, lanes.length)].id] });
  }
  const ad = e.target.closest("[data-allday]");
  if (ad) return open({ date: ad.dataset.date, all_day: true, member_ids: [lanes[laneAt(ad, e.clientX, lanes.length)].id] });
  const cell = e.target.closest("[data-cell][data-member]");
  if (cell) {
    const m = cell.dataset.member;
    return open({ date: cell.dataset.date, start: ctx.nextHour(), everyone: m === "everyone", member_ids: m !== "everyone" ? [+m] : [] });
  }
  const empty = e.target.closest("[data-agenda-day]");
  if (empty) {
    const f = ctx.filter ? ctx.filter() : "all";
    return open({ date: empty.dataset.agendaDay, start: ctx.nextHour(), member_ids: f !== "all" ? [f] : [] });
  }
  return false;
}

// A drag ended over a target (see drag.js for the payload and target shapes).
export async function applyDrop(p, t, ctx) {
  const lanes = ctx.lanes();
  if (p.type === "task") {
    const task = p.task;
    if (t.type === "folder") {
      if (t.folderId !== task.folder_id) { await patch(`/api/tasks/${task.id}`, { folder_id: t.folderId }); toast("Moved"); }
      return ctx.panel.changed();
    }
    if (t.type === "slot") {
      if (await scheduleDirect(task, { member_ids: [lanes[t.li].id], date: t.date, start: fromMin(t.mins), minutes: t.len })) {
        toast(`Scheduled ${fmtDate(t.date)} · ${lanes[t.li].name}`);
      }
      return ctx.refreshAll();
    }
    if (t.type === "allday") {
      if (await scheduleDirect(task, { member_ids: [lanes[t.li].id], date: t.date, all_day: true })) toast("Scheduled");
      return ctx.refreshAll();
    }
    if (t.type === "cell") {
      const m = t.member;
      return openSchedule(task, { members: ctx.members(), onSaved: ctx.refreshAll, defaults: { date: t.date, start: ctx.settings().default_task_time || "09:00",
        everyone: m === "everyone", member_ids: m && m !== "everyone" ? [+m] : undefined } });
    }
    return;
  }
  const item = p.item;
  if (p.type === "resize") {
    if (t.type === "resize" && fromMin(t.end) !== item.end && await saveMove(item, { start: item.start, end: fromMin(t.end) })) toast("Saved");
    return ctx.reload();
  }
  if (t.type === "unschedule") {
    try { await post(`/api/tasks/${item.task_id}/unschedule`); toast("Back in the task list"); } catch (err) { toast(err.message, true); }
    return ctx.refreshAll();
  }
  const changes = {};
  let personChanged = false;
  const swapPerson = (fromId, toId) => {
    if (item.everyone || fromId == null || toId == null || fromId === toId) return;
    const ids = item.member_ids.filter((id) => id !== fromId);
    if (!ids.includes(toId)) ids.push(toId);
    changes.member_ids = ids;
    personChanged = true;
  };
  if (t.type === "slot") {
    const len = item.start && item.end ? toMin(item.end) - toMin(item.start) : 60;
    Object.assign(changes, { date: t.date, start: fromMin(t.mins), end: fromMin(Math.min(t.mins + len, 23 * 60 + 59)) });
    if (item.all_day) changes.all_day = false;
    if (p.fromLane != null) swapPerson(lanes[p.fromLane]?.id, lanes[t.li].id);
  } else if (t.type === "allday") {
    changes.date = t.date;
  } else if (t.type === "cell") {
    changes.date = t.date;
    if (t.member && t.member !== "everyone" && p.fromMember && p.fromMember !== "everyone") swapPerson(+p.fromMember, +t.member);
  } else return;
  if (changes.date === item.date && !changes.member_ids && (!changes.start || changes.start === item.start)) return;
  if (await saveMove(item, changes, { personChanged })) toast("Moved");
  ctx.refreshAll();
}
