from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import DATABASE_URL

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


class Base(DeclarativeBase):
    pass


# No migration framework — create_all() only adds missing tables, never
# columns, so new nullable columns on existing tables are listed here and
# added in place on startup.
ADDED_COLUMNS: list[tuple[str, str, str]] = [
    ("members", "is_child", "BOOLEAN NOT NULL DEFAULT 0"),
    ("members", "allowance_cents", "INTEGER NOT NULL DEFAULT 0"),
    ("members", "allowance_weekday", "INTEGER NOT NULL DEFAULT 5"),
    ("members", "allowance_since", "DATE"),
    ("events", "money_job_id", "INTEGER REFERENCES money_jobs(id) ON DELETE SET NULL"),
    ("events", "from_google", "VARCHAR(100)"),
    ("hidden_external", "title", "VARCHAR(255) NOT NULL DEFAULT ''"),
    ("hidden_external", "copied", "BOOLEAN NOT NULL DEFAULT 0"),
]


def add_missing_columns() -> None:
    with engine.begin() as conn:
        for table, column, ddl in ADDED_COLUMNS:
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            if existing and column not in existing:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
