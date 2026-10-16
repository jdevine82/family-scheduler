import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app import feeds, money
from app.config import APP_DIR, ENABLE_BACKGROUND_TASKS, SESSION_SECRET
from app.database import Base, SessionLocal, add_missing_columns, engine
from app.routers import api, money as money_router, pages, settings
from app.settings_store import get_int

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    Base.metadata.create_all(bind=engine)
    add_missing_columns()
    task = asyncio.create_task(_feed_loop()) if ENABLE_BACKGROUND_TASKS else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Family Scheduler", lifespan=lifespan)

# The session cookie only carries the short parent-PIN unlock.
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET, https_only=False, max_age=60 * 60 * 24 * 180)
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")

app.include_router(pages.router)
app.include_router(api.router)
app.include_router(settings.router)
app.include_router(money_router.router)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    # Turn pydantic's error list into one readable sentence for the toast.
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", [])[1:]) or "request"
    return JSONResponse({"detail": f"Check the {field} field: {first.get('msg', 'invalid value')}."}, status_code=422)


async def _feed_loop():
    while True:
        db = SessionLocal()
        try:
            minutes = get_int(db, "feed_poll_minutes")
            try:
                await asyncio.to_thread(money.pay_income, db)
            except Exception:
                logger.exception("Paying weekly pocket money failed")
            try:
                result = await asyncio.to_thread(feeds.fetch_all, db)
                if result:
                    logger.info("Calendar feeds refreshed: %s", result)
            except Exception:
                logger.exception("Calendar feed refresh failed")
        finally:
            db.close()
        await asyncio.sleep(max(minutes, 5) * 60)


