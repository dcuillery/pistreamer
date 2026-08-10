# pistreamer — every operation you need, wrapped.

SHELL := /bin/bash

# Deliberately NOT named HOST/USER: make inherits the environment, and USER is
# already set in any interactive shell, so `USER ?=` would silently keep your
# Mac username and every ssh here would connect as the wrong user.
PI_HOST := $(shell awk '/^\[streamers\]/{getline; print $$1; exit}' inventory.ini 2>/dev/null)
PI_USER := $(shell awk -F= '/^ansible_user=/{print $$2; exit}' inventory.ini 2>/dev/null)
# -t allocates a TTY so `qbzd setup`'s TUI renders.
# -4 forces IPv4: mDNS also advertises eth0's link-local IPv6, and eth0 has
# carrier but no usable IP config, so unqualified connections intermittently
# land on a dead address.
SSH     := ssh -4 -t $(PI_USER)@$(PI_HOST)

.DEFAULT_GOAL := help

## ---- setup -----------------------------------------------------------------

help:  ## Show this help
	@echo "pistreamer — Qobuz Connect endpoint on a Raspberry Pi 3B"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo
	@if [ -f inventory.ini ]; then \
	  echo "  Target: $(PI_USER)@$(PI_HOST)"; \
	else \
	  echo "  No inventory.ini yet — run: cp inventory.ini.example inventory.ini"; \
	fi

guard-inventory:
	@test -f inventory.ini || { \
	  echo "inventory.ini missing. Run: cp inventory.ini.example inventory.ini"; \
	  exit 1; }

ping: guard-inventory  ## Check the Pi is reachable and Ansible can talk to it
	ansible streamers -m ping

check: guard-inventory  ## Dry run — show every change without making it
	ansible-playbook site.yml --check --diff

provision: guard-inventory  ## Apply the configuration
	ansible-playbook site.yml --diff

reboot: guard-inventory  ## Reboot the Pi and wait for it to come back
	ansible streamers -b -m reboot -a "reboot_timeout=180"

## ---- Qobuz -----------------------------------------------------------------

dacs: guard-inventory  ## List the ALSA playback devices and their capabilities
	@$(SSH) 'aplay -l; echo "--- USB devices ---"; lsusb; \
	  echo "--- supported formats/rates ---"; \
	  cat /proc/asound/card*/stream0 2>/dev/null || echo "(no USB audio device)"'

setup: guard-inventory  ## Six-screen wizard: Qobuz login, audio device, Connect name
	$(SSH) 'qbzd setup'

login: guard-inventory  ## Re-authenticate only (setup already covers login)
	$(SSH) 'qbzd login'

settings-show: guard-inventory  ## Dump qbzd's live settings keys and values
	@$(SSH) 'qbzd settings show'

## ---- operations ------------------------------------------------------------

status: guard-inventory  ## Daemon state and now-playing
	@$(SSH) 'systemctl --user status qbzd --no-pager -l; echo; qbzd status; qbzd now || true'

# --user-unit, not `--user -u`: the latter reads the per-user journal, which
# is empty here, and reports "No journal files were found". The user unit's
# output actually lands in the system journal.
logs: guard-inventory  ## Follow the daemon log
	$(SSH) 'journalctl --user-unit qbzd -f'

boots: guard-inventory  ## List previous boots (to spot unclean restarts)
	@$(SSH) 'journalctl --list-boots --no-pager; echo; uptime -p; vcgencmd get_throttled'

restart: guard-inventory  ## Restart the daemon
	$(SSH) 'systemctl --user restart qbzd'

upgrade: guard-inventory  ## Re-install qbzd after bumping qbzd_version in group_vars/all.yml
	ansible-playbook site.yml --diff --tags qbzd

## ---- web UI ----------------------------------------------------------------

web: guard-inventory  ## Deploy/update the web UI only
	ansible-playbook site.yml --diff --tags webui

webui-password: guard-inventory  ## Set the web UI password (prompts; never stored in git)
	@read -rsp "Nouveau mot de passe : " p; echo; \
	 read -rsp "Confirmer : " q; echo; \
	 if [ "$$p" != "$$q" ]; then echo "Les mots de passe diffèrent."; exit 1; fi; \
	 if [ -z "$$p" ]; then echo "Mot de passe vide."; exit 1; fi; \
	 ansible-playbook site.yml --tags webui -e "webui_password=$$p"

web-logs: guard-inventory  ## Follow the web UI log
	$(SSH) 'journalctl -u pistreamer-web -f'

open:  ## Open the web UI in your browser
	@open "http://$(PI_HOST):8080/" 2>/dev/null || echo "http://$(PI_HOST):8080/"

hwparams: guard-inventory  ## Show the rate/format the DAC is actually receiving
	@$(SSH) 'cat /proc/asound/card*/pcm*p/sub*/hw_params 2>/dev/null || echo "nothing playing"'

shell: guard-inventory  ## SSH into the Pi
	$(SSH)

.PHONY: help guard-inventory ping check provision reboot dacs setup login web \
        settings-show status logs boots restart upgrade hwparams shell \
        webui-password web-logs open
