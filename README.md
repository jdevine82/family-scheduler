# Family Scheduler

A self-hosted family wall calendar with a lane for each person. It has weekly routines, read-only Google calendars, to-do folders you drag onto the calendar, a daily check-in for flexible jobs, a chime for each person, and a pocket money tab for the kids.

- **Backend**: Python, FastAPI, SQLite
- **Frontend**: Jinja2 page shells and plain JavaScript modules (no framework). The calendar is drawn in the browser from a JSON API.
- **Deployment**: a native process under systemd on a Proxmox VM/LXC, the same as Job Scheduler. No Docker.

## Pages

| URL | Who | What |
|---|---|---|
| `/display` | Wall, computers and tablets | Day/week/month calendar, ✏️ Edit toggle, task drawer, check-in, chimes, Money tab |
| `/` | Phones (computers are sent to `/display`) | Phone layout: calendar, tasks, check-in, Money tab |
| `/checkin` | Anyone | Phone-friendly daily check-in |
| `/settings` | Parent PIN | Family members, Google calendars, routines, display & chimes, pocket money PIN, backup |

There are **no logins**. The calendar and tasks are open to everyone on the home network. The **parent PIN** protects Settings and pocket money parent actions (paying for jobs, fines, withdrawals, money setup).

## Getting started

- **[INSTALL.md](INSTALL.md)**: set up and run the app, and the wall kiosk.
- **[USER_GUIDE.md](USER_GUIDE.md)**: day-to-day use.
- **[FAMILY_SCHEDULER_SPEC.md](FAMILY_SCHEDULER_SPEC.md)**: the design spec, which is the source of truth. `mockups/mockup.html` is the original clickable mockup.

## Project layout

```
app/
  models.py, database.py     SQLAlchemy models and DB session
  occurrences.py             merges one-off events, expanded weekly routines and Google events into one list
  services.py                tasks, check-in and routine-edit rules
  money.py                   pocket money: PIN, weekly income, booking paid jobs, approvals
  feeds.py                   Google/iCal feed download and parsing
  deps.py                    parent PIN unlock rules
  routers/                   api (calendar/tasks/check-in), money, settings, pages
  templates/                 page shells and settings pages
  static/js/                 views (day/week/month), drag, tasks, checkin, editor, money, chime, app, display
  seed.py                    default folders, optional parent PIN and --demo family
tests/                       pytest suite (python -m pytest)
deploy/family-scheduler.service   systemd unit
```
