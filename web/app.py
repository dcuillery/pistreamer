"""pistreamer web UI — a friendly front end for the qbzd daemon.

Architecture, and why it is shaped this way:

    browser  ──password──>  this app (Pi)  ──>  qbzd 127.0.0.1:8182
                                           └──>  qbzd CLI (settings, login)

qbzd's HTTP API refuses any request carrying an Origin header (its "Origin
shield", verified: 200 without, 403 with). Browsers always send one
cross-origin, so the page cannot talk to qbzd directly — this app relays.

It also has no settings endpoints, so configuration shells out to the CLI.
That is why this app must run ON the Pi rather than anywhere else.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import (FileResponse, JSONResponse, RedirectResponse,
                               StreamingResponse)
from fastapi.staticfiles import StaticFiles

import qbzd
import system

STATIC = Path(__file__).parent / "static"
CONFIG = Path(os.environ.get("PISTREAMER_WEB_CONFIG", "/etc/pistreamer/web.json"))
SESSION_COOKIE = "pistreamer_session"
SESSION_MAX_AGE = 30 * 24 * 3600  # 30 days


def _load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        # No config yet: generate an ephemeral secret so the app still starts.
        # Auth is then effectively disabled, which the UI surfaces as a warning.
        return {"password_hash": None, "salt": None, "secret": secrets.token_hex(32)}


CFG = _load_config()
app = FastAPI(title="pistreamer", docs_url=None, redoc_url=None, openapi_url=None)


# --------------------------------------------------------------------------
# Authentication — signed cookie, no third-party session library
# --------------------------------------------------------------------------

def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt),
                               200_000).hex()


def _sign(value: str) -> str:
    mac = hmac.new(CFG["secret"].encode(), value.encode(), hashlib.sha256).hexdigest()
    return f"{value}.{mac}"


def _verify(token: str) -> bool:
    value, _, mac = token.rpartition(".")
    if not value or not mac:
        return False
    expected = hmac.new(CFG["secret"].encode(), value.encode(),
                        hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expected):
        return False
    try:
        return int(value) + SESSION_MAX_AGE > time.time()
    except ValueError:
        return False


def auth_required(request: Request) -> None:
    if not CFG.get("password_hash"):
        return  # no password configured; the UI shows a prominent warning
    token = request.cookies.get(SESSION_COOKIE, "")
    if not _verify(token):
        raise HTTPException(status_code=401, detail="not authenticated")


@app.post("/api/login")
async def login(request: Request) -> Response:
    body = await request.json()
    password = str(body.get("password", ""))
    if not CFG.get("password_hash"):
        return JSONResponse({"ok": True, "note": "no password configured"})
    # compare_digest keeps the check constant-time
    ok = hmac.compare_digest(_hash(password, CFG["salt"]), CFG["password_hash"])
    if not ok:
        raise HTTPException(status_code=401, detail="wrong password")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(SESSION_COOKIE, _sign(str(int(time.time()))),
                    max_age=SESSION_MAX_AGE, httponly=True, samesite="strict")
    return resp


# --------------------------------------------------------------------------
# First-run password claim
# --------------------------------------------------------------------------
# Accepted ONLY while no password exists. That is the whole safety property:
# the device can be claimed once, by whoever reaches it first on the LAN, and
# never again without authenticating. Leaving a freshly provisioned streamer
# unclaimed on an untrusted network is therefore the risk to avoid — the UI
# says so on the setup screen.

@app.post("/api/setup-password")
async def setup_password(request: Request) -> Response:
    if CFG.get("password_hash"):
        raise HTTPException(status_code=409,
                            detail="a password is already configured")
    body = await request.json()
    password = str(body.get("password", ""))
    if len(password) < 8:
        raise HTTPException(status_code=400,
                            detail="password must be at least 8 characters")
    try:
        CFG.update(system.write_password(CONFIG, password))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"cannot write config: {exc}")

    resp = JSONResponse({"ok": True})
    resp.set_cookie(SESSION_COOKIE, _sign(str(int(time.time()))),
                    max_age=SESSION_MAX_AGE, httponly=True, samesite="strict")
    return resp


@app.post("/api/password", dependencies=[Depends(auth_required)])
async def change_password(request: Request) -> dict:
    body = await request.json()
    current = str(body.get("current", ""))
    new = str(body.get("new", ""))
    if CFG.get("password_hash"):
        if not hmac.compare_digest(system.hash_password(current, CFG["salt"]),
                                   CFG["password_hash"]):
            raise HTTPException(status_code=401, detail="wrong current password")
    if len(new) < 8:
        raise HTTPException(status_code=400,
                            detail="password must be at least 8 characters")
    try:
        CFG.update(system.write_password(CONFIG, new))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"cannot write config: {exc}")
    return {"ok": True}


# --------------------------------------------------------------------------
# Wi-Fi
# --------------------------------------------------------------------------

@app.get("/api/wifi/status", dependencies=[Depends(auth_required)])
async def wifi_status() -> dict:
    try:
        return await system.wifi_status()
    except system.SystemError_ as exc:
        return {"ok": False, "error": str(exc)}


@app.get("/api/wifi/scan", dependencies=[Depends(auth_required)])
async def wifi_scan() -> dict:
    try:
        return {"ok": True, "networks": await system.wifi_scan()}
    except system.SystemError_ as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/wifi", dependencies=[Depends(auth_required)])
async def wifi_connect(request: Request) -> dict:
    """Switch networks. The helper restores the previous profile if the new one
    fails, so a wrong passphrase does not strand the device — but a *successful*
    move to a different network still changes the address you reach it on."""
    body = await request.json()
    ssid = str(body.get("ssid", "")).strip()
    passphrase = str(body.get("passphrase", ""))
    if not ssid:
        raise HTTPException(status_code=400, detail="SSID is required")
    try:
        return await system.wifi_connect(ssid, passphrase)
    except system.SystemError_ as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/logout")
async def logout_session() -> Response:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE)
    return resp


@app.get("/api/session")
async def session(request: Request) -> dict:
    return {
        "authenticated": not CFG.get("password_hash")
                          or _verify(request.cookies.get(SESSION_COOKIE, "")),
        "password_configured": bool(CFG.get("password_hash")),
    }


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

@app.get("/api/state", dependencies=[Depends(auth_required)])
async def state() -> dict:
    """Everything the dashboard needs, in one round trip."""
    out: dict = {"daemon": None, "settings": {}, "devices": [], "health": {},
                 "errors": []}
    try:
        out["daemon"] = await qbzd.status()
    except Exception as exc:  # daemon down is a normal, displayable state
        out["errors"].append(f"daemon unreachable: {exc}")
    try:
        out["settings"] = await qbzd.settings_show()
    except Exception as exc:
        out["errors"].append(f"settings unavailable: {exc}")
    out["devices"] = qbzd.list_devices()
    out["health"] = await qbzd.health()
    out["choices"] = {"quality": qbzd.QUALITY_CHOICES,
                      "volume_mode": qbzd.VOLUME_MODES}
    return out


@app.get("/api/events", dependencies=[Depends(auth_required)])
async def events() -> StreamingResponse:
    return StreamingResponse(qbzd.events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@app.get("/api/artwork", dependencies=[Depends(auth_required)])
async def artwork() -> Response:
    got = await qbzd.artwork()
    if not got:
        return Response(status_code=404)
    data, content_type = got
    return Response(data, media_type=content_type,
                    headers={"Cache-Control": "no-store"})


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

@app.post("/api/settings", dependencies=[Depends(auth_required)])
async def update_settings(request: Request) -> dict:
    body = await request.json()
    applied, failed = [], {}
    for key, value in body.items():
        try:
            await qbzd.settings_set(str(key), str(value))
            applied.append(key)
        except qbzd.QbzdError as exc:
            failed[key] = str(exc)
    return {"applied": applied, "failed": failed,
            "settings": await qbzd.settings_show()}


@app.post("/api/qobuz/login", dependencies=[Depends(auth_required)])
async def qobuz_login(request: Request) -> dict:
    host = request.url.hostname
    try:
        return {"url": await qbzd.login_url(callback_host=host)}
    except qbzd.QbzdError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/qobuz/logout", dependencies=[Depends(auth_required)])
async def qobuz_logout() -> dict:
    await qbzd.logout()
    return {"ok": True}


# --------------------------------------------------------------------------
# Transport
# --------------------------------------------------------------------------

_ACTIONS = {"play", "pause", "toggle", "stop", "next", "prev"}


@app.post("/api/playback/{action}", dependencies=[Depends(auth_required)])
async def transport(action: str) -> dict:
    if action not in _ACTIONS:
        raise HTTPException(status_code=400, detail="unknown action")
    try:
        await qbzd.playback(action)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True}


# --------------------------------------------------------------------------
# DAC hardware volume
# --------------------------------------------------------------------------
# qbzd's own volume is inert here — see system.py for why. These two endpoints
# drive the DAC's mixer directly, which actually changes the level and keeps
# the output bit-perfect.

@app.get("/api/hwvolume", dependencies=[Depends(auth_required)])
async def hwvolume_get() -> dict:
    settings = await qbzd.settings_show()
    return await system.mixer_status(settings.get("audio.device", ""))


@app.post("/api/hwvolume", dependencies=[Depends(auth_required)])
async def hwvolume_set(request: Request) -> dict:
    body = await request.json()
    try:
        percent = int(round(float(body["percent"])))
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="percent must be a number")
    settings = await qbzd.settings_show()
    try:
        return await system.mixer_set(settings.get("audio.device", ""), percent)
    except system.SystemError_ as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.post("/api/volume", dependencies=[Depends(auth_required)])
async def volume(request: Request) -> dict:
    body = await request.json()
    try:
        level = float(body["volume"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="volume must be a number")
    if not 0.0 <= level <= 1.0:
        raise HTTPException(status_code=400, detail="volume must be 0.0–1.0")
    try:
        await qbzd.set_volume(level)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True}


# --------------------------------------------------------------------------
# Static
# --------------------------------------------------------------------------

@app.get("/")
async def index() -> Response:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
