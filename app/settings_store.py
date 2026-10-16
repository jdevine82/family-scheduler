from sqlalchemy.orm import Session

from app.models import Setting

DEFAULTS: dict[str, str] = {
    "family_name": "Family Calendar",
    "display_start_hour": "6",
    "display_end_hour": "21",
    "week_starts_on": "0",  # 0 = Monday, 6 = Sunday
    "week_layout": "agenda",  # agenda | grid
    "display_rotate_seconds": "0",  # 0 = don't rotate
    "display_rotate_views": "day,week",
    "night_dim_start": "21:00",
    "night_dim_end": "06:00",
    "default_task_time": "09:00",
    "checkin_lookback_days": "14",
    "checkin_on_display": "1",
    "feed_poll_minutes": "15",
    "feed_window_months": "12",
    "chime_enabled": "1",
    "chime_volume": "70",
    "chime_google_events": "0",
    "quiet_start": "20:30",
    "quiet_end": "07:00",
}


def get_setting(db: Session, key: str) -> str:
    row = db.get(Setting, key)
    if row is not None:
        return row.value
    return DEFAULTS.get(key, "")


def get_int(db: Session, key: str) -> int:
    try:
        return int(get_setting(db, key))
    except ValueError:
        return int(DEFAULTS[key])


def set_setting(db: Session, key: str, value: str) -> None:
    row = db.get(Setting, key)
    if row is None:
        db.add(Setting(key=key, value=value))
    else:
        row.value = value


def all_settings(db: Session) -> dict[str, str]:
    values = dict(DEFAULTS)
    for row in db.query(Setting).all():
        values[row.key] = row.value
    return values


def public_settings(db: Session) -> dict:
    """Settings the browser needs to draw the calendar and run chimes."""
    s = all_settings(db)
    return {
        "family_name": s["family_name"],
        "start_hour": int(s["display_start_hour"]),
        "end_hour": int(s["display_end_hour"]),
        "week_starts_on": int(s["week_starts_on"]),
        "week_layout": s["week_layout"],
        "rotate_seconds": int(s["display_rotate_seconds"]),
        "rotate_views": [v for v in s["display_rotate_views"].split(",") if v],
        "night_dim_start": s["night_dim_start"],
        "night_dim_end": s["night_dim_end"],
        "default_task_time": s["default_task_time"],
        "checkin_on_display": s["checkin_on_display"] == "1",
        "chime_enabled": s["chime_enabled"] == "1",
        "chime_volume": int(s["chime_volume"]),
        "quiet_start": s["quiet_start"],
        "quiet_end": s["quiet_end"],
    }
