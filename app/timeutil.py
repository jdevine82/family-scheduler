import datetime
from zoneinfo import ZoneInfo

from app.config import TIMEZONE

TZ = ZoneInfo(TIMEZONE)


def now_local() -> datetime.datetime:
    """Current local wall-clock time, naive (matches how times are stored)."""
    return datetime.datetime.now(TZ).replace(tzinfo=None, microsecond=0)


def today_local() -> datetime.date:
    return now_local().date()


def parse_date(value: str | None) -> datetime.date | None:
    if not value:
        return None
    return datetime.date.fromisoformat(value)


def parse_time(value: str | None) -> datetime.time | None:
    if not value:
        return None
    return datetime.time.fromisoformat(value)


def fmt_time(t: datetime.time | None) -> str | None:
    return t.strftime("%H:%M") if t else None


def add_minutes(t: datetime.time, minutes: int) -> datetime.time:
    """Add minutes to a time, capped at 23:59 so it never wraps to the next day."""
    total = min(t.hour * 60 + t.minute + minutes, 23 * 60 + 59)
    return datetime.time(total // 60, total % 60)


def minutes_between(a: datetime.time, b: datetime.time) -> int:
    return (b.hour * 60 + b.minute) - (a.hour * 60 + a.minute)


def human_when(d: datetime.date, t: datetime.time | None) -> str:
    """e.g. 'Fri 16 Oct · 4:00 pm'."""
    day = f"{d:%a} {d.day} {d:%b}"
    if t is None:
        return day
    hour = t.hour % 12 or 12
    return f"{day} · {hour}:{t.minute:02d} {'pm' if t.hour >= 12 else 'am'}"
