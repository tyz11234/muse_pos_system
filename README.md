# CNKH POS 2.0 (muse_pos_system)

Server-authoritative POS for CHOP NG KIM HUAT. One FastAPI + SQLite backend
is the single source of truth; one zero-dependency web client serves phone,
tablet and desktop; thin shells (Capacitor / Electron) wrap the same client
for APK / IPA / EXE.

## Layout
- `server/` — FastAPI backend (`main.py`, single file) + `requirements.txt`
- `site/` — the web client (plain HTML/CSS/JS, no build step)
- `deploy/` — systemd unit, env template, Nginx location snippet
- `desktop/` — Electron shell for the Windows EXE
- `capacitor.config.json` + `package.json` — Android/iOS shell config
- `.github/workflows/build-shells.yml` — CI builds for APK, unsigned IPA, EXE

## Run the server
```bash
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
cp deploy/pos2.env.example pos2.env   # fill in real values
POS2_ENV=pos2.env .venv/bin/python -m uvicorn server.main:app --port 8091
```
(Production uses the systemd unit in `deploy/`.)

First run seeds an admin and a staff account — see the seed section in
`server/main.py`. Change the seed PINs in 账号管理 immediately after install.

## Features
PIN login with ADMIN/STAFF roles (server-enforced), POS checkout (cash /
DuitNow QR / card / credit), DuitNow dynamic QR (amount-locked), live
payment-arrival broadcast + auto-settle from the Public Bank email pipeline
(ai_helper), payment records, held orders, customers & credit with repay,
products & stocktake, suppliers & purchases with OCR assist, sales reports,
day closing, training mode, CSV/JSON exports, barcode label printing.

## Shells
The shells load the server URL from `capacitor.config.json` / `desktop/main.js`
— business logic ships once, in `site/`. CI produces a debug APK, an
**unsigned** IPA (sign it yourself for your iPhone) and a portable EXE.
