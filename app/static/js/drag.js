// Pointer-Events drag and drop, so it works for mouse, touch and pen.
// Mouse drags start after a small move; touch needs a long-press so normal
// scrolling still works.
//
// Drag sources:  [data-drag="<taskId>"]   a task row
//                [data-move] [data-key]    a calendar item (day block, week/month chip)
//                [data-resize]             the bottom edge of a day block
// Drop targets:  [data-lanes]   day-view lanes (time + person)
//                [data-allday]  day-view all-day row (person)
//                [data-cell]    week cell (day + person) / month cell (day)
//                [data-folder]  a task folder
//                [data-unschedule-zone]  the task list (send an item back)
import { toMin, fromMin, fmtTime } from "./util.js";

const LONG_PRESS_MS = 400;
const SNAP = 15;

export function initDrag(opts) {
  let d = null; // current drag state
  let suppressClick = false;

  const scrollers = () => opts.scrollers ? opts.scrollers() : [];

  function payloadFor(el) {
    if (el.dataset.resize !== undefined) {
      const block = el.closest("[data-key]");
      const item = opts.getItem(block.dataset.key);
      return item && { type: "resize", item, block };
    }
    if (el.dataset.drag) {
      const task = opts.getTask(+el.dataset.drag);
      return task && { type: "task", task, el };
    }
    const item = opts.getItem(el.dataset.key);
    if (!item || item.read_only) return null;
    return { type: "item", item, el, fromLane: el.dataset.lane !== undefined ? +el.dataset.lane : null,
      fromMember: el.closest("[data-cell]")?.dataset.member ?? null };
  }

  function onDown(e) {
    if (e.button > 0 || d) return;
    const src = e.target.closest("[data-resize], [data-drag], [data-move]");
    if (!src || (opts.enabled && !opts.enabled())) return;
    // Buttons inside a task row (tick, Schedule) keep working as buttons.
    const inner = e.target.closest("button, input, select, a, textarea");
    if (inner && inner !== src && src.contains(inner)) return;
    const p = payloadFor(src);
    if (!p) return;
    const r = (p.type === "item" || p.type === "resize") ? (p.block || p.el).getBoundingClientRect() : null;
    d = { p, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse", active: false,
      grabOffset: r ? e.clientY - r.top : 0, timer: null, target: null };
    if (p.type === "resize") { e.preventDefault(); return; } // starts once the pointer actually moves
    if (d.touch) d.timer = setTimeout(() => { if (d && !d.active) { start(); navigator.vibrate?.(15); } }, LONG_PRESS_MS);
  }

  function start() {
    d.active = true;
    clearTimeout(d.timer);
    document.body.classList.add("dragging");
    const { p } = d;
    if (p.type !== "resize") {
      const title = p.type === "task" ? p.task.title : p.item.title;
      const color = p.type === "task" ? "var(--accent)" : getComputedStyle(p.el).getPropertyValue("--c") || "var(--accent)";
      d.ghost = Object.assign(document.createElement("div"), { className: "ghost", textContent: title });
      d.ghost.style.setProperty("--c", color);
      document.body.appendChild(d.ghost);
      if (p.el) p.el.style.opacity = ".35";
    }
    opts.onStart && opts.onStart(p);
    move(d.x, d.y);
  }

  function clearPreview() {
    document.querySelectorAll(".drop-prev").forEach((n) => n.remove());
    document.querySelectorAll(".drop-hot").forEach((n) => n.classList.remove("drop-hot"));
  }

  function lengthOf(p) {
    if (p.type === "task") return p.task.est_duration_minutes || 60;
    const it = p.item;
    return it.start && it.end ? Math.max(toMin(it.end) - toMin(it.start), SNAP) : 60;
  }

  function resolve(x, y) {
    const { p } = d;
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    if (p.type === "resize") {
      const lanes = p.block.closest("[data-lanes]");
      const r = lanes.getBoundingClientRect(), hh = +lanes.dataset.hh, startH = +lanes.dataset.start;
      let end = startH * 60 + Math.round(((y - r.top) / hh) * 60 / SNAP) * SNAP;
      end = Math.max(end, toMin(p.item.start) + SNAP);
      end = Math.min(end, +lanes.dataset.end * 60);
      return { type: "resize", end };
    }
    const folder = el.closest("[data-folder]");
    if (folder && p.type === "task" && opts.allowFolderDrop) return { type: "folder", folderId: +folder.dataset.folder, el: folder };
    const zone = el.closest("[data-unschedule-zone]");
    if (zone) return p.type === "item" && p.item.task_id && !p.item.check_status ? { type: "unschedule", el: zone } : null;
    const lanes = el.closest("[data-lanes]");
    if (lanes) {
      const r = lanes.getBoundingClientRect(), n = +lanes.dataset.n, hh = +lanes.dataset.hh;
      const startH = +lanes.dataset.start, endH = +lanes.dataset.end;
      const li = Math.min(n - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * n)));
      const offset = p.type === "item" && p.el?.closest("[data-lanes]") ? d.grabOffset : 0;
      let mins = startH * 60 + Math.round((((y - r.top - offset) / hh) * 60) / SNAP) * SNAP;
      const len = lengthOf(p);
      mins = Math.max(startH * 60, Math.min(endH * 60 - Math.min(len, 60), mins));
      return { type: "slot", date: lanes.dataset.date, li, mins, len, el: lanes, n, hh, startH };
    }
    const ad = el.closest("[data-allday]");
    if (ad) {
      const r = ad.getBoundingClientRect(), n = +(ad.closest(".day")?.querySelector("[data-lanes]")?.dataset.n || 1);
      const li = Math.min(n - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * n)));
      return { type: "allday", date: ad.dataset.date, li, el: ad };
    }
    const cell = el.closest("[data-cell]");
    if (cell) return { type: "cell", date: cell.dataset.date, member: cell.dataset.member || null, el: cell };
    return null;
  }

  function autoScroll(y) {
    for (const s of scrollers()) {
      if (!s) continue;
      const r = s.getBoundingClientRect();
      if (y < r.top + 50 && y > r.top - 20) s.scrollTop -= 14;
      else if (y > r.bottom - 50 && y < r.bottom + 20) s.scrollTop += 14;
    }
  }

  function move(x, y) {
    d.x = x; d.y = y;
    if (d.ghost) { d.ghost.style.left = x + "px"; d.ghost.style.top = y + "px"; }
    clearPreview();
    const t = resolve(x, y);
    d.target = t;
    autoScroll(y);
    if (!t) return;
    if (t.type === "resize") {
      const startMin = toMin(d.p.item.start), lanes = d.p.block.closest("[data-lanes]");
      d.p.block.style.height = Math.max(((t.end - startMin) / 60) * +lanes.dataset.hh - 2, 16) + "px";
      return;
    }
    if (t.type === "slot") {
      const prev = document.createElement("div");
      prev.className = "drop-prev";
      const who = opts.laneName ? opts.laneName(t.li) : "";
      Object.assign(prev.style, {
        top: ((t.mins - t.startH * 60) / 60) * t.hh + "px",
        height: Math.max((t.len / 60) * t.hh - 2, 18) + "px",
        left: `calc(${(t.li / t.n) * 100}% + 2px)`,
        width: `calc(${100 / t.n}% - 4px)`,
      });
      prev.textContent = `${fmtTime(fromMin(t.mins))}${who ? " · " + who : ""}`;
      t.el.appendChild(prev);
      return;
    }
    t.el.classList.add("drop-hot");
  }

  function end(drop) {
    if (!d) return;
    clearTimeout(d.timer);
    const state = d;
    d = null;
    if (!state.active) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 50);
    clearPreview();
    state.ghost?.remove();
    if (state.p.el) state.p.el.style.opacity = "";
    document.body.classList.remove("dragging");
    opts.onEnd && opts.onEnd(state.p);
    if (drop && state.target) opts.onDrop(state.p, state.target);
    else if (state.p.type === "resize") opts.onCancel && opts.onCancel();
  }

  document.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", (e) => {
    if (!d) return;
    if (!d.active) {
      const moved = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
      if (d.p.type === "resize") { if (moved > 3) start(); }
      else if (d.touch) { if (moved > 8) { clearTimeout(d.timer); d = null; } }
      else if (moved > 6) { d.x = e.clientX; d.y = e.clientY; start(); }
      return;
    }
    e.preventDefault();
    move(e.clientX, e.clientY);
  });
  document.addEventListener("touchmove", (e) => { if (d && d.active) e.preventDefault(); }, { passive: false });
  document.addEventListener("pointerup", () => end(true));
  document.addEventListener("pointercancel", () => end(false));
  document.addEventListener("contextmenu", (e) => { if (d) e.preventDefault(); });
  // A drag ends with a click on whatever was under the pointer; swallow it.
  document.addEventListener("click", (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);

  return { isDragging: () => !!(d && d.active) };
}
