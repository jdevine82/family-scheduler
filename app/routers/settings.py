import datetime
import logging
import shutil
import sqlite3
from pathlib import Path

from fastapi import APIRouter, Depends, Form, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session

from app import feeds, money
from app.config import DATABASE_PATH
from app.database import engine, get_db
from app.deps import lock_parent, require_parent_page, unlock_parent
from app.models import CalendarFeed, Member, RecurringActivity
from app.services import ServiceError
from app.settings_store import all_settings, set_setting
from app.templating import templates
from app.timeutil import today_local

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings")

BACKUPS_DIR = Path(DATABASE_PATH).resolve().parent / "backups"

MEMBER_PALETTE = ["#2563EB", "#7C3AED", "#0891B2", "#DB2777", "#65A30D", "#B45309", "#4F46E5", "#A21CAF"]
# Keep in step with CHIMES in static/js/chime.js
CHIME_SOUNDS = [
    ("bells", "Bells"), ("dingdong", "Ding-dong"), ("marimba", "Marimba"), ("chirp", "Chirp"),
    ("harp", "Harp"), ("windchime", "Wind chime"), ("xylophone", "Xylophone"), ("doorbell", "Doorbell"),
]
WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

TABS = [
    ("members", "Family members"),
    ("routines", "Routines"),
    ("display", "Display & chimes"),
    ("money", "Pocket money"),
    ("backup", "Backup"),
]


def _ctx(request: Request, db: Session, tab: str, **extra) -> dict:
    return {"tab": tab, "tabs": TABS, "family_name": all_settings(db)["family_name"],
            "flash": request.query_params.get("msg"), "error": request.query_params.get("err"), **extra}


def _back(tab: str, msg: str | None = None, err: str | None = None) -> RedirectResponse:
    from urllib.parse import urlencode
    q = {k: v for k, v in (("msg", msg), ("err", err)) if v}
    return RedirectResponse(f"/settings/{tab}" + (f"?{urlencode(q)}" if q else ""), status_code=303)


# ---------------------------------------------------------------- parent PIN gate

def _safe_next(next_url: str) -> str:
    return next_url if next_url.startswith("/settings") and "//" not in next_url else "/settings/members"


@router.get("/unlock")
def unlock_page(request: Request, next: str = "/settings/members", db: Session = Depends(get_db)):
    return templates.TemplateResponse(request, "settings/unlock.html", {
        "family_name": all_settings(db)["family_name"], "pin_set": money.pin_is_set(db),
        "next": _safe_next(next), "error": request.query_params.get("err")})


@router.post("/unlock")
def unlock_submit(request: Request, pin: str = Form(...), pin2: str = Form(""), next: str = Form("/settings/members"),
                  db: Session = Depends(get_db)):
    from urllib.parse import urlencode
    dest = _safe_next(next)
    try:
        if money.pin_is_set(db):
            money.check_pin(db, pin)
        else:
            # First run: whoever sets up the app chooses the parent PIN.
            if pin != pin2:
                raise ServiceError("The two PINs don't match.")
            money.set_pin(db, pin)
            db.commit()
    except ServiceError as exc:
        return RedirectResponse("/settings/unlock?" + urlencode({"next": dest, "err": str(exc)}), status_code=303)
    unlock_parent(request)
    return RedirectResponse(dest, status_code=303)


@router.post("/lock")
def lock(request: Request):
    lock_parent(request)
    return RedirectResponse("/", status_code=303)


@router.get("")
def settings_home(_: None = Depends(require_parent_page)):
    return RedirectResponse("/settings/members", status_code=303)


# ---------------------------------------------------------------- members & feeds

@router.get("/members")
def members_page(request: Request, _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    members = db.query(Member).order_by(Member.active.desc(), Member.sort_order, Member.id).all()
    used = {m.chime_sound for m in members}
    next_chime = next((k for k, _ in CHIME_SOUNDS if k not in used), "bells")
    next_color = MEMBER_PALETTE[len(members) % len(MEMBER_PALETTE)]
    return templates.TemplateResponse(request, "settings/members.html", _ctx(request, db, "members", members=members, chime_sounds=CHIME_SOUNDS,
        next_chime=next_chime, next_color=next_color))


@router.post("/members")
def member_add(name: str = Form(...), color: str = Form(...), short_label: str = Form(""),
               chime_sound: str = Form("bells"), _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    top = db.query(Member).order_by(Member.sort_order.desc()).first()
    db.add(Member(name=name.strip(), color_hex=color, short_label=short_label.strip()[:8],
                  chime_sound=chime_sound, sort_order=(top.sort_order + 1) if top else 0))
    db.commit()
    return _back("members", f"Added {name.strip()}.")


@router.post("/members/{member_id}")
def member_update(member_id: int, name: str = Form(...), color: str = Form(...), short_label: str = Form(""),
                  chime_sound: str = Form("bells"), _: None = Depends(require_parent_page),
                  db: Session = Depends(get_db)):
    m = db.get(Member, member_id)
    if m is None:
        return _back("members", err="That person no longer exists.")
    m.name, m.color_hex, m.short_label, m.chime_sound = name.strip(), color, short_label.strip()[:8], chime_sound
    db.commit()
    return _back("members", f"Saved {m.name}.")


@router.post("/members/{member_id}/move")
def member_move(member_id: int, direction: str = Form(...), _: None = Depends(require_parent_page),
                db: Session = Depends(get_db)):
    members = db.query(Member).order_by(Member.sort_order, Member.id).all()
    idx = next((i for i, m in enumerate(members) if m.id == member_id), None)
    if idx is not None:
        j = idx - 1 if direction == "up" else idx + 1
        if 0 <= j < len(members):
            members[idx], members[j] = members[j], members[idx]
        for i, m in enumerate(members):
            m.sort_order = i
        db.commit()
    return _back("members")


@router.post("/members/{member_id}/active")
def member_active(member_id: int, active: str = Form(...), _: None = Depends(require_parent_page),
                  db: Session = Depends(get_db)):
    m = db.get(Member, member_id)
    if m is not None:
        m.active = active == "1"
        db.commit()
    return _back("members", f"{m.name} {'shown' if m.active else 'hidden'} on the calendar." if m else None)


@router.post("/members/{member_id}/delete")
def member_delete(member_id: int, _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    m = db.get(Member, member_id)
    if m is not None:
        name = m.name
        db.delete(m)
        db.commit()
        return _back("members", f"Deleted {name}. Items that were only theirs now have nobody assigned.")
    return _back("members")


@router.post("/members/{member_id}/feeds")
def feed_add(member_id: int, label: str = Form(...), ical_url: str = Form(...), busy_only: str = Form(""),
             chime: str = Form(""), _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    if db.get(Member, member_id) is None:
        return _back("members", err="That person no longer exists.")
    url = ical_url.strip()
    if not url.startswith(("https://", "http://", "webcal://")):
        return _back("members", err="That doesn't look like a calendar address. It should start with https://")
    feed = CalendarFeed(member_id=member_id, label=label.strip(), ical_url=url,
                        busy_only=busy_only == "1", chime=chime == "1")
    db.add(feed)
    db.commit()
    count = feeds.fetch_feed(db, feed)
    if feed.last_error:
        return _back("members", err=f"Saved, but the first download failed: {feed.last_error}")
    return _back("members", f"Added “{feed.label}” and loaded {count} events.")


@router.post("/feeds/refresh")
def feeds_refresh(_: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    result = feeds.fetch_all(db)
    failed = db.query(CalendarFeed).filter(CalendarFeed.enabled.is_(True), CalendarFeed.last_error.is_not(None)).count()
    if failed:
        return _back("members", err=f"Refreshed {len(result)} calendars; {failed} had a problem (see below).")
    return _back("members", f"Refreshed {len(result)} calendars.")


@router.post("/feeds/{feed_id}")
def feed_update(feed_id: int, label: str = Form(...), busy_only: str = Form(""), chime: str = Form(""),
                enabled: str = Form(""), _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    feed = db.get(CalendarFeed, feed_id)
    if feed is not None:
        feed.label, feed.busy_only, feed.chime, feed.enabled = label.strip(), busy_only == "1", chime == "1", enabled == "1"
        db.commit()
    return _back("members", "Calendar settings saved.")


@router.post("/feeds/{feed_id}/delete")
def feed_delete(feed_id: int, _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    feed = db.get(CalendarFeed, feed_id)
    if feed is not None:
        db.delete(feed)
        db.commit()
    return _back("members", "Calendar removed.")


# ---------------------------------------------------------------- routines

@router.get("/routines")
def routines_page(request: Request, _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    acts = db.query(RecurringActivity).order_by(RecurringActivity.active.desc(), RecurringActivity.title).all()
    today = today_local()
    return templates.TemplateResponse(request, "settings/routines.html", _ctx(request, db, "routines", acts=acts, weekday_names=WEEKDAY_NAMES, today=today))


@router.post("/routines/{rid}/active")
def routine_active(rid: int, active: str = Form(...), _: None = Depends(require_parent_page),
                   db: Session = Depends(get_db)):
    act = db.get(RecurringActivity, rid)
    if act is not None:
        act.active = active == "1"
        db.commit()
    return _back("routines", ("Resumed " if active == "1" else "Paused ") + f"“{act.title}”." if act else None)


@router.post("/routines/{rid}/delete")
def routine_delete(rid: int, _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    act = db.get(RecurringActivity, rid)
    if act is not None:
        title = act.title
        db.delete(act)
        db.commit()
        return _back("routines", f"Deleted “{title}” and all its weeks.")
    return _back("routines")


# ---------------------------------------------------------------- display, chimes, check-in

DISPLAY_FIELDS = [
    "family_name", "display_start_hour", "display_end_hour", "week_starts_on", "week_layout",
    "display_rotate_seconds", "night_dim_start", "night_dim_end", "default_task_time",
    "checkin_lookback_days", "chime_volume", "quiet_start", "quiet_end", "feed_poll_minutes",
    "feed_window_months",
]
DISPLAY_CHECKBOXES = ["checkin_on_display", "chime_enabled", "chime_google_events"]


@router.get("/display")
def display_page(request: Request, _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    return templates.TemplateResponse(request, "settings/display.html", _ctx(request, db, "display", s=all_settings(db)))


@router.post("/display")
async def display_save(request: Request, _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    form = await request.form()
    for key in DISPLAY_FIELDS:
        if key in form:
            set_setting(db, key, str(form[key]).strip())
    for key in DISPLAY_CHECKBOXES:
        set_setting(db, key, "1" if form.get(key) == "1" else "0")
    set_setting(db, "display_rotate_views", ",".join(v for v in ("day", "week", "month") if form.get(f"rotate_{v}") == "1"))
    start, end = int(form.get("display_start_hour", 6)), int(form.get("display_end_hour", 21))
    if not 0 <= start < end <= 24:
        db.rollback()
        return _back("display", err="The day view's last hour must be after its first hour.")
    db.commit()
    return _back("display", "Saved. The wall display picks this up within a minute.")


# ---------------------------------------------------------------- pocket money PIN

@router.get("/money")
def money_page(request: Request, _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    return templates.TemplateResponse(request, "settings/money.html", _ctx(request, db, "money", pin_set=money.pin_is_set(db)))


@router.post("/money/pin")
def money_pin(pin: str = Form(...), pin2: str = Form(...), _: None = Depends(require_parent_page),
              db: Session = Depends(get_db)):
    if pin != pin2:
        return _back("money", err="The two PINs don't match.")
    try:
        money.set_pin(db, pin)
    except ServiceError as exc:
        return _back("money", err=str(exc))
    db.commit()
    return _back("money", "Parent PIN saved.")


# ---------------------------------------------------------------- backup

@router.get("/backup")
def backup_page(request: Request, _: None = Depends(require_parent_page), db: Session = Depends(get_db)):
    pre = sorted((p.name for p in BACKUPS_DIR.glob("pre-restore-*.db")), reverse=True) if BACKUPS_DIR.exists() else []
    return templates.TemplateResponse(request, "settings/backup.html", _ctx(request, db, "backup", pre_restore_backups=pre))


@router.get("/backup/download")
def backup_download(_: None = Depends(require_parent_page)):
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    return FileResponse(DATABASE_PATH, filename=f"devine_family_planner_backup_{timestamp}.db",
                        media_type="application/octet-stream")


def _is_valid_db(path: Path) -> bool:
    try:
        with sqlite3.connect(path) as conn:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {"members", "events", "recurring_activities"} <= tables
    except sqlite3.DatabaseError:
        return False


@router.post("/backup/restore")
async def backup_restore(backup_file: UploadFile, _: None = Depends(require_parent_page),
                         db: Session = Depends(get_db)):
    BACKUPS_DIR.mkdir(exist_ok=True)
    tmp = BACKUPS_DIR / "upload-in-progress.db"
    with tmp.open("wb") as f:
        shutil.copyfileobj(backup_file.file, f)
    if not _is_valid_db(tmp):
        tmp.unlink(missing_ok=True)
        return _back("backup", err="That file isn't a Devine Family Planner backup. Nothing was changed.")
    # Keep a copy of what's about to be replaced, so a mistaken restore can be undone.
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    shutil.copy2(DATABASE_PATH, BACKUPS_DIR / f"pre-restore-{timestamp}.db")
    db.close()
    engine.dispose()
    try:
        shutil.move(str(tmp), DATABASE_PATH)
    except OSError:
        logger.exception("Failed to move restored database into place")
        return _back("backup", err="The restore failed while copying the file. Nothing was changed.")
    return _back("backup", "Restored.")
