# pistreamer

Turn a Raspberry Pi into a headless, bit-perfect **Qobuz Connect** endpoint feeding a USB hi-fi DAC.

The Pi appears in the official Qobuz apps (iOS, Android, desktop, web) as a playback device.
You select it, hit play, and audio streams from Qobuz to the Pi and out to your DAC over USB —
untouched, at the source sample rate, up to 24-bit/192 kHz.

This repo is **provisioning**, not an OS image. You flash stock Raspberry Pi OS Lite, then run
one command from your Mac and the Pi becomes a streamer. Re-runnable at any time; it converges.

---

## Target hardware

Built and tuned for the board in hand:

| | |
|---|---|
| **Board** | Raspberry Pi 3 Model B v1.2 |
| **SoC** | BCM2837, quad-core Cortex-A53 @ 1.2 GHz — **ARMv8, 64-bit capable** |
| **RAM** | 1 GB (905 MiB usable) |
| **OS** | Raspberry Pi OS **Lite, 64-bit** — Debian 13 (trixie), glibc 2.41 |
| **DAC** | **Musical Fidelity V90-DAC** (`25b0:0010`), class-compliant UAC1 |

All verified on the actual device, 2026-08-07.

### What the V90-DAC actually supports

Read from `/proc/asound/card1/stream0` rather than the marketing copy:

```
Format: S24_3LE          Rates: 32000, 44100, 48000, 88200, 96000
Bits: 24                 Endpoint: 0x01 (1 OUT) (ASYNC)
```

Three consequences worth internalising:

- **The ceiling is 24-bit/96 kHz.** `qbzd` can do 24/192, but this DAC cannot. Qobuz
  192 kHz tracks *must* be downsampled to 96 kHz — that's a hardware limit, not a
  misconfiguration. Everything at 96 kHz and below plays bit-perfect.
- **It's an asynchronous endpoint**, so the DAC owns the clock rather than slaving to the
  Pi's. That's the good arrangement, and it means jitter is largely the DAC's problem.
- **It enumerates as USB *full speed* (12 Mbit/s)**, not high speed — normal for UAC1.
  This one matters more than it looks: full-speed devices behind a high-speed hub require
  **split transactions**, which on the Pi are handled by the very `dwc_otg` FIQ state
  machine that the `usb_fiq_fsm_mask` tunable adjusts. If you get crackle, that tunable is
  a more likely remedy on this pairing than it would be with a high-speed UAC2 DAC.
  24/96 stereo is ~4.6 Mbit/s against a 12 Mbit/s full-speed budget, so the headroom is
  real but not lavish.

64-bit matters: `qbzd` ships an `aarch64` binary only. The Pi 3B is ARMv8 so it qualifies.
A Pi 1, Pi 2, or original Pi Zero W is ARMv6/v7 and **cannot** run this.

### The Pi 3B constraint you need to know about

On the Pi 3 Model B, **the ethernet port and all four USB ports sit behind a single
LAN9514 hub on one shared USB 2.0 bus.** Your DAC and your network traffic contend for the
same 480 Mbit/s controller and the same interrupt path. Wi-Fi is different — it's on SDIO,
so it stays off that bus entirely.

This is the dominant engineering fact for this board. What it means in practice:

- **Bandwidth is not the problem.** Stereo 24/192 PCM is ~9.2 Mbit/s. There is room to spare.
- **Contention and interrupt latency are the problem.** Dropouts and crackle on Pi 3 USB
  audio almost always trace back to bus scheduling, not throughput.
- **If you get dropouts on ethernet, try Wi-Fi.** It is counter-intuitive, but moving the
  network off the shared USB bus onto SDIO genuinely helps on this board. 2.4 GHz 802.11n
  has ample headroom for hi-res FLAC.
- The provisioning applies several mitigations by default and documents an opt-in USB driver
  tunable in [docs/troubleshooting.md](docs/troubleshooting.md).

---

## How the Qobuz Connect part works

Qobuz Connect has **no public SDK** — Qobuz licenses it to certified hardware partners
(Bluesound, Cambridge, Eversolo, WiiM and similar). There is no official route for a DIY build.

This project therefore uses [**qbzd**](https://github.com/vicrodh/qbz), the headless daemon
from the QBZ project: MIT-licensed, written in Rust, a ~25 MB standalone binary that registers
itself on your network as a Qobuz Connect endpoint and does ALSA-exclusive `hw:` output.

Be clear-eyed about what that is:

- The protocol was **reverse-engineered**, not licensed. It is unofficial.
- It can break if Qobuz changes the protocol. Pin the version, expect occasional maintenance.
- It needs your own valid Qobuz subscription and logs in via the normal OAuth flow.
  There are no API keys to obtain and no credentials stored in this repo.

If you would rather stay on officially supported ground, the alternative is buying a
certified Connect streamer — this repo cannot make a Pi into one.

---

## Quickstart

### 0. Prerequisites on your Mac

```bash
brew install ansible
```

### 1. Flash Raspberry Pi OS Lite (64-bit)

Use **Raspberry Pi Imager**. Choose:

- *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**
- Click the gear / **Edit Settings** and preset:
  - **Hostname**: `streamer`
  - **Enable SSH** → *Allow public-key authentication only*, paste your `~/.ssh/id_ed25519.pub`
  - **Username**: `pi` (or your preference — set `ansible_user` to match)
  - **Wi-Fi**: your SSID and password, country code set correctly
  - **Locale / timezone**

Presetting SSH and Wi-Fi is what makes this headless. Without it you need a monitor and keyboard.

> Your existing card holds Raspbian Stretch from 2018. It is end-of-life, 32-bit, and carries
> a full desktop. It gets overwritten. Copy anything you care about off it first.

### 2. Boot and confirm reachability

Insert the card, connect the DAC and the network, power up. Give it a minute, then:

```bash
ping streamer.local
ssh pi@streamer.local
```

### 3. Point the repo at it

```bash
cp inventory.ini.example inventory.ini
$EDITOR inventory.ini      # set the hostname/IP and ansible_user
```

### 4. Provision

```bash
make check       # dry run — shows every change without making it
make provision   # apply
make reboot      # boot-config changes need one reboot
```

### 5. Log in to Qobuz and pick your DAC

These two steps are interactive by design and are **not** automated — see
[Why configuration isn't templated](#why-configuration-isnt-templated) below.

```bash
make dacs        # list the ALSA devices the Pi can see; find your DAC
make setup       # six-screen wizard: Qobuz login, audio device, Connect name
make status      # confirm the daemon is up and connected
```

`qbzd setup` handles the Qobuz login itself, so there's no separate login step
in the normal flow — `make login` exists only for re-authenticating later.
The login is browser-based OAuth; over SSH it prints a URL using the Pi's LAN
address which you open on your Mac. There are no passwords or API keys to
store anywhere in this repo.

In `make setup`, the settings that matter for bit-perfect output:

| Setting | Value | Why |
|---|---|---|
| Backend | **ALSA** | Bypasses PipeWire/Pulse resampling entirely |
| Output device | your DAC's `hw:` node | Direct hardware access, no mixer in the path |
| Exclusive mode | **on** | Stops anything else grabbing the card and forcing a resample |
| Reserve DAC | **on** | Holds the device so the first track doesn't clip while it opens |

### 6. Play

Open Qobuz on your phone or desktop, hit the Connect icon, choose `streamer`. Done.

---

## Everyday use

```bash
make status    # daemon state and now-playing
make logs      # live journal
make boots     # previous boots + throttle state — spot unclean restarts
make hwparams  # what rate/format the DAC is actually receiving
make provision # re-apply config after editing group_vars/all.yml
make upgrade   # bump qbzd (set qbzd_version first) and restart
```

## Web UI

A small FastAPI app on the Pi gives you a friendly front end: now-playing with
artwork and transport controls, DAC selection, playback quality, Qobuz login, and a
health panel that surfaces under-voltage.

```bash
make webui-password    # set a password (prompts; never stored in git)
make web               # deploy or update just the UI
make open              # open it in your browser
make web-logs          # follow its log
```

It lands on `http://streamer.local:8080/`.

### Volume, done properly

The slider drives the **DAC's own hardware attenuator**, not a software gain. The
level really changes, and the stream stays bit-perfect — attenuation happens
inside the converter, so the samples sent over USB are never altered. It is the
same mechanism as a TEAC's "variable line output".

This exists because `qbzd` cannot do it on most DACs: its ALSA engine only
recognises controls named `Master`, `PCM`, `Speaker`, `Headphone` or `Digital`,
and it applies no software attenuation at all in `hw` + exclusive mode. The
slider was therefore inert whatever the setting.

Nothing is hardcoded to one converter. The control is **discovered** — the first
element exposing `pvolume`, preferring a conventional name when a card has
several — and its range is read from ALSA (`min`/`max` and `dBminmax`) rather
than assumed. **A DAC exposing no volume control disables the slider
automatically**, with a message that distinguishes *cannot* from *must not*.

Two tapers, in `group_vars/all.yml`:

```yaml
webui_volume_taper: amplitude   # dB = 20·log10(slider) — an analogue pot:
                                # 50% = -6 dB, 0% = silence
webui_volume_min_db: auto       # "auto" reaches the DAC's own floor (-127 dB
                                # here); a number caps it, e.g. -12 for a trim
webui_volume_curve: 1.0         # only used by taper "power"
```

The `Volume control` setting chooses between driving the DAC and **locked** —
fixed output at 0 dB, leaving the volume to your amplifier. Switching to locked
restores full output first: "fixed" should mean 0 dB, not "frozen wherever the
slider happened to be".

> One caveat outside our reach: the **Qobuz app's own volume slider still does
> nothing**. `qbzd` relays the value without applying it, and `locked` does not
> propagate to the app either. See *Known issues* in [CHANGELOG.md](CHANGELOG.md).

### Languages

The interface is English and French, chosen from the browser's preferences on
first visit and overridable from a switcher available **before** sign-in as well
as after. The choice is remembered.

Translations are plain JSON, editable in your IDE and committed:

```
web/static/i18n/en.json
web/static/i18n/fr.json
```

No build step and no extraction tooling — open the file, change the string. A
missing key renders as the key itself, so a gap is immediately visible rather
than silently blanking part of the page. Number formatting follows the locale,
so 44.1 kHz becomes 44,1 kHz.

### Why it must run on the Pi

Two constraints, both found by probing the daemon rather than assuming:

**1. `qbzd` refuses browser requests.** Its API has an always-on *Origin shield*
that returns 403 to any request carrying an `Origin` header — verified directly:

```
sans Origin : 200
avec Origin : 403
```

Browsers always send `Origin` cross-origin, so a static page cannot call `qbzd`.
This app relays server-side, where no `Origin` header is sent.

**2. There are no settings endpoints.** `/api/settings`, `/api/config`,
`/api/devices` all return 404. Only `status`, `now-playing`, `events`, `ping`,
`playback/*` and `queue/*` exist. Every configuration action therefore shells out
to the `qbzd` CLI — which has to run locally.

```
browser ──password──> web UI (Pi) ──HTTP──> qbzd 127.0.0.1:8182
                                  └──exec──> qbzd CLI (settings, login)
```

### What it fixed about security

By default `qbzd` binds `0.0.0.0:8182` **with no authentication** — anyone on your
network could control playback. Provisioning now binds it to `127.0.0.1`.

Token auth was the obvious alternative and does not work here: the CLI has **no
`--token` flag and honours no token environment variable** (its only options are
`--host`, `-q`, `-h`, `-V`). Enabling `[server] token` would have broken
`qbzd settings set`, `qbzd login` and this project's own provisioning. Binding to
localhost reaches the same goal at no cost — the CLI and the UI both run on the Pi,
so neither notices, and the web UI becomes the single password-protected front door.

Your password is hashed **on the Pi** (PBKDF2-SHA256, 200k iterations) and only the
hash is written to `/etc/pistreamer/web.json`. The plaintext never touches this
repository, which is public.

## Changing the DAC

Plug the new one in and re-provision. That's the whole procedure:

```bash
make provision
```

`qbzd_audio_device` defaults to `auto`, and the role discovers the USB audio card from
`/proc/asound/cards` and derives the matching `hw:CARD=<name>,DEV=0`. This is unambiguous
because the `audio` role disables onboard analog and HDMI audio, so a USB DAC is the only
sound card the system has.

If no USB audio card is found, provisioning **fails with an explicit message** rather than
silently falling back to a device that would quietly resample. Check `make dacs` — and note
that under-voltage can drop a DAC off the USB bus entirely, which looks identical to it not
being plugged in.

To pin a device instead of auto-detecting, set it explicitly in `group_vars/all.yml`:

```yaml
qbzd_audio_device: "hw:CARD=M2496,DEV=0"
```

Prefer the `hw:CARD=<name>` form over `hw:0,0` — it survives card renumbering. Never use
`system`, ALSA's default device: it routes through the software mixer and silently disables
bit-perfect output.

Two things worth checking after a swap, since they are DAC-specific:

- **`make hwparams`** while playing — confirm `rate` tracks the source material.
- **The new DAC's ceiling.** `audio.limit_quality_to_device` is on, so `qbzd` adapts to what
  the hardware reports. The V90-DAC tops out at 24-bit/96 kHz; a UAC2 DAC may reach 24/192,
  in which case you get the full Qobuz hi-res stream with no downsampling.

---

## How configuration is managed

`qbzd` stores its config at `~/.config/qbz/qbzd.toml`, but **upstream does not publish that
file's schema.** Its supported interfaces are `qbzd setup` (a TUI) and
`qbzd settings set <key> <value>`.

So this repo does not template `qbzd.toml` — inventing key names would produce a config that
fails *silently*. Instead the key names were read off a configured device with
`qbzd settings show`, and `group_vars/all.yml` now applies them declaratively through
`qbzd settings set`. The role reads current values first and only writes the ones that differ,
so `make provision` stays idempotent.

Only the **Qobuz login** remains interactive, because it's browser-based OAuth — that's
`make setup`, and it's a one-time step.

### The failure this is guarding against

Worth understanding, because it cost real debugging time here. After running the wizard, the
daemon reported:

```
audio : alsa (system default) · bit-perfect: Disabled · 44100 Hz / 24-bit
```

`audio.backend` was `alsa`, `audio.alsa_plugin` was `hw`, `audio.exclusive_mode` was `true` —
everything looked right. But `audio.device` was **`system`**, ALSA's default device, which
routes through the software mixer. Music played perfectly. It simply wasn't bit-perfect, and
nothing announced that.

Setting `audio.device` to the card's `hw:` node flipped it to:

```
audio : alsa hw:CARD=M2496,DEV=0 · present · bit-perfect: DirectHardware
```

That is the entire reason `make hwparams` exists and the reason these values are pinned in
version control rather than left as wizard state.

---

## What the provisioning actually does

**`base`** — hostname, timezone, packages (`alsa-utils`, `avahi-daemon`, `cpufrequtils`),
mDNS so `streamer.local` resolves, journald capped so logs don't chew through the SD card,
swap disabled (1 GB is ample for this workload, and swapping to SD stalls audio and wears
the card), and unused daemons (`triggerhappy`, `ModemManager`) removed from the picture.

**`audio`** — the part that earns its keep on a Pi 3B:

- Onboard analog audio and HDMI audio disabled, so your USB DAC is unambiguously the only
  card and enumerates predictably.
- CPU governor pinned to `performance`. On-demand scaling introduces latency spikes exactly
  when a buffer needs refilling; this is a classic source of intermittent crackle.
- Realtime scheduling privileges (`rtprio`, `memlock`) granted to the `audio` group so the
  playback thread can hold its deadline under load.
- `gpu_mem=16` — headless has no use for GPU memory, and this Pi only has 1 GB.
- Bluetooth disabled by default (a streamer doesn't need it, and its interrupts aren't free).
- Wi-Fi power saving disabled — it causes periodic latency spikes that surface as dropouts.
- An **opt-in** `dwc_otg` USB driver tunable, off by default and documented rather than
  applied blind. See [docs/troubleshooting.md](docs/troubleshooting.md).

**`qbzd`** — downloads the pinned release tarball, verifies it against a recorded SHA-256,
installs the binary to `/usr/bin` and the unit shipped inside the tarball, adds a realtime
drop-in, and enables `loginctl` **linger**.

Two details there are worth calling out, because both fail *silently*:

- **Linger.** `qbzd` runs as a *user* service. Without lingering, systemd tears down the user
  session — and the daemon with it — the moment your SSH connection closes. The streamer works
  perfectly until you disconnect, then quietly vanishes from the Qobuz app.
- **The realtime drop-in.** systemd does **not** read `/etc/security/limits.conf` for services.
  The `audio` role's limits raise the *hard* limit when the user session is created via PAM, but
  the daemon's own *soft* limit still needs `LimitRTPRIO=` / `LimitMEMLOCK=` in a unit drop-in.
  With only one half in place the daemon runs at `rtprio 0` and can't request realtime
  scheduling at all — it plays fine, until the box gets busy.

---

## Layout

```
pistreamer/
├── CHANGELOG.md              # what changed, and why it mattered
├── Makefile                  # every operation you need, wrapped
├── ansible.cfg
├── inventory.ini.example     # copy to inventory.ini (gitignored)
├── group_vars/all.yml        # all tunables live here
├── site.yml
├── roles/
│   ├── base/                 # OS hygiene, packages, mDNS, SD-card care
│   ├── audio/                # Pi 3B USB audio tuning, RT limits, governor
│   ├── qbzd/                 # Qobuz Connect daemon install + service
│   └── webui/                # web UI deployment, network helper, sudoers
├── web/
│   ├── app.py                # HTTP API: session, state, SSE relay, settings
│   ├── qbzd.py               # daemon client — HTTP for state, CLI for config
│   ├── system.py             # Wi-Fi, password store, DAC hardware volume
│   └── static/
│       ├── index.html
│       ├── app.js
│       ├── style.css         # ZERON theme
│       ├── i18n.js
│       └── i18n/{en,fr}.json # translations — edit these
├── scripts/release.py        # roll [Unreleased] into a version, commit, tag
├── .githooks/pre-push        # refuse a version tag with no changelog entry
└── docs/
    ├── first-boot.md         # flashing and initial access in detail
    └── troubleshooting.md    # dropouts, DAC not appearing, login problems
```

## Releasing

```bash
make hooks                     # once: enable the repo's git hooks
make release VERSION=0.2.0     # roll the changelog, commit, tag
git push origin main 0.2.0
```

`make release` renames `[Unreleased]` to the version with today's date, opens a
fresh section, regenerates the comparison links, and refuses to run on a dirty
tree. The `pre-push` hook then blocks any semver tag that the changelog does not
document — the last moment such a mistake is still cheap to fix.

---

# Licence, credits and legal notice

## This project

Licensed under the **MIT Licence** — see [LICENSE](LICENSE). © 2026 Damien Cuillery.

## What this repository contains, and what it does not

**This repository bundles no third-party code whatsoever.** It is provisioning only:
Ansible roles, a Makefile and documentation, all original to this project.

Every third-party component is fetched **at provision time**, on your own device, from its
own official source:

- `qbzd` is downloaded from the upstream GitHub release and verified against a recorded
  SHA-256 (`group_vars/all.yml`).
- Everything else comes from the Debian / Raspberry Pi OS package repositories via `apt`.

That distinction matters for redistribution: cloning or forking this repository copies only
MIT-licensed original work. No binaries, no vendored sources, no credentials.

## Third-party components

| Component | Role | Licence | Source |
|---|---|---|---|
| **QBZ / `qbzd`** | The Qobuz Connect endpoint — the core of this build | **MIT** — © 2024 blitzkriegfc | [github.com/vicrodh/qbz](https://github.com/vicrodh/qbz) |
| **Ansible** | Runs the provisioning from your machine | GPL-3.0-or-later (`ansible-core`) | [ansible.com](https://www.ansible.com/) |
| **Raspberry Pi OS / Debian** | Host operating system | Individual per-package licences | [raspberrypi.com](https://www.raspberrypi.com/software/) |
| `alsa-utils`, `avahi-daemon`, `iw`, `curl`, `ca-certificates` | Installed via `apt` at provision time | Individual per-package licences | Debian repositories |

Ansible is a **tool this project is run with**, not a component it distributes, so its GPL
terms do not extend to this repository's code. Likewise, Debian packages are installed on
your device by `apt` under their own licences; none are redistributed here.

### Credit where it is due

This project is a thin orchestration layer. **The hard part — implementing a working Qobuz
Connect endpoint — is the work of the QBZ authors and contributors**, not of this repository.
If this build is useful to you, the credit belongs upstream:
[github.com/vicrodh/qbz](https://github.com/vicrodh/qbz), whose README lists its contributors.

## Important: Qobuz Connect is unofficial

Read this before publishing, forking or relying on this project.

**Qobuz Connect has no public SDK.** Qobuz licenses it to certified hardware partners.
`qbzd` implements the protocol through **reverse engineering**; it is not authorised,
certified or supported by Qobuz. Consequences you should accept up front:

- **It can stop working at any time**, without notice, if Qobuz changes the protocol.
- **A valid Qobuz subscription is required.** This project provides no content, no access
  and no circumvention of any kind — it plays your own subscription through your own DAC.
- **You are responsible for your own compliance** with the
  [Qobuz Terms of Service](https://www.qobuz.com/us-en/legal/terms).

Quoting the upstream project's own disclaimer:

> "This application uses the Qobuz API but is not certified by Qobuz. Qobuz is a trademark of
> Qobuz. QBZ is not affiliated with, endorsed by, or certified by Qobuz."

The same applies here, and to this project additionally.

## Trademarks

**Qobuz** is a trademark of Qobuz. **Raspberry Pi** is a trademark of Raspberry Pi Ltd.
**Musical Fidelity** is a trademark of Musical Fidelity Ltd. **Debian** is a registered
trademark of Software in the Public Interest, Inc.

This project is **not affiliated with, endorsed by, sponsored by or certified by** any of
them. Their names are used solely to describe interoperability — to state factually which
service, hardware and operating system this configuration targets.

## Privacy

This repository stores **no credentials**. Qobuz authentication is browser-based OAuth
handled entirely by `qbzd`, and the resulting token is stored on your own device under
`~/.local/share/qbzd/`. `inventory.ini` — which holds your host address and username — is
gitignored. Nothing is transmitted anywhere by this project.

## No warranty, and not legal advice

This project is provided "as is", without warranty of any kind, as set out in [LICENSE](LICENSE).
The summary above is offered in good faith and reflects licences verified at the time of
writing; it is **not legal advice**. If you intend to redistribute this work — particularly
commercially — verify the current terms of each component yourself, as upstream licences can
change.
