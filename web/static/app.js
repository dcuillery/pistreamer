/* pistreamer web UI.
   Polls /api/state for configuration and health, and layers qbzd's SSE event
   stream on top for instant transport updates. */

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

const QUALITY_LABELS = {
  mp3: "MP3 320 kbps",
  cd: "CD — 16 bits / 44,1 kHz",
  hires: "Hi-Res — 24 bits / 96 kHz",
  hires_plus: "Hi-Res+ — jusqu'à 24/192",
};
const VOLUME_LABELS = {
  software: "Logiciel (réglable depuis l'app)",
  locked: "Verrouillé (bit-perfect garanti)",
};

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
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
  if (p1 !== p2) { err.textContent = "Les mots de passe ne correspondent pas."; err.hidden = false; return; }
  if (p1.length < 8) { err.textContent = "8 caractères minimum."; err.hidden = false; return; }
  try {
    await api("/api/setup-password", { method: "POST", body: JSON.stringify({ password: p1 }) });
  } catch (ex) {
    err.textContent = `Impossible d'enregistrer : ${ex.message}`;
    err.hidden = false;
    return;
  }
  $("new-password").value = $("new-password2").value = "";
  await start();
  toast("Mot de passe défini");
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
    $("login-error").textContent = "Mot de passe incorrect.";
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

/* ---------- rendering ---------- */

function renderBanners(s) {
  const box = $("banners");
  box.innerHTML = "";
  const add = (cls, title, body) => {
    const d = document.createElement("div");
    d.className = `banner ${cls}`;
    d.innerHTML = `<strong>${title}</strong>${body}`;
    box.appendChild(d);
  };

  if (!s.health?.healthy && s.health?.flags?.length) {
    add("err", "Alimentation insuffisante",
      `Le Pi signale : ${s.health.flags.join(", ")}. ` +
      `Utilisez une alimentation 5,1 V / 2,5 A — c'est la première cause de coupures.`);
  }
  if (!s.daemon) {
    add("err", "Démon injoignable", "qbzd ne répond pas sur 127.0.0.1:8182.");
  }
  if (!s.password_configured) {
    add("warn", "Aucun mot de passe configuré",
      "N'importe qui sur le réseau peut modifier ces réglages.");
  }
  const streamErr = s.daemon?.last_errors?.stream;
  if (streamErr) add("warn", "Dernière erreur de flux", streamErr);
}

function renderPlayer(s) {
  const p = s.daemon?.playback || {};
  $("title").textContent = p.title || "Rien en lecture";
  $("artist").textContent = p.artist || "";
  $("pos").textContent = fmtTime(p.position);
  $("dur").textContent = fmtTime(p.duration);
  $("bar-fill").style.width =
    p.duration ? `${Math.min(100, (p.position / p.duration) * 100)}%` : "0%";
  $("toggle").textContent = p.state === "playing" ? "⏸" : "▶";

  if (!dragging && p.volume != null) {
    const v = Math.round(p.volume * 100);
    $("volume").value = v;
    $("vol-val").textContent = `${v}%`;
    $("vol-icon").textContent = v === 0 ? "🔇" : v < 50 ? "🔉" : "🔊";
  }

  // Software volume below 100% silently defeats bit-perfect output — the
  // single most confusing failure mode of this whole setup, so say it plainly.
  const soft = s.settings?.["qconnect.volume_mode"] === "software";
  const v = Math.round((p.volume ?? 1) * 100);
  const w = $("vol-warning");
  if (soft && v < 100) {
    w.textContent = `Volume logiciel à ${v} % : le signal est atténué numériquement, ` +
      `donc plus bit-perfect. Mettez 100 % et réglez le niveau sur l'ampli.`;
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
    ? `${(a.sample_rate / 1000).toFixed(1)} kHz / ${a.bit_depth || "?"} bits` : "—";

  const bp = a.bit_perfect;
  if (bp && bp !== "Disabled") setFact($("bitperfect"), bp, "ok");
  else if (a.configured_device === "system")
    setFact($("bitperfect"), "désactivé (sortie « system »)", "err");
  else setFact($("bitperfect"), bp || "inactif", "warn");

  if (a.device_present) setFact($("dac-state"), a.device_open ? "connecté, ouvert" : "connecté", "ok");
  else setFact($("dac-state"), "absent ou éteint", "warn");

  // Device picker. A switched-off DAC vanishes from ALSA, so keep the
  // configured value visible rather than silently dropping the selection.
  const sel = $("device");
  const current = s.settings?.["audio.device"] || "";
  sel.innerHTML = "";
  const seen = new Set();
  for (const d of s.devices) {
    seen.add(d.device);
    const o = new Option(`${d.description} (carte ${d.card})`, d.device);
    sel.add(o);
  }
  if (current && !seen.has(current)) {
    sel.add(new Option(`${current} — éteint ou débranché`, current));
  }
  sel.value = current;

  const dev = s.devices.find((d) => d.device === sel.value);
  $("device-caps").textContent = dev?.rates?.length
    ? `Prend en charge ${dev.rates.map((r) => (r / 1000).toFixed(1)).join(", ")} kHz` +
      (dev.bits ? ` en ${dev.bits} bits` : "")
    : "";

  fillSelect($("quality"), s.choices.quality, QUALITY_LABELS, s.settings?.["playback.quality"]);
  fillSelect($("volume-mode"), s.choices.volume_mode, VOLUME_LABELS,
             s.settings?.["qconnect.volume_mode"]);
}

function fillSelect(sel, values, labels, current) {
  sel.innerHTML = "";
  for (const v of values) sel.add(new Option(labels[v] || v, v));
  if (current) sel.value = current;
}

function renderAccount(s) {
  const auth = s.daemon?.auth || {};
  const logged = auth.state === "logged_in";
  setFact($("auth-state"), logged ? "connecté" : "non connecté", logged ? "ok" : "warn");
  $("user-id").textContent = auth.user_id || "—";
  $("subscription").textContent = auth.subscription || "";
  $("qobuz-login").textContent = logged ? "Se reconnecter" : "Se connecter à Qobuz";
  $("qobuz-logout").disabled = !logged;

  const qc = s.daemon?.qconnect || {};
  setFact($("qc-state"), qc.state || "—", qc.state === "connected" ? "ok" : "warn");
  $("qc-session").textContent = qc.session_active ? "active" : "inactive";
  if (document.activeElement !== $("qc-name")) {
    $("qc-name").value = s.settings?.["qconnect.device_name"] || "";
  }
  $("device-name").textContent = qc.device_name || "Pi Streamer";
  $("conn-dot").className = `dot ${qc.state === "connected" ? "on" : "off"}`;
}

function renderHealth(s) {
  const h = s.health || {};
  if (h.healthy === true) setFact($("power"), "correcte", "ok");
  else if (h.flags?.length) setFact($("power"), `${h.throttled_raw} — ${h.flags[0]}`, "err");
  else setFact($("power"), "inconnue", "");
  $("temp").textContent = h.temperature_c != null ? `${h.temperature_c} °C` : "—";
  const up = s.daemon?.uptime_secs;
  $("uptime").textContent = up ? `${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min` : "—";
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
      toast(`Échec : ${Object.values(r.failed)[0]}`);
    } else {
      toast("Enregistré");
      state.settings = r.settings;
      renderAudio(state); renderAccount(state);
    }
  } catch (e) { toast(`Erreur : ${e.message}`); }
}

/* ---------- events ---------- */

$("device").addEventListener("change", (e) => save("audio.device", e.target.value));
$("quality").addEventListener("change", (e) => save("playback.quality", e.target.value));
$("volume-mode").addEventListener("change", (e) => save("qconnect.volume_mode", e.target.value));

let nameTimer;
$("qc-name").addEventListener("input", (e) => {
  clearTimeout(nameTimer);
  const v = e.target.value.trim();
  if (v) nameTimer = setTimeout(() => save("qconnect.device_name", v), 700);
});

for (const [id, action] of [["prev", "prev"], ["toggle", "toggle"], ["next", "next"]]) {
  $(id).addEventListener("click", async () => {
    try { await api(`/api/playback/${action}`, { method: "POST" }); }
    catch (e) { toast(`Erreur : ${e.message}`); }
  });
}

$("volume").addEventListener("input", (e) => {
  dragging = true;
  $("vol-val").textContent = `${e.target.value}%`;
});
$("volume").addEventListener("change", async (e) => {
  try { await api("/api/volume", { method: "POST", body: JSON.stringify({ volume: e.target.value / 100 }) }); }
  catch (err) { toast(`Erreur : ${err.message}`); }
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
  } catch (e) { toast(`Erreur : ${e.message}`); }
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
    if (w.ok === false) throw new Error(w.error || "statut indisponible");
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
    setFact($("wifi-ssid"), "indisponible", "warn");
    out.hidden = false;
    out.className = "hint warn";
    out.textContent = `Impossible de lire l'état du Wi-Fi : ${e.message}`;
  }
}

$("wifi-scan").addEventListener("click", async () => {
  const btn = $("wifi-scan");
  btn.disabled = true; btn.textContent = "Recherche…";
  try {
    const { networks } = await api("/api/wifi/scan");
    const sel = $("wifi-ssid-select");
    const current = $("wifi-ssid").textContent;
    sel.innerHTML = "";
    for (const n of networks) {
      const lock = n.security && n.security !== "--" ? " 🔒" : "";
      sel.add(new Option(`${n.ssid} — ${n.signal}%${lock}`, n.ssid));
    }
    if (networks.some((n) => n.ssid === current)) sel.value = current;
    toast(`${networks.length} réseau(x) trouvé(s)`);
  } catch (e) { toast(`Échec du scan : ${e.message}`); }
  finally { btn.disabled = false; btn.textContent = "Rechercher"; }
});

$("wifi-connect").addEventListener("click", async () => {
  const ssid = $("wifi-ssid-select").value;
  if (!ssid) { toast("Choisissez d'abord un réseau"); return; }
  const warning = `Se connecter à « ${ssid} » ?\n\n` +
    `Si la connexion échoue, l'appareil reviendra automatiquement au réseau actuel.\n` +
    `Si elle réussit et qu'il s'agit d'un autre réseau, cette page ne répondra plus : ` +
    `il faudra rejoindre « ${ssid} » pour retrouver le streamer.`;
  if (!confirm(warning)) return;

  const btn = $("wifi-connect"), out = $("wifi-result");
  btn.disabled = true; btn.textContent = "Connexion…";
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
      out.textContent = `Connecté à « ${r.ssid} ».`;
      refreshWifi();
    } else {
      out.className = "hint warn";
      out.textContent = `Échec : ${r.error}. Réseau restauré : « ${r.restored || "aucun"} ».`;
    }
  } catch (e) {
    out.hidden = false; out.className = "hint warn";
    // A timeout here often means the switch worked and took the link with it.
    out.textContent = `Pas de réponse (${e.message}). Si le réseau a changé, ` +
      `rejoignez-le et rechargez cette page.`;
  } finally { btn.disabled = false; btn.textContent = "Se connecter à ce réseau"; }
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
    out.hidden = false; out.className = "hint"; out.textContent = "Mot de passe modifié.";
  } catch (e) {
    out.hidden = false; out.className = "hint warn"; out.textContent = `Échec : ${e.message}`;
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
// in exactly the same state. Previously the login path started SSE but never
// the poll, so settings and health went stale until the next reload.
let pollTimer = null;

async function start() {
  showApp();
  await refresh().catch(() => {});
  refreshWifi();
  connectEvents();
  if (!pollTimer) pollTimer = setInterval(() => refresh().catch(() => {}), 5000);
}

(async () => {
  try {
    const sess = await api("/api/session");
    if (!sess.password_configured) { showGate("setup"); return; }
    if (!sess.authenticated) { showGate("login"); return; }
    await start();
  } catch { showGate("login"); }
})();
