"""Builds the merged list of calendar items for a date range.

One-off events, expanded recurring activities and cached Google events all
come out of `build_items()` in the same shape, so the day, week, month,
display and check-in code only ever deal with one kind of thing.
"""

import datetime

from sqlalchemy import or_
from sqlalchemy.orm import Session, selectinload

from app.models import (
    KIND_FLEXIBLE,
    CalendarFeed,
    Event,
    ExternalEvent,
    Member,
    OccurrenceOverride,
    RecurringActivity,
)
from app.settings_store import get_setting
from app.timeutil import fmt_time, now_local

ONE_DAY = datetime.timedelta(days=1)


def _monday(d: datetime.date) -> datetime.date:
    return d - datetime.timedelta(days=d.weekday())


def occurs_on(act: RecurringActivity, d: datetime.date) -> bool:
    """Does the weekly rule (ignoring overrides) produce an occurrence on this date?"""
    if d < act.valid_from or (act.valid_until and d > act.valid_until):
        return False
    if d.weekday() not in act.weekday_list:
        return False
    weeks = (_monday(d) - _monday(act.anchor_date)).days // 7
    return weeks % max(act.interval_weeks, 1) == 0


def occurrence_dates(act: RecurringActivity, start: datetime.date, end: datetime.date) -> list[datetime.date]:
    first = max(start, act.valid_from)
    last = min(end, act.valid_until) if act.valid_until else end
    out = []
    d = first
    while d <= last:
        if occurs_on(act, d):
            out.append(d)
        d += ONE_DAY
    return out


def _chime_flag(setting: str, all_day: bool) -> bool:
    if all_day:
        return False
    return setting != "off"


def _end_dt(date: datetime.date, end_date: datetime.date | None, end_time: datetime.time | None,
            all_day: bool) -> datetime.datetime:
    last = end_date or date
    if all_day or end_time is None:
        return datetime.datetime.combine(last + ONE_DAY, datetime.time())
    return datetime.datetime.combine(last, end_time)


def _finish(item: dict, now: datetime.datetime) -> dict:
    end = _end_dt(
        datetime.date.fromisoformat(item["date"]),
        datetime.date.fromisoformat(item["end_date"]) if item.get("end_date") else None,
        datetime.time.fromisoformat(item["end"]) if item.get("end") else None,
        item["all_day"],
    )
    item["past"] = end <= now
    # Paid jobs are approved on the Money tab instead of in check-in.
    item["needs_checkin"] = (
        item["kind"] == KIND_FLEXIBLE and item["past"] and not item.get("check_status") and not item["read_only"]
        and not item.get("money_job_id")
    )
    return item


def event_item(ev: Event, now: datetime.datetime) -> dict:
    return _finish(
        {
            "key": f"e{ev.id}",
            "source": "event",
            "event_id": ev.id,
            "task_id": ev.task_id,
            "money_job_id": ev.money_job_id,
            "money_cents": ev.money_job.amount_cents if ev.money_job else None,
            "title": ev.title,
            "notes": ev.notes,
            "location": ev.location,
            "date": ev.date.isoformat(),
            "end_date": ev.end_date.isoformat() if ev.end_date and ev.end_date != ev.date else None,
            "start": None if ev.all_day else fmt_time(ev.start_time),
            "end": None if ev.all_day else fmt_time(ev.end_time),
            "all_day": ev.all_day,
            "everyone": ev.is_everyone,
            "member_ids": [] if ev.is_everyone else [m.id for m in ev.members],
            "kind": ev.kind,
            "check_status": ev.check_status,
            "chime": _chime_flag(ev.chime, ev.all_day),
            "chime_setting": ev.chime,
            "remind_minutes": ev.remind_minutes,
            "read_only": False,
        },
        now,
    )


def recurring_item(act: RecurringActivity, original: datetime.date, ov: OccurrenceOverride | None,
                   now: datetime.datetime) -> dict | None:
    if ov is not None and ov.action == "skip":
        return None
    moved = ov is not None and ov.action == "modify"
    date = ov.new_date if moved and ov.new_date else original
    start = ov.new_start_time if moved and ov.new_start_time else act.start_time
    end = ov.new_end_time if moved and ov.new_end_time else act.end_time
    return _finish(
        {
            "key": f"r{act.id}_{original:%Y%m%d}",
            "source": "recurring",
            "recurring_id": act.id,
            "original_date": original.isoformat(),
            "title": (ov.new_title if moved and ov.new_title else act.title),
            "notes": (ov.new_notes if moved and ov.new_notes is not None else act.notes),
            "location": act.location,
            "date": date.isoformat(),
            "end_date": None,
            "start": None if act.all_day else fmt_time(start),
            "end": None if act.all_day else fmt_time(end),
            "all_day": act.all_day,
            "everyone": act.is_everyone,
            "member_ids": [] if act.is_everyone else [m.id for m in act.members],
            "kind": act.kind,
            "check_status": ov.check_status if ov else None,
            "chime": _chime_flag(act.chime, act.all_day),
            "chime_setting": act.chime,
            "remind_minutes": act.remind_minutes,
            "read_only": False,
            "moved": moved,
            "repeat": {
                "weekdays": act.weekday_list,
                "interval_weeks": act.interval_weeks,
                "valid_from": act.valid_from.isoformat(),
                "valid_until": act.valid_until.isoformat() if act.valid_until else None,
            },
        },
        now,
    )


def external_item(x: ExternalEvent, feed: CalendarFeed, chime_google: bool, now: datetime.datetime) -> dict:
    start_date = x.start_at.date()
    if x.all_day:
        last = (x.end_at - ONE_DAY).date() if x.end_at > x.start_at else start_date
    else:
        last = x.end_at.date() if x.end_at.time() != datetime.time() else (x.end_at - ONE_DAY).date()
        last = max(last, start_date)
    multi_day_timed = not x.all_day and last != start_date
    return _finish(
        {
            "key": f"x{x.id}",
            "source": "external",
            "title": "Busy" if feed.busy_only else x.title,
            "notes": "",
            "location": "" if feed.busy_only else x.location,
            "date": start_date.isoformat(),
            "end_date": last.isoformat() if last != start_date else None,
            # Timed events that run past midnight are shown as all-day bars.
            "start": None if x.all_day or multi_day_timed else x.start_at.strftime("%H:%M"),
            "end": None if x.all_day or multi_day_timed else x.end_at.strftime("%H:%M"),
            "all_day": x.all_day or multi_day_timed,
            "everyone": False,
            "member_ids": [feed.member_id],
            "kind": "fixed",
            "check_status": None,
            "chime": (feed.chime or chime_google) and not x.all_day,
            "chime_setting": "on" if feed.chime else "default",
            "remind_minutes": None,
            "read_only": True,
            "feed_label": feed.label,
        },
        now,
    )


def build_items(db: Session, start: datetime.date, end: datetime.date,
                now: datetime.datetime | None = None) -> list[dict]:
    """All calendar items touching [start, end] (inclusive), sorted by date then time."""
    now = now or now_local()
    items: list[dict] = []

    events = (
        db.query(Event)
        .options(selectinload(Event.members), selectinload(Event.money_job))
        .filter(Event.date <= end)
        .filter(or_(Event.date >= start, Event.end_date >= start))
        .all()
    )
    items += [event_item(ev, now) for ev in events]

    acts = (
        db.query(RecurringActivity)
        .options(selectinload(RecurringActivity.members), selectinload(RecurringActivity.overrides))
        .filter(RecurringActivity.active.is_(True))
        .filter(RecurringActivity.valid_from <= end)
        .filter(or_(RecurringActivity.valid_until.is_(None), RecurringActivity.valid_until >= start))
        .all()
    )
    # Overrides can move an occurrence into this range from outside it, so a
    # second pass picks those up.
    moved_in = (
        db.query(OccurrenceOverride)
        .filter(OccurrenceOverride.action == "modify")
        .filter(OccurrenceOverride.new_date >= start, OccurrenceOverride.new_date <= end)
        .filter(or_(OccurrenceOverride.original_date < start, OccurrenceOverride.original_date > end))
        .all()
    )
    for act in acts:
        overrides = {ov.original_date: ov for ov in act.overrides}
        for d in occurrence_dates(act, start, end):
            item = recurring_item(act, d, overrides.get(d), now)
            if item and start.isoformat() <= item["date"] <= end.isoformat():
                items.append(item)
    for ov in moved_in:
        act = ov.activity
        if act.active and occurs_on(act, ov.original_date):
            item = recurring_item(act, ov.original_date, ov, now)
            if item:
                items.append(item)

    chime_google = get_setting(db, "chime_google_events") == "1"
    window_start = datetime.datetime.combine(start, datetime.time())
    window_end = datetime.datetime.combine(end + ONE_DAY, datetime.time())
    rows = (
        db.query(ExternalEvent, CalendarFeed)
        .join(CalendarFeed, ExternalEvent.feed_id == CalendarFeed.id)
        .join(Member, CalendarFeed.member_id == Member.id)
        .filter(CalendarFeed.enabled.is_(True), Member.active.is_(True))
        .filter(ExternalEvent.start_at < window_end, ExternalEvent.end_at > window_start)
        .all()
    )
    items += [external_item(x, feed, chime_google, now) for x, feed in rows]

    items.sort(key=lambda i: (i["date"], not i["all_day"], i["start"] or "", i["title"].lower()))
    return items
