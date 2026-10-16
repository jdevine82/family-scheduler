// Task folders: shared by the computer sidebar, the phone Tasks tab and the wall drawer.
import { esc, toast, choose, openSheet } from "./util.js";
import { get, post, patch, del } from "./api.js";

const FOLD_KEY = "fs.folded";
const loadFolded = () => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || "[]")); } catch { return new Set(); } };
const saveFolded = (s) => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...s])); } catch { /* private mode */ } };

export class TaskPanel {
  constructor(root, { editable = false, big = false, onSchedule, onEdit, onChanged, members = () => [] }) {
    Object.assign(this, { root, editable, big, onSchedule, onEdit, onChanged, members });
    this.folders = [];
    this.folded = loadFolded();
    this.showDone = new Set();
    this.byId = new Map();
    root.addEventListener("click", (e) => this.click(e));
    root.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("[data-add-input]")) { e.preventDefault(); this.addTask(+e.target.dataset.addInput, e.target); }
    });
  }

  async load() {
    const data = await get("/api/tasks");
    this.folders = data.folders;
    this.byId = new Map(this.folders.flatMap((f) => f.tasks.map((t) => [t.id, t])));
    this.render();
    return this;
  }

  task(id) { return this.byId.get(id); }

  tagsHTML(t) {
    const tags = [];
    const names = new Map(this.members().map((m) => [m.id, m.name]));
    if (t.needs_checkin) tags.push('<span class="tag check">● Needs check-in</span>');
    if (t.underway) tags.push('<span class="tag under">🔧 Underway</span>');
    if (t.status === "scheduled" && t.when && !t.needs_checkin) {
      const who = t.who.map((w) => (w === "everyone" ? "Everyone" : names.get(w))).filter(Boolean).join(" & ");
      tags.push(`<span class="tag">📅 ${esc(t.when)}${who ? ` · ${esc(who)}` : ""}</span>`);
    }
    if (t.reschedule_count) tags.push(`<span class="tag push">Pushed back ${t.reschedule_count}×</span>`);
    tags.push(t.kind === "flexible" ? '<span class="tag flexk">Flexible</span>' : '<span class="tag">Fixed</span>');
    return tags.join("");
  }

  taskHTML(t) {
    const done = t.status === "done";
    const canSchedule = !done && !t.needs_checkin;
    return `<div class="task${done ? " done" : ""}" ${canSchedule ? `data-drag="${t.id}"` : ""}>
      <button class="tick" data-tick="${t.id}" aria-label="${done ? "Mark not done" : "Mark done"}">${done ? "✓" : ""}</button>
      <div class="tb">${this.editable ? `<button class="tt" data-edit-task="${t.id}">${esc(t.title)}</button>` : `<span class="tt">${esc(t.title)}</span>`}
        ${done ? "" : `<span class="tags">${this.tagsHTML(t)}</span>`}</div>
      ${canSchedule ? `<button class="sch" data-schedule="${t.id}">${t.status === "scheduled" ? "Move" : "Schedule"}</button>` : ""}
    </div>`;
  }

  render() {
    const sc = this.root.querySelector(".tasks-body")?.scrollTop || 0;
    const folders = this.folders.map((f) => {
      const open = f.tasks.filter((t) => t.status !== "done");
      const done = f.tasks.filter((t) => t.status === "done");
      const folded = this.folded.has(f.id);
      const showDone = this.showDone.has(f.id);
      return `<div class="folder" data-folder="${f.id}">
        <button class="fhead" data-fold="${f.id}" aria-expanded="${!folded}"><span class="car">${folded ? "▸" : "▾"}</span>${esc(f.name)}<span class="n">${open.length}</span></button>
        ${folded ? "" : `
          ${this.editable ? `<div class="addt"><input type="text" placeholder="Add a task to ${esc(f.name)}" data-add-input="${f.id}" aria-label="New task in ${esc(f.name)}"><button class="btn small" data-add="${f.id}">Add</button><button class="btn small" data-folder-menu="${f.id}" aria-label="Folder options">⋯</button></div>` : ""}
          ${open.map((t) => this.taskHTML(t)).join("")}
          ${!open.length ? '<div class="empty" style="padding:10px">Nothing to do here.</div>' : ""}
          ${done.length ? `<button class="showdone" data-show-done="${f.id}">${showDone ? "Hide" : "Show"} done (${done.length})</button>` : ""}
          ${showDone ? done.map((t) => this.taskHTML(t)).join("") : ""}`}
      </div>`;
    }).join("");
    this.root.innerHTML = `
      ${this.big ? "" : `<div class="tasks-head"><div class="r"><h3>Tasks</h3>${this.editable ? '<button class="btn small" data-new-folder>＋ Folder</button>' : ""}</div>
        <small>Drag a task onto the calendar, or tap Schedule. Drag a calendar item here to send it back.</small></div>`}
      <div class="tasks-body${this.big ? " big" : ""}" data-unschedule-zone>${folders || '<div class="empty">No folders yet.</div>'}</div>`;
    this.root.querySelector(".tasks-body").scrollTop = sc;
  }

  async click(e) {
    const b = e.target.closest("button");
    if (!b) return;
    const ds = b.dataset;
    try {
      if (ds.fold) {
        const id = +ds.fold;
        this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
        saveFolded(this.folded);
        this.render();
      } else if (ds.showDone) {
        const id = +ds.showDone;
        this.showDone.has(id) ? this.showDone.delete(id) : this.showDone.add(id);
        this.render();
      } else if (ds.tick) {
        const t = this.task(+ds.tick);
        await post(`/api/tasks/${t.id}/done`, { done: t.status !== "done" });
        toast(t.status !== "done" ? `Done: ${t.title} ✓` : `Reopened: ${t.title}`);
        await this.changed();
      } else if (ds.schedule) {
        this.onSchedule && this.onSchedule(this.task(+ds.schedule));
      } else if (ds.editTask) {
        this.onEdit && this.onEdit(this.task(+ds.editTask));
      } else if (ds.add) {
        this.addTask(+ds.add, this.root.querySelector(`[data-add-input="${ds.add}"]`));
      } else if (ds.newFolder !== undefined) {
        this.folderSheet(null);
      } else if (ds.folderMenu) {
        this.folderSheet(this.folders.find((f) => f.id === +ds.folderMenu));
      }
    } catch (err) { toast(err.message, true); }
  }

  async addTask(folderId, input) {
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    try {
      await post("/api/tasks", { folder_id: folderId, title });
      input.value = "";
      await this.changed();
      this.root.querySelector(`[data-add-input="${folderId}"]`)?.focus();
    } catch (err) { toast(err.message, true); }
  }

  async folderSheet(folder) {
    if (!folder) {
      const name = await askText("New folder", "Folder name", "");
      if (!name) return;
      await post("/api/folders", { name });
      toast(`Added folder “${name}”`);
      return this.changed();
    }
    const act = await choose(folder.name, [
      { label: "Rename folder", value: "rename" },
      { label: "Move up", value: "up" },
      { label: "Move down", value: "down" },
      { label: "Delete folder", value: "delete", danger: true },
    ]);
    if (act === "rename") {
      const name = await askText("Rename folder", "Folder name", folder.name);
      if (name) await patch(`/api/folders/${folder.id}`, { name });
    } else if (act === "up" || act === "down") {
      const i = this.folders.indexOf(folder), j = act === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= this.folders.length) return;
      const order = [...this.folders];
      [order[i], order[j]] = [order[j], order[i]];
      await Promise.all(order.map((f, k) => patch(`/api/folders/${f.id}`, { sort_order: k })));
    } else if (act === "delete") {
      await del(`/api/folders/${folder.id}`);
      toast(`Deleted “${folder.name}”`);
    }
    if (act) await this.changed();
  }

  async changed() {
    await this.load();
    this.onChanged && this.onChanged();
  }
}

export function askText(title, label, value) {
  return new Promise((resolve) => {
    const s = openSheet(`<h2>${esc(title)}</h2><form class="stack"><label class="field">${esc(label)}<input type="text" name="v" value="${esc(value)}" required autofocus maxlength="100"></label>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn pri">Save</button></div></form>`, { onClose: () => resolve(null) });
    s.body.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = e.target.v.value.trim();
      resolve(v);
      s.close();
    });
  });
}
