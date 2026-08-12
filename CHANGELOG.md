# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries note the commit they came from. Many "Fixed" items describe problems that
produced **no error message** — they are recorded in detail because a silent
failure you cannot see is the expensive kind.

---

## [Unreleased]

### Added

- **Web UI** — a FastAPI application served from the Pi at `http://streamer.local:8080/`
  (`cee400a`). Now-playing with cover art, transport controls and volume, live over
  SSE; DAC selection; playback quality; Qobuz Connect device name; OAuth login; and a
  system-health panel.
- **First-run password wizard.** A fresh install now presents a "create password"
  screen instead of a login form, so `make webui-password` is no longer required.
  `POST /api/setup-password` is accepted **only while no password exists** — once one
  is set, the endpoint returns `409` and the device can no longer be claimed.
- **Wi-Fi configuration from the UI** — scan, select, and join a network, with
  **automatic rollback**: the previous profile is restored if the new network fails
  to come up. Changing Wi-Fi over Wi-Fi could otherwise strand a device whose
  ethernet has no DHCP lease.
- **Password change** from the settings page, verifying the current password.
- Privileged helper `/usr/local/sbin/pistreamer-net` (`scan` / `status` / `connect`)
  with a narrow sudoers grant. The Wi-Fi passphrase is passed on **stdin, never
  argv** — arguments are world-readable through `ps`.
- `webui` Ansible role, and `make web`, `make webui-password`, `make web-logs`,
  `make open`, `make boots`, `make hwparams`.
- Health reporting that decodes `vcgencmd get_throttled` into readable flags, so
  under-voltage is visible in the UI rather than silently degrading playback.

### Changed

- **`qbzd` is now bound to `127.0.0.1`.** It listened on `0.0.0.0:8182` with no
  authentication, so anyone on the LAN could control playback. The web UI is now the
  only network-facing surface, and it requires a password.
- `/etc/pistreamer/web.json` is owned by the service user with mode `0600` (was
  `root:pi 0640`), and `/etc/pistreamer` was added to the unit's `ReadWritePaths`.
  Both were required for the wizard to write a password at all.
- Settings are written atomically (`os.replace`), so an interrupted write cannot
  leave a truncated config and lock you out.

### Fixed

- **The login form never disappeared after a successful login.** The server was
  correct throughout — `POST /api/login` returned `200` and the session worked. An
  author CSS rule `.gate { display: grid }` overrode the browser's
  `[hidden] { display: none }`, because author styles always beat the UA stylesheet.
  A global `[hidden] { display: none !important }` now guards every element; the same
  defect was silently pinning the volume warning permanently visible.
- **Logging in never started the polling loop** — only the SSE stream. Settings and
  health stayed frozen until a page reload. Both entry points now share one `start()`.
- **A rendering error was reported as "wrong password"**, because the login call and
  the render shared a `try` block. They are now separate, so a UI fault cannot be
  mistaken for an authentication fault.
- **Wi-Fi scanning crashed** with `awk: syntax error` — an assignment was used as
  `gsub`'s third argument. The helper now emits raw `nmcli` records and Python parses
  them, correctly handling SSIDs containing `:` or `\`.
- **Wi-Fi status displayed the connection *profile* name** (`netplan-wlan0-LesMilans`)
  instead of the SSID (`LesMilans`).
- **Wi-Fi status and scanning failed entirely** with *"sudo: The 'no new privileges'
  flag is set, which prevents sudo from running as root."* The service unit set
  `NoNewPrivileges=true`, which blocks every setuid escalation — precisely how `sudo`
  acquires root. The same deployment granted the service sudo access and removed its
  ability to use it. The flag is now off, with the reason recorded in the unit.
  It bought little regardless: the service user already has `NOPASSWD: ALL`.
- **The Wi-Fi panel swallowed its own errors**, showing three dashes and no
  explanation while the server was returning a perfectly clear message. Failures are
  now surfaced in the panel.
- **Provisioning aborted when the DAC was switched off.** A powered-down DAC
  de-enumerates from USB and vanishes from `/proc/asound/cards` — normal behaviour,
  not a fault. Auto-detection now keeps the configured device and only fails when
  there is nothing to fall back to.
- **The daemon config was written to a path `qbzd` never reads.** The upstream wiki
  documents `~/.config/qbz/qbzd.toml`; the daemon actually uses `~/.config/qbzd/`.
  The role now asks `qbzd config path`, which is authoritative. The stray file is
  removed automatically.
- The existing `[server]` section is edited in place rather than appended to, which
  would have produced a duplicate TOML table.

### Security

- **Token authentication was evaluated and rejected as unworkable.** `qbzd`'s
  `[server] token` requires `Authorization: Bearer` on every route, but the CLI has
  no `--token` flag and honours no token environment variable — its only options are
  `--host`, `-q`, `-h`, `-V`. Enabling it would have broken `qbzd settings set`,
  `qbzd login` and this project's own provisioning. Binding to localhost achieves the
  same isolation with no such cost.
- Web passwords are hashed on the device with PBKDF2-SHA256 (200 000 iterations) and
  a per-password salt. Plaintext never reaches this repository.
- Only an allow-list of `qbzd` settings keys may be written through the API, so a
  crafted request cannot reach arbitrary daemon configuration.
- **Known limitation:** the `pi` user has `NOPASSWD: ALL`, so the narrow sudoers grant
  does not meaningfully constrain the service — a compromise of the web UI yields
  root. Tightening this requires removing `pi`'s blanket sudo access.

---

## [0.1.0] — 2026-08-08

First working streamer: a Raspberry Pi 3B playing Qobuz Connect bit-perfect to a
USB DAC, provisioned reproducibly.

### Added

- **Ansible provisioning** over stock Raspberry Pi OS Lite (64-bit), in three roles
  (`8becbfb`):
  - `base` — hostname, timezone, mDNS, packages, SD-card care.
  - `audio` — the Pi 3B tuning that matters: onboard and HDMI audio disabled so the
    USB DAC is the only card, CPU governor pinned to `performance`, realtime
    scheduling limits, `gpu_mem=16`, Bluetooth off, Wi-Fi power saving off.
  - `qbzd` — pinned release install verified against a recorded SHA-256, the shipped
    systemd **user** unit, and `loginctl` lingering.
- **Declarative `qbzd` settings** applied through `qbzd settings set` (`a5d5750`).
  The daemon's `qbzd.toml` schema is unpublished, so key names were read from a
  configured device with `qbzd settings show` rather than guessed — a config with
  plausible-but-wrong keys fails silently.
- **DAC auto-detection** (`555d4e8`): `qbzd_audio_device: auto` discovers the USB
  audio card and derives `hw:CARD=<name>,DEV=0`. Swapping DACs is just
  `make provision`. The card-*name* form survives renumbering, unlike `hw:0,0`.
- **MIT licence, credits and legal notice** (`555d4e8`) — per-component licences
  verified at source, an explicit statement that the repository bundles no
  third-party code, and trademark disclaimers. Reconciled `credits.txt`, which said
  "All rights reserved" and contradicted open-source distribution.
- Documentation: `README.md`, `docs/first-boot.md`, `docs/troubleshooting.md`.

### Fixed

- **`cpufrequtils` no longer exists in Debian 13.** The CPU governor is now pinned by
  a small systemd oneshot unit, which needs no package at all.
- **`backup: true` failed on the boot partition.** Ansible's backup filename contains
  `:` and `@`, both invalid on FAT32, producing `EINVAL`. A pristine copy is kept as
  `cmdline.txt.orig` instead.
- **systemd does not read `/etc/security/limits.conf` for services.** The realtime
  limits reached the user session but never the daemon, which ran at `rtprio 0` and
  could not request realtime scheduling — audible only once the box got busy. A
  `LimitRTPRIO` / `LimitMEMLOCK` unit drop-in fixes it; both halves are needed.
- **USB autosuspend was suspending the DAC after 2 seconds**, causing clicks and
  dropped track starts. Disabled via `usbcore.autosuspend=-1`.
- **The journal was volatile**, wiped on every reboot, so `journalctl -b -1` could
  never explain why the device restarted. Now persistent, capped at 50 MB.
- **`make logs` returned "No journal files were found."** `journalctl --user -u`
  reads the per-user journal; a user unit's output lands in the *system* journal.
  Corrected to `--user-unit`.
- **`cmdline.txt` editing rewritten** from pattern-patching to a deterministic
  read-modify-write. It is a single line where a malformed edit yields a Pi that will
  not boot.
- `Makefile` used `USER`, which `make` inherits from the environment, so every `ssh`
  connected as the Mac username instead of the inventory's.
- `ansible.cfg` referenced the `community.general.yaml` callback, removed in current
  Ansible and a hard error.

### Notes

Qobuz Connect has no public SDK. This project configures
[QBZ / `qbzd`](https://github.com/vicrodh/qbz) (MIT, © 2024 blitzkriegfc), which
implements the protocol by **reverse engineering** — unofficial, unsupported by
Qobuz, and liable to break if the protocol changes. A valid Qobuz subscription is
required.

Verified on: Raspberry Pi 3 Model B Rev 1.2 · Raspberry Pi OS Lite 64-bit (Debian 13,
glibc 2.41) · Musical Fidelity V90-DAC (24-bit/96 kHz ceiling, UAC1, asynchronous).

[Unreleased]: https://github.com/dcuillery/pistreamer/compare/0.1.0...HEAD
[0.1.0]: https://github.com/dcuillery/pistreamer/releases/tag/0.1.0
