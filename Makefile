# pistreamer — every operation you need, wrapped.

SHELL := /bin/bash

# Deliberately NOT named HOST/USER: make inherits the environment, and USER is
# already set in any interactive shell, so `USER ?=` would silently keep your
# Mac username and every ssh here would connect as the wrong user.
PI_HOST := $(shell awk '/^\[streamers\]/{getline; print $$1; exit}' inventory.ini 2>/dev/null)
PI_USER := $(shell awk -F= '/^ansible_user=/{print $$2; exit}' inventory.ini 2>/dev/null)
SSH     := ssh -t $(PI_USER)@$(PI_HOST)

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

dacs: guard-inventory  ## List the ALSA playback devices the Pi can see
	@$(SSH) 'aplay -l; echo; echo "--- USB audio devices ---"; lsusb | grep -i audio || true'

setup: guard-inventory  ## Six-screen wizard: Qobuz login, audio device, Connect name
	$(SSH) 'qbzd setup'

login: guard-inventory  ## Re-authenticate only (setup already covers login)
	$(SSH) 'qbzd login'

settings-show: guard-inventory  ## Dump qbzd's live settings keys and values
	@$(SSH) 'qbzd settings show'

## ---- operations ------------------------------------------------------------

status: guard-inventory  ## Daemon state and now-playing
	@$(SSH) 'systemctl --user status qbzd --no-pager -l; echo; qbzd status; qbzd now || true'

logs: guard-inventory  ## Follow the daemon log
	$(SSH) 'journalctl --user -u qbzd -f'

restart: guard-inventory  ## Restart the daemon
	$(SSH) 'systemctl --user restart qbzd'

upgrade: guard-inventory  ## Re-install qbzd after bumping qbzd_version in group_vars/all.yml
	ansible-playbook site.yml --diff --tags qbzd

hwparams: guard-inventory  ## Show the rate/format the DAC is actually receiving
	@$(SSH) 'cat /proc/asound/card*/pcm*p/sub*/hw_params 2>/dev/null || echo "nothing playing"'

shell: guard-inventory  ## SSH into the Pi
	$(SSH)

.PHONY: help guard-inventory ping check provision reboot dacs setup login \
        settings-show status logs restart upgrade hwparams shell
