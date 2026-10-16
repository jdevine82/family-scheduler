import datetime

from app import feeds
from app.models import CalendarFeed

ICS = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:a1
DTSTART:20261016T000000Z
DTEND:20261016T063000Z
SUMMARY:Work
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:a2
DTSTART;VALUE=DATE:20261020
DTEND;VALUE=DATE:20261022
SUMMARY:Conference
END:VEVENT
END:VCALENDAR
"""


def test_parse_converts_to_local_and_expands_rrule():
    events = feeds.parse_ical(ICS, datetime.date(2026, 10, 1), datetime.date(2026, 12, 1))
    work = [e for e in events if e["title"] == "Work"]
    assert len(work) == 3
    # 00:00 UTC is 11:00 in Sydney during daylight saving
    assert work[0]["start_at"] == datetime.datetime(2026, 10, 16, 11, 0)
    conf = next(e for e in events if e["title"] == "Conference")
    assert conf["all_day"] and conf["end_at"] == datetime.datetime(2026, 10, 22)


def test_feed_items_on_calendar(client, db, family, monkeypatch):
    feed = CalendarFeed(member_id=family["Dad"], label="Dad – work", ical_url="https://example.invalid/x.ics", busy_only=True)
    db.add(feed)
    db.commit()

    class Resp:
        content = ICS
        def raise_for_status(self): pass

    class Client:
        def get(self, url): return Resp()

    monkeypatch.setattr(feeds, "now_local", lambda: datetime.datetime(2026, 10, 16, 9))
    assert feeds.fetch_feed(db, feed, Client()) == 4
    items = client.get("/api/calendar?start=2026-10-19&end=2026-10-23").json()["items"]
    conf = next(i for i in items if i["all_day"])
    assert conf["title"] == "Busy" and conf["read_only"] and conf["end_date"] == "2026-10-21"
    assert "ical_url" not in str(items)


def test_redact_hides_secret():
    url = "https://calendar.google.com/calendar/ical/abc%40gmail.com/private-123456/basic.ics"
    assert "private-123456" not in feeds.redact(url)
