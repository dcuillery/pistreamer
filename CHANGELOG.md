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

- **A setup wizard, so a streamer can be built without a terminal.** Five steps
  — network, DAC, Qobuz sign-in, name and quality, summary — shown once on a
  fresh device and re-runnable from Settings › Security. Each step commits
  through the *same* endpoints the Settings view uses, so a value set in the
  wizard and the same value set later cannot drift apart. Skippable on
  purpose: a device already configured with `make setup` over SSH should not
  be marched through five screens to reach its own player.

- **The UI is now two views.** Player stays the landing screen; everything
  configurable moved behind a Settings view with five tabs (Audio, Qobuz,
  Network, System, Security). Wi-Fi moved out of the main scroll into
  Network.

- **Maintenance from the browser** — the four operations that previously
  required SSH:
  - **Upgrade qbzd** to the newest upstream release, with the daemon restarted
    afterwards and the previous binary kept as `/usr/bin/qbzd.bak`. The
    SHA-256 of what was installed is displayed, because it has to be copied
    into `qbzd_sha256` or the next `make provision` reinstalls the older
    pinned build over the top of it.
  - **Restart** the daemon, this interface, or the whole Pi.
  - **Logs** for `qbzd` and `pistreamer-web`, read straight from the journal.
  - **Factory reset**: removes the Qobuz token, every qbzd setting, the seed
    ledger and the web password, then returns to the wizard. It deliberately
    does *not* touch anything Ansible put on the host — ALSA, boot cmdline,
    governor, units — because a web button that leaves a Pi unable to play
    audio and unable to be fixed from the same page is not a reset.

- **A record of when settings last changed**, shown in the footer on every
  screen. qbzd stores values but keeps no history, so "has anything changed
  since this last worked?" was previously unanswerable without a shell. Every
  successful write through the UI is stamped in `/etc/pistreamer/state.json`
  with the keys it touched; the last 25 are kept.

- Two privileged operations gained a helper, `/usr/local/sbin/pistreamer-admin`,
  reached through one narrow sudo rule exactly like `pistreamer-net`. It never
  accepts a URL from the caller — it builds the download address itself from a
  fixed repository and a version string it validates — because a script that
  writes a caller-supplied file to `/usr/bin/qbzd` as root is a root shell with
  extra steps. It also refuses to install a binary that will not execute on the
  machine, which is checked by running it rather than by inspecting the ELF
  header: `file` is not present on Lite images.

- **Postcardware.** The project is now postcardware, in the sense Spatie use the
  word: still MIT, still free to use and fork, but users are asked to send the
  author a postcard from their hometown — or a CD or LP worth playing on it.
  Documented in the README's licence section and in `credits.txt`. Deliberately
  *not* written into `LICENSE`: a postcard clause with legal force would make
  the project non-free and unpackageable, which is not the point of asking.

### Fixed

- **`/etc/pistreamer` was mode 0750, which made the first-run password claim
  impossible.** The directory was group-readable but not group-writable, and
  both the password store and the new settings ledger write through a
  temporary file plus an atomic rename — which needs write permission on the
  *directory*, not just on the file. The wizard would have failed with EACCES
  on a path that looked writable. Now 0770.

- A missing binary in the maintenance paths raised `FileNotFoundError`, which
  is an `OSError` and not the module's own error type, so it sailed past every
  caller's handler and became a 500. One absent helper took the entire
  maintenance panel down with it, including the half that was working. Missing
  executables are now reported per-field, and the panel degrades instead of
  disappearing.

---

## [0.4.0] — 2026-08-13
### Added

- **A volume control that actually works.** The slider drives the DAC's own
  hardware attenuator, so the level really changes **and the stream stays
  bit-perfect** — attenuation happens inside the converter, never on the samples.
  It is the same mechanism as a TEAC's "variable line output".

  Fully generic: the control is discovered (first element exposing `pvolume`,
  preferring a conventional name when several exist) and its range is read from
  ALSA rather than assumed. **A DAC with no volume control disables the slider
  automatically**, with a message distinguishing "cannot" from "must not".

  Two tapers, configurable in `group_vars/all.yml`:
  `amplitude` (default) follows `dB = 20·log10(slider)` — an analogue
  potentiometer, so half travel is −6 dB and zero is silence; `power` gives a
  straight line in dB for a deliberately narrow trim range.

- **`Volume control` is a real choice again**: *control the DAC's volume* versus
  *locked — fixed output at 0 dB*, the classic fixed line output. Switching to
  locked restores full output first, because "fixed" should mean 0 dB rather
  than "frozen wherever the slider happened to be".

- **Bilingual interface, English and French**, detected from the browser and
  overridable from a switcher present both before and after sign-in. Translations
  live in editable, committed JSON under `web/static/i18n/` — no build step, no
  extraction tooling. A missing key renders as the key itself, so a gap is
  visible instead of silently blanking the interface. Number formatting follows
  the locale (44.1 kHz / 44,1 kHz).

- **ZERON visual identity** applied from the brand book: Ivory / Charcoal /
  Walnut / Brass / Midnight, hairlines instead of shadows, flat geometric SVG
  icons in place of emoji, and a light/dark palette. Brass is reserved for
  signal and state — progress, the connected dot, focus — never as a fill,
  matching the reference where the primary button is black and brass appears
  only as a shadow line.

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
- **Settings are seeded once, then left alone.** Each key in `group_vars` is
  applied on first run and recorded in a ledger; afterwards the web UI is
  authoritative. Without this, changing a setting in the UI and later running
  `make provision` for an unrelated reason would silently revert it.
  `qbzd settings show` cannot help here — it always returns a value, so "the
  user chose false" and "false is the default" are indistinguishable. `make
  settings-force` re-imposes everything. `audio.device` is exempt and always
  enforced: it is derived from the hardware present, so seeding it would freeze
  the first DAC ever detected.
- **Section headings now read as headings.** Hierarchy is carried by four axes
  at once — size, case, weight and colour. Previously `h3` was 0.68rem while
  field labels were 0.74rem: the hierarchy was literally inverted, which is
  exactly why it did not read.
- Selects are drawn in the interface's own typeface with a custom chevron
  instead of inheriting the platform's. (The open dropdown list is drawn by the
  OS and cannot be styled — only the closed control is ours.)
- `playback.quality` follows the DAC in use, and `audio.device` is stored as
  `hw:CARD=<name>` without the `,DEV=0` suffix.
- Device name is `Qbz Pi Streamer`; gapless is on, with its drawback documented
  next to the setting.
- **Playback quality now degrades instead of failing.** `audio.allow_quality_fallback`
  is `true` and `audio.quality_fallback_behavior` is `always_fallback`, so a hi-res
  stream is downsampled to whatever the DAC accepts rather than refused.
- `playback.quality` is pinned to `cd` for the currently connected DAC, with the
  per-device options documented in `group_vars/all.yml`. This value **must** match the
  hardware; it is not a preference.

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
- **A perfectly healthy power supply was reported as inadequate.** The firmware's
  `get_throttled` word carries two families of bits: 0-3 describe *right now*,
  16-19 are **sticky** and latch until reboot. Testing `word == 0` meant a single
  blip during boot left a red alarm on screen for days. Every flag was also
  blamed on power, when a frequency cap without under-voltage is not an
  electrical fault and a thermal limit is a cooling problem. The API now reports
  `active` and `since_boot` separately, `healthy` depends only on active
  conditions, and history moved to a tooltip.
- **The DAC's second volume stage was left at −60 dB, and the output went
  silent.** A Rega DAC-R exposes `…Playback Volume` at index 0 *and* index 1,
  in series. `amixer sset '<name>'` writes only index 0, so restoring "the"
  volume restored half of it — while `sget` cheerfully reported
  `127 [100%] [0.00dB]`. Every stage is now enumerated and driven together, and
  the reported level is the **most attenuating** stage, so a drift is visible
  instead of being hidden behind a confident 0 dB.
- **`amixer` dB targets are unreliable** on this control — both `-30dB` and
  `-12dB` snapped to `-4dB`. Levels are set as raw values with the conversion
  done here, from the range ALSA publishes.
- The mixer scale was never detected, because `scontrols` reports the short name
  (`XMOS Audio 2.0 Output`) while `contents` spells it out
  (`… Playback Volume`); matching on the closing quote never hit, and the code
  silently fell back to the raw percentage.
- **The daemon's `last_errors` is sticky too** — kept until restart, with no
  timestamp. It was rendered as a warning, so an incident resolved hours earlier
  still looked live. Now a neutral note that says so.
- Redeploying took 90 seconds: the SSE endpoint holds a connection open, so
  uvicorn never finished a graceful shutdown and systemd waited its full default
  before `SIGKILL`. `TimeoutStopSec=10` — the service is ready in about two.
- `system.py` used `re` without importing it, which broke hardware volume
  detection on first call.
- **Playback stopped, with the daemon emitting an unbounded stream of errors**
  (30 147 lines observed):

  ```
  audio stream error: A backend-specific error has occurred:
                      `alsa::poll()` returned POLLERR
  ```

  The cause was a **format the DAC cannot provide**. `playback.quality` was
  `hires_plus` (24-bit) against a TI PCM2706 that reports `S16_LE` only, and
  `audio.allow_quality_fallback` was `false` — i.e. *fail rather than reduce
  quality*. In exclusive mode with the `hw:` plugin there is no conversion layer, so
  ALSA simply refuses and the stream dies.

  Two details worth remembering:

  - **Capping the sample rate was not sufficient.** `audio.device_max_sample_rate`
    fixed the frequency but not the bit depth, and 24-bit is what this converter
    cannot do at all. Only lowering `playback.quality` resolved it.
  - **It looked like a hardware fault and was not.** Sending silence straight to
    ALSA proved the stack healthy and isolated the fault to the daemon's
    configuration:

    ```
    aplay -D hw:CARD=DAC,DEV=0 -f S16_LE -r 44100 -c 2 -d 15 /dev/zero
      → exit 0, no kernel errors
    aplay -D hw:CARD=DAC,DEV=0 -f S24_3LE -r 96000 ...
      → Sample format non available. Available formats: - S16_LE
    ```

    Power (`throttled=0x0`), temperature, CPU governor, USB bus and Wi-Fi signal
    were all ruled out by measurement before the configuration was touched.
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
- `NoNewPrivileges=true` was removed from the service unit, deliberately and with
  the reason recorded there. It blocks every setuid escalation — which is how
  `sudo` acquires root — so the same deployment granted the service sudo access
  and removed its ability to use it, breaking Wi-Fi configuration with
  *"sudo: The 'no new privileges' flag is set"*.
- **Known limitation:** the `pi` user has `NOPASSWD: ALL`, so the narrow sudoers grant
  does not meaningfully constrain the service — a compromise of the web UI yields
  root. Tightening this requires removing `pi`'s blanket sudo access.

### Known issues (upstream)

Four defects in `qbzd` were identified with reproductions and are not fixable
from this repository. The Qobuz Connect protocol is reverse-engineered, so gaps
of this kind are expected.

1. **A track picked from search results never loads.** The queue is replaced and
   the metadata switches, but the player is never told to start the new source —
   no `starting streaming playback` appears, and the previous track keeps
   playing under the new title. Selecting from an **album** works; any transport
   command forces a proper reload.
2. **The ALSA mixer is opened with the PCM device string**, `,DEV=0` included,
   which a mixer handle cannot parse (`Unknown parameter DEV`). Worked around
   here by storing `hw:CARD=<name>`.
3. **Hardware volume only recognises five control names** — `Master`, `PCM`,
   `Speaker`, `Headphone`, `Digital` (visible in the binary). A DAC calling its
   control anything else, such as `XMOS Audio 2.0 Output`, can never be driven.
4. **Software volume is applied nowhere** in `hw` + exclusive mode, in any
   configuration tried, including `dsd_mode: convert`. The value is stored and
   relayed to the Qobuz app, which therefore shows a slider that does nothing.
   `qconnect.volume_mode: locked` does not propagate to the app either.

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

[Unreleased]: https://github.com/dcuillery/qbz-pistreamer/compare/0.4.0...develop
[0.4.0]: https://github.com/dcuillery/qbz-pistreamer/compare/0.3.0...0.4.0
[0.1.0]: https://github.com/dcuillery/qbz-pistreamer/releases/tag/0.1.0
