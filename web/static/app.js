/* pistreamer web UI.
   Polls /api/state for configuration and health, and layers qbzd's SSE event
   stream on top for instant transport updates.

   All user-facing text goes through t() from i18n.js. Nothing is hardcoded
   here — see /static/i18n/*.json. */

const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" }, ...opts,
  });
  if (r.status === 401) { showGate("login"); throw new Error("unauthenticated"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.status === 204 ? null : r.json();
};

let state = null;
let dragging = false;
// Last known DAC hardware mixer state. When a control exists, the slider
// drives IT rather than qbzd's volume, which is inert in bit-perfect mode.
let hwVol = null;
// Maintenance panel state, fetched on its own cadence: the version check goes
// out to the GitHub API and has no business on the 5-second dashboard poll.
let adminInfo = null;

/* ---------- helpers ---------- */

const fmtTime = (s) => {
  if (s == null || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

// Decimal separators differ: 44.1 kHz in English, 44,1 kHz in French.
const num1 = (v) => new Intl.NumberFormat(I18N.lang, {
  minimumFractionDigits: 1, maximumFractionDigits: 1,
}).format(v);

// The backend reports stable codes ("undervoltage", "freq_capped", …) rather
// than prose, precisely so they can be translated here.
const flagLabel = (code) => t(`flag.${code}`);

const qualityLabel = (v) => t(`quality.${v}`) === `quality.${v}` ? v : t(`quality.${v}`);
const volumeLabel  = (v) => t(`volume_mode.${v}`) === `volume_mode.${v}` ? v : t(`volume_mode.${v}`);

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

// Timestamps are stored as UTC ISO strings and rendered in the viewer's own
// zone and locale — the Pi's timezone is not necessarily the reader's.
function fmtStamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat(I18N.lang, {
    dateStyle: "medium", timeStyle: "short",
  }).format(d);
}

function setFact(el, text, cls) {
  el.textContent = text;
  el.className = cls || "";
}

/* ---------- gate ---------- */

/* The gate holds two forms: "claim" when no password exists yet, "login"
   otherwise. Showing the wrong one would either block a fresh install or
   invite anyone to reset a configured device. */
function showGate(mode) {
  $("gate").hidden = false;
  $("app").hidden = true;
  const claim = mode === "setup";
  $("setup-form").hidden = !claim;
  $("login-form").hidden = claim;
  (claim ? $("new-password") : $("password")).focus();
}
function showApp() {
  $("gate").hidden = true;
  $("wizard").hidden = true;
  $("app").hidden = false;
}

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p1 = $("new-password").value, p2 = $("new-password2").value;
  const err = $("setup-error");
  err.hidden = true;
  if (p1 !== p2) { err.textContent = t("gate.setup.mismatch"); err.hidden = false; return; }
  if (p1.length < 8) { err.textContent = t("gate.setup.too_short"); err.hidden = false; return; }
  try {
    await api("/api/setup-password", { method: "POST", body: JSON.stringify({ password: p1 }) });
  } catch (ex) {
    err.textContent = t("gate.setup.save_failed", { error: ex.message });
    err.hidden = false;
    return;
  }
  $("new-password").value = $("new-password2").value = "";
  // A device that has just been claimed has never been configured, so the
  // wizard is the right next screen rather than an empty dashboard.
  showWizard();
  toast(t("gate.setup.done"));
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").hidden = true;
  // The login call is caught on its own: wrapping start() in the same try
  // would report a rendering failure as "wrong password" and send any future
  // debugging in entirely the wrong direction.
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("password").value }),
    });
  } catch {
    $("login-error").textContent = t("gate.login.wrong");
    $("login-error").hidden = false;
    return;
  }
  $("password").value = "";
  await start();
});

$("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  location.reload();
});

/* ---------- views and tabs ---------- */

/* Two views (player, settings) and five settings tabs, all present in the
   markup and toggled with `hidden`. No routing and no templating: the whole
   interface is a few hundred lines of DOM, and rebuilding panels on every
   switch would lose focus and scroll position for no gain. */

function showView(name) {
  for (const el of document.querySelectorAll(".view")) {
    el.hidden = el.id !== `view-${name}`;
  }
  for (const btn of document.querySelectorAll(".view-btn")) {
    const active = btn.dataset.view === name;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
  // The maintenance panel is only refreshed when it is actually on screen —
  // it reaches out to the GitHub API, and polling that from the player view
  // would burn the hourly quota for nothing.
  if (name === "settings") refreshAdmin().catch(() => {});
}

function showTab(name) {
  for (const el of document.querySelectorAll(".tab-panel")) {
    el.hidden = el.dataset.tab !== name;
  }
  for (const btn of document.querySelectorAll(".tab-btn")) {
    const active = btn.dataset.tab === name;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  if (name === "system") refreshAdmin().catch(() => {});
  if (name === "network") refreshWifi().catch(() => {});
}

document.addEventListener("click", (e) => {
  const view = e.target.closest("[data-view]");
  if (view) showView(view.dataset.view);
  const tab = e.target.closest(".tab-btn");
  if (tab) showTab(tab.dataset.tab);
});

/* ---------- language ---------- */

// Delegated: the switcher exists twice (gate and topbar) and must work before
// sign-in as well as after.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-lang]");
  if (btn) I18N.set(btn.getAttribute("data-lang"));
});

// Static markup is re-translated by I18N.apply(); everything drawn from JS has
// to be redrawn here, otherwise half the page would switch and half would not.
document.addEventListener("i18n:changed", () => {
  if (state) {
    renderBanners(state); renderPlayer(state); renderAudio(state);
    renderAccount(state); renderHealth(state);
  }
  if (adminInfo) renderAdmin();
  if (!$("wizard").hidden) { renderWizard(); refreshWizardData().catch(() => {}); }
  refreshWifi().catch(() => {});
});

/* ---------- rendering ---------- */

function renderBanners(s) {
  const box = $("banners");
  box.innerHTML = "";
  const add = (cls, title, body) => {
    const d = document.createElement("div");
    d.className = `banner ${cls}`;
    // textContent, not innerHTML: `body` can carry a daemon error message,
    // which must never be parsed as markup.
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.textContent = body;
    d.append(strong, span);
    box.appendChild(d);
  };

  // Only ACTIVE conditions raise an alarm. The firmware's "has occurred" bits
  // latch until reboot, so treating them as current faults left a power alert
  // on screen indefinitely after one blip at boot — on a perfectly good supply.
  const active = s.health?.active || [];
  const power = active.filter((c) => c === "undervoltage" || c === "throttled");
  const thermal = active.filter((c) => c === "temp_limit");
  if (power.length) {
    add("err", t("banner.power_title"),
        t("banner.power_body", { flags: power.map(flagLabel).join(", ") }));
  }
  if (thermal.length) {
    add("warn", t("banner.thermal_title"), t("banner.thermal_body"));
  }
  if (!s.daemon) {
    add("err", t("banner.daemon_title"), t("banner.daemon_body"));
  }
  if (!s.password_configured) {
    add("warn", t("banner.nopw_title"), t("banner.nopw_body"));
  }
  // `last_errors` is sticky: qbzd keeps the last failure indefinitely, with no
  // timestamp, so it cannot be aged out. Rendering it as a warning meant an
  // incident resolved hours ago still looked like a live fault — the same
  // mistake as treating the firmware's "has occurred" bits as current.
  // Shown as a neutral note instead, worded so it reads as history.
  const streamErr = s.daemon?.last_errors?.stream;
  if (streamErr) {
    add("", t("banner.stream_error_title"),
        `${streamErr} — ${t("banner.stream_error_note")}`);
  }
}

function renderPlayer(s) {
  const p = s.daemon?.playback || {};
  $("title").textContent = p.title || t("player.nothing");
  $("artist").textContent = p.artist || "";
  $("pos").textContent = fmtTime(p.position);
  $("dur").textContent = fmtTime(p.duration);
  $("bar-fill").style.width =
    p.duration ? `${Math.min(100, (p.position / p.duration) * 100)}%` : "0%";
  // Class switches, not textContent: the glyphs are SVG living in the markup.
  $("toggle").classList.toggle("playing", p.state === "playing");

  renderVolume(s);

  if (p.title) {
    const img = $("art");
    img.src = `/api/artwork?t=${p.track_id || Date.now()}`;
    img.onload = () => { img.hidden = false; $("art-empty").hidden = true; };
    img.onerror = () => { img.hidden = true; $("art-empty").hidden = false; };
  }
}

/* Volume has two possible sources, and only one of them actually works here.
 *
 *   DAC hardware mixer  — real attenuation inside the converter, bit-perfect
 *                         preserved. Used whenever the DAC exposes a control.
 *   qbzd's own volume   — relayed to the Qobuz app, but applied nowhere in
 *                         hw+exclusive mode. Kept only as a fallback for DACs
 *                         with no hardware control.
 */
function renderVolume(s) {
  const el = $("volume"), w = $("vol-warning");
  const locked = s.settings?.["qconnect.volume_mode"] === "locked";
  const hw = hwVol?.available && !locked ? hwVol : null;

  // Locked: the DAC sits at full output and the amplifier does the volume.
  // The slider is disabled because it is meant to do nothing, not because it
  // is broken — a different message from "this DAC has no control".
  if (locked) {
    if (!dragging) {
      el.value = 100;
      $("vol-val").textContent = hwVol?.db != null ? `${Math.round(hwVol.db)} dB` : "0 dB";
      $("vol-icon").className = "vol-icon is-high";
    }
    el.disabled = true;
    el.title = t("player.volume_locked_title");
    w.className = "hint";
    w.textContent = t("player.volume_locked_hint") + " ";

    // Unlock from here rather than sending the user hunting through Settings.
    // This is the one disabled control in the interface whose next action is
    // unambiguous — the slider is off because a setting says so, and that
    // setting is one click away. textContent above cleared any previous
    // button, so this appends exactly one per render.
    const unlock = document.createElement("button");
    unlock.type = "button";
    unlock.className = "linkish";
    unlock.textContent = t("player.volume_unlock");
    unlock.addEventListener("click", async () => {
      unlock.disabled = true;
      await save("qconnect.volume_mode", "software");
      // The mixer is read again rather than assumed: unlocking only produces a
      // usable slider if the DAC actually exposes a control, and the next
      // render needs to know which of the two it is.
      await refreshHwVolume();
    });
    w.append(unlock);

    w.hidden = false;
    return;
  }

  if (hw) {
    if (!dragging) {
      // `slider` is the position on the useful dB window, not the raw ALSA
      // percentage — the raw scale puts -63 dB at half travel.
      const pos = hw.slider ?? 100;
      el.value = pos;
      // dB is the honest unit for an attenuator, and what the hi-fi world reads.
      $("vol-val").textContent = hw.db != null ? `${Math.round(hw.db)} dB` : `${pos}%`;
      $("vol-icon").className =
        `vol-icon ${pos === 0 ? "is-mute" : pos < 50 ? "is-low" : "is-high"}`;
    }
    el.disabled = false;
    el.title = t("player.volume_hardware_title");
    w.className = "hint";
    w.textContent = t("player.volume_hardware_hint", { control: hw.control });
    w.hidden = false;
    return;
  }

  // No hardware volume control on this DAC.
  //
  // qbzd's own volume applies nothing in hw+exclusive mode, so there is no
  // second path to fall back on: the control is disabled outright rather than
  // left looking operable. Better an honestly greyed-out slider than one that
  // moves and changes nothing.
  const p = s.daemon?.playback || {};
  const v = Math.round((p.volume ?? 1) * 100);
  if (!dragging) {
    el.value = v;
    $("vol-val").textContent = "—";
    $("vol-icon").className = "vol-icon is-mute";
  }
  el.disabled = true;
  el.title = t("player.volume_unavailable_title");
  w.className = "hint warn";
  w.textContent = t("player.volume_unavailable_hint");
  w.hidden = false;
}

async function refreshHwVolume() {
  try { hwVol = await api("/api/hwvolume"); }
  catch { hwVol = null; }
  if (state) renderVolume(state);
}

function renderAudio(s) {
  const a = s.daemon?.audio || {};
  $("fmt").textContent = a.sample_rate
    ? `${num1(a.sample_rate / 1000)} kHz / ${a.bit_depth || "?"} bit`
    : "—";

  const bp = a.bit_perfect;
  if (bp && bp !== "Disabled") setFact($("bitperfect"), bp, "ok");
  else if (a.configured_device === "system")
    setFact($("bitperfect"), t("audio.bitperfect_off_system"), "err");
  else setFact($("bitperfect"), bp || t("audio.bitperfect_inactive"), "warn");

  if (a.device_present)
    setFact($("dac-state"), t(a.device_open ? "audio.dac_open" : "audio.dac_connected"), "ok");
  else setFact($("dac-state"), t("audio.dac_absent"), "warn");

  // Device picker. A switched-off DAC vanishes from ALSA, so keep the
  // configured value visible rather than silently dropping the selection.
  const sel = $("device");
  const current = s.settings?.["audio.device"] || "";
  sel.innerHTML = "";
  const seen = new Set();
  for (const d of s.devices) {
    seen.add(d.device);
    sel.add(new Option(
      t("audio.device_option", { description: d.description, card: d.card }), d.device));
  }
  if (current && !seen.has(current)) {
    sel.add(new Option(t("audio.device_offline", { device: current }), current));
  }
  sel.value = current;

  const dev = s.devices.find((d) => d.device === sel.value);
  $("device-caps").textContent = dev?.rates?.length
    ? t("audio.caps", { rates: dev.rates.map((r) => num1(r / 1000)).join(", ") }) +
      (dev.bits ? t("audio.caps_bits", { bits: dev.bits }) : "")
    : "";

  fillSelect($("quality"), s.choices.quality, qualityLabel, s.settings?.["playback.quality"]);
  fillSelect($("volume-mode"), s.choices.volume_mode, volumeLabel,
             s.settings?.["qconnect.volume_mode"]);

  // The mode is a real choice again, but about OUR volume path rather than
  // qbzd's inert one:
  //   software — the slider drives the DAC's own attenuator
  //   locked   — fixed output at 0 dB, the amplifier does the volume
  // qbzd's key is reused as the store: "locked" already means "do not touch
  // the level", so the two readings agree.
  const modeHint = $("volume-mode").parentElement.querySelector(".hint");
  if (modeHint) {
    modeHint.textContent = t("audio.volume_mode_hint");
    modeHint.className = "hint";
  }

  // qbzd stores booleans as the strings "true"/"false".
  // Skip while focused so a poll cannot flip the switch under the user's finger.
  if (document.activeElement !== $("gapless")) {
    $("gapless").checked = s.settings?.["audio.gapless_enabled"] === "true";
  }
}

function fillSelect(sel, values, label, current) {
  sel.innerHTML = "";
  for (const v of values) sel.add(new Option(label(v), v));
  if (current) sel.value = current;
}

function renderAccount(s) {
  const auth = s.daemon?.auth || {};
  const logged = auth.state === "logged_in";
  setFact($("auth-state"), t(logged ? "qobuz.signed_in" : "qobuz.signed_out"),
          logged ? "ok" : "warn");
  $("user-id").textContent = auth.user_id || "—";
  $("subscription").textContent = auth.subscription || "";
  $("qobuz-login").textContent = t(logged ? "qobuz.relogin" : "qobuz.login");
  $("qobuz-logout").disabled = !logged;

  const qc = s.daemon?.qconnect || {};
  setFact($("qc-state"), qc.state || "—", qc.state === "connected" ? "ok" : "warn");
  $("qc-session").textContent =
    t(qc.session_active ? "qconnect.session_active" : "qconnect.session_inactive");
  if (document.activeElement !== $("qc-name")) {
    $("qc-name").value = s.settings?.["qconnect.device_name"] || "";
  }
  $("device-name").textContent = qc.device_name || "Pi Streamer";
  $("conn-dot").className = `dot ${qc.state === "connected" ? "on" : "off"}`;
}

function renderHealth(s) {
  const h = s.health || {};
  const el = $("power");
  if (h.healthy === true) {
    setFact(el, t("system.power_ok"), "ok");
    // History belongs in a tooltip, not in an alarm: it is context for someone
    // already investigating, not a call to action.
    el.title = h.since_boot?.length
      ? t("system.power_since_boot", { flags: h.since_boot.map(flagLabel).join(", ") })
      : "";
  } else if (h.active?.length) {
    setFact(el, h.active.map(flagLabel).join(", "), "err");
    el.title = h.throttled_raw || "";
  } else {
    setFact(el, t("system.power_unknown"), "");
    el.title = "";
  }
  $("temp").textContent = h.temperature_c != null ? `${h.temperature_c} °C` : "—";
  const up = s.daemon?.uptime_secs;
  $("uptime").textContent = up
    ? t("system.uptime", { hours: Math.floor(up / 3600), minutes: Math.floor((up % 3600) / 60) })
    : "—";
  $("version").textContent = s.daemon?.version ? `qbzd ${s.daemon.version}` : "";
}

/* ---------- data ---------- */

async function refresh() {
  const sess = await api("/api/session");
  state = await api("/api/state");
  state.password_configured = sess.password_configured;
  renderBanners(state);
  renderPlayer(state);
  renderAudio(state);
  renderAccount(state);
  renderHealth(state);
}

async function save(key, value) {
  try {
    const r = await api("/api/settings", {
      method: "POST", body: JSON.stringify({ [key]: value }),
    });
    if (r.failed && Object.keys(r.failed).length) {
      toast(t("toast.save_failed", { error: Object.values(r.failed)[0] }));
    } else {
      toast(t("toast.saved"));
      state.settings = r.settings;
      // The footer's "last saved" must move on the save itself, not on the
      // next maintenance poll — a stamp that lags the action it describes is
      // worse than no stamp.
      if (r.last_saved && adminInfo?.state) {
        adminInfo.state.settings_last_saved = r.last_saved;
        renderLastSaved();
      }
      // renderPlayer too: volume_mode decides whether the slider is usable,
      // and waiting for the next poll would leave it wrong for 5 seconds.
      renderAudio(state); renderAccount(state); renderPlayer(state);
    }
  } catch (e) { toast(t("toast.error", { error: e.message })); }
}

/* ---------- events ---------- */

$("device").addEventListener("change", (e) => save("audio.device", e.target.value));
$("quality").addEventListener("change", (e) => save("playback.quality", e.target.value));
$("volume-mode").addEventListener("change", async (e) => {
  const mode = e.target.value;
  // Switching to locked restores full output first: "fixed line output" means
  // 0 dB, not "frozen at whatever the slider happened to be".
  if (mode === "locked" && hwVol?.available) {
    try { hwVol = await api("/api/hwvolume", { method: "POST", body: JSON.stringify({ percent: 100 }) }); }
    catch { /* reported by save() below if it matters */ }
  }
  await save("qconnect.volume_mode", mode);
});

$("gapless").addEventListener("change", async (e) => {
  const el = e.target;
  const wanted = el.checked;
  el.disabled = true;
  try {
    await save("audio.gapless_enabled", wanted ? "true" : "false");
  } finally {
    el.disabled = false;
  }
  // save() re-renders from the daemon's reply, so the switch reflects what was
  // actually stored rather than what was clicked.
});

let nameTimer;
$("qc-name").addEventListener("input", (e) => {
  clearTimeout(nameTimer);
  const v = e.target.value.trim();
  if (v) nameTimer = setTimeout(() => save("qconnect.device_name", v), 700);
});

for (const [id, action] of [["prev", "prev"], ["toggle", "toggle"], ["next", "next"]]) {
  $(id).addEventListener("click", async () => {
    try { await api(`/api/playback/${action}`, { method: "POST" }); }
    catch (e) { toast(t("toast.error", { error: e.message })); }
  });
}

$("volume").addEventListener("input", (e) => {
  dragging = true;
  $("vol-val").textContent = `${e.target.value}%`;
});
$("volume").addEventListener("change", async (e) => {
  const pct = Number(e.target.value);
  try {
    if (hwVol?.available) {
      hwVol = await api("/api/hwvolume", {
        method: "POST", body: JSON.stringify({ percent: pct }),   // slider position
      });
    } else {
      await api("/api/volume", {
        method: "POST", body: JSON.stringify({ volume: pct / 100 }),
      });
    }
  } catch (err) { toast(t("toast.error", { error: err.message })); }
  finally {
    dragging = false;
    if (state) renderVolume(state);
  }
});

$("qobuz-login").addEventListener("click", async () => {
  $("qobuz-login").disabled = true;
  try {
    const { url } = await api("/api/qobuz/login", { method: "POST" });
    $("login-url").href = url;
    $("login-url").textContent = url;
    $("login-url-box").hidden = false;
    window.open(url, "_blank", "noopener");
  } catch (e) { toast(t("toast.error", { error: e.message })); }
  finally { $("qobuz-login").disabled = false; }
});

$("qobuz-logout").addEventListener("click", async () => {
  await api("/api/qobuz/logout", { method: "POST" }).catch(() => {});
  refresh();
});

/* ---------- Wi-Fi ---------- */

async function refreshWifi() {
  const out = $("wifi-result");
  try {
    const w = await api("/api/wifi/status");
    // The helper reports its own failures in-band, so a 200 does not by itself
    // mean the query worked.
    if (w.ok === false) throw new Error(w.error || t("wifi.unavailable"));
    $("wifi-ssid").textContent = w.ssid || "—";
    $("wifi-ip").textContent = w.ip || "—";
    if (w.signal != null) {
      const pct = Number(w.signal);
      $("wifi-signal").textContent = `${pct}%`;
      $("wifi-signal").className = pct >= 60 ? "ok" : pct >= 40 ? "warn" : "err";
    } else { setFact($("wifi-signal"), "—", ""); }
    out.hidden = true;
  } catch (e) {
    // Previously swallowed, which left three dashes on screen and no clue why.
    setFact($("wifi-ssid"), t("wifi.unavailable"), "warn");
    out.hidden = false;
    out.className = "hint warn";
    out.textContent = t("wifi.status_failed", { error: e.message });
  }
}

// Placeholder option is rebuilt on language change, hence not in the markup.
function resetWifiSelect(sel) {
  sel.innerHTML = "";
  sel.add(new Option(t("wifi.scan_placeholder"), ""));
}

$("wifi-scan").addEventListener("click", async () => {
  const btn = $("wifi-scan");
  btn.disabled = true; btn.textContent = t("wifi.scanning");
  try {
    const { networks } = await api("/api/wifi/scan");
    const sel = $("wifi-ssid-select");
    const current = $("wifi-ssid").textContent;
    sel.innerHTML = "";
    for (const n of networks) {
      const lock = n.security && n.security !== "--" ? " ·" : "";
      sel.add(new Option(`${n.ssid} — ${n.signal}%${lock}`, n.ssid));
    }
    if (networks.some((n) => n.ssid === current)) sel.value = current;
    toast(t("wifi.found", { count: networks.length }));
  } catch (e) { toast(t("wifi.scan_failed", { error: e.message })); }
  finally { btn.disabled = false; btn.textContent = t("wifi.scan"); }
});

$("wifi-connect").addEventListener("click", async () => {
  const ssid = $("wifi-ssid-select").value;
  if (!ssid) { toast(t("wifi.pick_first")); return; }
  if (!confirm(t("wifi.confirm", { ssid }))) return;

  const btn = $("wifi-connect"), out = $("wifi-result");
  btn.disabled = true; btn.textContent = t("wifi.connecting");
  out.hidden = true;
  try {
    const r = await api("/api/wifi", {
      method: "POST",
      body: JSON.stringify({ ssid, passphrase: $("wifi-psk").value }),
    });
    $("wifi-psk").value = "";
    out.hidden = false;
    if (r.ok) {
      out.className = "hint";
      out.textContent = t("wifi.connected", { ssid: r.ssid });
      refreshWifi();
    } else {
      out.className = "hint warn";
      out.textContent = t("wifi.failed",
        { error: r.error, restored: r.restored || t("wifi.none") });
    }
  } catch (e) {
    out.hidden = false; out.className = "hint warn";
    // A timeout here often means the switch worked and took the link with it.
    out.textContent = t("wifi.no_response", { error: e.message });
  } finally { btn.disabled = false; btn.textContent = t("wifi.connect"); }
});

/* ---------- password ---------- */

$("pw-save").addEventListener("click", async () => {
  const out = $("pw-result");
  out.hidden = true;
  try {
    await api("/api/password", {
      method: "POST",
      body: JSON.stringify({ current: $("pw-current").value, new: $("pw-new").value }),
    });
    $("pw-current").value = $("pw-new").value = "";
    out.hidden = false; out.className = "hint"; out.textContent = t("security.changed");
  } catch (e) {
    out.hidden = false; out.className = "hint warn";
    out.textContent = t("security.failed", { error: e.message });
  }
});

/* ---------- maintenance ---------- */

/* The four operations that previously required SSH — upgrade, restart, logs,
   reset. Each one is deliberately explicit about what it is about to do:
   these are the only controls in this interface that can take the streamer
   off the air. */

async function refreshAdmin(force = false) {
  try {
    adminInfo = await api(`/api/admin/info${force ? "?refresh=true" : ""}`);
  } catch {
    return;   // the panel keeps its last values rather than blanking
  }
  renderAdmin();
}

function renderAdmin() {
  if (!adminInfo) return;
  const q = adminInfo.qbzd || {};

  $("qbzd-installed").textContent = q.installed || "—";

  // An unreachable release API is a normal state on a network with no outbound
  // access, and says nothing about whether an upgrade exists.
  if (q.latest) {
    setFact($("qbzd-latest"), q.latest, q.upgradable ? "warn" : "ok");
  } else {
    setFact($("qbzd-latest"), t("maint.offline"), "");
  }
  $("qbzd-upgrade").disabled = !q.upgradable;
  $("qbzd-upgrade").textContent = q.upgradable
    ? t("maint.upgrade_to", { version: q.latest })
    : t("maint.up_to_date");

  const d = adminInfo.daemon || {};
  setFact($("daemon-unit"), d.active || "—", d.running ? "ok" : "err");

  renderLastSaved();
}

function renderLastSaved() {
  const iso = adminInfo?.state?.settings_last_saved;
  const when = fmtStamp(iso);
  $("last-saved").textContent = when
    ? t("footer.last_saved", { when })
    : t("footer.never_saved");
  $("last-saved").title = iso || "";
}

$("qbzd-check").addEventListener("click", async () => {
  const btn = $("qbzd-check");
  btn.disabled = true;
  try { await refreshAdmin(true); toast(t("maint.checked")); }
  finally { btn.disabled = false; }
});

$("qbzd-upgrade").addEventListener("click", async () => {
  const q = adminInfo?.qbzd || {};
  if (!confirm(t("maint.upgrade_confirm", { version: q.latest }))) return;

  const btn = $("qbzd-upgrade"), out = $("upgrade-result");
  btn.disabled = true;
  btn.textContent = t("maint.upgrading");
  out.hidden = false; out.className = "hint"; out.textContent = t("maint.upgrading_hint");
  try {
    const r = await api("/api/admin/upgrade", { method: "POST" });
    if (!r.changed) {
      out.textContent = t("maint.already", { version: r.installed });
    } else {
      // The hash is shown so it can be recorded in group_vars/all.yml, which
      // is what keeps `make provision` from reinstalling the older pinned
      // build over the top of this one.
      out.textContent = t("maint.upgraded", {
        version: r.installed, previous: r.previous || "—", sha: r.sha256 || "—",
      });
      if (r.daemon_error) {
        out.className = "hint warn";
        out.textContent += ` — ${t("maint.daemon_failed", { error: r.daemon_error })}`;
      }
    }
    await refreshAdmin(true);
  } catch (e) {
    out.className = "hint warn";
    out.textContent = t("maint.upgrade_failed", { error: e.message });
  } finally {
    btn.disabled = false;
    renderAdmin();
  }
});

for (const [id, target, confirmKey] of [
  ["restart-daemon", "daemon", null],
  ["restart-web", "web", "maint.confirm_web"],
  ["reboot", "reboot", "maint.confirm_reboot"],
]) {
  $(id).addEventListener("click", async () => {
    if (confirmKey && !confirm(t(confirmKey))) return;
    const btn = $(id);
    btn.disabled = true;
    try {
      await api("/api/admin/restart", {
        method: "POST", body: JSON.stringify({ target }),
      });
      toast(t(`maint.${target}_started`));
      if (target === "daemon") await refreshAdmin();
    } catch (e) {
      toast(t("toast.error", { error: e.message }));
    } finally {
      // Left disabled for the two that take the server with them: re-enabling
      // a button whose backend is mid-restart only invites a second click that
      // cannot land.
      if (target === "daemon") btn.disabled = false;
    }
  });
}

/* ---------- logs ---------- */

async function loadLogs() {
  const unit = $("log-unit").value;
  const pre = $("log-output");
  pre.textContent = t("logs.loading");
  try {
    const r = await fetch(`/api/admin/logs?unit=${encodeURIComponent(unit)}&lines=300`);
    if (r.status === 401) { showGate("login"); return; }
    if (!r.ok) throw new Error(r.statusText);
    const text = await r.text();
    pre.textContent = text.trim() || t("logs.empty");
    // Newest lines are at the bottom, which is where a reader starts.
    pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    pre.textContent = t("logs.failed", { error: e.message });
  }
}

$("log-refresh").addEventListener("click", loadLogs);
$("log-unit").addEventListener("change", loadLogs);

/* ---------- factory reset ---------- */

$("factory-reset").addEventListener("click", async () => {
  // Two barriers, because this is the one irreversible button in the
  // interface: a confirm that spells out the consequences, then a typed word.
  if (!confirm(t("reset.confirm"))) return;
  const typed = prompt(t("reset.prompt"));
  if (typed == null) return;
  if (typed.trim().toUpperCase() !== "RESET") {
    toast(t("reset.mistyped"));
    return;
  }

  const btn = $("factory-reset"), out = $("reset-result");
  btn.disabled = true;
  out.hidden = false; out.className = "hint"; out.textContent = t("reset.working");
  try {
    const r = await api("/api/admin/reset", {
      method: "POST", body: JSON.stringify({ confirm: "RESET" }),
    });
    if (r.errors?.length) {
      out.className = "hint warn";
      out.textContent = t("reset.partial", { errors: r.errors.join("; ") });
      btn.disabled = false;
      return;
    }
    out.textContent = t("reset.done");
    // The password file is gone, so the session is meaningless. Reloading
    // lands on the first-run claim screen, which is the point of the reset.
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    out.className = "hint warn";
    out.textContent = t("reset.failed", { error: e.message });
    btn.disabled = false;
  }
});

/* ---------- setup wizard ---------- */

/* Five steps, in the order the device actually needs them: a network to reach
   Qobuz on, a DAC to play into, an account, a name, then a summary.
   The password is not a step here — it is the gate's first-run claim screen,
   which has to come before anything can be configured at all.

   Every step writes through the SAME endpoints as the Settings view. There is
   no separate "wizard mode" on the backend, so a value set here and a value
   set later cannot diverge. */

const WIZ_STEPS = ["network", "dac", "qobuz", "name", "done"];
let wizIndex = 0;

function showWizard() {
  $("gate").hidden = true;
  $("app").hidden = true;
  $("wizard").hidden = false;
  wizIndex = 0;
  renderWizard();
  refreshWizardData().catch(() => {});
}

function renderWizardSteps() {
  const ol = $("wiz-steps");
  ol.innerHTML = "";
  WIZ_STEPS.forEach((name, i) => {
    const li = document.createElement("li");
    li.className = `step${i === wizIndex ? " is-current" : ""}${i < wizIndex ? " is-done" : ""}`;
    const n = document.createElement("span");
    n.className = "step-n";
    n.textContent = String(i + 1);
    const label = document.createElement("span");
    label.textContent = t(`wizard.step.${name}`);
    li.append(n, label);
    ol.appendChild(li);
  });
}

function renderWizard() {
  for (const el of document.querySelectorAll(".wiz-step")) {
    el.hidden = el.dataset.step !== WIZ_STEPS[wizIndex];
  }
  renderWizardSteps();
  $("wiz-back").disabled = wizIndex === 0;
  $("wiz-next").textContent =
    wizIndex === WIZ_STEPS.length - 1 ? t("wizard.finish") : t("wizard.next");
}

/* Populates every step from one /api/state call, so moving between steps never
   waits on the network. */
async function refreshWizardData() {
  state = await api("/api/state");

  const w = await api("/api/wifi/status").catch(() => null);
  $("wiz-wifi-ssid").textContent = w?.ssid || t("wifi.unavailable");
  $("wiz-wifi-ip").textContent = w?.ip || "—";

  const sel = $("wiz-device");
  const current = state.settings?.["audio.device"] || "";
  sel.innerHTML = "";
  for (const d of state.devices) {
    sel.add(new Option(
      t("audio.device_option", { description: d.description, card: d.card }), d.device));
  }
  $("wiz-dac-empty").hidden = state.devices.length > 0;
  if (current && state.devices.some((d) => d.device === current)) sel.value = current;
  renderWizDeviceCaps();

  const auth = state.daemon?.auth || {};
  const logged = auth.state === "logged_in";
  setFact($("wiz-auth-state"), t(logged ? "qobuz.signed_in" : "qobuz.signed_out"),
          logged ? "ok" : "warn");
  $("wiz-qobuz-login").textContent = t(logged ? "qobuz.relogin" : "qobuz.login");

  if (document.activeElement !== $("wiz-name")) {
    $("wiz-name").value = state.settings?.["qconnect.device_name"] || "";
  }
  fillSelect($("wiz-quality"), state.choices.quality, qualityLabel,
             state.settings?.["playback.quality"]);

  // Summary, drawn from what is actually stored rather than from what was
  // typed into the form a moment ago.
  const dev = state.devices.find((d) => d.device === current);
  $("wiz-sum-dac").textContent = dev?.description || current || "—";
  setFact($("wiz-sum-qobuz"), t(logged ? "qobuz.signed_in" : "qobuz.signed_out"),
          logged ? "ok" : "warn");
  $("wiz-sum-name").textContent = state.settings?.["qconnect.device_name"] || "—";
}

function renderWizDeviceCaps() {
  const dev = state?.devices?.find((d) => d.device === $("wiz-device").value);
  $("wiz-device-caps").textContent = dev?.rates?.length
    ? t("audio.caps", { rates: dev.rates.map((r) => num1(r / 1000)).join(", ") }) +
      (dev.bits ? t("audio.caps_bits", { bits: dev.bits }) : "")
    : "";
}

$("wiz-device").addEventListener("change", renderWizDeviceCaps);

$("wiz-qobuz-login").addEventListener("click", async () => {
  const btn = $("wiz-qobuz-login");
  btn.disabled = true;
  try {
    const { url } = await api("/api/qobuz/login", { method: "POST" });
    $("wiz-login-url").href = url;
    $("wiz-login-url").textContent = url;
    $("wiz-login-url-box").hidden = false;
    window.open(url, "_blank", "noopener");
  } catch (e) { toast(t("toast.error", { error: e.message })); }
  finally { btn.disabled = false; }
});

$("wiz-back").addEventListener("click", () => {
  if (wizIndex > 0) { wizIndex--; renderWizard(); }
});

/* Each step commits its own value on the way forward, rather than batching
   everything at the end: a wizard that saves only on the last screen loses the
   lot if the daemon rejects one field. */
$("wiz-next").addEventListener("click", async () => {
  const btn = $("wiz-next");
  btn.disabled = true;
  try {
    const step = WIZ_STEPS[wizIndex];

    if (step === "dac" && $("wiz-device").value) {
      await api("/api/settings", {
        method: "POST",
        body: JSON.stringify({ "audio.device": $("wiz-device").value }),
      });
    }

    if (step === "name") {
      const payload = { "playback.quality": $("wiz-quality").value };
      const name = $("wiz-name").value.trim();
      if (name) payload["qconnect.device_name"] = name;
      await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    }

    if (step === "done") {
      await api("/api/wizard/complete", { method: "POST" });
      $("wizard").hidden = true;
      await start();
      toast(t("wizard.completed"));
      return;
    }

    wizIndex++;
    renderWizard();
    await refreshWizardData().catch(() => {});
  } catch (e) {
    toast(t("toast.save_failed", { error: e.message }));
  } finally {
    btn.disabled = false;
  }
});

// Skipping is allowed on purpose: a device configured over SSH with
// `make setup` is already complete, and forcing its owner through five screens
// to reach the player would be theatre.
$("wiz-skip").addEventListener("click", async () => {
  if (!confirm(t("wizard.skip_confirm"))) return;
  await api("/api/wizard/complete", { method: "POST" }).catch(() => {});
  $("wizard").hidden = true;
  await start();
});

$("rerun-wizard").addEventListener("click", () => showWizard());

/* SSE gives instant transport feedback; the poll keeps settings and health
   fresh, since those never appear on the event stream. */
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = () => refresh().catch(() => {});
  es.onerror = () => { es.close(); setTimeout(connectEvents, 5000); };
}

/* ---------- boot ---------- */

// One entry point for both paths, so logging in and reloading the page end up
// in exactly the same state.
let pollTimer = null;

async function start() {
  showApp();
  await refresh().catch(() => {});
  refreshHwVolume();
  refreshWifi();
  // Once, not on the poll: this is what fills in "settings last saved" in the
  // footer, and it costs a GitHub lookup the first time round.
  refreshAdmin().catch(() => {});
  connectEvents();
  if (!pollTimer) pollTimer = setInterval(() => {
    refresh().catch(() => {});
    refreshHwVolume();
  }, 5000);
}

(async () => {
  // Translations first: otherwise the gate would flash untranslated keys.
  await I18N.init();
  resetWifiSelect($("wifi-ssid-select"));
  document.addEventListener("i18n:changed", () => {
    if (!$("wifi-ssid-select").value) resetWifiSelect($("wifi-ssid-select"));
  });
  try {
    const sess = await api("/api/session");
    if (!sess.password_configured) { showGate("setup"); return; }
    if (!sess.authenticated) { showGate("login"); return; }
    // The wizard is shown once and then never again unless asked for. The flag
    // lives on the Pi rather than in localStorage: it describes the device,
    // not the browser looking at it, and every phone in the house would
    // otherwise be greeted by a setup flow for a streamer that already works.
    if (!sess.wizard_completed_at) { showWizard(); return; }
    await start();
  } catch { showGate("login"); }
})();
