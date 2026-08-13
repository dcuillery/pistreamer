"""Client for the qbzd daemon.

Two transports, because qbzd splits its surface between them:

  * HTTP API (127.0.0.1:8182) — live state, transport controls, SSE events.
  * CLI (`qbzd settings ...`, `qbzd login`) — configuration. There are NO
    settings endpoints on the HTTP API; `/api/settings` and friends return 404.
    Configuration genuinely has to shell out.

Why this module must exist at all: qbzd's HTTP API has an always-on "Origin
shield" that returns 403 to any request carrying an Origin header. Browsers
always send one cross-origin, so a page cannot call qbzd directly. A
server-side client like this one sends no Origin and is accepted.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from typing import Any, AsyncIterator

import httpx

QBZD_HOST = os.environ.get("QBZD_HOST", "127.0.0.1:8182")
QBZD_BIN = os.environ.get("QBZD_BIN", shutil.which("qbzd") or "/usr/bin/qbzd")
BASE = f"http://{QBZD_HOST}"

# Settings this UI is allowed to write. Anything not listed is rejected, so a
# crafted request cannot reach arbitrary daemon configuration.
WRITABLE = {
    "audio.device",
    "audio.exclusive_mode",
    "audio.reserve_dac_while_running",
    "audio.limit_quality_to_device",
    "audio.gapless_enabled",
    "playback.quality",
    "qconnect.device_name",
    "qconnect.volume_mode",
}

# Settings the UI presents as an on/off switch. qbzd stores them as the
# strings "true"/"false", not JSON booleans.
BOOLEAN_SETTINGS = {"audio.gapless_enabled", "audio.exclusive_mode",
                    "audio.reserve_dac_while_running"}

QUALITY_CHOICES = ["mp3", "cd", "hires", "hires_plus"]
VOLUME_MODES = ["software", "locked"]


class QbzdError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# HTTP API
# --------------------------------------------------------------------------

async def status() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.get(f"{BASE}/api/status")
        r.raise_for_status()
        return r.json()


async def now_playing() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.get(f"{BASE}/api/now-playing")
        r.raise_for_status()
        return r.json()


async def ping() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            return (await c.get(f"{BASE}/api/ping")).status_code == 200
    except httpx.HTTPError:
        return False


async def playback(action: str) -> None:
    """Transport control. `action` is validated by the caller."""
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.post(f"{BASE}/api/playback/{action}")
        r.raise_for_status()


async def set_volume(level: float) -> None:
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.post(f"{BASE}/api/playback/volume", json={"volume": level})
        r.raise_for_status()


async def events() -> AsyncIterator[bytes]:
    """Proxy qbzd's SSE stream. Yields raw chunks for relaying to the browser."""
    async with httpx.AsyncClient(timeout=None) as c:
        async with c.stream("GET", f"{BASE}/api/events") as r:
            async for chunk in r.aiter_raw():
                yield chunk


async def artwork() -> tuple[bytes, str] | None:
    """Fetch current cover art. The endpoint 302s to the real image, and we
    follow it server-side so the browser never talks to Qobuz directly."""
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:
            r = await c.get(f"{BASE}/api/artwork/current")
            if r.status_code != 200:
                return None
            return r.content, r.headers.get("content-type", "image/jpeg")
    except httpx.HTTPError:
        return None


# --------------------------------------------------------------------------
# CLI — configuration
# --------------------------------------------------------------------------

async def _run(*args: str, timeout: float = 20) -> tuple[int, str, str]:
    """Run the qbzd CLI. Uses exec (never a shell), so values containing
    spaces or metacharacters cannot be reinterpreted as commands."""
    proc = await asyncio.create_subprocess_exec(
        QBZD_BIN, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise QbzdError(f"`qbzd {' '.join(args)}` timed out")
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def settings_show() -> dict[str, str]:
    rc, out, err = await _run("settings", "show")
    if rc != 0:
        raise QbzdError(err.strip() or "settings show failed")
    result: dict[str, str] = {}
    for line in out.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            result[k.strip()] = v.strip()
    return result


async def settings_set(key: str, value: str) -> None:
    if key not in WRITABLE:
        raise QbzdError(f"refusing to write unlisted setting '{key}'")
    rc, _, err = await _run("settings", "set", key, value)
    if rc != 0:
        raise QbzdError(err.strip() or f"could not set {key}")


async def logout() -> None:
    await _run("logout")


_URL_RE = re.compile(r"https?://\S+")


async def login_url(callback_host: str | None = None) -> str:
    """Start the OAuth flow and return the URL for the user's browser.

    `qbzd login` runs a one-shot listener and blocks until the callback
    arrives, so we read just far enough to capture the URL and leave the
    process running to receive it.
    """
    args = ["login"]
    if callback_host:
        args += ["--callback-host", callback_host]
    proc = await asyncio.create_subprocess_exec(
        QBZD_BIN, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    assert proc.stdout is not None
    try:
        for _ in range(40):  # bounded read; the URL appears in the first lines
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=15)
            if not line:
                break
            m = _URL_RE.search(line.decode(errors="replace"))
            if m:
                return m.group(0)
    except asyncio.TimeoutError:
        pass
    proc.kill()
    raise QbzdError("qbzd did not print a login URL")


# --------------------------------------------------------------------------
# ALSA device discovery
# --------------------------------------------------------------------------

_CARD_RE = re.compile(r"^\s*(\d+)\s*\[\s*(\S+)\s*\]:\s*(.*)$")


def list_devices() -> list[dict[str, Any]]:
    """Enumerate USB audio cards with their real capabilities.

    Capabilities come from /proc/asound/cardN/stream0, i.e. what the hardware
    actually reports — not a spec sheet. A DAC that is switched off simply
    de-enumerates and will not appear here; that is normal, not an error.
    """
    devices: list[dict[str, Any]] = []
    try:
        with open("/proc/asound/cards") as fh:
            text = fh.read()
    except OSError:
        return devices

    for line in text.splitlines():
        m = _CARD_RE.match(line)
        if not m:
            continue
        index, name, desc = m.group(1), m.group(2), m.group(3).strip()
        if "USB-Audio" not in desc:
            continue
        dev = {
            "card": int(index),
            "name": name,
            "description": desc.replace("USB-Audio - ", ""),
            "device": f"hw:CARD={name},DEV=0",
            "rates": [],
            "bits": None,
            "formats": [],
        }
        try:
            with open(f"/proc/asound/card{index}/stream0") as fh:
                stream = fh.read()
            if r := re.search(r"Rates:\s*(.+)", stream):
                dev["rates"] = [int(x) for x in re.findall(r"\d+", r.group(1))]
            if b := re.search(r"Bits:\s*(\d+)", stream):
                dev["bits"] = int(b.group(1))
            dev["formats"] = sorted(set(re.findall(r"Format:\s*(\S+)", stream)))
        except OSError:
            pass
        devices.append(dev)
    return devices


# --------------------------------------------------------------------------
# Host health
# --------------------------------------------------------------------------

# Bit meanings from the Raspberry Pi firmware's get_throttled word.
#
# The distinction that matters: bits 0-3 describe RIGHT NOW, bits 16-19 are
# sticky — they latch the moment a condition occurs and stay set until the next
# reboot. Reporting the sticky bits as a current fault means a single blip
# during boot leaves an alarm on screen for days, which is exactly what this
# code used to do.
#
# Stable codes rather than prose, so the interface can translate them.
_BITS_NOW = {0: "undervoltage", 1: "freq_capped", 2: "throttled", 3: "temp_limit"}
_BITS_PAST = {16: "undervoltage", 17: "freq_capped", 18: "throttled", 19: "temp_limit"}


async def health() -> dict[str, Any]:
    """Power and thermal state.

    `active`     — conditions happening now; these deserve an alarm.
    `since_boot` — conditions that occurred at some point since power-on; these
                   are history, and clear only on reboot.
    `healthy`    — no ACTIVE condition. Past events do not make a device
                   unhealthy, they make it a device that had an event.
    """
    info: dict[str, Any] = {"throttled_raw": None, "active": [], "since_boot": [],
                            "healthy": None, "temperature_c": None}
    vcgencmd = shutil.which("vcgencmd") or "/usr/bin/vcgencmd"
    try:
        proc = await asyncio.create_subprocess_exec(
            vcgencmd, "get_throttled",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        if m := re.search(r"0x([0-9a-fA-F]+)", out.decode()):
            word = int(m.group(1), 16)
            info["throttled_raw"] = f"0x{word:X}"
            info["active"] = [c for bit, c in _BITS_NOW.items() if word & (1 << bit)]
            info["since_boot"] = [c for bit, c in _BITS_PAST.items() if word & (1 << bit)]
            info["healthy"] = not info["active"]
    except (OSError, asyncio.TimeoutError):
        pass

    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as fh:
            info["temperature_c"] = round(int(fh.read().strip()) / 1000, 1)
    except (OSError, ValueError):
        pass
    return info
