# Installing Devine Family Planner

## Prerequisites

- Python 3.11 or newer (developed on 3.14)
- For the wall: a touchscreen running Chromium/Chrome in kiosk mode (for example a Raspberry Pi or mini-PC on a touch monitor)

## 1. Get the code onto the server

Copy the folder to the server, for example `/opt/family-scheduler`.

## 2. Create a virtual environment and install dependencies

```bash
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

## 3. Configure

```bash
cp .env.example .env
```

| Variable | Required | Notes |
|---|---|---|
| `SESSION_SECRET` | **Yes** | Signs login cookies. Generate one with `python3 -c "import secrets; print(secrets.token_hex(32))"`. |
| `DATABASE_PATH` | No | Defaults to `./family_scheduler.db`. |
| `TIMEZONE` | No | Defaults to `Australia/Sydney`. All times are shown in this zone. |

## 4. Create the database

```bash
.venv/bin/python -m app.seed               # or: --pin 4821 to set the parent PIN now
```

To try it out with an example family (Mum, Dad, Sam, Ella), routines, tasks and pocket money, add `--demo`. The demo parent PIN is `1234`.

Then open **⚙ Settings**. The first time, it asks you to **choose the parent PIN**. After that it asks for the PIN each time. Then:

1. **Family members**: add everyone and pick colours and chimes. Paste each person's Google **Secret address in iCal format**.
2. **Display & chimes**: day view hours, view switching, night dimming and quiet hours.
3. On the **💰 Money** tab, open **Money setup** to mark the children, set weekly money and add paid jobs.

## 5. Run it

Development:

```bash
.venv/bin/uvicorn app.main:app --reload --port 8420
```

Production with systemd: edit the paths and user in `deploy/family-scheduler.service`, then run:

```bash
sudo cp deploy/family-scheduler.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now family-scheduler
journalctl -u family-scheduler -f
```

## 6. Set up the wall display

Point Chromium at `http://<server>:8420/display` in kiosk mode, with sound allowed without a tap:

```bash
chromium --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 http://<server>:8420/display
```

Sound is on by default (the 🔊 button mutes it). Without `--autoplay-policy=no-user-gesture-required`, the browser holds sound back until someone touches the screen once, and the speaker button shows an amber dot until then.

Turn off the OS screen blanking. The page asks the browser to keep the screen awake, and dims itself at night.

## Security notes

- There are no logins: anyone who can reach the app can view and change the calendar and tasks. This is meant for the **home network only**. Don't expose it to the internet without a password-protected reverse proxy in front of it.
- Settings and pocket money parent actions need the parent PIN. It's stored hashed, stays unlocked for 5 minutes in that browser, and 5 wrong tries lock it for a minute.
- Google feed addresses are secrets. They're kept only in the database, never shown on the wall, and never written to logs.

## Tests

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```
