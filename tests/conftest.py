import os
import tempfile

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_PATH"] = os.path.join(_tmp, "test.db")
os.environ["ENABLE_BACKGROUND_TASKS"] = "0"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Member, TaskFolder  # noqa: E402


@pytest.fixture()
def db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture()
def family(db):
    members = [Member(name=n, color_hex=c, sort_order=i)
               for i, (n, c) in enumerate([("Mum", "#DB2777"), ("Dad", "#2563EB"), ("Sam", "#65A30D")])]
    db.add_all(members)
    db.add(TaskFolder(name="House", sort_order=0))
    db.commit()
    return {m.name: m.id for m in members}


@pytest.fixture()
def client(db):
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def admin(client, family):
    # No logins any more: anyone on the network can edit the calendar.
    return client
