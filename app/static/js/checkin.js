// Daily check-in: pick who you are, then answer each past flexible job.
// Used on the wall (in a sheet), the phone Check-in tab and the /checkin page.
import { esc, toast, fmtDate, fmtTime, addDays } from "./util.js";
import { get, post } from "./api.js";

export class Checkin {
  constructor(root, { onChange, today } = {}) {
    Object.assign(this, { root, onChange, today: today || (() => new Date().toISOString().slice(0, 10)) });
    this.members = [];
    this.items = [];
    this.member = null;
    this.skipped = new Set();
    this.sub = null;
    this.busy = false;
    root.addEventListener("click", (e) => this.click(e));
  }

  async load() {
    const data = await get("/api/checkin");
    this.members = data.members;
    this.items = data.items;
    this.render();
    this.onChange && this.onChange(this.items.length);
    return this;
  }

  reset() { this.member = null; this.skipped = new Set(); this.sub = null; this.render(); }

  mine() { return this.items.filter((i) => i.answer_member_ids.includes(this.member)); }
  current() { return this.mine().find((i) => !this.skipped.has(i.key)); }

  planned(it) {
    const d = it.date === this.today() ? "Today" : fmtDate(it.date);
    return it.start ? `${d} · ${fmtTime(it.start)}` : d;
  }

  render() {
    if (!this.member) {
      this.root.innerHTML = `<div class="ci"><h3>Who's checking in?</h3><p class="lede">Flexible jobs from earlier that nobody has answered yet.</p>
        <div class="who">${this.members.map((m) => {
          const c = this.items.filter((i) => i.answer_member_ids.includes(m.id)).length;
          return `<button data-who="${m.id}"><span class="av" style="--c:${m.color}">${esc(m.short_label || m.name[0])}</span><span class="nm">${esc(m.name)}</span>
            <span class="ct${c ? "" : " zero"}">${c ? `${c} to check` : "All done ✓"}</span></button>`;
        }).join("")}</div></div>`;
      return;
    }
    const m = this.members.find((x) => x.id === this.member);
    const item = this.current();
    if (!item) {
      const later = this.mine().length;
      this.root.innerHTML = `<div class="ci"><div class="caught"><div class="big">✓</div><h3>All caught up, ${esc(m.name)}</h3>
        <p class="lede" style="margin:0">${later ? `${later} saved for later.` : "Nothing left to check."}</p>
        <button class="btn pri" data-back>Done</button></div></div>`;
      return;
    }
    const left = this.mine().filter((i) => !this.skipped.has(i.key)).length;
    const tomorrow = addDays(this.today(), 1);
    const t = item.start || "09:00";
    const recurring = item.source === "recurring";
    let sub = "";
    if (this.sub === "under") {
      sub = `<div class="sub-q"><label for="ci-ud"><b>Continue when?</b> (optional)</label>
        <div class="inrow"><input type="date" id="ci-ud" value="${tomorrow}" min="${this.today()}"><input type="time" id="ci-ut" value="${t}" step="900"></div>
        <button class="btn pri" data-act="under-time">Put it on the calendar</button>
        <button class="btn" data-act="under-none">${recurring ? "No new time" : "No time yet, back to task list"}</button></div>`;
    } else if (this.sub === "res") {
      sub = recurring
        ? `<div class="sub-q"><label for="ci-rd"><b>Move just this one to…</b></label>
            <div class="inrow"><input type="date" id="ci-rd" value="${tomorrow}" min="${this.today()}"><input type="time" id="ci-rt" value="${t}" step="900"></div>
            <button class="btn pri" data-act="res-time">Move it</button><button class="btn" data-act="res-skip">Skip this week</button></div>`
        : `<div class="sub-q"><b>It goes back into the task list.</b>
            <button class="btn pri" data-act="res-none">Send it back to the list</button>
            <span class="muted" style="font-size:13.5px">or pick a new time now:</span>
            <div class="inrow"><input type="date" id="ci-rd" value="${tomorrow}" min="${this.today()}"><input type="time" id="ci-rt" value="${t}" step="900"></div>
            <button class="btn" data-act="res-time">Schedule for this time</button></div>`;
    }
    const others = item.everyone ? "Everyone" : item.member_ids.length > 1 ? item.member_ids.map((id) => this.members.find((x) => x.id === id)?.name).filter(Boolean).join(" & ") : "";
    this.root.innerHTML = `<div class="ci">
      <div class="card" style="--c:${m.color}"><span class="prog">${esc(m.name)} · ${left} left</span>
        <span class="ttl">${esc(item.title)}</span>
        <span class="meta">Planned ${esc(this.planned(item))}${others ? ` · ${esc(others)}` : ""}</span>
        <span class="meta">${recurring ? "↻ Repeats weekly" : item.task_id ? "From the task list" : "Flexible job"}</span>
        ${item.notes ? `<span class="meta" style="color:var(--fg);white-space:pre-wrap">${esc(item.notes)}</span>` : ""}</div>
      ${sub || `<div class="acts">
        <button class="a-done" data-act="done">✅ Done</button>
        <button class="a-under" data-act="under">🔧 Underway</button>
        <button class="a-res" data-act="res">📅 Needs rescheduling</button>
        <button data-act="later">⏭ Ask me later</button></div>`}
      <button class="linkbtn" data-back>‹ ${sub ? "Back" : "Someone else"}</button></div>`;
  }

  async click(e) {
    const b = e.target.closest("button");
    if (!b || this.busy) return;
    if (b.dataset.who) { this.member = +b.dataset.who; this.skipped = new Set(); this.sub = null; return this.render(); }
    if (b.dataset.back !== undefined) { if (this.sub) this.sub = null; else this.member = null; return this.render(); }
    const act = b.dataset.act;
    if (!act) return;
    if (act === "under" || act === "res") { this.sub = act; return this.render(); }
    const item = this.current();
    if (act === "later") { this.skipped.add(item.key); toast("Saved for later"); return this.render(); }
    const val = (id) => this.root.querySelector(id)?.value || null;
    const body = { member_id: this.member };
    if (act === "done") body.answer = "done";
    if (act === "under-time") Object.assign(body, { answer: "underway", new_date: val("#ci-ud"), new_time: val("#ci-ut") });
    if (act === "under-none") body.answer = "underway";
    if (act === "res-none") body.answer = "reschedule";
    if (act === "res-time") Object.assign(body, { answer: "reschedule", new_date: val("#ci-rd"), new_time: val("#ci-rt") });
    if (act === "res-skip") Object.assign(body, { answer: "reschedule", skip_week: true });
    if ((act === "under-time" || act === "res-time") && !body.new_date) { toast("Pick a day first.", true); return; }
    this.busy = true;
    try {
      const r = await post(`/api/checkin/${encodeURIComponent(item.key)}`, body);
      toast(r.message);
      this.sub = null;
      await this.load();
    } catch (err) {
      toast(err.message, true);
      await this.load();
    } finally {
      this.busy = false;
    }
  }
}
