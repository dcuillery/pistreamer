"""Maintenance operations: qbzd upgrades, service control, logs, factory reset,
and the record of when settings last changed.

Privilege split, and why it is drawn here:

    user-scoped, no sudo   qbzd is a *user* service owned by the same account
                           this app runs as, so restarting it and reading its
                           journal need no elevation — only XDG_RUNTIME_DIR,
                           which a systemd System= unit does not inherit.

    root, via the helper   installing a binary into /usr/bin, reading a system
                           unit's journal, removing the root-owned seed ledger,
                           rebooting. All five live in
                           /usr/local/sbin/pistreamer-admin, reachable through
                           one narrow sudo rule.

The settings ledger answers a question the daemon cannot: qbzd stores values
but keeps no history, so "did anything change since it last worked?" was
unanswerable without shell access. Every successful write through this UI is
recorded with a timestamp and the keys touched.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HELPER = "/usr/local/sbin/pistreamer-admin"

STATE = Path(os.environ.get("PISTREAMER_STATE",
                            "/etc/pistreamer/state.json"))

# qbzd's own storage. Settings and the OAuth token live apart, and a factory
# reset has to take both: clearing settings while leaving the token behind
# produces a device that is signed in to an account but configured for nothing.
QBZD_CONFIG = Path.home() / ".config" / "qbz"
QBZD_DATA = Path.home() / ".local" / "share" / "qbzd"

HISTORY_LIMIT = 25

# The GitHub release lookup is cached: the API allows 60 unauthenticated calls
# an hour per address, and the dashboard polls every five seconds. Without this
# the UI would exhaust the quota within minutes and then report "cannot reach
# the release API" for the rest of the hour.
_VERSION_CACHE: dict[str, Any] = {"at": 0.0, "data": None}
VERSION_TTL = 3600.0


class AdminError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# State file — settings ledger and wizard progress
# --------------------------------------------------------------------------

def read_state() -> dict[str, Any]:
    try:
        data = json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {"settings_last_saved": None, "wizard_completed_at": None,
                "history": []}
    data.setdefault("settings_last_saved", None)
    data.setdefault("wizard_completed_at", None)
    data.setdefault("history", [])
    return data


def _write_state(data: dict[str, Any]) -> dict[str, Any]:
    """Atomic, like the password store: a half-written state file would be
    unparseable and would silently reset the ledger on next read."""
    tmp = STATE.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2))
        os.chmod(tmp, 0o600)
        os.replace(tmp, STATE)
    except OSError as exc:
        raise AdminError(f"cannot write {STATE}: {exc}")
    return data


def record_change(keys: list[str], source: str = "settings") -> dict[str, Any]:
    """Stamp a successful configuration write.

    Failures are deliberately not recorded: the ledger answers "what is on this
    device and since when", and an entry for a write that did not take would
    make it lie.
    """
    data = read_state()
    stamp = _now()
    data["settings_last_saved"] = stamp
    data["history"].insert(0, {"at": stamp, "source": source,
                               "keys": sorted(set(keys))})
    del data["history"][HISTORY_LIMIT:]
    return _write_state(data)


def mark_wizard_done() -> dict[str, Any]:
    data = read_state()
    data["wizard_completed_at"] = _now()
    return _write_state(data)


def clear_state() -> None:
    try:
        STATE.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise AdminError(f"cannot remove {STATE}: {exc}")


# --------------------------------------------------------------------------
# Subprocess plumbing
# --------------------------------------------------------------------------

async def _run(*args: str, timeout: float = 30,
               env: dict[str, str] | None = None) -> tuple[int, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, **(env or {})})
    except OSError as exc:
        # A missing binary raises FileNotFoundError, which is an OSError and
        # NOT an AdminError — so without this it sails past every caller's
        # handler and becomes a 500. The maintenance panel then disappears
        # entirely on a device where, say, the helper was never installed,
        # taking the working half of the panel down with the broken half.
        raise AdminError(f"cannot run {args[0]}: {exc}")
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise AdminError(f"`{args[0]}` timed out")
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def _helper(*args: str, timeout: float = 60) -> dict[str, Any]:
    rc, out, err = await _run("sudo", "-n", HELPER, *args, timeout=timeout)
    text = out.strip()
    if not text:
        raise AdminError(err.strip() or "maintenance helper returned nothing")
    try:
        data = json.loads(text)
    except ValueError:
        raise AdminError(text[:300])
    if not data.get("ok"):
        raise AdminError(data.get("error") or "maintenance helper failed")
    return data


async def _helper_text(*args: str, timeout: float = 60) -> str:
    rc, out, err = await _run("sudo", "-n", HELPER, *args, timeout=timeout)
    if rc != 0 and not out.strip():
        raise AdminError(err.strip() or "maintenance helper failed")
    return out


def _user_systemd_env() -> dict[str, str]:
    """`systemctl --user` needs to find the user's own systemd instance.

    A System= unit inherits neither XDG_RUNTIME_DIR nor the session bus
    address, so without these two variables every call fails with "Failed to
    connect to bus". Lingering is enabled by the qbzd role, which is what keeps
    /run/user/<uid> alive with nobody logged in.
    """
    uid = os.getuid()
    run = f"/run/user/{uid}"
    return {"XDG_RUNTIME_DIR": run,
            "DBUS_SESSION_BUS_ADDRESS": f"unix:path={run}/bus"}


async def _systemctl_user(*args: str, timeout: float = 30) -> tuple[int, str, str]:
    systemctl = shutil.which("systemctl") or "/usr/bin/systemctl"
    return await _run(systemctl, "--user", *args, timeout=timeout,
                      env=_user_systemd_env())


# --------------------------------------------------------------------------
# Service control
# --------------------------------------------------------------------------

async def daemon_state() -> dict[str, Any]:
    rc, out, _ = await _systemctl_user("is-active", "qbzd", timeout=10)
    active = out.strip() or "unknown"
    return {"unit": "qbzd", "scope": "user", "active": active,
            "running": active == "active"}


async def restart_daemon() -> dict[str, Any]:
    rc, _, err = await _systemctl_user("restart", "qbzd", timeout=45)
    if rc != 0:
        raise AdminError(err.strip() or "could not restart qbzd")
    # systemd returns as soon as the unit is started, which is before qbzd has
    # bound its port. Reporting the state immediately would show "activating"
    # and look like a failure to anyone watching.
    await asyncio.sleep(1.5)
    return await daemon_state()


async def restart_web() -> dict[str, Any]:
    """Restart this very app.

    The helper detaches the actual restart by a second so this reply reaches
    the browser first — restarting the unit the request arrived through
    otherwise reads as a connection reset rather than a success.
    """
    return await _helper("restart-web", timeout=20)


async def reboot() -> dict[str, Any]:
    return await _helper("reboot", timeout=20)


# --------------------------------------------------------------------------
# Logs
# --------------------------------------------------------------------------

UNITS = {"qbzd", "pistreamer-web"}


async def logs(unit: str, lines: int = 200) -> str:
    if unit not in UNITS:
        raise AdminError(f"unknown unit '{unit}'")
    lines = max(10, min(2000, int(lines)))

    if unit == "qbzd":
        # Own user, own journal: no elevation needed. The helper can do this
        # too, but going direct keeps the common case off sudo entirely.
        journalctl = shutil.which("journalctl") or "/usr/bin/journalctl"
        rc, out, err = await _run(journalctl, "--user-unit=qbzd",
                                  "-n", str(lines), "--no-pager",
                                  "--output=short-iso",
                                  timeout=30, env=_user_systemd_env())
        if out.strip():
            return out
        # An empty read is usually a permissions problem rather than a quiet
        # daemon, so fall through to the privileged path instead of showing an
        # empty pane and no explanation.
    return await _helper_text("logs", unit, str(lines), timeout=45)


# --------------------------------------------------------------------------
# qbzd version and upgrade
# --------------------------------------------------------------------------

async def versions(force: bool = False) -> dict[str, Any]:
    now = time.time()
    cached = _VERSION_CACHE["data"]
    if cached and not force and now - _VERSION_CACHE["at"] < VERSION_TTL:
        return {**cached, "cached": True}
    try:
        data = await _helper("latest", timeout=30)
    except AdminError as exc:
        # Offline is a normal state for a device on a home network with no
        # outbound access, and must not blank the whole maintenance panel.
        if cached:
            return {**cached, "cached": True, "stale": True, "error": str(exc)}
        return {"ok": False, "installed": None, "latest": None,
                "upgradable": False, "error": str(exc)}
    _VERSION_CACHE.update({"at": now, "data": data})
    return {**data, "cached": False}


async def upgrade() -> dict[str, Any]:
    """Install the newest upstream release, then restart the daemon.

    Deliberately blunt — one button, always the latest — which is what was
    asked for. The cost is real and worth stating where the UI can repeat it:
    the Connect protocol is reverse-engineered, so a new release is also the
    most likely way for a working streamer to stop appearing in the Qobuz app.
    The previous binary is kept at /usr/bin/qbzd.bak for exactly that reason.
    """
    result = await _helper("upgrade", timeout=420)
    _VERSION_CACHE.update({"at": 0.0, "data": None})
    if result.get("changed"):
        try:
            result["daemon"] = await restart_daemon()
        except AdminError as exc:
            # The binary IS installed at this point; saying otherwise would send
            # the user looking in the wrong place.
            result["daemon_error"] = str(exc)
        record_change([f"qbzd={result.get('installed')}"], source="upgrade")
    return result


# --------------------------------------------------------------------------
# Factory reset
# --------------------------------------------------------------------------

async def factory_reset(web_config: Path) -> dict[str, Any]:
    """Return the device to its just-provisioned state.

    What this removes is everything the *interactive* setup created: qbzd's
    settings, the Qobuz token, the web password, the ledger of applied seeds,
    and this app's own state file.

    What it deliberately leaves alone is everything Ansible put on the host —
    ALSA configuration, boot cmdline, the CPU governor, the units themselves.
    Those are not "settings" in any sense the user of this page means, and
    tearing them down from a web button would leave a Pi that cannot play
    audio and cannot be fixed from the same page.
    """
    removed: list[str] = []
    errors: list[str] = []

    try:
        rc, _, err = await _systemctl_user("stop", "qbzd", timeout=30)
        if rc != 0:
            errors.append(f"stop qbzd: {err.strip() or rc}")
    except AdminError as exc:
        errors.append(f"stop qbzd: {exc}")

    for path in (QBZD_CONFIG, QBZD_DATA):
        try:
            if path.is_dir():
                shutil.rmtree(path)
                removed.append(str(path))
        except OSError as exc:
            errors.append(f"{path}: {exc}")

    try:
        result = await _helper("reset-seed", timeout=20)
        removed.append(result.get("removed", "seed ledger"))
    except AdminError as exc:
        errors.append(f"seed ledger: {exc}")

    # The web password goes last among the removals: until this file is gone
    # the caller is still authenticated, and if an earlier step fails we would
    # rather leave a protected device than an open one.
    try:
        web_config.unlink()
        removed.append(str(web_config))
    except FileNotFoundError:
        pass
    except OSError as exc:
        errors.append(f"{web_config}: {exc}")

    try:
        clear_state()
    except AdminError as exc:
        errors.append(str(exc))

    try:
        rc, _, err = await _systemctl_user("start", "qbzd", timeout=45)
        if rc != 0:
            errors.append(f"start qbzd: {err.strip() or rc}")
    except AdminError as exc:
        errors.append(f"start qbzd: {exc}")

    return {"ok": not errors, "removed": removed, "errors": errors}
