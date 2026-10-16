import datetime

from app import services
from app.models import Event, Task, TaskFolder


def fixed_now(monkeypatch, when):
    import app.occurrences
    import app.services
    import app.routers.api
    for mod in (app.occurrences, app.services, app.routers.api):
        monkeypatch.setattr(mod, "now_local", lambda: when)


def test_calendar_edits_need_no_login(client, family):
    r = client.post("/api/events", json={"title": "x", "date": "2026-10-16", "all_day": True, "everyone": True})
    assert r.status_code == 200
    assert client.get("/api/calendar?start=2026-10-12&end=2026-10-18").status_code == 200


def test_create_event_and_recurring(admin, family):
    r = admin.post("/api/events", json={"title": "Dentist", "date": "2026-10-16", "start": "13:30", "end": "14:30",
                                        "member_ids": [family["Mum"]]})
    assert r.status_code == 200, r.text
    r = admin.post("/api/events", json={"title": "Swim", "date": "2026-10-13", "start": "16:00", "end": "17:00",
                                        "member_ids": [family["Sam"]], "repeat": {"weekdays": [1, 4]}})
    assert r.status_code == 200, r.text
    items = admin.get("/api/calendar?start=2026-10-12&end=2026-10-25").json()["items"]
    assert [(i["title"], i["date"]) for i in items] == [
        ("Swim", "2026-10-13"), ("Dentist", "2026-10-16"), ("Swim", "2026-10-16"),
        ("Swim", "2026-10-20"), ("Swim", "2026-10-23")]


def test_validation_messages(admin, family):
    r = admin.post("/api/events", json={"title": "x", "date": "2026-10-16", "start": "10:00", "end": "09:00",
                                        "everyone": True})
    assert r.status_code == 400 and "end time" in r.json()["detail"]
    r = admin.post("/api/events", json={"title": "x", "date": "2026-10-16", "all_day": True})
    assert r.status_code == 400 and "who" in r.json()["detail"]


def _task(db, title="Clean gutters", kind="flexible"):
    folder = db.query(TaskFolder).first()
    t = Task(folder=folder, title=title, kind=kind)
    db.add(t)
    db.commit()
    return t.id


def test_schedule_and_unschedule_task(admin, db, family):
    tid = _task(db)
    r = admin.post(f"/api/tasks/{tid}/schedule", json={"member_ids": [family["Dad"]], "date": "2026-10-16",
                                                        "start": "16:00", "minutes": 90})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "scheduled" and r.json()["when"] == "Fri 16 Oct · 4:00 pm"
    # Scheduling again moves it rather than adding a second copy.
    admin.post(f"/api/tasks/{tid}/schedule", json={"member_ids": [family["Dad"]], "date": "2026-10-17", "start": "09:00"})
    assert db.query(Event).filter(Event.task_id == tid).count() == 1
    r = admin.post(f"/api/tasks/{tid}/unschedule")
    assert r.json()["status"] == "open"
    assert db.query(Event).filter(Event.task_id == tid).count() == 0


def test_checkin_reschedule_returns_task_to_list(client, admin, db, family, monkeypatch):
    tid = _task(db)
    admin.post(f"/api/tasks/{tid}/schedule", json={"member_ids": [family["Dad"]], "date": "2026-10-14", "start": "17:00"})
    fixed_now(monkeypatch, datetime.datetime(2026, 10, 16, 15, 42))
    q = client.get("/api/checkin").json()["items"]
    assert len(q) == 1 and q[0]["answer_member_ids"] == [family["Dad"]]
    r = client.post(f"/api/checkin/{q[0]['key']}", json={"member_id": family["Dad"], "answer": "reschedule"})
    assert r.json()["message"] == "Back in the task list"
    t = db.get(Task, tid)
    db.refresh(t)
    assert t.status == "open" and t.reschedule_count == 1
    assert client.get("/api/checkin").json()["items"] == []
    # Answering twice is refused.
    r = client.post(f"/api/checkin/{q[0]['key']}", json={"member_id": family["Dad"], "answer": "done"})
    assert r.status_code == 400


def test_checkin_underway_with_new_time(client, admin, db, family, monkeypatch):
    tid = _task(db)
    admin.post(f"/api/tasks/{tid}/schedule", json={"member_ids": [family["Dad"]], "date": "2026-10-14",
                                                   "start": "17:00", "minutes": 60})
    fixed_now(monkeypatch, datetime.datetime(2026, 10, 16, 15, 42))
    key = client.get("/api/checkin").json()["items"][0]["key"]
    r = client.post(f"/api/checkin/{key}", json={"member_id": family["Dad"], "answer": "underway",
                                                "new_date": "2026-10-17", "new_time": "09:00"})
    assert "next session" in r.json()["message"]
    evs = db.query(Event).filter(Event.task_id == tid).order_by(Event.date).all()
    assert [(e.date.isoformat(), e.check_status) for e in evs] == [("2026-10-14", "underway"), ("2026-10-17", None)]
    assert evs[1].end_time == datetime.time(10)
    task = services.task_dict(db.get(Task, tid), datetime.datetime(2026, 10, 16, 15, 42))
    assert task["status"] == "scheduled" and task["underway"]


def test_checkin_flexible_event_without_task_goes_to_rescheduled_folder(client, admin, db, family, monkeypatch):
    admin.post("/api/events", json={"title": "Tidy shed", "date": "2026-10-15", "start": "10:00", "end": "11:00",
                                    "member_ids": [family["Dad"]], "kind": "flexible"})
    fixed_now(monkeypatch, datetime.datetime(2026, 10, 16, 15, 42))
    key = client.get("/api/checkin").json()["items"][0]["key"]
    client.post(f"/api/checkin/{key}", json={"member_id": family["Dad"], "answer": "reschedule"})
    folders = client.get("/api/tasks").json()["folders"]
    resched = next(f for f in folders if f["name"] == "Rescheduled")
    assert [t["title"] for t in resched["tasks"]] == ["Tidy shed"]
    assert resched["tasks"][0]["reschedule_count"] == 1


def test_checkin_recurring_skip_and_move(client, admin, db, family, monkeypatch):
    admin.post("/api/events", json={"title": "Mow lawn", "date": "2026-10-12", "start": "17:00", "end": "18:00",
                                    "member_ids": [family["Dad"]], "kind": "flexible", "repeat": {"weekdays": [0, 2]}})
    fixed_now(monkeypatch, datetime.datetime(2026, 10, 16, 15, 42))
    keys = [i["key"] for i in client.get("/api/checkin").json()["items"]]
    assert len(keys) == 2
    assert client.post(f"/api/checkin/{keys[0]}", json={"answer": "reschedule", "skip_week": True}).json()["message"] == "Skipped this week"
    r = client.post(f"/api/checkin/{keys[1]}", json={"answer": "reschedule", "new_date": "2026-10-18", "new_time": "10:00"})
    assert r.json()["message"].startswith("Moved to Sun 18 Oct")
    items = client.get("/api/calendar?start=2026-10-12&end=2026-10-18").json()["items"]
    assert [(i["date"], i["start"]) for i in items] == [("2026-10-18", "10:00")]
    assert client.get("/api/checkin").json()["items"] == []


def test_recurring_edit_scopes(admin, family):
    rid = admin.post("/api/events", json={"title": "Swim", "date": "2026-10-13", "start": "16:00", "end": "17:00",
                                          "member_ids": [family["Sam"]], "repeat": {"weekdays": [1]}}).json()["recurring_id"]
    # this one only: move to 5pm
    r = admin.patch(f"/api/recurring/{rid}", json={"scope": "this", "original_date": "2026-10-20", "start": "17:00", "end": "18:00"})
    assert r.status_code == 200, r.text
    # this one can't change who
    r = admin.patch(f"/api/recurring/{rid}", json={"scope": "this", "original_date": "2026-10-27", "member_ids": [family["Mum"]]})
    assert r.status_code == 400
    # future: rename from 27 Oct
    r = admin.patch(f"/api/recurring/{rid}", json={"scope": "future", "original_date": "2026-10-27", "title": "Squad"})
    assert r.status_code == 200
    items = admin.get("/api/calendar?start=2026-10-12&end=2026-11-08").json()["items"]
    assert [(i["date"], i["title"], i["start"]) for i in items] == [
        ("2026-10-13", "Swim", "16:00"), ("2026-10-20", "Swim", "17:00"),
        ("2026-10-27", "Squad", "16:00"), ("2026-11-03", "Squad", "16:00")]
    # all: drag one Tuesday to Wednesday moves the whole (new) series
    new_rid = int(items[2]["recurring_id"])
    r = admin.patch(f"/api/recurring/{new_rid}", json={"scope": "all", "original_date": "2026-10-27", "date": "2026-10-28"})
    items = admin.get("/api/calendar?start=2026-10-26&end=2026-11-08").json()["items"]
    assert [i["date"] for i in items] == ["2026-10-28", "2026-11-04"]


def test_delete_recurring_scopes(admin, family):
    rid = admin.post("/api/events", json={"title": "Swim", "date": "2026-10-13", "start": "16:00", "end": "17:00",
                                          "everyone": True, "repeat": {"weekdays": [1]}}).json()["recurring_id"]
    admin.delete(f"/api/recurring/{rid}?scope=this&original_date=2026-10-20")
    admin.delete(f"/api/recurring/{rid}?scope=future&original_date=2026-11-03")
    items = admin.get("/api/calendar?start=2026-10-12&end=2026-11-30").json()["items"]
    assert [i["date"] for i in items] == ["2026-10-13", "2026-10-27"]


def test_tick_task_done_marks_slot(client, admin, db, family):
    tid = _task(db)
    admin.post(f"/api/tasks/{tid}/schedule", json={"member_ids": [family["Dad"]], "date": "2026-10-20", "start": "09:00"})
    r = client.post(f"/api/tasks/{tid}/done", json={"done": True})
    assert r.json()["status"] == "done"
    ev = db.query(Event).filter(Event.task_id == tid).one()
    assert ev.check_status == "done"
    r = client.post(f"/api/tasks/{tid}/done", json={"done": False})
    assert r.json()["status"] == "scheduled"


def test_multi_day_event_drag_keeps_length(admin, db, family):
    eid = admin.post("/api/events", json={"title": "Camp", "date": "2026-10-21", "end_date": "2026-10-23",
                                          "all_day": True, "member_ids": [family["Sam"]]}).json()["event_id"]
    admin.patch(f"/api/events/{eid}", json={"date": "2026-10-28"})
    ev = db.get(Event, eid)
    db.refresh(ev)
    assert (ev.date.isoformat(), ev.end_date.isoformat()) == ("2026-10-28", "2026-10-30")


def test_settings_need_parent_pin(client, db, family):
    from app import money
    money._failures.clear()
    r = client.get("/settings/members", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].startswith("/settings/unlock")
    # First run: choosing a PIN unlocks settings
    r = client.post("/settings/unlock", data={"pin": "4821", "pin2": "4821", "next": "/settings/members"}, follow_redirects=False)
    assert r.headers["location"] == "/settings/members"
    assert client.get("/settings/members").status_code == 200
    client.post("/settings/lock")
    r = client.post("/settings/unlock", data={"pin": "0000", "next": "/settings/members"}, follow_redirects=False)
    assert "err=" in r.headers["location"]
    assert client.get("/settings/members", follow_redirects=False).status_code == 303
    # Never redirect off-site
    r = client.post("/settings/unlock", data={"pin": "4821", "next": "https://evil.example"}, follow_redirects=False)
    assert r.headers["location"] == "/settings/members"



def test_refresh_all_calendars_button(client, db, family):
    from app import money
    money._failures.clear()
    client.post("/settings/unlock", data={"pin": "4821", "pin2": "4821", "next": "/settings/members"})
    # Must not be mistaken for "save calendar number <refresh>".
    r = client.post("/settings/feeds/refresh", follow_redirects=False)
    assert r.status_code == 303 and "Refreshed" in r.headers["location"]

def test_routine_start_date_can_be_set_and_moved(admin, family):
    # Created with a later start date (the "Meeting" case): nothing before it.
    rid = admin.post("/api/events", json={"title": "Meeting", "date": "2026-10-31", "start": "13:30", "end": "15:45",
                                          "everyone": True, "repeat": {"weekdays": [5]}}).json()["recurring_id"]
    dates = lambda: [i["date"] for i in admin.get("/api/calendar?start=2026-10-12&end=2026-11-08").json()["items"]]
    assert dates() == ["2026-10-31", "2026-11-07"]
    # Moving "Starting from" earlier brings the earlier weeks back.
    r = admin.patch(f"/api/recurring/{rid}", json={"scope": "all", "original_date": "2026-10-31",
                                                   "repeat": {"weekdays": [5], "valid_from": "2026-10-16"}})
    assert r.status_code == 200, r.text
    assert dates() == ["2026-10-17", "2026-10-24", "2026-10-31", "2026-11-07"]
    # An explicit start on create wins over the date field; until before start is refused.
    r = admin.post("/api/events", json={"title": "X", "date": "2026-10-16", "all_day": True, "everyone": True,
                                        "repeat": {"weekdays": [0], "valid_from": "2026-11-01", "valid_until": "2026-10-20"}})
    assert r.status_code == 400 and "until" in r.json()["detail"]


def test_get_routine_for_series_editing(admin, family, monkeypatch):
    fixed_now(monkeypatch, datetime.datetime(2026, 10, 16, 9))
    rid = admin.post("/api/events", json={"title": "Meeting", "date": "2026-10-31", "start": "13:30", "end": "15:45",
                                          "everyone": True, "repeat": {"weekdays": [5]}}).json()["recurring_id"]
    it = admin.get(f"/api/recurring/{rid}").json()
    assert (it["title"], it["original_date"], it["repeat"]["valid_from"], it["active"]) == ("Meeting", "2026-10-31", "2026-10-31", True)
    assert admin.get("/api/recurring/999").status_code == 404
