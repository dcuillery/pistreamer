/* Minimal i18n runtime.
 *
 * Translations live in editable, committed JSON files under /static/i18n/ —
 * no build step, no extraction tooling: open the file, change the string.
 *
 * Language resolution, in order:
 *   1. an explicit choice the user made previously
 *   2. the browser's preferred languages (navigator.languages)
 *   3. the fallback locale
 *
 * A missing key renders as the key itself rather than as empty text, so a gap
 * in a translation file is immediately visible instead of silently blanking
 * part of the interface.
 */

const I18N = (() => {
  const SUPPORTED = ["en", "fr"];
  const FALLBACK = "en";
  const STORAGE_KEY = "pistreamer.lang";

  // Which data-attribute writes which DOM attribute.
  const ATTR_MAP = {
    "data-i18n-placeholder": "placeholder",
    "data-i18n-title": "title",
    "data-i18n-aria-label": "aria-label",
  };

  let dict = {};
  let current = FALLBACK;
  let explicit = false;

  function detect() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.includes(saved)) { explicit = true; return saved; }
    } catch { /* private mode: fall through to detection */ }

    const prefs = navigator.languages?.length
      ? navigator.languages
      : [navigator.language || ""];
    for (const p of prefs) {
      const base = String(p).toLowerCase().split("-")[0];   // "fr-CA" -> "fr"
      if (SUPPORTED.includes(base)) return base;
    }
    return FALLBACK;
  }

  async function load(lang) {
    const r = await fetch(`/static/i18n/${lang}.json`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`i18n ${lang}: HTTP ${r.status}`);
    return r.json();
  }

  function t(key, vars) {
    let s = dict[key];
    if (s === undefined) return key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.split(`{${k}}`).join(String(v));
      }
    }
    return s;
  }

  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    for (const [dataAttr, attr] of Object.entries(ATTR_MAP)) {
      root.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
        el.setAttribute(attr, t(el.getAttribute(dataAttr)));
      });
    }
    document.documentElement.lang = current;
    document.querySelectorAll("[data-lang]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-lang") === current);
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-lang") === current));
    });
  }

  async function init() {
    current = detect();
    try {
      dict = await load(current);
    } catch {
      // A broken or missing locale must not leave a blank interface.
      if (current !== FALLBACK) {
        current = FALLBACK;
        dict = await load(FALLBACK).catch(() => ({}));
      }
    }
    apply();
  }

  async function set(lang) {
    if (!SUPPORTED.includes(lang) || lang === current) return;
    const next = await load(lang).catch(() => null);
    if (!next) return;
    dict = next;
    current = lang;
    explicit = true;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
    apply();
    // Static markup is handled by apply(); anything rendered from JS listens
    // for this and redraws itself.
    document.dispatchEvent(new CustomEvent("i18n:changed", { detail: { lang } }));
  }

  return {
    t, apply, set, init, SUPPORTED,
    get lang() { return current; },
    get isExplicit() { return explicit; },
  };
})();

const t = I18N.t;
