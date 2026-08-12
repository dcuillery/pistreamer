#!/usr/bin/env python3
"""Roll CHANGELOG's [Unreleased] section into a released version, then tag it.

    make release VERSION=0.2.0

Written in Python rather than shell on purpose: the text surgery needs
in-place editing, and `sed -i` takes an argument on macOS that it rejects on
Linux. This behaves identically on both.

The commit and tag are made under YOUR git identity — this script is run by
you, from your machine.
"""

from __future__ import annotations

import datetime as dt
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / "CHANGELOG.md"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
                    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")

EMPTY_UNRELEASED = """## [Unreleased]

_Nothing yet._
"""


def fail(msg: str) -> None:
    print(f"release: {msg}", file=sys.stderr)
    sys.exit(1)


def git(*args: str, capture: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, text=True,
                       capture_output=capture)
    if r.returncode != 0:
        fail((r.stderr or r.stdout or "git failed").strip())
    return (r.stdout or "").strip()


def repo_url() -> str:
    """Derive the browsable URL from origin, so compare links are correct even
    if the repository is renamed or moved."""
    remote = git("remote", "get-url", "origin")
    m = re.match(r"^git@([^:]+):(.+?)(?:\.git)?$", remote)
    if m:
        return f"https://{m.group(1)}/{m.group(2)}"
    return re.sub(r"\.git$", "", remote)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: release.py <version>   e.g. release.py 0.2.0")
    version = sys.argv[1].lstrip("v")
    if not SEMVER.match(version):
        fail(f"'{version}' is not valid semver (expected MAJOR.MINOR.PATCH)")

    if not CHANGELOG.exists():
        fail("CHANGELOG.md not found")

    # Refuse to release a dirty tree: the tag must point at exactly what was
    # reviewed, not at whatever happened to be lying around.
    if git("status", "--porcelain"):
        fail("working tree is not clean — commit or stash first")

    if git("tag", "-l", version):
        fail(f"tag {version} already exists")

    text = CHANGELOG.read_text()

    m = re.search(r"^## \[Unreleased\]\s*$", text, re.M)
    if not m:
        fail("no '## [Unreleased]' section found")

    # Everything from [Unreleased] to the next version heading.
    start = m.end()
    nxt = re.search(r"^## \[", text[start:], re.M)
    body = text[start:start + nxt.start()] if nxt else text[start:]

    stripped = re.sub(r"^\s*(---|_Nothing yet\._)\s*$", "", body, flags=re.M).strip()
    if not stripped:
        fail("[Unreleased] is empty — nothing to release")

    today = dt.date.today().isoformat()
    previous = ""
    tags = [t for t in git("tag", "-l", "--sort=-v:refname").splitlines() if SEMVER.match(t)]
    if tags:
        previous = tags[0]

    # Rename [Unreleased] -> [version], and open a fresh [Unreleased] above it.
    text = text[:m.start()] + EMPTY_UNRELEASED + f"\n---\n\n## [{version}] — {today}" + text[m.end():]

    url = repo_url()
    # Rewrite the link definitions at the foot of the file.
    text = re.sub(r"^\[Unreleased\]:.*$",
                  f"[Unreleased]: {url}/compare/{version}...HEAD", text, flags=re.M)
    new_link = (f"[{version}]: {url}/compare/{previous}...{version}" if previous
                else f"[{version}]: {url}/releases/tag/{version}")
    text = re.sub(r"^(\[Unreleased\]:.*)$", r"\1\n" + new_link, text, count=1, flags=re.M)

    CHANGELOG.write_text(text)

    git("add", "CHANGELOG.md", capture=True)
    git("commit", "-m", f"Release {version}", capture=True)
    git("tag", "-a", version, "-m", f"Release {version}", capture=True)

    print(f"✓ CHANGELOG rolled into [{version}] — {today}")
    print(f"✓ committed and tagged {version}")
    print()
    print("Review it, then publish with:")
    print(f"    git push origin main {version}")


if __name__ == "__main__":
    main()
