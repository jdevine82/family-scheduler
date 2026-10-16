# Family Scheduler — Build Spec

A self-hosted family wall calendar. It shows **day**, **week** and **month** views on a wall display, with one **swim lane per family member**, and you can plan months ahead. It handles **recurring weekly activities**, events for the whole family or for one person, **read-only Google Calendar feeds** for each member, and **to-do task folders** you can drag onto the calendar. Calendar items are either **fixed events**, which count as done once their time has passed, or **flexible jobs**, which a family member confirms through a **daily check-in**.

It's a sibling of `../workSchduler` (Job Scheduler) with the same look, stack and deployment, but it has **no ServiceM8 connection at all**.

Mockup: `mockups/mockup.html` is a clickable mockup of the wall display, phone screens, tasks and check-in. Treat it as the visual reference for the build.

Status: **built** (phases 1–7b). Draft notes below are kept as the design record. Items marked **[ASSUMPTION]** are decisions I made for you. Items marked **[QUESTION]** need your answer before or during the build (they're collected in §11).

---

## 1. Purpose

- A big, glanceable calendar on the wall: who's doing what today and this week.
- Enter the regular weekly routine once (school, swimming, footy training, bins night) and have it show up every week automatically.
- Add one-off events for one person, a few people, or the whole family.
- Pull each person's Google Calendar in automatically so nothing has to be typed twice.
- Keep "someday" task lists in folders (House, Garden, Shopping, Car…) and drag a task onto a day when it's time to do it.
- Plan months ahead (holidays, birthdays, term dates) and see them in a month view.
- Stop flexible jobs from quietly slipping. Each day, a family member taps **Check-in** and answers for each of their flexible jobs from previous days: done, underway, or needs rescheduling.

---

## 2. Tech stack and deployment (same as Job Scheduler)

| Layer | Choice |
|---|---|
| Backend | Python, FastAPI |
| Database | SQLite, a single file |
| Frontend | Jinja2 server-rendered templates + vanilla JS, no framework. **Mobile-first and touch-first** (§6.7): drag-and-drop uses Pointer Events (works for mouse, touch and pen), not the HTML5 drag API, which doesn't work on touch. |
| Auth | No user logins. A hashed **parent PIN** (session unlock for 5 minutes) protects Settings and pocket money parent actions. |
| Wall display | A public, read-only **display mode** URL that needs no login and auto-refreshes (§6.1). |
| Deployment | Proxmox LXC, Python venv, systemd unit. No Docker. |
| Background jobs | An in-app polling task that refreshes the Google Calendar feeds (default every 15 min). |

**[ASSUMPTION]** Code is reused heavily from Job Scheduler: `database.py`, `security.py`, `deps.py`, auth router, backup/restore, `base.html` shell, and the lane-building logic in `scheduling.py` adapted from workers to members. Nothing ServiceM8-related comes across: no `servicem8.py`, `sync.py`, queues, statuses, booking write-back or reports.

---

## 3. Core concepts

| Concept | What it is |
|---|---|
| **Member** | A family member. Has a name, colour, a short label/emoji for lane headers, and a sort order. Every active member **always** gets a lane, even on an empty day. This is different from Job Scheduler, which only shows lanes for workers who have jobs. |
| **Event** | A one-off item on a date. It can be timed (start/end) or **all-day**, and it's assigned to one or more members or to **Everyone**. |
| **Recurring activity** | A weekly rule such as "Swimming, Tue & Thu, 4:00–5:00pm, Sam" or "Bins out, Sunday 7pm, Everyone". It's expanded into occurrences when the calendar is drawn, so nothing is copied into the DB week by week. |
| **Occurrence override** | A change to one instance of a recurring activity: skip it ("no swimming, public holiday") or move/edit just that one ("swimming at 5 instead of 4 this week"). |
| **External event** | An event read from a member's Google Calendar feed. Shown in that member's lane and read-only in this app. |
| **Task folder / task** | To-do lists in folders. A task has no date until it's dragged onto the calendar, which turns it into a scheduled event linked back to the task. |
| **Kind: fixed event vs flexible job** | Every event, recurring activity and task has a `kind`. **Fixed event** (swimming, dentist, a party): once its end time passes it's assumed done, with no questions asked. **Flexible job** (clean gutters, wash the car): the time is a plan, not a commitment. Once its time passes it waits as *needs check-in* until a family member responds to it. |
| **Check-in** | A daily review, per member, of their past flexible jobs that nobody has responded to yet (§6.6). |

---

## 4. Data model (SQLite)

```
User
  id, username, password_hash, display_name, is_admin, active, created_at, last_login_at
  member_id (FK → Member, nullable)   -- optional: "this login is Mum"

Member
  id, name, short_label (e.g. "S" or "🏊"), color_hex, chime_sound, sort_order, active, created_at
  -- chime_sound: one of the built-in presets (§6.8); defaults to the next unused one

Event                                   -- one-off items
  id, title, notes, location,
  date, start_time (nullable), end_time (nullable), all_day (bool),
  end_date (nullable)                   -- multi-day, e.g. school camp
  is_everyone (bool),
  kind ('fixed' | 'flexible'),          -- default 'fixed' when created directly
  check_status ('pending' | 'done' | 'underway' | 'rescheduled', nullable)
                                        -- flexible only; fixed events are "done" by time, nothing stored
  checked_at, checked_by_member_id (nullable)
  chime ('default' | 'on' | 'off'), remind_minutes (nullable)
  task_id (FK → Task, nullable)         -- set if it came from dragging a task
  created_by, updated_by, created_at, updated_at

EventMember                             -- many-to-many (ignored when is_everyone)
  event_id, member_id

RecurringActivity
  id, title, notes, location,
  weekdays (bitmask or "MO,TU,TH"),
  start_time, end_time, all_day,
  interval_weeks (default 1)            -- 2 = fortnightly
  anchor_date                           -- needed for fortnightly parity
  valid_from (date), valid_until (date, nullable)  -- e.g. school term only
  is_everyone, active,
  kind ('fixed' | 'flexible'),          -- e.g. "mow lawn, weekly, flexible"
  chime ('default' | 'on' | 'off'), remind_minutes (nullable)
  created_by, updated_by, created_at, updated_at

RecurringActivityMember
  recurring_activity_id, member_id

OccurrenceOverride
  id, recurring_activity_id, original_date,
  action ('skip' | 'modify'),
  new_date, new_start_time, new_end_time, new_title, new_notes (all nullable)
  check_status, checked_at, checked_by_member_id (nullable)
                                        -- check-in answer for a flexible recurring occurrence
  -- members can't be changed per occurrence in v1 [ASSUMPTION]
  -- (action may be 'none' when the row only records a check-in answer)

CalendarFeed
  id, member_id (FK), label ("Mum – work"), ical_url (secret, never shown on the display page),
  color_hex (nullable; defaults to member colour), enabled, chime (bool, default off),
  last_fetched_at, last_error

ExternalEvent                            -- cache, rebuilt on every fetch
  id, feed_id, uid, recurrence_id, title, location,
  start_at, end_at, all_day, fetched_at

TaskFolder
  id, name, color_hex (nullable), sort_order

Task
  id, folder_id, title, notes,
  default_member_id (nullable), est_duration_minutes (default 60),
  kind ('flexible' | 'fixed')           -- default 'flexible'; copied to the event when scheduled
  status ('open' | 'scheduled' | 'underway' | 'done'),
  reschedule_count (int, default 0)     -- shown as a badge: "pushed back 3×"
  done_at, sort_order, created_at, updated_at

TaskLog                                  -- history, so nothing just disappears
  id, task_id, event_id (nullable), member_id (nullable),
  action ('scheduled' | 'done' | 'underway' | 'rescheduled' | 'moved' | 'unscheduled'),
  from_at, to_at (nullable), note, created_at

-- Pocket money (§6.9)
Member (extra columns)
  is_child (bool), allowance_cents (int), allowance_weekday (0=Mon…6=Sun), allowance_since (date)

MoneyJob
  id, title, notes, amount_cents, est_minutes, for_member_id (nullable), active, sort_order

Event (extra column)
  money_job_id (FK → MoneyJob, nullable)  -- a booked paid job

MoneyTxn
  id, member_id, amount_cents (+ credit / − debit), kind ('income'|'job'|'fine'|'withdrawal'),
  description, event_id (nullable), period_date (nullable; the payday for 'income'), created_at
  UNIQUE (member_id, kind, period_date)  -- income can't be paid twice for one payday

Setting                                  -- key/value, same pattern as Job Scheduler
  display_start_hour, display_end_hour, display_rotate_seconds,
  feed_poll_minutes, feed_window_months (default 12), week_starts_on,
  checkin_lookback_days (default 14), timezone (Australia/Sydney),
  chime_enabled, chime_volume, chime_google_events (default off),
  quiet_start ("20:30"), quiet_end ("07:00")
```

---

## 5. Recurrence rules

- Weekly only in v1: pick the days of the week, a time (or all-day), and optionally **every N weeks**. That covers about 95% of family routines.
- An optional **valid from / until** date range covers "Term 4 only" without having to delete and re-enter.
- On the calendar, clicking an occurrence asks **"This one only / All future / Whole series"**, the same way Google does:
  - *This one* → writes an `OccurrenceOverride`.
  - *All future* → ends the current series the day before (`valid_until`) and creates a new series from that date.
  - *Whole series* → edits the `RecurringActivity` directly.
- Expansion happens in one function, `expand_recurring(start_date, end_date) -> list[Occurrence]`, which the week, day and display views all call. Occurrences, one-off events and external events are merged into a single list before lane layout.
- **[QUESTION]** Do you want a "School holidays" calendar (date ranges) that pauses school-related activities automatically? It would be nice, but it adds a concept. I suggest leaving it for later and using `valid_until` for now.

---

## 6. Views

### 6.1 Wall display mode (the main purpose)

- URL: `/display`. No login. Full screen. **Read-only by default.** No sidebar, no hover-only information.
- **✏️ Edit toggle** (added later, **no PIN**): it switches the wall into edit mode. An amber "Editing" bar appears with a **Done** button. In edit mode you can tap empty space to add, tap an item to edit or delete it, hold and drag to move it (including to another person), drag the bottom edge to resize, and the task drawer gains add/edit. Edit mode turns itself off after 2 minutes without a touch, or when you switch to the Money tab. It's only there to stop stray taps, not for security.
- **No logins at all** (decided later). Calendar and task editing is open on the home network. Computers and tablets opening `/` are sent to the wall view, which is their editing view. Phones keep the phone layout. The **parent PIN** protects Settings (first visit: choose the PIN) and pocket money parent actions. User accounts were removed.
- Auto-refreshes data every 60s (fetching JSON or a partial and swapping it in, rather than reloading the whole page, so there's no flicker). The current-time line moves live.
- **Auto-rotate** between Today, This Week and (optionally) This Month every N seconds (configurable; 0 = off). Alternatively, use a URL parameter (`/display?view=day|week|month`) so each screen can be pinned to one view.
- A **Check-in button** in the header with a count badge ("3 to check"), shown only when something is waiting (§6.6).
- Bigger type than Job Scheduler, readable from about 3 m. Base event text around 18px. Times in mono.
- Header strip: date, live clock, and a small "next up" line ("Next: Swimming – Sam in 25 min").
- Optional **dim/night mode** after a set hour. A touch wakes it to full brightness for 2 minutes.
- **[ASSUMPTION]** The display runs on the LAN only, the same trust model as Job Scheduler's public read-only calendar. It never shows Google feed URLs, only the event titles from them.
- **The wall screen is a touchscreen** (decided). The display stays read-only for editing, but it supports:
  - tapping an event → a large detail card (title, who, time, notes, location); tap outside to close
  - swiping left/right (or ← → buttons) to change day/week/month, with a "Today" button. After 2 minutes idle it returns to today and resumes rotating.
  - tapping **Check-in** (§6.6)
  - tapping the day/week/month toggle
- **[ASSUMPTION]** Hardware is a Chromium kiosk (e.g. a Pi or mini-PC on a touch monitor, or a tablet) pointed at `/display`. Exact device still to be confirmed, but nothing in the design depends on it.

### 6.2 Day view

```
┌──────────────────────────────────────────────────────────────┐
│ Fri 16 Oct                  10:42                Week | Day  │
├─────────┬───────────┬───────────┬───────────┬────────────────┤
│ All day │ ███ School camp (Sam, Ella) ███   │ Bins night ███ │  ← all-day row
├─────────┼───────────┼───────────┼───────────┼────────────────┤
│         │  Mum      │  Dad      │  Sam      │  Ella          │  ← member lanes, always shown
│  7am    │           │ ▓ Work    │           │                │
│  8am    │ ███████████ School run (Everyone) █████████████████ │  ← "Everyone" spans all lanes
│  …      │           │ (Google)  │ Swimming  │                │
└─────────┴───────────┴───────────┴───────────┴────────────────┘
```

- One column per member, with a time grid down the left, and a separate all-day row at the top.
- **Weekly report** (added later): tapping a person's name (day view lane header, week view row, or phone More → 📊 Weekly reports) opens their last 7 days, newest first. Every item is marked done / not done / underway / still to come / moved (using the same "done" rule as the progress bar), with daily bars and a weekly percentage. It's on screen only, with no printing or saving, and it closes after 2 minutes without a touch, showing a countdown.
- **Progress bar under each name** (added later): shows that person's done vs total items for the day, as a green (done) and red (not done) bar with a "3/5" count. Done means checked in as done, or a fixed event whose time has passed. Unchecked flexible jobs, tasks and paid jobs count as not done, and moved items are left out. Its colour shows time pressure: the minutes of unfinished items divided by the minutes left before the day view ends. With plenty of time it's mostly grey, and as the ratio nears 1 it becomes full green/red. Past days and finished days are full colour; future days are grey.
- **Everyone** events draw as **one block spanning all lanes**, not one copy per lane, so whole-family items stand out instantly.
- Multi-member (not everyone) events draw one linked copy per member lane, the same as multi-worker jobs in Job Scheduler. If the members are in adjacent lanes, they merge into one wide block. **[ASSUMPTION]**
- Overlapping events in one lane split the lane width side by side.
- Google events are visually distinct: a dashed or hatched left edge plus a small "G" mark. They show "read-only" when clicked in edit mode.

### 6.3 Week view

Two layouts, chosen in Settings and per display:

- **Grid (the Job Scheduler feel):** days as columns, each subdivided into member lanes with a time grid. Precise, but with 7 days × 4–5 members the lanes get narrow.
- **Agenda rows (recommended for the wall):** **members as rows, days as columns**, with events listed as chips with times and no time grid. Much more readable from across a room. An "Everyone" row sits at the top.

**[QUESTION]** Do you want both, or should we pick one? I'd build agenda rows first for the wall, and grid for the editing screen.

### 6.3a Month view

- A standard 7-column month grid, 5–6 weeks. Each day lists compact chips (time + title) coloured by member. "Everyone" chips are in the accent colour, and multi-day events draw as a bar across the days. Busy days show "+3 more".
- Click a day → day view. Click a week number → week view.
- Navigate any number of months forward or back with ← →. Jump with "Today" or a month picker.
- Recurring activities are expanded for whatever range is shown, so they appear correctly months ahead with no stored copies.
- Google feeds are cached `feed_window_months` ahead (default 12) so the month view is complete far out.
- Optional filter to only show all-day items + Everyone events, for a cleaner "big picture" of holidays, birthdays and trips. **[ASSUMPTION]** Off by default.

### 6.4 Edit mode (logged in)

- The same week/day views plus the **task sidebar**: a left panel on desktop/tablet, a bottom tab/sheet on phones (§6.7).
- Tap an empty slot → quick-add (title, members/Everyone, time, fixed/flexible, "repeat weekly?" toggle). On phones a floating **+** button does the same.
- Drag to move, drag edges to resize (long-press to pick up on touch). Dragging a block into another member's lane reassigns it. Every drag action also has a non-drag equivalent in the edit modal (date/time/member fields), because dragging is fiddly on a small phone.
- Editing an event opens a modal modelled on `_job_modal.html`: title, members (checkbox chips coloured per member, plus an "Everyone" chip), date, time / all-day, repeat settings, notes, location.

### 6.5 Task sidebar

- Folders are collapsible (House, Garden, Car, Shopping, School…). Tasks can be reordered within a folder by dragging, and moved between folders by dragging.
- **Drag a task onto the calendar** (long-press on touch), or tap the task → **Schedule…** to pick member/date/time in a sheet. Either way → creates an `Event` with `task_id` set. The member is set from the lane it lands in, the time from the drop position, and the length from `est_duration_minutes`. The task becomes `scheduled` and is greyed out in the sidebar.
- **Drag a scheduled task-event back to the sidebar** → deletes the event and sets the task back to `open`.
- Tick a task done, from the sidebar or the event → `done`. Done tasks are hidden behind a "Show done" toggle.
- Quick-add a task at the top of each folder. Each task has a **Flexible / Fixed** toggle, defaulting to Flexible because most to-dos are.
- Badges on sidebar tasks: **underway** (started, not finished) and **pushed back N×**, so chronically postponed jobs are obvious.
- **Where the task list lives** (decided):
  - **Computer/tablet editing view:** a permanent left sidebar with folders, search and "+ Folder".
  - **Phone:** the Tasks tab in the bottom nav.
  - **Wall display:** a **☑ Tasks** button in the top bar opens a drawer from the left with large touch rows. You can tick tasks, drag one onto a lane (the drawer fades while dragging), or tap **Schedule**. The drawer closes after 1 minute without a touch. This is the one editing action allowed on the wall.
- **Schedule sheet** (used everywhere): who (member chips + Everyone), date, time, length (30 min – half day). It also shows a one-line reminder of what flexible vs fixed means.

### 6.6 Daily check-in (flexible jobs)

How flexible jobs get resolved, so nothing silently slips.

**What's in the queue:** a member's flexible items (one-off events and recurring occurrences) where the end time has passed, `check_status` is empty/`pending`, and the date is within `checkin_lookback_days`. "Everyone" or multi-member flexible jobs appear for each of their members, and whoever answers first resolves it for all. **[ASSUMPTION]**

**Fixed events never appear here.** Once their end time passes they show as done (slightly faded, with a small ✓) automatically.

**Flow:**
1. Tap **Check-in** (on the wall display, in edit mode, or on a phone at `/checkin`). **It only appears when the button is pressed.** There's no auto-popup (decided).
2. Pick who you are: big coloured member buttons, each showing a count.
3. Step through the items one card at a time, oldest first. Each card shows the title, when it was planned and notes. There are four big buttons:

| Answer | What happens |
|---|---|
| ✅ **Done** | Event → `done`. Linked task → `done`. It stays on the calendar with a ✓. |
| 🔧 **Underway** | Event → `underway`. Shows a date/time picker ("continue when?", optional). **If a time is entered:** a new flexible event is created at that time (the original stays as a record of the first session) and the task stays `scheduled`. **If skipped:** the task goes back to the sidebar with an *underway* badge. |
| 📅 **Needs rescheduling** | Event → `rescheduled` and removed from the calendar view. The task goes back to the sidebar as `open`, `reschedule_count += 1`. There's an optional "pick a new time now" shortcut so you don't have to go and drag it later. |
| ⏭ **Ask me later** | No change. It shows up again at the next check-in. |

4. Every answer writes a `TaskLog` row (who, what, when).

**Flexible recurring occurrences** (e.g. weekly "mow lawn"): *Done* / *Underway* record the answer on an `OccurrenceOverride`. *Needs rescheduling* asks for a new date for this occurrence (an override with `action='modify'`), or offers "skip this week". It doesn't go to the task list, because there's no task behind it. **[ASSUMPTION]**

**On the calendar:** past flexible items with no response get an amber "needs check-in" marker until they're answered. Done ones get a ✓, underway ones a 🔧.

**No login and no PIN for check-in** (decided). Tapping your name identifies who answered. It's LAN-only, the same trust model as display mode.

**Underway with no new time → back to the task list** with an *underway* badge (decided). It does not keep reappearing in check-in.

### 6.7 Mobile-first and touch design

Build every screen for a phone first, then let it expand to a tablet, desktop and the wall touchscreen.

**Breakpoints [ASSUMPTION]:** phone < 640px, tablet 640–1024px, desktop/wall > 1024px.

| Screen | Phone | Tablet / desktop / wall |
|---|---|---|
| Day view | One member lane at a time, plus a **member switcher** row of coloured chips (tap one, or "All" for a stacked agenda list). Swipe to change day. | All member lanes side by side |
| Week view | Agenda list grouped by day (each item with a member colour dot). A member filter chip row. | Agenda rows (members × days) or grid |
| Month view | Compact grid with coloured dots per day; tap a day → that day's list in a bottom sheet | Full grid with chips |
| Task folders | A **Tasks** tab in a bottom nav bar; folders are accordions | Left sidebar |
| Edit event | Full-screen sheet | Centred modal |
| Check-in | Full-screen cards (the default layout everywhere) | Same cards, centred, max ~600px wide |

**Rules:**
- **No hover-only information or actions.** Everything that hover shows on desktop must also be reachable by tap.
- Touch targets at least 44px (64px on check-in and on the wall).
- Bottom nav on phones: **Calendar · Tasks · Check-in (with badge) · More** (Settings, if admin).
- Long-press (about 400ms) starts a drag on touch, so scrolling still works normally. A drop target highlights clearly, and auto-scrolls at screen edges.
- Swipe left/right changes the period in every calendar view.
- Bottom sheets and modals close with swipe-down, ✕, or tapping outside.
- Installable as a **PWA** (manifest + icon) so it can sit on phone home screens like an app. **[ASSUMPTION]** No offline mode in v1, just "add to home screen".
- Inputs use native mobile pickers (`<input type="date">`, `type="time"`).

### 6.8 Chimes and reminders (wall display)

The wall display plays a chime and shows a large alert card when it's time for something.

- **Start chime:** when an event or flexible job starts, a bright three-note chime plays. A card appears over the calendar: "4:00 pm · Starting now" with each item (title, who, location, "flexible job" if it is one). Items that start at the same time share one card and one chime.
- **Reminder chime (optional, per item):** "remind me N minutes before" (5 / 10 / 15 / 30 / 60). It plays a softer two-note chime: "In 10 minutes · 4:30 pm · time to get ready and leave". Handy for swimming, netball and school pick-ups.
- The card closes when someone taps **OK**, or after 60 seconds. A touch also wakes the screen from night dim.
- **What chimes by default** [ASSUMPTION]: fixed events and flexible jobs created in this app → start chime **on**, no reminder. Google calendar events → **off** (work calendars would chime all day). All-day items never chime.
- **Per item override:** every event, recurring activity and task has a chime setting: *Default / On / Off*, plus the reminder time. A recurring "Swimming" with a 15-minute reminder is set once and works every week.
- **Quiet hours:** no chime *sound* between, say, 8:30 pm and 7:00 am (configurable). The alert card still shows silently, and the speaker button shows 🌙 so it's clear why there's no sound.
- **Volume** and a **Test chime** button in Settings → Display.
- **A different chime per member** (decided), so you can tell by ear whose it is without looking:
  - Each member picks a chime in Settings → Members, with a ▶ preview. Presets: *Bells, Ding-dong, Marimba, Chirp, Harp, Wind chime, Xylophone, Doorbell*. New members get the next unused one.
  - "Everyone" items use a distinct **Family fanfare**, which isn't a member preset.
  - When several people's items start at once, each person's chime plays **in turn** (e.g. Sam's marimba, then Dad's ding-dong). The alert card names them: "♪ Sam's marimba, then Dad's ding-dong".
  - Reminder chimes are a shorter, quieter version of the same member's chime (first two notes only).
  - Multi-member (not Everyone) items play each member's chime in turn as well.
- **Sounds:** generated in the browser with the Web Audio API (no sound files). Each preset is a list of notes (pitch, start offset, length) plus a waveform. Custom uploaded sounds could come later.
- **Sound on by default** with a 🔊/🔇 mute button in the wall's top bar. Mute is remembered per screen. When muted, alert cards still show.
- **Kiosk note:** browsers block sound until the page has been touched. Start the wall's Chromium with `--autoplay-policy=no-user-gesture-required`. Otherwise the speaker button shows an amber dot until the first touch.
- **How it works:** the display already refreshes every 60s. A client-side timer checks the next start/reminder time from the loaded data and fires on the minute, so no server push is needed.
- **Phones:** no sound or notifications in v1. Possible later: PWA push notifications (needs HTTPS, so that would also need a reverse proxy and certificate).

### 6.9 Pocket money (second tab)

A second tab, **💰 Money**, next to **📅 Calendar**, in the same page on the wall, phone and computer. It works like a small bank for each child.

**Who's a child:** each member has an "is a child" switch. Only children have accounts.

**Parent PIN** (decided: PIN, not logins, because it has to work on the wall):
- A 4–6 digit **parent PIN** is first set by an admin in Settings → Pocket money. After that it can be changed from the Money tab (needs the current PIN).
- Viewing balances, history and the jobs board needs **no PIN**. Every parent action asks for the PIN on a big keypad: approve and pay a job, fine, withdraw, money setup. Once entered, it stays unlocked for 5 minutes (or until someone leaves the tab or the wall goes idle).
- 5 wrong tries locks the keypad for a minute. The PIN is stored hashed.

**Money setup** (behind the PIN):
- **Basic income** per child: an amount per week and a payday (e.g. $5.00 every Saturday). It's credited automatically on payday, and the app catches up if it was off. It never pays the same week twice.
- **Paid jobs list**: title, payment (e.g. "Wash the car · $4.00"), roughly how long it takes, and optionally "only for" one child. Jobs stay on the list after being done, so they can be done again.

**Main Money screen (no PIN):**
- One card per child: balance, weekly income, and buttons for **History** and **Find a job**.
- **Jobs board**: every active paid job with its payment.
- **Waiting for a parent**: booked jobs whose time has come, each with **Approve & pay** and **Not done** (both need the PIN).
- **Coming up**: jobs children have booked that haven't happened yet. A child can cancel their own future booking.

**A child books a job into their schedule:**
1. Tap a job → choose who you are → pick a day.
2. The app shows the **free start times** that day, on a 30-minute grid. A time is free if nothing timed is already in that child's lane for the job's length: their own items, Everyone items, routines and Google events. The time can't be in the past, and it must be inside the day view's hours.
3. Booking creates a **flexible** calendar item for that child, marked 💰 with the amount. It shows on every calendar view.
4. The server checks for clashes again when saving, so two people can't grab the same slot.
- Paid-job items **don't appear in the daily check-in**. A parent approving them on the Money tab replaces check-in for these.

**Approving:** **Approve & pay** credits the child (transaction "Job: Wash the car · +$4.00") and marks the calendar item ✓ done. **Not done** marks it not done (shown struck through) without paying. The child can book it again.

**Fines:** PIN → choose child → amount → reason (e.g. "Room not tidied") → debit. A balance can go below zero from a fine, and it shows in red.

**Withdrawals:** PIN → choose child → amount → note (e.g. "Bought Lego") → debit. You can't withdraw more than the balance.

**History:** each child's transactions, newest first: date, description, amount (+ green / − red), and running balance. Kinds are *Income*, *Job*, *Fine*, *Withdrawal*.

Money is stored as whole **cents** (integers) and shown as $0.00.

---

## 7. Google Calendar integration (read-only)

**v1 approach: each calendar's secret iCal address.** In Google Calendar → Settings → (calendar) → *Integrate calendar* → **"Secret address in iCal format"**. Paste that URL into Settings → Members → Calendars, against the right member.

Why this route rather than OAuth:
- No Google Cloud project, consent screen or token refresh is needed, and it works for each family member's own account.
- Read-only by nature, which is exactly what was asked for.
- One member can have several feeds (personal, work, school sport club calendars that publish an `.ics`).

Behaviour:
- A background poll every `feed_poll_minutes` (default 15) and a "Refresh now" button in Settings.
- Parsed with `icalendar` + `recurring-ical-events`, which correctly expands Google's RRULEs and exceptions. The app caches the window from 1 month back to `feed_window_months` ahead (default 12) in `ExternalEvent`, so month view works far ahead.
- Google events are always treated as **fixed**: they never appear in check-in.
- Failures are stored in `last_error` and shown in Settings. The display keeps the last good copy.
- Feed URLs are treated as secrets. They're stored only in the DB, never rendered on display pages, and redacted from logs.
- Optional per-feed **privacy**: "show as Busy only" (the title is replaced with "Busy"). Useful for work calendars.

**Later option:** an OAuth Google Calendar API connection if you ever want two-way sync (events created here pushed to Google). Not in v1.

---

## 8. Settings (admin)

| Tab | Contents |
|---|---|
| Members | Add/edit/reorder/deactivate members, colour, label/emoji, **chime sound (with ▶ preview)**, plus their Google calendar feeds |
| Recurring | A list of every recurring activity (easier to review than hunting on the calendar), with edit/pause/delete |
| Task folders | Add/rename/reorder/recolour/delete folders |
| Display | Hours shown, week layout, which views rotate (day/week/month), rotate interval, night-dim hours, week start day |
| Check-in | Lookback days, whether the display shows the check-in button, auto-prompt time |
| Users | Same as Job Scheduler |
| Backup | Same as Job Scheduler (download / restore DB) |

---

## 9. Style

Reuse Job Scheduler's `STYLE_GUIDE.md` tokens (light Pico-style neutrals, Inter + JetBrains Mono, flat hairline borders) so the two apps look like siblings, with these changes:

- **No status colours.** Member colour is the only colour channel: block fill at about 18% plus a full-colour left edge. "Everyone" events use the accent colour (`--accent #1095C1`) as fill so they read as family-wide.
- Flexible vs fixed: flexible items get a **dashed** border so plans read as "loose". Past fixed events fade to about 60% opacity. Check-in states use small icons (✓ done, 🔧 underway, amber dot needs check-in), never fill colour, keeping to Job Scheduler's "one colour channel" rule.
- Check-in screens use very large touch targets (minimum 64px buttons).
- Display mode type scale is about 1.4× the edit-mode scale.
- No company branding. The top bar says "Family Calendar" (**[QUESTION]** do you want a family name or photo?).
- Same member palette as the worker palette (blue, violet, cyan, rose, lime, gold, indigo, magenta).

---

## 10. Build plan (phases)

1. **Skeleton.** Mobile-first CSS base (bottom nav, sheets, breakpoints), Pointer Events drag helper, PWA manifest. Copy the project scaffold from Job Scheduler, strip ServiceM8, add the Member model, seed script, login, and Settings → Members.
2. **One-off events.** Event + EventMember, day view with always-on member lanes, all-day row, Everyone spanning, the create/edit modal, drag/resize.
3. **Recurring.** RecurringActivity + overrides, `expand_recurring()`, the "this one / future / all" edit flow, Settings → Recurring list.
4. **Week + month views.** Agenda-rows week layout (and/or grid), month grid, month navigation.
5. **Display mode.** `/display`, auto-refresh, rotate, big type, clock, "next up", touch (tap details, swipe, idle return), chimes + alert card + reminders.
6. **Google feeds.** CalendarFeed, poller, ICS parsing, read-only rendering, busy-only privacy.
7. **Tasks.** Folders, sidebar, drag-to-calendar, drag-back, done, flexible/fixed kind.
7a. **Check-in.** Queue logic, `/checkin` phone page, display button, done/underway/reschedule/later, TaskLog, calendar markers.
7b. **Pocket money.** Money tab (wall, phone, computer), parent PIN, weekly income, paid jobs, booking into free slots, approve & pay, fines, withdrawals, history.
8. **Polish.** Night dim, print week (reusing `print_week.html`), backup/restore, INSTALL.md / USER_GUIDE.md, systemd unit.

Each phase ends usable. After phase 5 you can already put it on the wall.

---

## 11. Open questions

1. ~~Wall hardware~~ **Decided:** touchscreen. The exact device is still unknown but doesn't block the build.
2. **Week layout**: agenda rows, grid, or both?
3. **Who edits**: just you, or does each family member get a login? Do kids get a simple "tick my task" ability?
4. **Tasks on the wall**: show them on the display (and tickable if touch)?
5. **Members**: names, colours, and whether pets or "House" get a lane (e.g. for bin night).
6. **School holidays** calendar to pause term-time activities, now or later?
7. **Google**: is read-only via secret iCal addresses OK for v1 (no two-way sync)?
8. **Extras for the display** (later): weather, countdowns ("12 sleeps to holidays"), meal plan row, birthday reminders?
9. **Name/branding** for the top bar.
10. ~~Check-in identity~~ **Decided:** tap name, no PIN.
11. ~~Check-in prompting~~ **Decided:** only when the button is pressed.
12. ~~Underway with no new time~~ **Decided:** back into the task list.
13. ~~Mobile~~ **Decided:** mobile-first UI throughout.
