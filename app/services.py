"""Business rules shared by the API routes: tasks, check-in and recurring edits."""

import datetime

from sqlalchemy.orm import Session

from app.models import (
    CHECK_DONE,
    CHECK_RESCHEDULED,
    CHECK_UNDERWAY,
    KIND_FLEXIBLE,
    TASK_DONE,
    TASK_OPEN,
    TASK_SCHEDULED,
    TASK_UNDERWAY,
    Event,
    Member,
    OccurrenceOverride,
    RecurringActivity,
    Task,
    TaskFolder,
    TaskLog,
)
from app.occurrences import build_items, occurs_on
from app.settings_store import get_int
from app.timeutil import add_minutes, human_when, minutes_between, now_local

RESCHEDULED_FOLDER = "Rescheduled"


class ServiceError(ValueError):
    """A request that breaks a rule; the message is shown to the user."""


def _dt(d: datetime.date | None, t: datetime.time | None) -> datetime.datetime | None:
    if d is None:
        return None
    return datetime.datetime.combine(d, t or datetime.time())


def log(db: Session, action: str, *, task_id=None, event_id=None, recurring_id=None, member_id=None,
        from_at=None, to_at=None, note: str = "") -> None:
    db.add(TaskLog(task_id=task_id, event_id=event_id, recurring_id=recurring_id, member_id=member_id,
                   action=action, from_at=from_at, to_at=to_at, note=note))


def active_members(db: Session) -> list[Member]:
    return db.query(Member).filter(Member.active.is_(True)).order_by(Member.sort_order, Member.id).all()


def members_by_ids(db: Session, ids: list[int]) -> list[Member]:
    if not ids:
        return []
    found = db.query(Member).filter(Member.id.in_(ids)).all()
    if len(found) != len(set(ids)):
        raise ServiceError("One of the chosen people no longer exists.")
    return sorted(found, key=lambda m: (m.sort_order, m.id))


# ---------------------------------------------------------------- tasks

def pending_event(task: Task) -> Event | None:
    """The task's current calendar slot: its latest event nobody has answered yet."""
    pending = [e for e in task.events if e.check_status is None]
    return pending[-1] if pending else None


def task_dict(task: Task, now: datetime.datetime | None = None) -> dict:
    now = now or now_local()
    ev = pending_event(task)
    needs_checkin = False
    when = None
    who = []
    if ev is not None and task.status != TASK_DONE:
        end = _dt(ev.date, ev.end_time) if ev.end_time else _dt(ev.date + datetime.timedelta(days=1), None)
        needs_checkin = task.kind == KIND_FLEXIBLE and end <= now
        when = human_when(ev.date, None if ev.all_day else ev.start_time)
        who = ["everyone"] if ev.is_everyone else [m.id for m in ev.members]
    return {
        "id": task.id,
        "folder_id": task.folder_id,
        "title": task.title,
        "notes": task.notes,
        "kind": task.kind,
        "status": task.status,
        "default_member_id": task.default_member_id,
        "est_duration_minutes": task.est_duration_minutes,
        "reschedule_count": task.reschedule_count,
        "underway": task.status == TASK_UNDERWAY or any(e.check_status == CHECK_UNDERWAY for e in task.events),
        "event_id": ev.id if ev else None,
        "when": when,
        "who": who,
        "needs_checkin": needs_checkin,
        "done_at": task.done_at.isoformat() if task.done_at else None,
    }


def schedule_task(db: Session, task: Task, *, member_ids: list[int], everyone: bool, date: datetime.date,
                  start: datetime.time | None, minutes: int | None = None, all_day: bool = False) -> Event:
    if task.status == TASK_DONE:
        raise ServiceError("That task is already done.")
    if not everyone and not member_ids:
        raise ServiceError("Choose who this is for.")
    # Re-scheduling a task that's already on the calendar moves it rather than duplicating it.
    old = pending_event(task)
    if old is not None:
        db.delete(old)
        db.flush()
        db.refresh(task)
    minutes = minutes or task.est_duration_minutes or 60
    ev = Event(
        title=task.title,
        notes=task.notes,
        date=date,
        all_day=all_day or start is None,
        start_time=None if all_day or start is None else start,
        end_time=None if all_day or start is None else add_minutes(start, minutes),
        is_everyone=everyone,
        kind=task.kind,
        task_id=task.id,
    )
    ev.members = [] if everyone else members_by_ids(db, member_ids)
    db.add(ev)
    task.status = TASK_SCHEDULED
    db.flush()
    log(db, "scheduled", task_id=task.id, event_id=ev.id, to_at=_dt(date, ev.start_time))
    return ev


def unschedule_task(db: Session, task: Task) -> None:
    ev = pending_event(task)
    if ev is None:
        return
    when = _dt(ev.date, ev.start_time)
    db.delete(ev)
    was_underway = any(e.check_status == CHECK_UNDERWAY for e in task.events if e is not ev)
    task.status = TASK_UNDERWAY if was_underway else TASK_OPEN
    log(db, "unscheduled", task_id=task.id, from_at=when)


def set_task_done(db: Session, task: Task, done: bool, member_id: int | None = None) -> None:
    if done:
        task.status = TASK_DONE
        task.done_at = now_local()
        # Ticking a task off also answers its calendar slot, so it shows ✓ and
        # never turns up in check-in.
        for ev in task.events:
            if ev.check_status is None:
                ev.check_status = CHECK_DONE
                ev.checked_at = task.done_at
                ev.checked_by_member_id = member_id
        log(db, "done", task_id=task.id, member_id=member_id)
    else:
        task.done_at = None
        last = task.events[-1] if task.events else None
        if last is not None and last.check_status == CHECK_DONE and last.checked_at:
            last.check_status = None
            last.checked_at = None
        task.status = TASK_SCHEDULED if pending_event(task) else TASK_OPEN
        log(db, "reopened", task_id=task.id, member_id=member_id)


def rescheduled_folder(db: Session) -> TaskFolder:
    folder = db.query(TaskFolder).filter(TaskFolder.name == RESCHEDULED_FOLDER).first()
    if folder is None:
        top = db.query(TaskFolder).order_by(TaskFolder.sort_order.desc()).first()
        folder = TaskFolder(name=RESCHEDULED_FOLDER, sort_order=(top.sort_order + 1) if top else 0)
        db.add(folder)
        db.flush()
    return folder


# ---------------------------------------------------------------- check-in

def checkin_queue(db: Session, now: datetime.datetime | None = None) -> list[dict]:
    """Past flexible items nobody has answered, oldest first, each with who can answer it."""
    now = now or now_local()
    lookback = get_int(db, "checkin_lookback_days")
    items = build_items(db, now.date() - datetime.timedelta(days=lookback), now.date(), now)
    all_ids = [m.id for m in active_members(db)]
    queue = []
    for item in items:
        if not item["needs_checkin"]:
            continue
        item["answer_member_ids"] = all_ids if item["everyone"] else [i for i in item["member_ids"] if i in all_ids]
        if item["answer_member_ids"]:
            queue.append(item)
    return queue


def _clone_event_at(db: Session, ev: Event, date: datetime.date, start: datetime.time | None) -> Event:
    length = minutes_between(ev.start_time, ev.end_time) if ev.start_time and ev.end_time else 60
    new = Event(
        title=ev.title, notes=ev.notes, location=ev.location, date=date,
        all_day=start is None,
        start_time=start,
        end_time=add_minutes(start, length) if start else None,
        is_everyone=ev.is_everyone, kind=ev.kind, chime=ev.chime, remind_minutes=ev.remind_minutes,
        task_id=ev.task_id,
    )
    new.members = list(ev.members)
    db.add(new)
    db.flush()
    return new


def answer_checkin(db: Session, key: str, *, member_id: int | None, answer: str,
                   new_date: datetime.date | None = None, new_time: datetime.time | None = None,
                   skip_week: bool = False) -> str:
    """Apply a check-in answer. Returns a short message for the toast."""
    if answer not in ("done", "underway", "reschedule"):
        raise ServiceError("Unknown answer.")
    now = now_local()
    if key.startswith("e"):
        return _answer_event(db, int(key[1:]), member_id, answer, new_date, new_time, now)
    if key.startswith("r"):
        rid, _, day = key[1:].partition("_")
        original = datetime.datetime.strptime(day, "%Y%m%d").date()
        return _answer_occurrence(db, int(rid), original, member_id, answer, new_date, new_time, skip_week, now)
    raise ServiceError("Google calendar events can't be checked in.")


def _answer_event(db, event_id, member_id, answer, new_date, new_time, now) -> str:
    ev = db.get(Event, event_id)
    if ev is None:
        raise ServiceError("That item no longer exists.")
    if ev.check_status is not None:
        raise ServiceError("Someone has already answered for that one.")
    task = ev.task
    ev.checked_at = now
    ev.checked_by_member_id = member_id
    planned = _dt(ev.date, ev.start_time)

    if answer == "done":
        ev.check_status = CHECK_DONE
        if task is not None:
            task.status = TASK_DONE
            task.done_at = now
        log(db, "done", task_id=ev.task_id, event_id=ev.id, member_id=member_id, from_at=planned)
        return "Marked done ✓"

    if answer == "underway":
        ev.check_status = CHECK_UNDERWAY
        if new_date:
            nxt = _clone_event_at(db, ev, new_date, new_time)
            if task is not None:
                task.status = TASK_SCHEDULED
            log(db, "underway", task_id=ev.task_id, event_id=nxt.id, member_id=member_id,
                from_at=planned, to_at=_dt(new_date, new_time))
            return f"Underway · next session {human_when(new_date, new_time)}"
        if task is None:
            task = _task_from_event(db, ev)
        task.status = TASK_UNDERWAY
        log(db, "underway", task_id=task.id, event_id=ev.id, member_id=member_id, from_at=planned)
        return "Underway · back in the task list"

    # reschedule
    ev.check_status = CHECK_RESCHEDULED
    if task is None:
        task = _task_from_event(db, ev)
    task.reschedule_count += 1
    if new_date:
        nxt = _clone_event_at(db, ev, new_date, new_time)
        task.status = TASK_SCHEDULED
        log(db, "rescheduled", task_id=task.id, event_id=nxt.id, member_id=member_id,
            from_at=planned, to_at=_dt(new_date, new_time))
        return f"Moved to {human_when(new_date, new_time)}"
    task.status = TASK_OPEN
    log(db, "rescheduled", task_id=task.id, event_id=ev.id, member_id=member_id, from_at=planned)
    return "Back in the task list"


def _task_from_event(db: Session, ev: Event) -> Task:
    """A flexible event made straight on the calendar has no task; make one so it can go back to the list."""
    folder = rescheduled_folder(db)
    length = minutes_between(ev.start_time, ev.end_time) if ev.start_time and ev.end_time else 60
    task = Task(folder=folder, title=ev.title, notes=ev.notes, kind=ev.kind,
                default_member_id=ev.members[0].id if ev.members else None,
                est_duration_minutes=max(length, 15), sort_order=len(folder.tasks))
    db.add(task)
    db.flush()
    ev.task_id = task.id
    return task


def _answer_occurrence(db, rid, original, member_id, answer, new_date, new_time, skip_week, now) -> str:
    act = db.get(RecurringActivity, rid)
    if act is None or not occurs_on(act, original):
        raise ServiceError("That item no longer exists.")
    ov = get_or_create_override(db, act, original)
    if ov.check_status is not None:
        raise ServiceError("Someone has already answered for that one.")
    planned = _dt(original, act.start_time)

    if answer == "done":
        ov.check_status, ov.checked_at, ov.checked_by_member_id = CHECK_DONE, now, member_id
        log(db, "done", recurring_id=act.id, member_id=member_id, from_at=planned)
        return "Marked done ✓"

    if answer == "underway":
        ov.check_status, ov.checked_at, ov.checked_by_member_id = CHECK_UNDERWAY, now, member_id
        if new_date:
            ev = Event(title=act.title, notes=act.notes, location=act.location, date=new_date,
                       all_day=new_time is None, start_time=new_time,
                       end_time=add_minutes(new_time, _act_minutes(act)) if new_time else None,
                       is_everyone=act.is_everyone, kind=act.kind, chime=act.chime)
            ev.members = list(act.members)
            db.add(ev)
            log(db, "underway", recurring_id=act.id, member_id=member_id, from_at=planned,
                to_at=_dt(new_date, new_time))
            return f"Underway · next session {human_when(new_date, new_time)}"
        log(db, "underway", recurring_id=act.id, member_id=member_id, from_at=planned)
        return "Marked underway"

    # reschedule: move just this occurrence, or skip it this week
    if skip_week or not new_date:
        ov.action = "skip"
        ov.check_status, ov.checked_at, ov.checked_by_member_id = CHECK_RESCHEDULED, now, member_id
        log(db, "skipped", recurring_id=act.id, member_id=member_id, from_at=planned)
        return "Skipped this week"
    ov.action = "modify"
    ov.new_date = new_date
    if new_time and not act.all_day:
        ov.new_start_time = new_time
        ov.new_end_time = add_minutes(new_time, _act_minutes(act))
    log(db, "moved", recurring_id=act.id, member_id=member_id, from_at=planned, to_at=_dt(new_date, new_time))
    return f"Moved to {human_when(new_date, new_time)}"


def _act_minutes(act: RecurringActivity) -> int:
    if act.start_time and act.end_time:
        return max(minutes_between(act.start_time, act.end_time), 15)
    return 60


# ---------------------------------------------------------------- recurring edits

def get_or_create_override(db: Session, act: RecurringActivity, original: datetime.date) -> OccurrenceOverride:
    ov = (
        db.query(OccurrenceOverride)
        .filter(OccurrenceOverride.recurring_id == act.id, OccurrenceOverride.original_date == original)
        .first()
    )
    if ov is None:
        ov = OccurrenceOverride(recurring_id=act.id, original_date=original, action="none")
        db.add(ov)
        db.flush()
    return ov


def split_series(db: Session, act: RecurringActivity, from_date: datetime.date) -> RecurringActivity:
    """End `act` the day before `from_date` and return a copy that starts on it ("all future" edits)."""
    if from_date <= act.valid_from:
        return act
    new = RecurringActivity(
        title=act.title, notes=act.notes, location=act.location, weekdays=act.weekdays,
        start_time=act.start_time, end_time=act.end_time, all_day=act.all_day,
        interval_weeks=act.interval_weeks, anchor_date=act.anchor_date,
        valid_from=from_date, valid_until=act.valid_until, is_everyone=act.is_everyone,
        active=act.active, kind=act.kind, chime=act.chime, remind_minutes=act.remind_minutes,
    )
    new.members = list(act.members)
    db.add(new)
    db.flush()
    for ov in list(act.overrides):
        if ov.original_date >= from_date:
            ov.recurring_id = new.id
    act.valid_until = from_date - datetime.timedelta(days=1)
    db.flush()
    db.expire(act, ["overrides"])
    return new
