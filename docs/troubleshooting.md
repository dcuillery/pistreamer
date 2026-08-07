# Troubleshooting

## The device doesn't appear in the Qobuz app

**Check the daemon is actually running:**

```bash
make status
```

**The single most likely cause is linger.** `qbzd` is a systemd *user*
service. Without lingering enabled, systemd tears down your user session — and
the daemon with it — the moment your SSH connection closes. The classic
symptom is a streamer that works perfectly while you're logged in and vanishes
from the app minutes after you disconnect.

```bash
ssh pi@streamer.local 'loginctl show-user $USER | grep Linger'
# want: Linger=yes
```

`qbzd status` warns about this explicitly. `make provision` enables it.

**Check you're logged in:** `qbzd status` will say. Re-run `make setup`.

**Check both devices are on the same network segment.** Connect discovery
needs the Qobuz app and the Pi to see each other; VLANs, guest networks and
client isolation on the access point all break it.

---

## Dropouts, crackle, or stuttering

This is the failure mode the Pi 3B is prone to, and it is almost never a
bandwidth problem. Stereo 24/192 PCM is about **9.2 Mbit/s** against a
480 Mbit/s bus. The problem is contention and interrupt latency, because
**ethernet and all four USB ports share a single USB 2.0 controller** on this
board.

Work through these in order — cheapest and most likely first.

### 1. Rule out power

Undervoltage on a Pi 3B presents as intermittent instability, not a clear
error. A bus-powered DAC makes it worse.

```bash
vcgencmd get_throttled     # 0x0 is what you want
```

Anything non-zero means the supply is inadequate. Use a 2.5 A supply, and
prefer a **self-powered** DAC or a powered USB hub.

### 2. Confirm the governor took

```bash
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor    # want: performance
```

Frequency scaling introduces latency spikes exactly when a buffer needs
refilling. If this says `ondemand`, the `audio` role didn't apply — re-run
`make provision`.

### 3. Move the network off the shared USB bus

Counter-intuitive but effective on this specific board: **switch from ethernet
to Wi-Fi.** The Pi 3B's Wi-Fi is on SDIO, not the USB bus, so it stops
competing with your DAC for the same controller. 2.4 GHz 802.11n has ample
headroom for hi-res FLAC.

If you're already on Wi-Fi and struggling, try the opposite — some
environments have too much 2.4 GHz congestion for a stable stream, and the
shared bus is the lesser evil.

### 4. Enable the dwc_otg FIQ tunable

The Pi's USB driver uses a FIQ state machine for split transactions. Some USB
DACs misbehave with the default mask. This is a **workaround for a specific
failure mode, not a general improvement**, which is why it's off by default —
applying it pre-emptively makes everything above harder to diagnose.

In `group_vars/all.yml`:

```yaml
usb_fiq_fsm_mask: "0x3"
```

Then:

```bash
make provision && make reboot
```

Set it back to `""` to remove it cleanly — the role handles both directions.

### 5. Try a different USB port, and drop the sample rate

Test whether 24/96 is stable when 24/192 isn't. If it is, you've confirmed a
bus-contention problem rather than a configuration one, which points back at
steps 1 and 3.

---

## The DAC doesn't show up at all

```bash
make dacs
```

That runs `aplay -l` and greps `lsusb` for audio devices.

- **Nothing in `lsusb`** — power or cable. Try a powered hub; the Pi 3B's
  per-port current budget is modest.
- **In `lsusb` but not `aplay -l`** — the DAC isn't class-compliant, or it's
  in a mode that needs a vendor driver. Most hi-fi DACs have a switch or menu
  setting for UAC2 / "class compliant" mode.
- **Card numbering moved** — the `audio` role disables onboard analog and HDMI
  audio precisely so the DAC is the only card and enumerates predictably. If
  you re-enabled either, expect the numbering to shift.

---

## Is it actually bit-perfect?

The point of this build is that nothing resamples your audio. Verify rather
than assume — a misconfigured backend still plays music, it just plays
resampled music, and there is no audible alarm bell.

With something playing, ask the kernel what the hardware is actually doing:

```bash
cat /proc/asound/card0/pcm0p/sub0/hw_params
```

Look at `rate:` and `format:`. Play a 96 kHz track and a 44.1 kHz track and
confirm the reported rate **changes to match**. If it's pinned at 48000
regardless of source, something in the path is resampling — go back to
`make setup` and confirm:

- Backend is **ALSA** (not PipeWire or Pulse)
- Output device is the DAC's `hw:` node, not `default` or a `plughw:` alias
- **Exclusive mode** is on

Most DACs also display the incoming sample rate on their front panel, which is
the easiest confirmation of all.

---

## After a Qobuz-side change

The Connect protocol here is reverse-engineered, not licensed. If the device
stops appearing after working fine for months, and linger and network check
out, look for a newer `qbzd` release before assuming a local fault:

```bash
curl -s https://api.github.com/repos/vicrodh/qbz/releases/latest | grep tag_name
```

Bump `qbzd_version` and `qbzd_sha256` in `group_vars/all.yml`, then
`make upgrade`. See [first-boot.md](first-boot.md#recording-the-checksum-after-a-version-bump).
