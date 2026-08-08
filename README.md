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
make provision # re-apply config after editing group_vars/all.yml
make upgrade   # bump qbzd (set qbzd_version first) and restart
```

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
├── Makefile                  # every operation you need, wrapped
├── ansible.cfg
├── inventory.ini.example     # copy to inventory.ini (gitignored)
├── group_vars/all.yml        # all tunables live here
├── site.yml
├── roles/
│   ├── base/                 # OS hygiene, packages, mDNS, SD-card care
│   ├── audio/                # Pi 3B USB audio tuning, RT limits, governor
│   └── qbzd/                 # Qobuz Connect daemon install + service
└── docs/
    ├── first-boot.md         # flashing and initial access in detail
    └── troubleshooting.md    # dropouts, DAC not appearing, login problems
```

## Licence

MIT. Bundles nothing; `qbzd` is fetched at provision time from its own MIT-licensed release.
