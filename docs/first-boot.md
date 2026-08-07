# First boot

Getting from a blank SD card to a Pi that Ansible can reach.

## 1. Flash Raspberry Pi OS Lite (64-bit)

**Lite**, because a desktop on a 1 GB Pi 3B is wasted RAM and extra services
competing for the same CPU that has to keep an audio buffer fed.
**64-bit**, because `qbzd` ships an `aarch64` binary only.

In **Raspberry Pi Imager**:

1. *Choose Device* → Raspberry Pi 3
2. *Choose OS* → Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)**
3. *Choose Storage* → your card
4. **Next** → **Edit Settings**, and fill in:

| Tab | Setting | Value |
|---|---|---|
| General | Hostname | `streamer` |
| General | Username | `pi` (match `ansible_user` in `inventory.ini`) |
| General | Wi-Fi SSID / password | yours — set the **country code** correctly or the radio stays off |
| General | Locale / timezone | yours |
| Services | Enable SSH | **Allow public-key authentication only**, paste `~/.ssh/id_ed25519.pub` |

Presetting SSH and Wi-Fi is what makes the rest of this headless. Skip it and
you need a monitor and keyboard to get in.

> **glibc note:** the binary is built against glibc 2.35 (Ubuntu 22.04)
> specifically so it runs on Raspberry Pi OS Bookworm (2.36) and later without
> a rebuild. Any current Pi OS release is fine.

If you don't have an SSH key yet:

```bash
ssh-keygen -t ed25519 -C "pistreamer"
cat ~/.ssh/id_ed25519.pub
```

## 2. Wire it up

Connect the **DAC** and the **network**, then power up.

On a Pi 3B, ethernet and all four USB ports share one USB 2.0 bus, so the
network and your DAC contend for the same controller. Wi-Fi is on SDIO and
avoids that entirely. Start with whichever is convenient — if you hear
dropouts, [troubleshooting.md](troubleshooting.md) covers switching.

### Power: use a real supply

The Pi 3B wants a **5.1 V / 2.5 A** micro-USB supply, and a bus-powered DAC
draws from the same budget.

**Do not power it from a router's, monitor's, or computer's USB port.** Those
typically supply 0.5 A (USB 2.0) or around 0.9 A (USB 3.0) — enough for the Pi
to boot and idle, which is what makes this trap so easy to fall into, but not
enough once a DAC is attached and actually streaming.

Undervoltage on a Pi 3B does not announce itself with a clean error. It
presents as precisely the symptoms this whole build exists to avoid: dropouts,
stalls, random instability — plus a genuine risk of SD card corruption. You can
lose evenings to it.

The official Raspberry Pi supply is the safe choice. Check for it any time
something is odd:

```bash
vcgencmd get_throttled     # 0x0 is what you want; anything else is undervoltage
```

## 3. Confirm you can reach it

```bash
ping streamer.local
ssh pi@streamer.local
```

If `.local` doesn't resolve, find the Pi on your LAN and use the IP in
`inventory.ini` instead:

```bash
arp -a | grep -iE 'b8:27:eb|dc:a6:32|e4:5f:01|2c:cf:67'
```

Those OUI prefixes belong to Raspberry Pi. A Pi 3B will be `b8:27:eb`.

## 4. Provision

```bash
cp inventory.ini.example inventory.ini
$EDITOR inventory.ini
make ping
make check       # dry run first
make provision
make reboot      # boot config changes need one reboot
```

## 5. Finish interactively

```bash
make dacs        # confirm the Pi sees your DAC
make setup       # six screens: Qobuz login, audio device, Connect name
make status
```

`qbzd setup` handles the Qobuz login itself, so there's usually no need to run
`make login` separately — it exists as an escape hatch if you only want to
re-authenticate.

The login is browser-based OAuth. Over SSH it prints a URL using the Pi's LAN
address, which you open on your Mac. If it stalls (300 s timeout), use
`qbzd login --paste` to paste the redirect back manually, or
`qbzd login --callback-host <pi-ip>` to force the address.

There are no email/password fields and no API keys — nothing to store in
this repo.

---

## Recording the checksum after a version bump

`group_vars/all.yml` pins both the version and its SHA-256. When you bump the
version, re-record the hash:

```bash
V=2.0.3
curl -sSL "https://github.com/vicrodh/qbz/releases/download/v$V/qbzd-$V-linux-aarch64.tar.gz" \
  | shasum -a 256
```

Put the version in `qbzd_version` and the hash in `qbzd_sha256`, then:

```bash
make upgrade
```

Leaving `qbzd_sha256` empty is allowed — the role warns and installs anyway —
but you lose integrity verification on a binary that runs as a network-facing
daemon.
