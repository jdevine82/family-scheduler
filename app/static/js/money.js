// Pocket money tab: balances, jobs board, bookings, and PIN-protected parent actions.
import { esc, toast, openSheet, fmtDate, fmtTime, addDays } from "./util.js";
import { get, post, patch, del, api } from "./api.js";

const DAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const fmtMoney = (c) => `${c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
function parseMoney(s) {
  const v = String(s).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(v)) return null;
  return Math.round(parseFloat(v) * 100);
}

// ---------------------------------------------------------------- PIN keypad
export function askPin(title = "Parent PIN") {
  return new Promise((resolve) => {
    let pin = "";
    const s = openSheet(`<h2>🔒 ${esc(title)}</h2>
      <div class="pin-dots" aria-live="polite"></div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-d="${n}">${n}</button>`).join("")}
        <button data-back aria-label="Delete">⌫</button><button data-d="0">0</button><button data-ok class="ok" aria-label="Enter">✓</button></div>`,
      { onClose: () => { document.removeEventListener("keydown", onKey); resolve(null); } });
    const dots = s.body.querySelector(".pin-dots");
    const draw = () => (dots.innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? "on" : ""}"></i>`).join(""));
    const finish = () => { if (pin.length >= 4) { const p = pin; document.removeEventListener("keydown", onKey); resolve(p); s.close(); } };
    const onKey = (e) => {
      if (/^\d$/.test(e.key) && pin.length < 6) { pin += e.key; draw(); }
      else if (e.key === "Backspace") { pin = pin.slice(0, -1); draw(); }
      else if (e.key === "Enter") finish();
    };
    document.addEventListener("keydown", onKey);
    s.body.querySelector(".keypad").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.d && pin.length < 6) pin += b.dataset.d;
      if (b.dataset.back !== undefined) pin = pin.slice(0, -1);
      draw();
      if (b.dataset.ok !== undefined) finish();
    });
    draw();
  });
}

export class MoneyPanel {
  constructor(root, { big = false, today } = {}) {
    Object.assign(this, { root, big, today });
    this.data = null;
    root.addEventListener("click", (e) => this.click(e));
  }

  async load() {
    try {
      this.data = await get("/api/money");
      this.render();
    } catch (err) { toast(err.message, true); }
    return this;
  }

  kid(id) { return this.data.children.find((k) => k.id === id); }
  memberName(id) { return this.data.members.find((m) => m.id === id)?.name || ""; }
  color(id) { return this.data.members.find((m) => m.id === id)?.color || "var(--accent)"; }

  // Run a parent action, asking for the PIN first if this browser isn't unlocked.
  async asParent(fn) {
    if (!this.data.pin_set) { toast("Set a parent PIN first: Settings → Pocket money.", true); return false; }
    if (!this.data.unlocked && !(await this.unlock())) return false;
    try {
      return await fn();
    } catch (err) {
      if (err.message === "Parent PIN needed") {
        this.data.unlocked = false;
        if (await this.unlock()) return fn();
        return false;
      }
      toast(err.message, true);
      return false;
    }
  }
  async unlock() {
    const pin = await askPin();
    if (!pin) return false;
    try {
      await post("/api/money/unlock", { pin });
      this.data.unlocked = true;
      this.render();
      return true;
    } catch (err) { toast(err.message, true); return false; }
  }
  async lock() {
    if (!this.data?.unlocked) return;
    await post("/api/money/lock").catch(() => {});
    this.data.unlocked = false;
    this.render();
  }

  render() {
    const d = this.data;
    const lock = d.unlocked ? "🔓" : "🔒";
    const kids = d.children.map((k) => {
      const income = k.allowance_cents ? `${fmtMoney(k.allowance_cents)} every ${DAYS_LONG[k.allowance_weekday]}` : "No weekly money";
      return `<div class="kid" style="--c:${k.color}">
        <div class="kid-top"><span class="av">${esc(k.short_label)}</span><span class="nm">${esc(k.name)}</span></div>
        <div class="bal mono${k.balance_cents < 0 ? " neg" : ""}">${fmtMoney(k.balance_cents)}</div>
        <div class="muted inc">${esc(income)}</div>
        <div class="btnrow"><button class="btn small" data-history="${k.id}">History</button><button class="btn small pri" data-findjob="${k.id}">Find a job</button></div>
      </div>`;
    }).join("");
    const row = (b, actions) => `<div class="mrow" style="--c:${this.color(b.member_id)}"><i class="bar"></i>
      <div class="grow"><b>${esc(b.title)}</b><small class="muted">${esc(this.memberName(b.member_id))} · ${esc(b.when)}</small></div>
      <span class="amt mono">${fmtMoney(b.amount_cents)}</span>${actions}</div>`;
    const waiting = d.waiting.map((b) => row(b, `<button class="btn small pri" data-approve="${b.event_id}">${lock} Approve &amp; pay</button><button class="btn small" data-reject="${b.event_id}">${lock} Not done</button>`)).join("");
    const upcoming = d.upcoming.map((b) => row(b, `<button class="btn small" data-cancel="${b.event_id}">Cancel</button>`)).join("");
    const jobs = d.jobs.filter((j) => j.active).map((j) => `<div class="mrow job">
      <div class="grow"><b>${esc(j.title)}</b><small class="muted">About ${j.est_minutes} min${j.for_member_id ? ` · only for ${esc(this.memberName(j.for_member_id))}` : ""}${j.notes ? ` · ${esc(j.notes)}` : ""}</small></div>
      <span class="amt mono pay">${fmtMoney(j.amount_cents)}</span><button class="btn small pri" data-book="${j.id}">Add to my schedule</button></div>`).join("");

    this.root.innerHTML = `<div class="money${this.big ? " big" : ""}">
      <div class="mhead"><h2>💰 Pocket money</h2>
        <div class="btnrow">
          <button class="btn small" data-fine>${lock} Fine</button>
          <button class="btn small" data-withdraw>${lock} Withdraw</button>
          <button class="btn small" data-setup>${lock} Money setup</button>
          ${d.unlocked ? '<button class="btn small" data-lock>Lock</button>' : ""}
        </div></div>
      ${!d.pin_set ? '<div class="flash error">No parent PIN yet. A parent can set one in Settings → Pocket money.</div>' : ""}
      ${kids ? `<div class="kids">${kids}</div>` : `<div class="panel"><h3>No pocket money accounts yet</h3><p>Open <b>Money setup</b> and tick “Has pocket money” for each child.</p></div>`}
      ${waiting ? `<section class="msec"><h3>Waiting for a parent <span class="tag check">${d.waiting.length}</span></h3>${waiting}</section>` : ""}
      <section class="msec"><h3>Jobs you can do</h3>${jobs || '<p class="muted">No paid jobs yet. A parent can add some in Money setup.</p>'}</section>
      ${upcoming ? `<section class="msec"><h3>Coming up</h3>${upcoming}</section>` : ""}
    </div>`;
  }

  async click(e) {
    const b = e.target.closest("button");
    if (!b) return;
    const ds = b.dataset;
    if (ds.history) return this.history(+ds.history);
    if (ds.findjob) return this.root.querySelector(".msec .job")?.scrollIntoView({ behavior: "smooth", block: "center" }) ?? toast("No paid jobs yet.");
    if (ds.book) return this.book(this.data.jobs.find((j) => j.id === +ds.book));
    if (ds.cancel) {
      try { await del(`/api/money/bookings/${ds.cancel}`); toast("Booking cancelled"); } catch (err) {
        if (err.message === "Parent PIN needed") await this.asParent(async () => { await del(`/api/money/bookings/${ds.cancel}`); toast("Booking cancelled"); });
        else toast(err.message, true);
      }
      return this.load();
    }
    if (ds.approve) return this.asParent(async () => { const r = await post(`/api/money/bookings/${ds.approve}/approve`); toast(r.message); await this.load(); });
    if (ds.reject) return this.asParent(async () => { const r = await post(`/api/money/bookings/${ds.reject}/reject`); toast(r.message); await this.load(); });
    if (ds.fine !== undefined) return this.asParent(() => this.amountSheet("fine"));
    if (ds.withdraw !== undefined) return this.asParent(() => this.amountSheet("withdraw"));
    if (ds.setup !== undefined) return this.asParent(() => this.setup());
    if (ds.lock !== undefined) return this.lock();
  }

  // ---------------------------------------------------------------- history
  async history(id) {
    try {
      const h = await get(`/api/money/history/${id}`);
      const label = { income: "Weekly money", job: "Job", fine: "Fine", withdrawal: "Withdrawal" };
      openSheet(`<h2>${esc(h.name)}'s money</h2>
        <div class="bal mono${h.balance_cents < 0 ? " neg" : ""}" style="font-size:34px;font-weight:700;margin-bottom:12px">${fmtMoney(h.balance_cents)}</div>
        <div class="txns">${h.rows.map((r) => `<div class="txn"><div class="grow"><b>${esc(r.description)}</b><small class="muted">${fmtDate(r.date)} · ${label[r.kind]}</small></div>
          <span class="mono amt ${r.amount_cents < 0 ? "neg" : "pos"}">${r.amount_cents > 0 ? "+" : ""}${fmtMoney(r.amount_cents)}</span>
          <span class="mono muted run">${fmtMoney(r.balance_cents)}</span></div>`).join("") || '<p class="muted">Nothing yet.</p>'}</div>`);
    } catch (err) { toast(err.message, true); }
  }

  // ---------------------------------------------------------------- book a job into a free slot
  book(job) {
    const kids = this.data.children.filter((k) => !job.for_member_id || k.id === job.for_member_id);
    if (!kids.length) return toast("No child can do this job yet.", true);
    const today = this.today();
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
    let who = kids.length === 1 ? kids[0].id : null, day = today, time = null;
    const s = openSheet(`<h2>${esc(job.title)} · ${fmtMoney(job.amount_cents)}</h2>
      <div class="stack">
        <div class="field"><b>Who's doing it?</b><div class="chips" data-who>${kids.map((k) => `<button data-k="${k.id}" aria-pressed="${who === k.id}" style="--c:${k.color}"><i class="sw" style="--c:${k.color}"></i>${esc(k.name)}</button>`).join("")}</div></div>
        <div class="field"><b>Which day?</b><div class="chips small" data-days>${days.map((d, i) => `<button data-day="${d}" aria-pressed="${d === day}">${i === 0 ? "Today" : i === 1 ? "Tomorrow" : fmtDate(d)}</button>`).join("")}</div>
          <input type="date" data-pickday value="${day}" min="${today}" aria-label="Another day" style="max-width:220px"></div>
        <div class="field"><b>Free times</b> <small class="muted">About ${job.est_minutes} min. Only times with nothing else on are shown.</small><div class="chips small" data-times></div></div>
        <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn pri" data-go disabled>Add to my schedule</button></div>
      </div>`);
    const timesEl = s.body.querySelector("[data-times]"), go = s.body.querySelector("[data-go]");
    const loadTimes = async () => {
      time = null;
      go.disabled = true;
      go.textContent = "Add to my schedule";
      if (!who) { timesEl.innerHTML = '<span class="muted">Choose who first.</span>'; return; }
      timesEl.innerHTML = '<span class="muted">Looking…</span>';
      try {
        const r = await get(`/api/money/free?member_id=${who}&date=${day}&minutes=${job.est_minutes}`);
        timesEl.innerHTML = r.slots.length ? r.slots.map((t) => `<button data-t="${t}" aria-pressed="false">${fmtTime(t)}</button>`).join("")
          : `<span class="muted">${esc(r.reason || "No free time that day. Try another day.")}</span>`;
      } catch (err) { timesEl.innerHTML = `<span class="muted">${esc(err.message)}</span>`; }
    };
    s.body.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.k) { who = +b.dataset.k; s.body.querySelectorAll("[data-k]").forEach((x) => x.setAttribute("aria-pressed", x === b)); loadTimes(); }
      if (b.dataset.day) { day = b.dataset.day; s.body.querySelector("[data-pickday]").value = day; s.body.querySelectorAll("[data-day]").forEach((x) => x.setAttribute("aria-pressed", x === b)); loadTimes(); }
      if (b.dataset.t) {
        time = b.dataset.t;
        timesEl.querySelectorAll("[data-t]").forEach((x) => x.setAttribute("aria-pressed", x === b));
        go.disabled = false;
        go.textContent = `Add for ${fmtDate(day)} at ${fmtTime(time)}`;
      }
      if (b.dataset.go !== undefined && time) {
        try {
          const r = await post(`/api/money/jobs/${job.id}/book`, { member_id: who, date: day, start: time });
          toast(r.message);
          s.close();
          this.load();
          this.onBooked && this.onBooked();
        } catch (err) { toast(err.message, true); loadTimes(); }
      }
    });
    s.body.querySelector("[data-pickday]").addEventListener("change", (e) => {
      if (!e.target.value) return;
      day = e.target.value;
      s.body.querySelectorAll("[data-day]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.day === day));
      loadTimes();
    });
    loadTimes();
  }

  // ---------------------------------------------------------------- fine / withdraw
  amountSheet(kind) {
    const kids = this.data.children;
    if (!kids.length) { toast("No pocket money accounts yet.", true); return; }
    const isFine = kind === "fine";
    let who = kids.length === 1 ? kids[0].id : null;
    const quick = isFine ? ["Room not tidy", "Not listening", "Fighting", "Chore not done"] : ["Spent at the shops", "Saved to the bank"];
    const s = openSheet(`<h2>${isFine ? "Fine" : "Take money out"}</h2>
      <form class="stack">
        <div class="field"><b>Who</b><div class="chips" data-who>${kids.map((k) => `<button type="button" data-k="${k.id}" aria-pressed="${who === k.id}" style="--c:${k.color}"><i class="sw" style="--c:${k.color}"></i>${esc(k.name)} · ${fmtMoney(k.balance_cents)}</button>`).join("")}</div></div>
        <label class="field">Amount<input type="text" name="amount" inputmode="decimal" placeholder="$0.00" required></label>
        <label class="field">${isFine ? "What for" : "What for (optional)"}<input type="text" name="note" maxlength="200" ${isFine ? "required" : ""}></label>
        <div class="chips small">${quick.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
        <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn pri">${isFine ? "Fine" : "Take out"}</button></div>
      </form>`);
    const f = s.body.querySelector("form");
    s.body.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b?.dataset.k) { who = +b.dataset.k; s.body.querySelectorAll("[data-k]").forEach((x) => x.setAttribute("aria-pressed", x === b)); }
      if (b?.dataset.q) f.note.value = b.dataset.q;
    });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const cents = parseMoney(f.amount.value);
      if (!who) return toast("Choose who.", true);
      if (!cents) return toast("Enter an amount like 2.50", true);
      const ok = await this.asParent(async () => {
        const r = await post(`/api/money/${isFine ? "fine" : "withdraw"}`, { member_id: who, amount_cents: cents, note: f.note.value.trim() });
        toast(r.message);
        return true;
      });
      if (ok) { s.close(); this.load(); }
    });
    return true;
  }

  // ---------------------------------------------------------------- setup (children, jobs, PIN)
  setup() {
    const d = this.data;
    const dayOpts = (sel) => DAYS_LONG.map((n, i) => `<option value="${i}" ${i === sel ? "selected" : ""}>${n}</option>`).join("");
    const kidRows = d.members.map((m) => `<form class="setrow" data-child="${m.id}">
        <span class="nm"><i class="sw" style="--c:${m.color}"></i> ${esc(m.name)}</span>
        <label class="check"><input type="checkbox" name="is_child" ${m.is_child ? "checked" : ""}> Has pocket money</label>
        <label class="field">Each week<input type="text" name="amount" inputmode="decimal" value="${(m.allowance_cents / 100).toFixed(2)}"></label>
        <label class="field">Payday<select name="day">${dayOpts(m.allowance_weekday)}</select></label>
        <button class="btn small pri">Save</button></form>`).join("");
    const memberOpts = (sel) => `<option value="">Any child</option>` + d.members.filter((m) => m.is_child).map((m) => `<option value="${m.id}" ${m.id === sel ? "selected" : ""}>${esc(m.name)}</option>`).join("");
    const jobRow = (j) => `<form class="setrow job" data-job="${j ? j.id : "new"}">
        <label class="field grow">Job<input type="text" name="title" value="${esc(j?.title || "")}" maxlength="200" required placeholder="e.g. Wash the car"></label>
        <label class="field">Pays<input type="text" name="amount" inputmode="decimal" value="${j ? (j.amount_cents / 100).toFixed(2) : ""}" placeholder="$0.00" required></label>
        <label class="field">Minutes<input type="number" name="minutes" min="5" max="720" step="5" value="${j?.est_minutes || 30}"></label>
        <label class="field">For<select name="for">${memberOpts(j?.for_member_id)}</select></label>
        ${j ? `<label class="check"><input type="checkbox" name="active" ${j.active ? "checked" : ""}> On the list</label>` : ""}
        <span class="btnrow"><button class="btn small pri">${j ? "Save" : "Add job"}</button>${j ? `<button type="button" class="btn small danger" data-deljob="${j.id}">Delete</button>` : ""}</span></form>`;
    const s = openSheet(`<h2>Money setup</h2>
      <div class="stack">
        <section class="stack"><h3 style="margin:0">Children and weekly money</h3>${kidRows}</section>
        <section class="stack"><h3 style="margin:0">Paid jobs</h3>${d.jobs.map(jobRow).join("")}${jobRow(null)}</section>
        <section class="stack"><h3 style="margin:0">Change parent PIN</h3>
          <form class="setrow" data-pin><label class="field">Current PIN<input type="password" name="cur" inputmode="numeric" maxlength="6" required autocomplete="off"></label>
          <label class="field">New PIN (4–6 digits)<input type="password" name="new" inputmode="numeric" maxlength="6" required autocomplete="off"></label>
          <button class="btn small pri">Change PIN</button></form></section>
      </div>`, { wide: true, onClose: () => this.load() });
    s.body.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const run = (fn) => this.asParent(fn);
      if (f.dataset.child) {
        const cents = parseMoney(f.amount.value || "0");
        if (cents === null) return toast("Enter weekly money like 5.00", true);
        await run(async () => { await patch(`/api/money/children/${f.dataset.child}`, { is_child: f.is_child.checked, allowance_cents: cents, allowance_weekday: +f.day.value }); toast("Saved"); });
      } else if (f.dataset.job) {
        const cents = parseMoney(f.amount.value);
        if (!cents) return toast("Enter what the job pays, like 2.50", true);
        const body = { title: f.title.value.trim(), amount_cents: cents, est_minutes: +f.minutes.value || 30, for_member_id: f.for.value ? +f.for.value : null, active: f.active ? f.active.checked : true };
        const isNew = f.dataset.job === "new";
        const ok = await run(async () => { await api(isNew ? "POST" : "PATCH", isNew ? "/api/money/jobs" : `/api/money/jobs/${f.dataset.job}`, body); toast(isNew ? "Job added" : "Saved"); return true; });
        if (ok && isNew) { s.close(); await this.load(); this.setup(); }
      } else if (f.dataset.pin !== undefined) {
        try { await post("/api/money/pin", { current: f.cur.value, new: f.new.value }); toast("PIN changed"); f.reset(); } catch (err) { toast(err.message, true); }
      }
    });
    s.body.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-deljob]");
      if (!b) return;
      const ok = await this.asParent(async () => { await del(`/api/money/jobs/${b.dataset.deljob}`); toast("Job deleted"); return true; });
      if (ok) { s.close(); await this.load(); this.setup(); }
    });
    return true;
  }
}
