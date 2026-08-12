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
import os
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
