import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
APP_DIR = Path(__file__).resolve().parent

SESSION_SECRET = os.environ.get("SESSION_SECRET", "dev-secret-change-me")
DATABASE_PATH = os.environ.get("DATABASE_PATH", str(BASE_DIR / "family_scheduler.db"))
DATABASE_URL = f"sqlite:///{DATABASE_PATH}"

# All calendar times are stored as naive local times in this zone.
TIMEZONE = os.environ.get("TIMEZONE", "Australia/Sydney")

# Set to "0" in tests so the Google feed poller doesn't start.
ENABLE_BACKGROUND_TASKS = os.environ.get("ENABLE_BACKGROUND_TASKS", "1") == "1"
