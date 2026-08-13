"""System-level operations: Wi-Fi configuration and the web password store.

Wi-Fi changes go through /usr/local/sbin/pistreamer-net, invoked via a narrowly
scoped sudo rule. The service user cannot modify NetworkManager connections
directly ("Insufficient privileges"), and granting it blanket nmcli access
would be a much wider surface than three fixed subcommands.

The passphrase is written to the helper's STDIN, never passed as an argument:
argv is world-readable through `ps`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import secrets
from pathlib import Path
from typing import Any

HELPER = "/usr/local/sbin/pistreamer-net"
PBKDF2_ROUNDS = 200_000


class SystemError_(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Wi-Fi
# --------------------------------------------------------------------------

def _split_nmcli(line: str) -> list[str]:
    """Split one `nmcli -t` record. Literal colons inside a value are escaped
    as '\\:', so a naive split() mangles any SSID containing one."""
    fields, buf, esc = [], [], False
    for ch in line:
        if esc:
            buf.append(ch)
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == ":":
            fields.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    fields.append("".join(buf))
    return fields


async def _helper_raw(*args: str, timeout: float = 60) -> str:
    proc = await asyncio.create_subprocess_exec(
        "sudo", "-n", HELPER, *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise SystemError_("network helper timed out")
    if proc.returncode != 0:
        raise SystemError_(err.decode(errors="replace").strip() or "helper failed")
    return out.decode(errors="replace")


async def _helper(*args: str, stdin: str | None = None,
                  timeout: float = 60) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        "sudo", "-n", HELPER, *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(
            proc.communicate(stdin.encode() if stdin is not None else None),
            timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise SystemError_("network helper timed out")

    text = out.decode(errors="replace").strip()
    if not text:
        raise SystemError_(err.decode(errors="replace").strip() or "no output")
    try:
        return json.loads(text)
    except ValueError:
        raise SystemError_(text[:300])


async def wifi_scan() -> list[dict[str, Any]]:
    """Parse `nmcli -t -f SSID,SIGNAL,SECURITY`, keeping the strongest reading
    per SSID — a mesh network appears once per access point otherwise."""
    text = await _helper_raw("scan", timeout=45)
    best: dict[str, dict[str, Any]] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = _split_nmcli(line)
        if len(parts) < 3 or not parts[0]:
            continue  # hidden networks report an empty SSID
        try:
            signal = int(parts[1])
        except ValueError:
            signal = 0
        entry = {"ssid": parts[0], "signal": signal, "security": parts[2] or ""}
        if parts[0] not in best or signal > best[parts[0]]["signal"]:
            best[parts[0]] = entry
    return sorted(best.values(), key=lambda n: n["signal"], reverse=True)


async def wifi_status() -> dict[str, Any]:
    return await _helper("status", timeout=20)


async def wifi_connect(ssid: str, passphrase: str) -> dict[str, Any]:
    if not ssid:
        raise SystemError_("SSID is required")
    return await _helper("connect", ssid, stdin=passphrase, timeout=90)


# --------------------------------------------------------------------------
# DAC hardware volume
# --------------------------------------------------------------------------
# qbzd cannot drive this DAC's volume: its ALSA engine only recognises
# controls named Master / PCM / Speaker / Headphone / Digital (visible in the
# binary), and an XMOS interface calls its control "XMOS Audio 2.0 Output".
# It also applies no software attenuation at all in hw+exclusive mode. So the
# volume slider was inert whatever the setting.
#
# Driving the mixer ourselves fixes that, and does it better than software
# volume would: attenuation happens INSIDE the DAC, so the samples we send are
# never altered and bit-perfect output is preserved. It is the same mechanism
# as a TEAC's "variable line output".
#
# No sudo: the service user can already write the mixer.

_SGET_PCT = re.compile(r"\[(\d{1,3})%\]")
_SGET_DB = re.compile(r"\[(-?\d+(?:\.\d+)?)dB\]")
_RANGE = re.compile(r"min=(-?\d+),max=(-?\d+)")
_DBRANGE = re.compile(r"dBminmax-min=(-?[\d.]+)dB,max=(-?[\d.]+)dB")

# --- Slider shape -----------------------------------------------------------
#
# The DAC's raw scale cannot be used directly: 0 to -127 dB over 127 steps puts
# -63 dB at half travel, so everything audible is crammed into the top fifth.
# Two tapers are available, both ending exactly on 0 dB at the top.
#
#   amplitude   dB = 20·log10(slider)
#               An analogue potentiometer: the slider IS the voltage ratio, so
#               half travel is -6 dB and zero travel is silence. Resolution
#               concentrates at the top on its own, with no artificial warping.
#
#   power       dB = bottom·(1 - slider)^CURVE
#               A straight line in dB when CURVE = 1, warped towards the top
#               above that. Useful for a deliberately narrow trim range —
#               bottom = -12 with CURVE = 1 gives 0.12 dB per point of travel.
#
# VOLUME_MIN_DB caps how far down the slider may reach. "auto" means the
# converter's own minimum, which is what makes 0% silence rather than merely
# quiet; a number caps it instead (e.g. -12 for a fine trim around unity).
_MIN_DB = os.environ.get("PISTREAMER_VOLUME_MIN_DB", "auto").strip().lower()
VOLUME_MIN_DB: float | None = None if _MIN_DB in ("", "auto") else float(_MIN_DB)
VOLUME_CURVE = max(0.2, float(os.environ.get("PISTREAMER_VOLUME_CURVE", "1.0")))
VOLUME_TAPER = os.environ.get("PISTREAMER_VOLUME_TAPER", "amplitude").strip().lower()


async def _amixer(*args: str, timeout: float = 10) -> str:
    proc = await asyncio.create_subprocess_exec(
        "amixer", *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise SystemError_("amixer timed out")
    if proc.returncode != 0:
        raise SystemError_(err.decode(errors="replace").strip() or "amixer failed")
    return out.decode(errors="replace")


def _card_of(device: str) -> str:
    """Strip the PCM sub-device from a device string.

    A mixer handle cannot parse DEV: `hw:CARD=X20,DEV=0` fails with
    "Unknown parameter DEV", while `hw:CARD=X20` opens correctly.
    """
    return (device or "").split(",DEV=")[0] or "default"


async def _volume_stages(card: str, control: str) -> list[dict[str, Any]]:
    """Every volume element belonging to a control, with its range.

    A control can span SEVERAL numids — a Rega DAC-R exposes
    `…Playback Volume` at index 0 (two channels) AND at index 1. They are in
    series, so leaving one down mutes the output however far up the other is.

    `amixer sset '<name>'` only ever writes index 0, which is exactly how one
    stage was left at -60 dB while the UI reported 0 dB and no sound came out.
    Every stage is therefore enumerated and driven together.

    Ranges come from ALSA itself (`min=0,max=127`,
    `dBminmax-min=-127.00dB,max=0.00dB`), never assumed. Passing dB straight to
    amixer is not reliable — this control snapped both -30dB and -12dB to -4dB
    — hence raw values and arithmetic of our own.
    """
    try:
        contents = await _amixer("-D", card, "contents")
    except SystemError_:
        return []

    stages: list[dict[str, Any]] = []
    for chunk in contents.split("numid="):
        # `scontrols` gives the short name ("XMOS Audio 2.0 Output"), while
        # `contents` spells it out ("… Playback Volume"), so match the prefix.
        if f"name='{control}" not in chunk or "Volume" not in chunk:
            continue
        nid = re.match(r"(\d+)", chunk)
        r, d = _RANGE.search(chunk), _DBRANGE.search(chunk)
        if not nid or not r:
            continue
        vals = re.search(r"^\s*: values=([\d,\-]+)", chunk, re.M)
        current = [int(v) for v in vals.group(1).split(",")] if vals else []
        stages.append({
            "numid": int(nid.group(1)),
            "count": len(current) or 1,
            "current": current,
            "raw_min": float(r.group(1)), "raw_max": float(r.group(2)),
            "db_min": float(d.group(1)) if d else None,
            "db_max": float(d.group(2)) if d else None,
        })
    return stages


async def _scale(card: str, control: str) -> dict[str, float] | None:
    stages = await _volume_stages(card, control)
    for st in stages:
        if st["db_min"] is not None and st["db_max"] is not None:
            return {"raw_min": st["raw_min"], "raw_max": st["raw_max"],
                    "db_min": st["db_min"], "db_max": st["db_max"]}
    return None


def _raw_to_db(raw: float, sc: dict[str, float]) -> float:
    span = sc["raw_max"] - sc["raw_min"]
    if span <= 0:
        return sc["db_max"]
    frac = (raw - sc["raw_min"]) / span
    return sc["db_min"] + frac * (sc["db_max"] - sc["db_min"])


def _db_to_raw(db: float, sc: dict[str, float]) -> int:
    dspan = sc["db_max"] - sc["db_min"]
    if dspan <= 0:
        return int(sc["raw_max"])
    frac = (db - sc["db_min"]) / dspan
    raw = sc["raw_min"] + frac * (sc["raw_max"] - sc["raw_min"])
    return int(round(max(sc["raw_min"], min(sc["raw_max"], raw))))


def _bottom(hw_min: float) -> float:
    """Lowest dB the slider may reach: the hardware minimum unless capped."""
    return hw_min if VOLUME_MIN_DB is None else max(VOLUME_MIN_DB, hw_min)


def _slider_to_db(slider: int, top: float, hw_min: float) -> float:
    """slider 0-100 -> dB, with the resolution concentrated at the top."""
    s = max(0, min(100, slider)) / 100
    bottom = _bottom(hw_min)
    if VOLUME_TAPER == "amplitude":
        # An analogue potentiometer: the slider IS the voltage ratio, so half
        # travel is -6 dB and zero travel is silence.
        if s <= 0:
            return bottom
        return max(bottom, top + 20 * math.log10(s))
    return top + (bottom - top) * ((1 - s) ** VOLUME_CURVE)


def _db_to_slider(db: float, top: float, hw_min: float) -> int:
    """Exact inverse of _slider_to_db, so a read-back lands on the same notch."""
    bottom = _bottom(hw_min)
    if VOLUME_TAPER == "amplitude":
        if db <= bottom:
            return 0
        return int(round(max(0.0, min(1.0, 10 ** ((db - top) / 20))) * 100))
    if bottom >= top:
        return 100
    ratio = max(0.0, min(1.0, (db - top) / (bottom - top)))
    return int(round((1 - ratio ** (1 / VOLUME_CURVE)) * 100))


async def mixer_status(device: str) -> dict[str, Any]:
    """Find the first playback-volume control on the card and read it.

    Discovered rather than hardcoded, so a different DAC keeps working.
    `slider` is the 0-100 position on the useful dB window, which is what the
    UI shows; `percent` is the raw ALSA percentage, kept for diagnostics.
    """
    card = _card_of(device)
    info: dict[str, Any] = {"available": False, "card": card, "control": None,
                            "percent": None, "db": None, "slider": None,
                            "min_db": VOLUME_MIN_DB, "max_db": 0.0}
    try:
        controls = await _amixer("-D", card, "scontrols")
    except SystemError_:
        return info

    # Collect every playback-volume control, then pick one. A card may expose
    # several (a main output plus a headphone stage, say); a conventional name
    # is the better guess for the main output, otherwise the first will do.
    # Nothing here is specific to any DAC.
    candidates: list[tuple[str, str]] = []
    for line in controls.splitlines():
        m = re.search(r"Simple mixer control '(.+)',(\d+)", line)
        if not m:
            continue
        name = m.group(1)
        if any(name == c[0] for c in candidates):
            continue                       # same control, other channel index
        try:
            detail = await _amixer("-D", card, "sget", name)
        except SystemError_:
            continue
        if "pvolume" not in detail:
            continue          # capture-only or a switch: cannot set a level
        candidates.append((name, detail))

    if not candidates:
        return info           # no hardware volume: the UI disables the slider

    preferred = ("master", "pcm", "digital", "output", "speaker", "headphone")
    name, detail = next(
        (c for c in candidates if c[0].strip().lower() in preferred),
        candidates[0])

    info["available"] = True
    info["control"] = name
    if p := _SGET_PCT.search(detail):
        info["percent"] = int(p.group(1))
    if d := _SGET_DB.search(detail):
        info["db"] = float(d.group(1))

    sc = await _scale(card, name)
    if sc and sc["db_max"] > sc["db_min"]:
        info["max_db"] = sc["db_max"]
        # Report the MOST ATTENUATING stage, not just index 0. Stages are in
        # series, so that is what you actually hear — and if one drifts, the
        # UI shows it instead of cheerfully reporting 0 dB in silence.
        stages = await _volume_stages(card, name)
        raws = [min(st["current"]) for st in stages if st["current"]]
        if raws:
            ref = next((st for st in stages if st["db_min"] is not None), None) or sc
            worst = _raw_to_db(min(raws), {**sc, "raw_min": ref["raw_min"],
                                          "raw_max": ref["raw_max"]})
            info["db"] = round(worst, 1)
            info["stages"] = len(stages)
        if info["db"] is not None:
            info["slider"] = _db_to_slider(info["db"], sc["db_max"], sc["db_min"])
    elif info["percent"] is not None:
        # No usable dB scale: fall back to the raw percentage. Less pleasant to
        # use, but honest and still functional.
        info["slider"] = info["percent"]
        info["min_db"] = None
    return info


async def mixer_set(device: str, slider: int) -> dict[str, Any]:
    """Move the DAC's volume to a slider position on the useful dB window."""
    if not 0 <= slider <= 100:
        raise SystemError_("volume must be 0–100")
    status = await mixer_status(device)
    if not status["available"]:
        raise SystemError_("this DAC exposes no hardware volume control")

    stages = await _volume_stages(status["card"], status["control"])
    sc = await _scale(status["card"], status["control"])

    if stages and sc:
        target_db = _slider_to_db(slider, sc["db_max"], sc["db_min"])
        # Every stage is driven to the same level. Writing only the first is
        # what silenced the output once already: stages are in series, so the
        # quietest one wins regardless of the others.
        for st in stages:
            ref = st if st["db_min"] is not None else sc
            raw = _db_to_raw(target_db, {**ref, "raw_min": st["raw_min"],
                                         "raw_max": st["raw_max"]})
            await _amixer("-D", status["card"], "cset", f"numid={st['numid']}",
                          ",".join([str(raw)] * st["count"]))
    else:
        # No usable scale: percentage on the simple control, single stage only.
        await _amixer("-D", status["card"], "sset", status["control"], f"{slider}%")
    return await mixer_status(device)


# --------------------------------------------------------------------------
# Password store
# --------------------------------------------------------------------------

def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(),
                               bytes.fromhex(salt), PBKDF2_ROUNDS).hex()


def read_config(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def write_password(path: Path, password: str) -> dict[str, Any]:
    """Set the password, preserving the session secret so existing sessions
    are not invalidated by an unrelated change."""
    cfg = read_config(path)
    salt = secrets.token_hex(16)
    cfg["salt"] = salt
    cfg["password_hash"] = hash_password(password, salt)
    cfg.setdefault("secret", secrets.token_hex(32))

    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)  # atomic; never leaves a half-written config
    return cfg
