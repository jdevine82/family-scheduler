"""Pocket money: parent PIN, weekly income, paid jobs, approvals, fines and withdrawals."""

import datetime
import time

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import CHECK_DONE, CHECK_RESCHEDULED, KIND_FLEXIBLE, Event, Member, MoneyJob, MoneyTxn
from app.occurrences import build_items
from app.security import hash_password, verify_password
from app.services import ServiceError
from app.settings_store import get_int, get_setting, set_setting
from app.timeutil import add_minutes, human_when, now_local

PIN_KEY = "parent_pin_hash"
MAX_TRIES = 5
LOCKOUT_SECONDS = 60
SLOT_STEP = 30

# Wrong-PIN tracking is per server process; that's plenty for a family LAN app.
_failures: list[float] = []


def money(cents: int) -> str:
    sign = "−" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.2f}"


# ---------------------------------------------------------------- PIN

def pin_is_set(db: Session) -> bool:
    return bool(get_setting(db, PIN_KEY))


def set_pin(db: Session, pin: str) -> None:
    if not (pin.isdigit() and 4 <= len(pin) <= 6):
        raise ServiceError("The PIN must be 4 to 6 digits.")
    set_setting(db, PIN_KEY, hash_password(pin))


def check_pin(db: Session, pin: str) -> None:
    """Raise ServiceError unless the PIN is right. Locks out briefly after repeated misses."""
    now = time.monotonic()
    _failures[:] = [t for t in _failures if now - t < LOCKOUT_SECONDS]
    if len(_failures) >= MAX_TRIES:
        wait = int(LOCKOUT_SECONDS - (now - _failures[0])) + 1
        raise ServiceError(f"Too many wrong tries. Wait {wait} seconds.")
    stored = get_setting(db, PIN_KEY)
    if not stored:
        raise ServiceError("No parent PIN has been set yet. A parent can set one in Settings → Pocket money.")
    if not verify_password(pin or "", stored):
        _failures.append(now)
        left = MAX_TRIES - len(_failures)
        raise ServiceError("Wrong PIN." + (f" {left} tries left." if left <= 2 else ""))
    _failures.clear()


# ---------------------------------------------------------------- balances & income

def balance(db: Session, member_id: int) -> int:
    return db.query(func.coalesce(func.sum(MoneyTxn.amount_cents), 0)).filter(MoneyTxn.member_id == member_id).scalar()


def children(db: Session) -> list[Member]:
    return (db.query(Member).filter(Member.active.is_(True), Member.is_child.is_(True))
            .order_by(Member.sort_order, Member.id).all())


def pay_income(db: Session, today: datetime.date | None = None) -> int:
    """Credit any weekly income that has fallen due (catching up missed paydays). Returns payments made."""
    today = today or now_local().date()
    paid = 0
    for kid in children(db):
        if kid.allowance_cents <= 0 or kid.allowance_since is None:
            continue
        d = kid.allowance_since + datetime.timedelta(days=(kid.allowance_weekday - kid.allowance_since.weekday()) % 7)
        while d <= today:
            exists = db.query(MoneyTxn.id).filter(MoneyTxn.member_id == kid.id, MoneyTxn.kind == "income",
                                                  MoneyTxn.period_date == d).first()
            if not exists:
                db.add(MoneyTxn(member_id=kid.id, amount_cents=kid.allowance_cents, kind="income",
                                description="Weekly pocket money", period_date=d))
                paid += 1
            d += datetime.timedelta(days=7)
    if paid:
        try:
            db.commit()
        except IntegrityError:  # another request paid it at the same moment
            db.rollback()
    return paid


def set_child(db: Session, member: Member, *, is_child: bool, allowance_cents: int, allowance_weekday: int) -> None:
    if allowance_cents < 0 or allowance_cents > 100_000:
        raise ServiceError("Weekly money must be between $0 and $1,000.")
    if not 0 <= allowance_weekday <= 6:
        raise ServiceError("Pick a payday.")
    changed = (member.allowance_cents, member.allowance_weekday) != (allowance_cents, allowance_weekday)
    member.is_child = is_child
    member.allowance_cents = allowance_cents
    member.allowance_weekday = allowance_weekday
    # Income starts from today when it's first set or changed; earlier paydays are never back-paid.
    if changed or member.allowance_since is None:
        member.allowance_since = now_local().date()


def add_txn(db: Session, member: Member, cents: int, kind: str, description: str, event_id: int | None = None) -> MoneyTxn:
    txn = MoneyTxn(member_id=member.id, amount_cents=cents, kind=kind, description=description[:300], event_id=event_id)
    db.add(txn)
    return txn


def fine(db: Session, member: Member, cents: int, reason: str) -> MoneyTxn:
    if cents <= 0:
        raise ServiceError("Enter how much the fine is.")
    if not reason.strip():
        raise ServiceError("Say what the fine is for.")
    return add_txn(db, member, -cents, "fine", f"Fine: {reason.strip()}")


def withdraw(db: Session, member: Member, cents: int, note: str) -> MoneyTxn:
    if cents <= 0:
        raise ServiceError("Enter how much to take out.")
    bal = balance(db, member.id)
    if cents > bal:
        raise ServiceError(f"{member.name} only has {money(bal)}.")
    return add_txn(db, member, -cents, "withdrawal", f"Withdrawal: {note.strip()}" if note.strip() else "Withdrawal")


# ---------------------------------------------------------------- booking paid jobs

def _busy_ranges(db: Session, member_id: int, date: datetime.date, ignore_event: int | None = None) -> list[tuple[int, int]]:
    out = []
    for it in build_items(db, date, date):
        if it["date"] != date.isoformat() or it["all_day"] or it.get("end_date") or not it["start"]:
            continue
        if it.get("check_status") == CHECK_RESCHEDULED or (ignore_event and it.get("event_id") == ignore_event):
            continue
        if it["everyone"] or member_id in it["member_ids"]:
            s = int(it["start"][:2]) * 60 + int(it["start"][3:])
            e = int(it["end"][:2]) * 60 + int(it["end"][3:]) if it["end"] else s + 30
            out.append((s, e))
    return out


def _fmt_hour(h: int) -> str:
    return "midnight" if h % 24 == 0 else f"{h % 12 or 12}:00 {'am' if h < 12 else 'pm'}"


def free_slots(db: Session, member_id: int, date: datetime.date, minutes: int) -> tuple[list[str], str]:
    """Free start times for a job of this length, plus a sentence explaining an empty list."""
    now = now_local()
    start_h, end_h = get_int(db, "display_start_hour"), get_int(db, "display_end_hour")
    first, last = start_h * 60, end_h * 60
    if date < now.date():
        return [], "That day has already gone. Pick today or a later day."
    if date == now.date():
        first = max(first, ((now.hour * 60 + now.minute) // SLOT_STEP + 1) * SLOT_STEP)
        if first + minutes > last:
            return [], (f"It's too late today: the calendar day ends at {_fmt_hour(end_h)} and this job takes about "
                        f"{minutes} min. Try tomorrow.")
    busy = _busy_ranges(db, member_id, date)
    slots = []
    t = first
    while t + minutes <= last:
        if all(t + minutes <= s or t >= e for s, e in busy):
            slots.append(f"{t // 60:02d}:{t % 60:02d}")
        t += SLOT_STEP
    if not slots:
        return [], (f"Already busy all day between {_fmt_hour(start_h)} and {_fmt_hour(end_h)} "
                    f"with no {minutes}-minute gap. Try another day.")
    return slots, ""


def book_job(db: Session, job: MoneyJob, member: Member, date: datetime.date, start: datetime.time) -> Event:
    if not member.is_child:
        raise ServiceError(f"{member.name} doesn't have a pocket money account.")
    if job.for_member_id and job.for_member_id != member.id:
        raise ServiceError("That job is for someone else.")
    if not job.active:
        raise ServiceError("That job isn't on the list any more.")
    now = now_local()
    if datetime.datetime.combine(date, start) < now - datetime.timedelta(minutes=5):
        raise ServiceError("Pick a time that hasn't happened yet.")
    s = start.hour * 60 + start.minute
    e = s + job.est_minutes
    if e > 24 * 60:
        raise ServiceError("That's too late in the day for this job.")
    for bs, be in _busy_ranges(db, member.id, date):
        if s < be and e > bs:
            raise ServiceError(f"{member.name} already has something on then. Pick another time.")
    ev = Event(title=job.title, notes=job.notes, date=date, start_time=start, end_time=add_minutes(start, job.est_minutes),
               all_day=False, is_everyone=False, kind=KIND_FLEXIBLE, money_job_id=job.id)
    ev.members = [member]
    db.add(ev)
    db.flush()
    return ev


def booking_dict(ev: Event, now: datetime.datetime) -> dict:
    end = datetime.datetime.combine(ev.date, ev.end_time or datetime.time(23, 59))
    start = datetime.datetime.combine(ev.date, ev.start_time or datetime.time())
    return {
        "event_id": ev.id,
        "title": ev.title,
        "member_id": ev.members[0].id if ev.members else None,
        "date": ev.date.isoformat(),
        "start": ev.start_time.strftime("%H:%M") if ev.start_time else None,
        "when": human_when(ev.date, ev.start_time),
        "amount_cents": ev.money_job.amount_cents if ev.money_job else 0,
        "started": start <= now,
        "finished": end <= now,
        "status": ev.check_status,
    }


def bookings(db: Session) -> tuple[list[dict], list[dict]]:
    """(waiting for a parent, coming up) — unanswered paid-job bookings."""
    now = now_local()
    evs = (db.query(Event).filter(Event.money_job_id.is_not(None), Event.check_status.is_(None))
           .order_by(Event.date, Event.start_time).all())
    items = [booking_dict(ev, now) for ev in evs]
    return [i for i in items if i["started"]], [i for i in items if not i["started"]]


def approve(db: Session, ev: Event) -> MoneyTxn:
    if ev.money_job_id is None or not ev.members:
        raise ServiceError("That isn't a paid job.")
    if ev.check_status is not None:
        raise ServiceError("That job has already been dealt with.")
    if datetime.datetime.combine(ev.date, ev.start_time or datetime.time()) > now_local():
        raise ServiceError("That job hasn't started yet.")
    amount = ev.money_job.amount_cents if ev.money_job else 0
    ev.check_status = CHECK_DONE
    ev.checked_at = now_local()
    ev.checked_by_member_id = None
    return add_txn(db, ev.members[0], amount, "job", f"Job: {ev.title}", event_id=ev.id)


def reject(db: Session, ev: Event) -> None:
    if ev.money_job_id is None or ev.check_status is not None:
        raise ServiceError("That job has already been dealt with.")
    ev.check_status = CHECK_RESCHEDULED
    ev.checked_at = now_local()


def job_dict(job: MoneyJob) -> dict:
    return {"id": job.id, "title": job.title, "notes": job.notes, "amount_cents": job.amount_cents,
            "est_minutes": job.est_minutes, "for_member_id": job.for_member_id, "active": job.active}
