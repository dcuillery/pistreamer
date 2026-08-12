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

const qualityLabel = (v) => t(`quality.${v}`) === `quality.${v}` ? v : t(`quality.${v}`);
const volumeLabel  = (v) => t(`volume_mode.${v}`) === `volume_mode.${v}` ? v : t(`volume_mode.${v}`);

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
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
function showApp() { $("gate").hidden = true; $("app").hidden = false; }

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
  await start();
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

  if (!s.health?.healthy && s.health?.flags?.length) {
    add("err", t("banner.power_title"),
        t("banner.power_body", { flags: s.health.flags.join(", ") }));
  }
  if (!s.daemon) {
    add("err", t("banner.daemon_title"), t("banner.daemon_body"));
  }
  if (!s.password_configured) {
    add("warn", t("banner.nopw_title"), t("banner.nopw_body"));
  }
  const streamErr = s.daemon?.last_errors?.stream;
  if (streamErr) add("warn", t("banner.stream_error_title"), streamErr);
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

  if (!dragging && p.volume != null) {
    const v = Math.round(p.volume * 100);
    $("volume").value = v;
    $("vol-val").textContent = `${v}%`;
    $("vol-icon").className =
      `vol-icon ${v === 0 ? "is-mute" : v < 50 ? "is-low" : "is-high"}`;
  }

  // Volume mode drives both the control and the message beneath it.
  //   locked   — qbzd never touches the samples, so the slider would do
  //              nothing. Disable it rather than offer a control that lies.
  //   software — attenuation is applied digitally, which silently defeats
  //              bit-perfect output below 100%. Say so plainly.
  const mode = s.settings?.["qconnect.volume_mode"];
  const locked = mode === "locked";
  const v = Math.round((p.volume ?? 1) * 100);
  const w = $("vol-warning");

  $("volume").disabled = locked;
  $("volume").title = t(locked ? "player.volume_locked_title" : "player.volume_software_title");

  if (locked) {
    w.className = "hint";
    w.textContent = t("player.volume_locked_hint");
    w.hidden = false;
  } else if (mode === "software" && v < 100) {
    w.className = "hint warn";
    w.textContent = t("player.volume_software_warn", { pct: v });
    w.hidden = false;
  } else { w.hidden = true; }

  if (p.title) {
    const img = $("art");
    img.src = `/api/artwork?t=${p.track_id || Date.now()}`;
    img.onload = () => { img.hidden = false; $("art-empty").hidden = true; };
    img.onerror = () => { img.hidden = true; $("art-empty").hidden = false; };
  }
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
  if (h.healthy === true) setFact($("power"), t("system.power_ok"), "ok");
  else if (h.flags?.length) setFact($("power"), `${h.throttled_raw} — ${h.flags[0]}`, "err");
  else setFact($("power"), t("system.power_unknown"), "");
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
      // renderPlayer too: volume_mode decides whether the slider is usable,
      // and waiting for the next poll would leave it wrong for 5 seconds.
      renderAudio(state); renderAccount(state); renderPlayer(state);
    }
  } catch (e) { toast(t("toast.error", { error: e.message })); }
}

/* ---------- events ---------- */

$("device").addEventListener("change", (e) => save("audio.device", e.target.value));
$("quality").addEventListener("change", (e) => save("playback.quality", e.target.value));
$("volume-mode").addEventListener("change", (e) => save("qconnect.volume_mode", e.target.value));

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
  try { await api("/api/volume", { method: "POST", body: JSON.stringify({ volume: e.target.value / 100 }) }); }
  catch (err) { toast(t("toast.error", { error: err.message })); }
  finally { dragging = false; }
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
  refreshWifi();
  connectEvents();
  if (!pollTimer) pollTimer = setInterval(() => refresh().catch(() => {}), 5000);
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
    await start();
  } catch { showGate("login"); }
})();
