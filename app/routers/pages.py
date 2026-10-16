from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.settings_store import get_setting
from app.templating import templates
from app.timeutil import today_local

router = APIRouter()


def _ctx(db: Session, **extra) -> dict:
    return {"family_name": get_setting(db, "family_name"), "today": today_local().isoformat(), **extra}


@router.get("/")
def app_page(request: Request, db: Session = Depends(get_db)):
    return templates.TemplateResponse(request, "app.html", _ctx(db))


@router.get("/login")
def old_login():
    # There are no logins any more; old bookmarks land on the calendar.
    return RedirectResponse("/", status_code=303)


@router.get("/display")
def display_page(request: Request, db: Session = Depends(get_db)):
    return templates.TemplateResponse(request, "display.html", _ctx(db))


@router.get("/checkin")
def checkin_page(request: Request, db: Session = Depends(get_db)):
    return templates.TemplateResponse(request, "checkin.html", _ctx(db))


@router.get("/manifest.webmanifest")
def manifest(db: Session = Depends(get_db)):
    name = get_setting(db, "family_name")
    return JSONResponse(
        {
            "name": name,
            "short_name": name[:12],
            "start_url": "/",
            "display": "standalone",
            "background_color": "#FBFCFD",
            "theme_color": "#1095C1",
            "icons": [{"src": "/static/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}],
        },
        media_type="application/manifest+json",
    )
