"""Bootstrap the database: default task folders, and optionally an example family.

Usage:
    python -m app.seed                # empty app; set the parent PIN the first time you open Settings
    python -m app.seed --pin 4821     # also set the parent PIN now
    python -m app.seed --demo         # add an example family (parent PIN 1234 unless --pin is given)
"""

import argparse
import datetime

from app.database import Base, SessionLocal, add_missing_columns, engine
from app import money
from app.models import (
    Event,
    Member,
    MoneyJob,
    MoneyTxn,
    OccurrenceOverride,
    RecurringActivity,
    Task,
    TaskFolder,
)
from app.timeutil import today_local

DEFAULT_FOLDERS = ["House", "Garden", "Car", "Shopping", "Kids"]


def seed_folders(db) -> None:
    if db.query(TaskFolder).count():
        return
    for i, name in enumerate(DEFAULT_FOLDERS):
        db.add(TaskFolder(name=name, sort_order=i))
    db.commit()


def _t(s: str) -> datetime.time:
    return datetime.time.fromisoformat(s)


def seed_demo(db) -> None:
    if db.query(Member).count():
        print("Members already exist; skipping the demo family.")
        return
    mum = Member(name="Mum", short_label="M", color_hex="#DB2777", chime_sound="bells", sort_order=0)
    dad = Member(name="Dad", short_label="D", color_hex="#2563EB", chime_sound="dingdong", sort_order=1)
    sam = Member(name="Sam", short_label="S", color_hex="#65A30D", chime_sound="marimba", sort_order=2)
    ella = Member(name="Ella", short_label="E", color_hex="#7C3AED", chime_sound="chirp", sort_order=3)
    db.add_all([mum, dad, sam, ella])
    db.flush()

    today = today_local()
    monday = today - datetime.timedelta(days=today.weekday())
    term_start = monday - datetime.timedelta(days=7)

    def routine(title, days, start, end, who, everyone=False, kind="fixed", **kw):
        act = RecurringActivity(title=title, weekdays=",".join(map(str, days)), start_time=_t(start) if start else None,
                                end_time=_t(end) if end else None, all_day=start is None, anchor_date=term_start,
                                valid_from=term_start, is_everyone=everyone, kind=kind, **kw)
        act.members = who
        db.add(act)
        return act

    routine("School", [0, 1, 2, 3, 4], "08:45", "15:15", [sam, ella])
    routine("Swimming", [1, 4], "16:00", "17:00", [sam], location="Aquatic centre", remind_minutes=15)
    routine("Netball training", [2, 4], "16:30", "17:30", [ella], location="Netball courts", remind_minutes=10)
    dish = routine("Unload dishwasher", [0, 1, 2, 3, 4], "07:15", "07:45", [ella], kind="flexible")
    routine("Pizza & movie night", [4], "18:30", "20:30", [], everyone=True)
    routine("Bin night – yellow lid", [3], None, None, [], everyone=True, interval_weeks=2)
    db.flush()
    # Earlier dishwasher days (last week and this week) have been answered already.
    for i in range(7 + today.weekday()):
        d = term_start + datetime.timedelta(days=i)
        if d.weekday() < 5:
            db.add(OccurrenceOverride(recurring_id=dish.id, original_date=d, check_status="done"))

    def event(title, day_offset, start, end, who, everyone=False, **kw):
        ev = Event(title=title, date=today + datetime.timedelta(days=day_offset),
                   start_time=_t(start) if start else None, end_time=_t(end) if end else None,
                   all_day=start is None, is_everyone=everyone, **kw)
        ev.members = who
        db.add(ev)
        return ev

    event("Dentist", 0, "13:30", "14:30", [mum], location="Smile Dental, Main St")
    event("Nan's birthday lunch", 1, "12:00", "14:00", [], everyone=True)
    event("Soccer game", 1, "08:30", "09:30", [sam])
    event("Book club", 4, "19:30", "21:00", [mum])
    event("School camp", 5, None, None, [sam], end_date=today + datetime.timedelta(days=7))
    event("Weekend at the coast", 15, None, None, [], everyone=True, end_date=today + datetime.timedelta(days=16))

    folders = {f.name: f for f in db.query(TaskFolder).all()}

    def task(folder, title, kind="flexible", who=None, **kw):
        t = Task(folder=folders[folder], title=title, kind=kind, default_member_id=who.id if who else None,
                 sort_order=len(folders[folder].tasks), **kw)
        db.add(t)
        return t

    gutters = task("House", "Clean gutters", who=dad, est_duration_minutes=90)
    task("House", "Fix fly screen – back door", who=dad, reschedule_count=2)
    task("House", "Book carpet cleaner", kind="fixed")
    mow = task("Garden", "Mow front lawn", who=dad)
    task("Garden", "Prune roses")
    task("Car", "Rego renewal", kind="fixed")
    task("Car", "Wash the car", reschedule_count=1)
    task("Shopping", "New school shoes – Sam")
    task("Kids", "Cover school books", who=ella)
    camp = task("Kids", "Pack camp bag", who=sam)
    db.flush()

    # A couple of tasks already on the calendar: one coming up, two waiting for check-in.
    for t, offset, start, end, who in ((gutters, 0, "16:00", "17:30", dad), (mow, -2, "17:00", "18:00", dad),
                                       (camp, -1, "16:00", "16:30", sam)):
        t.status = "scheduled"
        ev = event(t.title, offset, start, end, [who], kind="flexible")
        ev.task = t
    # Pocket money: Sam and Ella have accounts, a few paid jobs, and parent PIN 1234.
    for kid, weekly in ((sam, 500), (ella, 400)):
        kid.is_child, kid.allowance_cents, kid.allowance_weekday = True, weekly, 5
        kid.allowance_since = today
    for i, (title, cents, mins) in enumerate((("Wash the car", 400, 60), ("Vacuum the lounge", 200, 30),
                                               ("Weed the front garden", 300, 45), ("Fold the washing", 150, 20))):
        db.add(MoneyJob(title=title, amount_cents=cents, est_minutes=mins, sort_order=i))
    db.add_all([
        MoneyTxn(member_id=sam.id, amount_cents=500, kind="income", description="Weekly pocket money",
                 period_date=today - datetime.timedelta(days=7)),
        MoneyTxn(member_id=sam.id, amount_cents=400, kind="job", description="Job: Wash the car"),
        MoneyTxn(member_id=sam.id, amount_cents=-100, kind="fine", description="Fine: Room not tidy"),
        MoneyTxn(member_id=ella.id, amount_cents=400, kind="income", description="Weekly pocket money",
                 period_date=today - datetime.timedelta(days=7)),
        MoneyTxn(member_id=ella.id, amount_cents=-300, kind="withdrawal", description="Withdrawal: Book fair"),
    ])
    demo_pin = not money.pin_is_set(db)
    if demo_pin:
        money.set_pin(db, "1234")
    db.commit()
    print("Added the demo family (Mum, Dad, Sam, Ella), routines, events, tasks and pocket money.")
    if demo_pin:
        print("Parent PIN for Settings and pocket money: 1234 (change it in Settings → Pocket money).")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pin", help="parent PIN (4–6 digits) for Settings and pocket money")
    parser.add_argument("--demo", action="store_true", help="add an example family, routines and tasks")
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    add_missing_columns()
    db = SessionLocal()
    try:
        seed_folders(db)
        if args.pin:
            money.set_pin(db, args.pin)
            db.commit()
            print("Parent PIN set.")
        if args.demo:
            seed_demo(db)
    finally:
        db.close()


if __name__ == "__main__":
    main()
