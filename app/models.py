import datetime

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Table,
    Text,
    Time,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

KIND_FIXED = "fixed"
KIND_FLEXIBLE = "flexible"

# Check-in answers stored on a flexible event / occurrence
CHECK_DONE = "done"
CHECK_UNDERWAY = "underway"
CHECK_RESCHEDULED = "rescheduled"
CHECK_STATUSES = (CHECK_DONE, CHECK_UNDERWAY, CHECK_RESCHEDULED)

TASK_OPEN = "open"
TASK_SCHEDULED = "scheduled"
TASK_UNDERWAY = "underway"
TASK_DONE = "done"

CHIME_DEFAULT = "default"
CHIME_CHOICES = ("default", "on", "off")


def _now() -> datetime.datetime:
    return datetime.datetime.now()


event_members = Table(
    "event_members",
    Base.metadata,
    Column("event_id", ForeignKey("events.id", ondelete="CASCADE"), primary_key=True),
    Column("member_id", ForeignKey("members.id", ondelete="CASCADE"), primary_key=True),
)

recurring_members = Table(
    "recurring_members",
    Base.metadata,
    Column("recurring_id", ForeignKey("recurring_activities.id", ondelete="CASCADE"), primary_key=True),
    Column("member_id", ForeignKey("members.id", ondelete="CASCADE"), primary_key=True),
)


class Member(Base):
    __tablename__ = "members"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(60))
    short_label: Mapped[str] = mapped_column(String(8), default="")
    color_hex: Mapped[str] = mapped_column(String(7))
    chime_sound: Mapped[str] = mapped_column(String(32), default="bells")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now)
    # Pocket money
    is_child: Mapped[bool] = mapped_column(Boolean, default=False)
    allowance_cents: Mapped[int] = mapped_column(Integer, default=0)
    allowance_weekday: Mapped[int] = mapped_column(Integer, default=5)  # Saturday
    allowance_since: Mapped[datetime.date | None] = mapped_column(Date)

    feeds: Mapped[list["CalendarFeed"]] = relationship(back_populates="member", cascade="all, delete-orphan")


class Event(Base):
    """A one-off item on the calendar (possibly spanning several days)."""

    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str] = mapped_column(Text, default="")
    location: Mapped[str] = mapped_column(String(200), default="")
    date: Mapped[datetime.date] = mapped_column(Date, index=True)
    end_date: Mapped[datetime.date | None] = mapped_column(Date)  # multi-day all-day items
    start_time: Mapped[datetime.time | None] = mapped_column(Time)
    end_time: Mapped[datetime.time | None] = mapped_column(Time)
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    is_everyone: Mapped[bool] = mapped_column(Boolean, default=False)
    kind: Mapped[str] = mapped_column(String(10), default=KIND_FIXED)
    check_status: Mapped[str | None] = mapped_column(String(12))
    checked_at: Mapped[datetime.datetime | None] = mapped_column(DateTime)
    checked_by_member_id: Mapped[int | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    chime: Mapped[str] = mapped_column(String(8), default=CHIME_DEFAULT)
    remind_minutes: Mapped[int | None] = mapped_column(Integer)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    money_job_id: Mapped[int | None] = mapped_column(ForeignKey("money_jobs.id", ondelete="SET NULL"), index=True)
    # Label of the Google calendar this was copied from (editing a Google event makes a local copy).
    from_google: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    members: Mapped[list[Member]] = relationship(secondary=event_members, order_by=Member.sort_order)
    task: Mapped["Task | None"] = relationship(back_populates="events")
    money_job: Mapped["MoneyJob | None"] = relationship()


class RecurringActivity(Base):
    """A weekly rule, expanded into occurrences when the calendar is drawn."""

    __tablename__ = "recurring_activities"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str] = mapped_column(Text, default="")
    location: Mapped[str] = mapped_column(String(200), default="")
    weekdays: Mapped[str] = mapped_column(String(20))  # "0,1,4" — Monday is 0
    start_time: Mapped[datetime.time | None] = mapped_column(Time)
    end_time: Mapped[datetime.time | None] = mapped_column(Time)
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    interval_weeks: Mapped[int] = mapped_column(Integer, default=1)
    anchor_date: Mapped[datetime.date] = mapped_column(Date)  # fortnightly parity is counted from this week
    valid_from: Mapped[datetime.date] = mapped_column(Date)
    valid_until: Mapped[datetime.date | None] = mapped_column(Date)
    is_everyone: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    kind: Mapped[str] = mapped_column(String(10), default=KIND_FIXED)
    chime: Mapped[str] = mapped_column(String(8), default=CHIME_DEFAULT)
    remind_minutes: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    members: Mapped[list[Member]] = relationship(secondary=recurring_members, order_by=Member.sort_order)
    overrides: Mapped[list["OccurrenceOverride"]] = relationship(
        back_populates="activity", cascade="all, delete-orphan"
    )

    @property
    def weekday_list(self) -> list[int]:
        return sorted(int(d) for d in self.weekdays.split(",") if d.strip() != "")


class OccurrenceOverride(Base):
    """A change to (or a check-in answer for) one occurrence of a recurring activity."""

    __tablename__ = "occurrence_overrides"
    __table_args__ = (UniqueConstraint("recurring_id", "original_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    recurring_id: Mapped[int] = mapped_column(ForeignKey("recurring_activities.id", ondelete="CASCADE"))
    original_date: Mapped[datetime.date] = mapped_column(Date)
    action: Mapped[str] = mapped_column(String(10), default="none")  # none | skip | modify
    new_date: Mapped[datetime.date | None] = mapped_column(Date)
    new_start_time: Mapped[datetime.time | None] = mapped_column(Time)
    new_end_time: Mapped[datetime.time | None] = mapped_column(Time)
    new_title: Mapped[str | None] = mapped_column(String(200))
    new_notes: Mapped[str | None] = mapped_column(Text)
    check_status: Mapped[str | None] = mapped_column(String(12))
    checked_at: Mapped[datetime.datetime | None] = mapped_column(DateTime)
    checked_by_member_id: Mapped[int | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))

    activity: Mapped[RecurringActivity] = relationship(back_populates="overrides")


class CalendarFeed(Base):
    __tablename__ = "calendar_feeds"

    id: Mapped[int] = mapped_column(primary_key=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("members.id", ondelete="CASCADE"))
    label: Mapped[str] = mapped_column(String(100))
    ical_url: Mapped[str] = mapped_column(Text)  # secret — never rendered on public pages
    busy_only: Mapped[bool] = mapped_column(Boolean, default=False)
    chime: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_fetched_at: Mapped[datetime.datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str | None] = mapped_column(Text)

    member: Mapped[Member] = relationship(back_populates="feeds")
    events: Mapped[list["ExternalEvent"]] = relationship(back_populates="feed", cascade="all, delete-orphan")


class ExternalEvent(Base):
    """Cache of events read from a CalendarFeed; rebuilt on every fetch."""

    __tablename__ = "external_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    feed_id: Mapped[int] = mapped_column(ForeignKey("calendar_feeds.id", ondelete="CASCADE"), index=True)
    uid: Mapped[str] = mapped_column(String(255))
    title: Mapped[str] = mapped_column(String(255))
    location: Mapped[str] = mapped_column(String(255), default="")
    start_at: Mapped[datetime.datetime] = mapped_column(DateTime, index=True)  # local naive
    end_at: Mapped[datetime.datetime] = mapped_column(DateTime)  # exclusive; midnight for all-day
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)

    feed: Mapped[CalendarFeed] = relationship(back_populates="events")


class HiddenExternal(Base):
    """A Google event occurrence that has been edited (copied into an Event) or deleted here.

    Keyed by UID + start, because ExternalEvent rows are rebuilt on every fetch.
    """

    __tablename__ = "hidden_external"
    __table_args__ = (UniqueConstraint("feed_id", "uid", "start_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    feed_id: Mapped[int] = mapped_column(ForeignKey("calendar_feeds.id", ondelete="CASCADE"), index=True)
    uid: Mapped[str] = mapped_column(String(255))
    start_at: Mapped[datetime.datetime] = mapped_column(DateTime)
    title: Mapped[str] = mapped_column(String(255), default="")  # for the Restore list in Settings
    copied: Mapped[bool] = mapped_column(Boolean, default=False)  # edited into a planner item, not just removed

    feed: Mapped[CalendarFeed] = relationship()


class TaskFolder(Base):
    __tablename__ = "task_folders"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    color_hex: Mapped[str | None] = mapped_column(String(7))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    tasks: Mapped[list["Task"]] = relationship(
        back_populates="folder", cascade="all, delete-orphan", order_by="Task.sort_order"
    )


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int] = mapped_column(ForeignKey("task_folders.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str] = mapped_column(Text, default="")
    default_member_id: Mapped[int | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    est_duration_minutes: Mapped[int] = mapped_column(Integer, default=60)
    kind: Mapped[str] = mapped_column(String(10), default=KIND_FLEXIBLE)
    status: Mapped[str] = mapped_column(String(10), default=TASK_OPEN)
    reschedule_count: Mapped[int] = mapped_column(Integer, default=0)
    done_at: Mapped[datetime.datetime | None] = mapped_column(DateTime)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    folder: Mapped[TaskFolder] = relationship(back_populates="tasks")
    events: Mapped[list[Event]] = relationship(back_populates="task", order_by=Event.date)


class TaskLog(Base):
    __tablename__ = "task_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    event_id: Mapped[int | None] = mapped_column(ForeignKey("events.id", ondelete="SET NULL"))
    recurring_id: Mapped[int | None] = mapped_column(ForeignKey("recurring_activities.id", ondelete="CASCADE"))
    member_id: Mapped[int | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(20))
    from_at: Mapped[datetime.datetime | None] = mapped_column(DateTime)
    to_at: Mapped[datetime.datetime | None] = mapped_column(DateTime)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


# ---------------------------------------------------------------- pocket money

class MoneyJob(Base):
    """A paid job children can book into their schedule."""

    __tablename__ = "money_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str] = mapped_column(Text, default="")
    amount_cents: Mapped[int] = mapped_column(Integer)
    est_minutes: Mapped[int] = mapped_column(Integer, default=30)
    for_member_id: Mapped[int | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now)


class MoneyTxn(Base):
    __tablename__ = "money_txns"
    __table_args__ = (UniqueConstraint("member_id", "kind", "period_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("members.id", ondelete="CASCADE"), index=True)
    amount_cents: Mapped[int] = mapped_column(Integer)  # + credit, - debit
    kind: Mapped[str] = mapped_column(String(12))  # income | job | fine | withdrawal
    description: Mapped[str] = mapped_column(String(300), default="")
    event_id: Mapped[int | None] = mapped_column(ForeignKey("events.id", ondelete="SET NULL"))
    period_date: Mapped[datetime.date | None] = mapped_column(Date)  # payday, for income only
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=_now)
