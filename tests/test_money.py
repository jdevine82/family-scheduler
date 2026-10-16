import datetime

import pytest

from app import money
from app.models import Event, Member, MoneyJob, MoneyTxn


@pytest.fixture(autouse=True)
def _reset_failures():
    money._failures.clear()


def at(monkeypatch, when):
    import app.money
    import app.occurrences
    import app.services
    for mod in (app.money, app.occurrences, app.services):
        monkeypatch.setattr(mod, "now_local", lambda: when)


@pytest.fixture()
def kids(db, family):
    sam = db.get(Member, family["Sam"])
    sam.is_child = True
    db.add(MoneyJob(title="Wash the car", amount_cents=400, est_minutes=60))
    money.set_pin(db, "1234")
    db.commit()
    return family


def unlock(client, pin="1234"):
    return client.post("/api/money/unlock", json={"pin": pin})


def test_parent_actions_need_pin(client, kids):
    r = client.post("/api/money/fine", json={"member_id": kids["Sam"], "amount_cents": 100, "note": "Room"})
    assert r.status_code == 403
    assert unlock(client, "9999").status_code == 403
    assert unlock(client).status_code == 200
    r = client.post("/api/money/fine", json={"member_id": kids["Sam"], "amount_cents": 100, "note": "Room"})
    assert r.status_code == 200
    assert client.get(f"/api/money/history/{kids['Sam']}").json()["balance_cents"] == -100


def test_lockout_after_wrong_tries(client, kids):
    for _ in range(5):
        unlock(client, "0000")
    r = unlock(client)
    assert r.status_code == 403 and "Too many" in r.json()["detail"]


def test_income_dates(db, kids, monkeypatch):
    sam = db.get(Member, kids["Sam"])
    at(monkeypatch, datetime.datetime(2026, 10, 1, 9))
    money.set_child(db, sam, is_child=True, allowance_cents=500, allowance_weekday=5)
    db.commit()
    money.pay_income(db, datetime.date(2026, 10, 17))
    money.pay_income(db, datetime.date(2026, 10, 17))
    dates = [t.period_date.isoformat() for t in db.query(MoneyTxn).order_by(MoneyTxn.period_date)]
    assert dates == ["2026-10-03", "2026-10-10", "2026-10-17"]
    assert money.balance(db, sam.id) == 1500


def test_book_free_slot_approve_and_pay(client, db, kids, monkeypatch):
    at(monkeypatch, datetime.datetime(2026, 10, 16, 9))
    # Sam has swimming 16:00–17:00
    ev = Event(title="Swim", date=datetime.date(2026, 10, 16), start_time=datetime.time(16), end_time=datetime.time(17))
    ev.members = [db.get(Member, kids["Sam"])]
    db.add(ev)
    db.commit()
    job = db.query(MoneyJob).first()
    slots = client.get(f"/api/money/free?member_id={kids['Sam']}&date=2026-10-16&minutes=60").json()["slots"]
    assert "15:00" in slots and "15:30" not in slots and "16:00" not in slots and "17:00" in slots
    assert "09:00" not in slots and "09:30" in slots  # not in the past
    r = client.post(f"/api/money/jobs/{job.id}/book", json={"member_id": kids["Sam"], "date": "2026-10-16", "start": "16:30"})
    assert r.status_code == 400 and "already has something" in r.json()["detail"]
    r = client.post(f"/api/money/jobs/{job.id}/book", json={"member_id": kids["Sam"], "date": "2026-10-16", "start": "17:00"})
    assert r.status_code == 200, r.text
    eid = r.json()["event_id"]
    # Not in check-in, shown on the calendar with its amount
    at(monkeypatch, datetime.datetime(2026, 10, 16, 18, 30))
    assert client.get("/api/checkin").json()["items"] == []
    item = next(i for i in client.get("/api/calendar?start=2026-10-16&end=2026-10-16").json()["items"] if i["title"] == "Wash the car")
    assert item["money_cents"] == 400
    data = client.get("/api/money").json()
    assert [w["event_id"] for w in data["waiting"]] == [eid]
    unlock(client)
    r = client.post(f"/api/money/bookings/{eid}/approve")
    assert r.json()["message"] == "Paid $4.00 to Sam"
    assert client.post(f"/api/money/bookings/{eid}/approve").status_code == 400
    hist = client.get(f"/api/money/history/{kids['Sam']}").json()
    assert hist["balance_cents"] == 400 and hist["rows"][0]["description"] == "Job: Wash the car"


def test_withdraw_cannot_exceed_balance(client, db, kids):
    db.add(MoneyTxn(member_id=kids["Sam"], amount_cents=300, kind="job", description="x"))
    db.commit()
    unlock(client)
    r = client.post("/api/money/withdraw", json={"member_id": kids["Sam"], "amount_cents": 500, "note": "Lego"})
    assert r.status_code == 400 and "only has $3.00" in r.json()["detail"]
    r = client.post("/api/money/withdraw", json={"member_id": kids["Sam"], "amount_cents": 300, "note": "Lego"})
    assert r.status_code == 200


def test_non_child_cannot_book(client, kids):
    job_id = client.get("/api/money").json()["jobs"][0]["id"]
    r = client.post(f"/api/money/jobs/{job_id}/book", json={"member_id": kids["Mum"], "date": "2030-01-01", "start": "10:00"})
    assert r.status_code == 400


def test_free_slots_explain_late_evening(client, kids, monkeypatch):
    at(monkeypatch, datetime.datetime(2026, 10, 16, 21, 36))  # after the 9 pm end of the calendar day
    r = client.get(f"/api/money/free?member_id={kids['Sam']}&date=2026-10-16&minutes=30").json()
    assert r["slots"] == [] and "too late today" in r["reason"] and "9:00 pm" in r["reason"]
    r = client.get(f"/api/money/free?member_id={kids['Sam']}&date=2026-10-17&minutes=30").json()
    assert r["slots"][0] == "06:00" and r["reason"] == ""
