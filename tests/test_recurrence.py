import datetime

from app.models import OccurrenceOverride, RecurringActivity
from app.occurrences import build_items, occurrence_dates

D = datetime.date


def make(db, **kw):
    defaults = dict(title="Swim", weekdays="1,4", start_time=datetime.time(16), end_time=datetime.time(17),
                    anchor_date=D(2026, 10, 5), valid_from=D(2026, 10, 5), is_everyone=True)
    defaults.update(kw)
    act = RecurringActivity(**defaults)
    db.add(act)
    db.commit()
    return act


def test_weekly_dates(db):
    act = make(db)
    assert occurrence_dates(act, D(2026, 10, 12), D(2026, 10, 18)) == [D(2026, 10, 13), D(2026, 10, 16)]


def test_fortnightly_parity_and_range(db):
    act = make(db, weekdays="3", interval_weeks=2, valid_until=D(2026, 11, 30))
    dates = occurrence_dates(act, D(2026, 10, 1), D(2026, 12, 31))
    assert dates == [D(2026, 10, 8), D(2026, 10, 22), D(2026, 11, 5), D(2026, 11, 19)]


def test_not_before_valid_from(db):
    act = make(db, valid_from=D(2026, 10, 14))
    assert occurrence_dates(act, D(2026, 10, 12), D(2026, 10, 18)) == [D(2026, 10, 16)]


def test_skip_and_move_overrides(db):
    act = make(db)
    db.add(OccurrenceOverride(recurring_id=act.id, original_date=D(2026, 10, 13), action="skip"))
    db.add(OccurrenceOverride(recurring_id=act.id, original_date=D(2026, 10, 16), action="modify",
                              new_date=D(2026, 10, 17), new_start_time=datetime.time(9), new_end_time=datetime.time(10)))
    db.commit()
    now = datetime.datetime(2026, 10, 1)
    items = build_items(db, D(2026, 10, 12), D(2026, 10, 18), now)
    assert [(i["date"], i["start"]) for i in items] == [("2026-10-17", "09:00")]
    assert items[0]["key"] == f"r{act.id}_20261016"


def test_moved_in_from_outside_range(db):
    act = make(db)
    db.add(OccurrenceOverride(recurring_id=act.id, original_date=D(2026, 10, 16), action="modify",
                              new_date=D(2026, 10, 19)))
    db.commit()
    items = build_items(db, D(2026, 10, 19), D(2026, 10, 19), datetime.datetime(2026, 10, 1))
    assert len(items) == 1 and items[0]["original_date"] == "2026-10-16"


def test_needs_checkin_only_for_past_flexible(db):
    make(db, kind="flexible")
    now = datetime.datetime(2026, 10, 16, 16, 30)
    items = build_items(db, D(2026, 10, 13), D(2026, 10, 16), now)
    flags = {i["date"]: (i["past"], i["needs_checkin"]) for i in items}
    assert flags == {"2026-10-13": (True, True), "2026-10-16": (False, False)}
