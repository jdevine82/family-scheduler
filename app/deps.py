"""Access rules. There are no user logins: the calendar is open on the home network,
and Settings plus pocket money parent actions need the parent PIN."""

import time
from urllib.parse import quote

from fastapi import HTTPException, Request, status

# Set by a correct parent PIN (POST /api/money/unlock or /settings/unlock).
PARENT_UNLOCK_KEY = "parent_unlocked_until"
PARENT_UNLOCK_SECONDS = 5 * 60


def parent_unlocked(request: Request) -> bool:
    return float(request.session.get(PARENT_UNLOCK_KEY, 0) or 0) > time.time()


def unlock_parent(request: Request) -> None:
    request.session[PARENT_UNLOCK_KEY] = time.time() + PARENT_UNLOCK_SECONDS


def lock_parent(request: Request) -> None:
    request.session.pop(PARENT_UNLOCK_KEY, None)


def require_parent(request: Request) -> None:
    """API parent actions. The unlock slides forward while a parent keeps using it."""
    if not parent_unlocked(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Parent PIN needed")
    unlock_parent(request)


def require_parent_page(request: Request) -> None:
    """Settings pages: send to the PIN page, then back."""
    if not parent_unlocked(request):
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER,
                            headers={"Location": f"/settings/unlock?next={quote(request.url.path)}"})
    unlock_parent(request)
