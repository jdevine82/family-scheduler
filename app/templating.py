from fastapi.templating import Jinja2Templates

from app.config import APP_DIR

templates = Jinja2Templates(directory=str(APP_DIR / "templates"))

# Bump when static files change so browsers (and the wall kiosk) fetch fresh copies.
ASSET_VERSION = "16"
templates.env.globals["v"] = ASSET_VERSION
