"""Pocket money API. Viewing and booking jobs are open (wall, LAN); parent actions need the PIN.

After a correct PIN the browser session stays unlocked for a few minutes (see deps.py),
so a parent can approve several jobs in a row without typing it each time.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import money
from app.database import get_db
from app.deps import lock_parent, parent_unlocked, require_parent, unlock_parent
from app.models import Event, Member, MoneyJob, MoneyTxn
from app.services import ServiceError
from app.timeutil import parse_date, parse_time

router = APIRouter(prefix="/api/money")


def bad(message: str, code: int = 400):
    raise HTTPException(status_code=code, detail=message)


def _member(db: Session, member_id: int) -> Member:
    m = db.get(Member, member_id)
    if m is None or not m.active:
        bad("That person no longer exists.", 404)
    return m


def _kid(db: Session, member_id: int) -> Member:
    m = _member(db, member_id)
    if not m.is_child:
        bad(f"{m.name} doesn't have a pocket money account.")
    return m


# ---------------------------------------------------------------- PIN

class PinBody(BaseModel):
    pin: str = Field(max_length=12)


@router.post("/unlock")
def unlock(body: PinBody, request: Request, db: Session = Depends(get_db)):
    try:
        money.check_pin(db, body.pin)
    except ServiceError as exc:
        bad(str(exc), 403)
    unlock_parent(request)
    return {"ok": True}


@router.post("/lock")
def lock(request: Request):
    lock_parent(request)
    return {"ok": True}


class ChangePinBody(BaseModel):
    current: str = Field(max_length=12)
    new: str = Field(max_length=12)


@router.post("/pin")
def change_pin(body: ChangePinBody, db: Session = Depends(get_db)):
    try:
        money.check_pin(db, body.current)
        money.set_pin(db, body.new)
    except ServiceError as exc:
        bad(str(exc))
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- overview (no PIN)

@router.get("")
def overview(request: Request, db: Session = Depends(get_db)):
    money.pay_income(db)
    kids = money.children(db)
    waiting, upcoming = money.bookings(db)
    jobs = db.query(MoneyJob).order_by(MoneyJob.sort_order, MoneyJob.title).all()
    members = db.query(Member).filter(Member.active.is_(True)).order_by(Member.sort_order, Member.id).all()
    return {
        "pin_set": money.pin_is_set(db),
        "unlocked": parent_unlocked(request),
        "children": [{
            "id": k.id, "name": k.name, "color": k.color_hex, "short_label": k.short_label or k.name[:1],
            "balance_cents": money.balance(db, k.id), "allowance_cents": k.allowance_cents,
            "allowance_weekday": k.allowance_weekday,
        } for k in kids],
        "members": [{"id": m.id, "name": m.name, "color": m.color_hex, "is_child": m.is_child,
                     "allowance_cents": m.allowance_cents, "allowance_weekday": m.allowance_weekday} for m in members],
        "jobs": [money.job_dict(j) for j in jobs],
        "waiting": waiting,
        "upcoming": upcoming,
    }


@router.get("/history/{member_id}")
def history(member_id: int, db: Session = Depends(get_db)):
    kid = _kid(db, member_id)
    money.pay_income(db)
    txns = db.query(MoneyTxn).filter(MoneyTxn.member_id == kid.id).order_by(MoneyTxn.created_at, MoneyTxn.id).all()
    running, rows = 0, []
    for t in txns:
        running += t.amount_cents
        rows.append({"id": t.id, "date": (t.period_date or t.created_at.date()).isoformat(), "kind": t.kind,
                     "description": t.description, "amount_cents": t.amount_cents, "balance_cents": running})
    rows.reverse()
    return {"member_id": kid.id, "name": kid.name, "balance_cents": running, "rows": rows}


@router.get("/free")
def free(member_id: int, date: str, minutes: int, db: Session = Depends(get_db)):
    kid = _kid(db, member_id)
    d = parse_date(date) or bad("Pick a day.")
    slots, reason = money.free_slots(db, kid.id, d, max(5, min(minutes, 12 * 60)))
    return {"slots": slots, "reason": reason}


class BookBody(BaseModel):
    member_id: int
    date: str
    start: str


@router.post("/jobs/{job_id}/book")
def book(job_id: int, body: BookBody, db: Session = Depends(get_db)):
    job = db.get(MoneyJob, job_id) or bad("That job isn't on the list any more.", 404)
    kid = _kid(db, body.member_id)
    try:
        ev = money.book_job(db, job, kid, parse_date(body.date), parse_time(body.start))
    except ServiceError as exc:
        db.rollback()
        bad(str(exc))
    db.commit()
    return {"ok": True, "event_id": ev.id, "message": f"{job.title} booked for {kid.name}"}


@router.delete("/bookings/{event_id}")
def cancel_booking(event_id: int, request: Request, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id)
    if ev is None or ev.money_job_id is None or ev.check_status is not None:
        bad("That booking can't be cancelled.")
    started = money.booking_dict(ev, money.now_local())["started"]
    if started:
        require_parent(request)  # once it's started, only a parent can take it off
    db.delete(ev)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- parent actions

@router.post("/bookings/{event_id}/approve", dependencies=[Depends(require_parent)])
def approve(event_id: int, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id) or bad("That job no longer exists.", 404)
    try:
        txn = money.approve(db, ev)
    except ServiceError as exc:
        bad(str(exc))
    db.commit()
    return {"ok": True, "message": f"Paid {money.money(txn.amount_cents)} to {ev.members[0].name}"}


@router.post("/bookings/{event_id}/reject", dependencies=[Depends(require_parent)])
def reject(event_id: int, db: Session = Depends(get_db)):
    ev = db.get(Event, event_id) or bad("That job no longer exists.", 404)
    try:
        money.reject(db, ev)
    except ServiceError as exc:
        bad(str(exc))
    db.commit()
    return {"ok": True, "message": "Marked not done. No money paid."}


class AmountBody(BaseModel):
    member_id: int
    amount_cents: int = Field(gt=0, le=100_000)
    note: str = Field(default="", max_length=200)


@router.post("/fine", dependencies=[Depends(require_parent)])
def fine(body: AmountBody, db: Session = Depends(get_db)):
    kid = _kid(db, body.member_id)
    try:
        money.fine(db, kid, body.amount_cents, body.note)
    except ServiceError as exc:
        bad(str(exc))
    db.commit()
    return {"ok": True, "message": f"Fined {kid.name} {money.money(body.amount_cents)}"}


@router.post("/withdraw", dependencies=[Depends(require_parent)])
def withdraw(body: AmountBody, db: Session = Depends(get_db)):
    kid = _kid(db, body.member_id)
    try:
        money.withdraw(db, kid, body.amount_cents, body.note)
    except ServiceError as exc:
        bad(str(exc))
    db.commit()
    return {"ok": True, "message": f"Took {money.money(body.amount_cents)} out of {kid.name}'s account"}


class ChildBody(BaseModel):
    is_child: bool
    allowance_cents: int = Field(ge=0, le=100_000)
    allowance_weekday: int = Field(ge=0, le=6)


@router.patch("/children/{member_id}", dependencies=[Depends(require_parent)])
def update_child(member_id: int, body: ChildBody, db: Session = Depends(get_db)):
    m = _member(db, member_id)
    try:
        money.set_child(db, m, is_child=body.is_child, allowance_cents=body.allowance_cents,
                        allowance_weekday=body.allowance_weekday)
    except ServiceError as exc:
        bad(str(exc))
    db.commit()
    money.pay_income(db)
    return {"ok": True}


class JobBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    notes: str = Field(default="", max_length=2000)
    amount_cents: int = Field(gt=0, le=100_000)
    est_minutes: int = Field(default=30, ge=5, le=12 * 60)
    for_member_id: int | None = None
    active: bool = True


@router.post("/jobs", dependencies=[Depends(require_parent)])
def create_job(body: JobBody, db: Session = Depends(get_db)):
    top = db.query(MoneyJob).order_by(MoneyJob.sort_order.desc()).first()
    job = MoneyJob(**body.model_dump(), sort_order=(top.sort_order + 1) if top else 0)
    job.title = job.title.strip()
    db.add(job)
    db.commit()
    return money.job_dict(job)


@router.patch("/jobs/{job_id}", dependencies=[Depends(require_parent)])
def update_job(job_id: int, body: JobBody, db: Session = Depends(get_db)):
    job = db.get(MoneyJob, job_id) or bad("That job no longer exists.", 404)
    for k, v in body.model_dump().items():
        setattr(job, k, v.strip() if k == "title" else v)
    db.commit()
    return money.job_dict(job)


@router.delete("/jobs/{job_id}", dependencies=[Depends(require_parent)])
def delete_job(job_id: int, db: Session = Depends(get_db)):
    job = db.get(MoneyJob, job_id) or bad("That job no longer exists.", 404)
    # Unpaid future bookings go too; paid history keeps its calendar item.
    for ev in db.query(Event).filter(Event.money_job_id == job.id, Event.check_status.is_(None)).all():
        db.delete(ev)
    db.delete(job)
    db.commit()
    return {"ok": True}

