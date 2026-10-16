"""JSON API used by the calendar, wall display and check-in pages.

There are no logins: everything here is open to the home network (spec §6.1).
Pocket money parent actions live in routers/money.py behind the parent PIN.
"""

import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.models import (
    KIND_FIXED,
    KIND_FLEXIBLE,
    TASK_DONE,
    Event,
    Member,
    OccurrenceOverride,
    RecurringActivity,
    Task,
    TaskFolder,
)
from app.occurrences import build_items, occurs_on
from app.services import (
    ServiceError,
    active_members,
    answer_checkin,
    checkin_queue,
    get_or_create_override,
    members_by_ids,
    schedule_task,
    set_task_done,
    split_series,
    task_dict,
    unschedule_task,
)
from app.settings_store import public_settings
from app.timeutil import now_local, parse_date, parse_time

router = APIRouter(prefix="/api")

MAX_RANGE_DAYS = 120


def bad(message: str, code: int = 400):
    raise HTTPException(status_code=code, detail=message)


def member_dict(m: Member) -> dict:
    return {"id": m.id, "name": m.name, "short_label": m.short_label or m.name[:1],
            "color": m.color_hex, "chime_sound": m.chime_sound}


# ---------------------------------------------------------------- reads

@router.get("/calendar")
def calendar(start: str, end: str, db: Session = Depends(get_db)):
    s, e = parse_date(start), parse_date(end)
    if s is None or e is None or e < s:
        bad("Give a start and end date.")
    if (e - s).days > MAX_RANGE_DAYS:
        bad(f"Ask for at most {MAX_RANGE_DAYS} days at a time.")
    now = now_local()
    return {
        "now": now.isoformat(timespec="minutes"),
        "settings": public_settings(db),
        "members": [member_dict(m) for m in active_members(db)],
        "items": build_items(db, s, e, now),
        "checkin_count": len(checkin_queue(db, now)),
    }


@router.get("/tasks")
def list_tasks(db: Session = Depends(get_db)):
    now = now_local()
    folders = (
        db.query(TaskFolder)
        .options(selectinload(TaskFolder.tasks).selectinload(Task.events).selectinload(Event.members))
        .order_by(TaskFolder.sort_order, TaskFolder.id)
        .all()
    )
    return {"folders": [
        {"id": f.id, "name": f.name, "color": f.color_hex,
         "tasks": [task_dict(t, now) for t in f.tasks]}
        for f in folders
    ]}


@router.get("/checkin")
def get_checkin(db: Session = Depends(get_db)):
    return {"members": [member_dict(m) for m in active_members(db)], "items": checkin_queue(db)}


# ---------------------------------------------------------------- check-in (no login)

class CheckinAnswer(BaseModel):
    member_id: int | None = None
    answer: Literal["done", "underway", "reschedule"]
    new_date: str | None = None
    new_time: str | None = None
    skip_week: bool = False


@router.post("/checkin/{key}")
def post_checkin(key: str, body: CheckinAnswer, db: Session = Depends(get_db)):
    try:
        msg = answer_checkin(db, key, member_id=body.member_id, answer=body.answer,
                             new_date=parse_date(body.new_date), new_time=parse_time(body.new_time),
                             skip_week=body.skip_week)
    except ServiceError as exc:
        db.rollback()
        bad(str(exc))
    db.commit()
    return {"ok": True, "message": msg}


# ---------------------------------------------------------------- tasks: wall-safe actions

class DoneBody(BaseModel):
    done: bool = True
    member_id: int | None = None


@router.post("/tasks/{task_id}/done")
def task_done(task_id: int, body: DoneBody, db: Session = Depends(get_db)):
    task = db.get(Task, task_id) or bad("That task no longer exists.", 404)
    set_task_done(db, task, body.done, body.member_id)
    db.commit()
    return task_dict(task)


class ScheduleBody(BaseModel):
    member_ids: list[int] = []
    everyone: bool = False
    date: str
    start: str | None = None
    minutes: int | None = Field(default=None, ge=5, le=24 * 60)
    all_day: bool = False


@router.post("/tasks/{task_id}/schedule")
def task_schedule(task_id: int, body: ScheduleBody, db: Session = Depends(get_db)):
    task = db.get(Task, task_id) or bad("That task no longer exists.", 404)
    try:
        schedule_task(db, task, member_ids=body.member_ids, everyone=body.everyone,
                      date=parse_date(body.date), start=parse_time(body.start), minutes=body.minutes,
                      all_day=body.all_day)
    except ServiceError as exc:
        db.rollback()
        bad(str(exc))
    db.commit()
    db.refresh(task)
    return task_dict(task)


# ---------------------------------------------------------------- tasks & folders: editing (login)

class FolderBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    color: str | None = None
    sort_order: int | None = None


@router.post("/folders")
def create_folder(body: FolderBody, db: Session = Depends(get_db)):
    if not body.name:
        bad("Give the folder a name.")
    top = db.query(TaskFolder).order_by(TaskFolder.sort_order.desc()).first()
    f = TaskFolder(name=body.name.strip(), color_hex=body.color, sort_order=(top.sort_order + 1) if top else 0)
    db.add(f)
    db.commit()
    return {"id": f.id}


@router.patch("/folders/{folder_id}")
def update_folder(folder_id: int, body: FolderBody, db: Session = Depends(get_db)):
    f = db.get(TaskFolder, folder_id) or bad("That folder no longer exists.", 404)
    if body.name is not None:
        f.name = body.name.strip()
    if body.color is not None:
        f.color_hex = body.color or None
    if body.sort_order is not None:
        f.sort_order = body.sort_order
    db.commit()
    return {"ok": True}


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: int, db: Session = Depends(get_db)):
    f = db.get(TaskFolder, folder_id) or bad("That folder no longer exists.", 404)
    if any(t.status != TASK_DONE for t in f.tasks):
        bad("Move or finish the tasks in this folder before deleting it.")
    db.delete(f)
    db.commit()
    return {"ok": True}


class TaskBody(BaseModel):
    folder_id: int | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = None
    kind: Literal["fixed", "flexible"] | None = None
    default_member_id: int | None = None
    est_duration_minutes: int | None = Field(default=None, ge=5, le=24 * 60)


@router.post("/tasks")
def create_task(body: TaskBody, db: Session = Depends(get_db)):
    if not body.title or not body.folder_id:
        bad("Give the task a title and a folder.")
    folder = db.get(TaskFolder, body.folder_id) or bad("That folder no longer exists.", 404)
    t = Task(folder=folder, title=body.title.strip(), notes=body.notes or "",
             kind=body.kind or KIND_FLEXIBLE, default_member_id=body.default_member_id,
             est_duration_minutes=body.est_duration_minutes or 60, sort_order=-1)
    db.add(t)
    db.flush()
    for i, task in enumerate(sorted(folder.tasks, key=lambda x: x.sort_order)):
        task.sort_order = i
    db.commit()
    return task_dict(t)


@router.patch("/tasks/{task_id}")
def update_task(task_id: int, body: TaskBody, db: Session = Depends(get_db)):
    t = db.get(Task, task_id) or bad("That task no longer exists.", 404)
    data = body.model_dump(exclude_unset=True)
    if "folder_id" in data:
        db.get(TaskFolder, data["folder_id"]) or bad("That folder no longer exists.", 404)
    for field, value in data.items():
        setattr(t, field, value.strip() if isinstance(value, str) and field == "title" else value)
    # Keep the calendar copy's title/kind in step with the task.
    for ev in t.events:
        if ev.check_status is None:
            ev.title, ev.kind = t.title, t.kind
    db.commit()
    return task_dict(t)


@router.delete("/tasks/{task_id}")
def delete_task(task_id: int, db: Session = Depends(get_db)):
    t = db.get(Task, task_id) or bad("That task no longer exists.", 404)
    for ev in t.events:
        if ev.check_status is None:
            db.delete(ev)
    db.delete(t)
    db.commit()
    return {"ok": True}


@router.post("/tasks/{task_id}/unschedule")
def task_unschedule(task_id: int, db: Session = Depends(get_db)):
    t = db.get(Task, task_id) or bad("That task no longer exists.", 404)
    unschedule_task(db, t)
    db.commit()
    db.refresh(t)
    return task_dict(t)


class ReorderBody(BaseModel):
    folder_id: int
    task_ids: list[int]


@router.post("/tasks/reorder")
def reorder_tasks(body: ReorderBody, db: Session = Depends(get_db)):
    db.get(TaskFolder, body.folder_id) or bad("That folder no longer exists.", 404)
    tasks = {t.id: t for t in db.query(Task).filter(Task.id.in_(body.task_ids)).all()}
    for i, tid in enumerate(body.task_ids):
        if tid in tasks:
            tasks[tid].folder_id = body.folder_id
            tasks[tid].sort_order = i
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- events & recurring (login)

class RepeatBody(BaseModel):
    weekdays: list[int] = Field(min_length=1)
    interval_weeks: int = Field(default=1, ge=1, le=8)
    valid_until: str | None = None


class ItemBody(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = None
    location: str | None = None
    date: str | None = None
    end_date: str | None = None
    start: str | None = None
    end: str | None = None
    all_day: bool | None = None
    everyone: bool | None = None
    member_ids: list[int] | None = None
    kind: Literal["fixed", "flexible"] | None = None
    chime: Literal["default", "on", "off"] | None = None
    remind_minutes: int | None = Field(default=None, ge=0, le=24 * 60)
    repeat: RepeatBody | None = None
    # recurring edits only
    scope: Literal["this", "future", "all"] | None = None
    original_date: str | None = None


def _times(data: dict, all_day: bool, cur_start=None, cur_end=None):
    if all_day:
        return None, None
    start = parse_time(data["start"]) if "start" in data else cur_start
    end = parse_time(data["end"]) if "end" in data else cur_end
    if start is None:
        bad("Give a start time, or make it all day.")
    if end is None:
        end = (datetime.datetime.combine(datetime.date.today(), start) + datetime.timedelta(hours=1)).time()
    if end <= start:
        bad("The end time must be after the start time.")
    return start, end


def _who(db: Session, data: dict, cur_everyone=False, cur_members=None):
    everyone = data.get("everyone", cur_everyone) or False
    ids = data.get("member_ids")
    members = [] if everyone else (members_by_ids(db, ids) if ids is not None else (cur_members or []))
    if not everyone and not members:
        bad("Choose who this is for, or pick Everyone.")
    return everyone, members


@router.post("/events")
def create_item(body: ItemBody, db: Session = Depends(get_db)):
    data = body.model_dump(exclude_unset=True)
    if not body.title or not body.date:
        bad("Give it a title and a date.")
    date = parse_date(body.date)
    all_day = bool(body.all_day)
    start, end = _times(data, all_day)
    try:
        everyone, members = _who(db, data)
    except ServiceError as exc:
        bad(str(exc))
    common = dict(title=body.title.strip(), notes=body.notes or "", location=body.location or "",
                  start_time=start, end_time=end, all_day=all_day, is_everyone=everyone,
                  kind=body.kind or KIND_FIXED, chime=body.chime or "default",
                  remind_minutes=body.remind_minutes or None)
    if body.repeat:
        act = RecurringActivity(weekdays=",".join(str(d) for d in sorted(set(body.repeat.weekdays))),
                                interval_weeks=body.repeat.interval_weeks, anchor_date=date, valid_from=date,
                                valid_until=parse_date(body.repeat.valid_until), **common)
        act.members = members
        db.add(act)
        db.commit()
        return {"key": None, "recurring_id": act.id}
    end_date = parse_date(body.end_date)
    if end_date and end_date < date:
        bad("The last day can't be before the first day.")
    ev = Event(date=date, end_date=end_date if end_date and end_date != date else None, **common)
    ev.members = members
    db.add(ev)
    db.commit()
    return {"key": f"e{ev.id}", "event_id": ev.id}


@router.patch("/events/{event_id}")
def update_event(event_id: int, body: ItemBody, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id) or bad("That item no longer exists.", 404)
    data = body.model_dump(exclude_unset=True)
    if body.repeat:
        # Turning a one-off into a weekly routine.
        if ev.task_id:
            bad("Items from the task list can't repeat. Make a new repeating item instead.")
        merged = {
            "title": ev.title, "notes": ev.notes, "location": ev.location, "date": ev.date.isoformat(),
            "start": ev.start_time.strftime("%H:%M") if ev.start_time else None,
            "end": ev.end_time.strftime("%H:%M") if ev.end_time else None, "all_day": ev.all_day,
            "everyone": ev.is_everyone, "member_ids": [m.id for m in ev.members], "kind": ev.kind,
            "chime": ev.chime, "remind_minutes": ev.remind_minutes,
        }
        merged.update({k: v for k, v in data.items() if k not in ("scope", "original_date")})
        db.delete(ev)
        db.flush()
        return create_item(ItemBody(**merged), db)
    if "title" in data:
        ev.title = data["title"].strip()
    for field in ("notes", "location", "kind", "chime"):
        if field in data and data[field] is not None:
            setattr(ev, field, data[field])
    if "remind_minutes" in data:
        ev.remind_minutes = data["remind_minutes"] or None
    if "date" in data:
        new_date = parse_date(data["date"])
        if ev.end_date:  # keep a multi-day item's length when it's dragged
            ev.end_date = ev.end_date + (new_date - ev.date)
        ev.date = new_date
    if "end_date" in data:
        end_date = parse_date(data["end_date"])
        if end_date and end_date < ev.date:
            bad("The last day can't be before the first day.")
        ev.end_date = end_date if end_date and end_date != ev.date else None
    all_day = data.get("all_day", ev.all_day)
    if any(k in data for k in ("start", "end", "all_day")):
        ev.start_time, ev.end_time = _times(data, all_day, ev.start_time, ev.end_time)
        ev.all_day = all_day
    if "everyone" in data or "member_ids" in data:
        try:
            ev.is_everyone, ev.members = _who(db, data, ev.is_everyone, list(ev.members))
        except ServiceError as exc:
            bad(str(exc))
    if ev.task is not None:
        ev.task.title = ev.title
        ev.task.kind = ev.kind
    db.commit()
    return {"ok": True}


@router.delete("/events/{event_id}")
def delete_event(event_id: int, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id) or bad("That item no longer exists.", 404)
    task = ev.task
    db.delete(ev)
    db.flush()
    if task is not None and task.status != TASK_DONE:
        db.refresh(task)
        task.status = "scheduled" if any(e.check_status is None for e in task.events) else "open"
    db.commit()
    return {"ok": True}


def _shift_weekdays(act: RecurringActivity, delta_days: int) -> None:
    if delta_days % 7:
        act.weekdays = ",".join(str(d) for d in sorted({(d + delta_days) % 7 for d in act.weekday_list}))


def _apply_series(db: Session, act: RecurringActivity, data: dict, original: datetime.date) -> None:
    if "title" in data:
        act.title = data["title"].strip()
    for field in ("notes", "location", "kind", "chime"):
        if field in data and data[field] is not None:
            setattr(act, field, data[field])
    if "remind_minutes" in data:
        act.remind_minutes = data["remind_minutes"] or None
    if "date" in data and data["date"]:
        delta = (parse_date(data["date"]) - original).days
        if delta and not data.get("repeat"):
            _shift_weekdays(act, delta)
    all_day = data.get("all_day", act.all_day)
    if any(k in data for k in ("start", "end", "all_day")):
        act.start_time, act.end_time = _times(data, all_day, act.start_time, act.end_time)
        act.all_day = all_day
    if "everyone" in data or "member_ids" in data:
        try:
            act.is_everyone, act.members = _who(db, data, act.is_everyone, list(act.members))
        except ServiceError as exc:
            bad(str(exc))
    if data.get("repeat"):
        rep = data["repeat"]
        act.weekdays = ",".join(str(d) for d in sorted(set(rep["weekdays"])))
        act.interval_weeks = rep.get("interval_weeks", 1)
        act.valid_until = parse_date(rep.get("valid_until"))


@router.patch("/recurring/{rid}")
def update_recurring(rid: int, body: ItemBody, db: Session = Depends(get_db)):
    act = db.get(RecurringActivity, rid) or bad("That routine no longer exists.", 404)
    data = body.model_dump(exclude_unset=True)
    scope = body.scope or "all"
    original = parse_date(body.original_date)
    if scope in ("this", "future") and (original is None or not occurs_on(act, original)):
        bad("Say which day you're changing.")

    if scope == "this":
        if any(k in data for k in ("member_ids", "everyone", "repeat", "kind", "all_day")):
            bad("Who it's for, repeats and type can only be changed for this and future weeks, or all weeks.")
        ov = get_or_create_override(db, act, original)
        ov.action = "modify"
        if "date" in data:
            ov.new_date = parse_date(data["date"])
        if not act.all_day and ("start" in data or "end" in data):
            cur_start = ov.new_start_time or act.start_time
            cur_end = ov.new_end_time or act.end_time
            ov.new_start_time, ov.new_end_time = _times(data, False, cur_start, cur_end)
        if "title" in data:
            ov.new_title = data["title"].strip()
        if "notes" in data:
            ov.new_notes = data["notes"]
        db.commit()
        return {"ok": True}

    if scope == "future":
        target = split_series(db, act, original)
        _apply_series(db, target, data, original)
        db.commit()
        return {"ok": True, "recurring_id": target.id}

    _apply_series(db, act, data, original or act.valid_from)
    if "date" in data and original:
        # Moving the whole series by dragging one occurrence: drop that
        # occurrence's own move/skip so it follows the series.
        db.query(OccurrenceOverride).filter(OccurrenceOverride.recurring_id == act.id,
                                            OccurrenceOverride.original_date == original,
                                            OccurrenceOverride.check_status.is_(None)).delete()
    db.commit()
    return {"ok": True}


@router.post("/recurring/{rid}/active")
def set_recurring_active(rid: int, active: bool, db: Session = Depends(get_db)):
    act = db.get(RecurringActivity, rid) or bad("That routine no longer exists.", 404)
    act.active = active
    db.commit()
    return {"ok": True}


@router.delete("/recurring/{rid}")
def delete_recurring(rid: int, scope: Literal["this", "future", "all"] = "all", original_date: str | None = None,
                     db: Session = Depends(get_db)):
    act = db.get(RecurringActivity, rid) or bad("That routine no longer exists.", 404)
    original = parse_date(original_date)
    if scope == "all":
        db.delete(act)
    elif original is None or not occurs_on(act, original):
        bad("Say which day you're deleting.")
    elif scope == "this":
        ov = get_or_create_override(db, act, original)
        ov.action = "skip"
    else:
        if original <= act.valid_from:
            db.delete(act)
        else:
            act.valid_until = original - datetime.timedelta(days=1)
    db.commit()
    return {"ok": True}


@router.get("/recurring")
def list_recurring(db: Session = Depends(get_db)):
    acts = db.query(RecurringActivity).order_by(RecurringActivity.title).all()
    return [{"id": a.id, "title": a.title, "weekdays": a.weekday_list, "start": a.start_time and a.start_time.strftime("%H:%M"),
             "active": a.active} for a in acts]

