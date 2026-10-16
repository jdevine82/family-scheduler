"""Read-only Google Calendar (or any iCal) feeds, cached in ExternalEvent."""

import datetime
import logging

from urllib.parse import urlsplit

import httpx
import icalendar
import recurring_ical_events
from sqlalchemy.orm import Session

from app.models import CalendarFeed, ExternalEvent
from app.settings_store import get_int
from app.timeutil import TZ, now_local

logger = logging.getLogger(__name__)


def redact(url: str) -> str:
    """Feed URLs are secrets (anyone holding one can read the calendar) — only ever log the host."""
    return f"{urlsplit(url).netloc or '?'}/…"


def _to_local(value) -> tuple[datetime.datetime, bool]:
    """Convert an iCal DTSTART/DTEND value to (local naive datetime, is_all_day)."""
    if isinstance(value, datetime.datetime):
        if value.tzinfo is not None:
            value = value.astimezone(TZ).replace(tzinfo=None)
        return value, False
    return datetime.datetime.combine(value, datetime.time()), True


def parse_ical(data: bytes, start: datetime.date, end: datetime.date) -> list[dict]:
    cal = icalendar.Calendar.from_ical(data)
    out = []
    for comp in recurring_ical_events.of(cal).between(start, end):
        if comp.get("STATUS", "").upper() == "CANCELLED":
            continue
        dtstart = comp.get("DTSTART")
        if dtstart is None:
            continue
        start_at, all_day = _to_local(dtstart.dt)
        dtend = comp.get("DTEND")
        if dtend is not None:
            end_at, _ = _to_local(dtend.dt)
        elif comp.get("DURATION") is not None:
            end_at = start_at + comp["DURATION"].dt
        else:
            end_at = start_at + (datetime.timedelta(days=1) if all_day else datetime.timedelta(hours=1))
        if end_at <= start_at:
            end_at = start_at + (datetime.timedelta(days=1) if all_day else datetime.timedelta(minutes=30))
        out.append({
            "uid": str(comp.get("UID", ""))[:255],
            "title": str(comp.get("SUMMARY", "")).strip()[:255] or "(no title)",
            "location": str(comp.get("LOCATION", "")).strip()[:255],
            "start_at": start_at,
            "end_at": end_at,
            "all_day": all_day,
        })
    return out


def fetch_feed(db: Session, feed: CalendarFeed, client: httpx.Client | None = None) -> int:
    """Download and re-cache one feed. Keeps the last good copy on failure. Returns events cached."""
    today = now_local().date()
    start = today - datetime.timedelta(days=31)
    end = today + datetime.timedelta(days=31 * get_int(db, "feed_window_months"))
    feed.last_fetched_at = now_local()
    try:
        url = feed.ical_url.strip()
        if url.startswith("webcal://"):
            url = "https://" + url[len("webcal://"):]
        own_client = client is None
        client = client or httpx.Client(timeout=30, follow_redirects=True)
        try:
            resp = client.get(url)
        finally:
            if own_client:
                client.close()
        resp.raise_for_status()
        events = parse_ical(resp.content, start, end)
    except Exception as exc:  # noqa: BLE001 — any failure is reported in Settings, not raised
        logger.warning("Calendar feed %s (%s) failed: %s", feed.id, redact(feed.ical_url), exc)
        feed.last_error = _friendly_error(exc)
        db.commit()
        return 0
    db.query(ExternalEvent).filter(ExternalEvent.feed_id == feed.id).delete()
    for e in events:
        db.add(ExternalEvent(feed_id=feed.id, **e))
    feed.last_error = None
    db.commit()
    return len(events)


def _friendly_error(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in (401, 403, 404):
            return f"Google refused the address (HTTP {code}). Copy the secret iCal address again from Google Calendar."
        return f"The calendar server returned HTTP {code}."
    if isinstance(exc, httpx.HTTPError):
        return "Couldn't reach the calendar address. Check the internet connection."
    if isinstance(exc, ValueError):
        return "The address didn't return a calendar. Use the 'Secret address in iCal format'."
    return f"Unexpected error: {exc}"[:300]


def fetch_all(db: Session) -> dict:
    feeds = db.query(CalendarFeed).filter(CalendarFeed.enabled.is_(True)).all()
    results = {}
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        for feed in feeds:
            results[feed.id] = fetch_feed(db, feed, client)
    return results
