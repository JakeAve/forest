import { tick } from "svelte";
import { agoText } from "../parse.ts";
import { parseThemeText, resolveTheme, setFavicon } from "./theme.js";
import { prefs, saveLayout } from "./prefs.svelte.js";

class Ui {
  busy = $state({});
  killing = $state({});
  banner = $state(null);
  toast = $state("");
  copied = $state("");
  now = $state(Date.now());
  themes = $state([]);
  /** Imperative handles App registers with `bind:this`. */
  refs = {};
}
export const ui = new Ui();

export const ago = (ms) => agoText(ui.now, ms);

export function loadThemes() {
  return fetch("/api/themes").then((r) => r.json())
    .then((t) => (ui.themes = t));
}

export function errBanner(text) {
  ui.banner = {
    kind: "bad",
    text,
    actions: [{ label: "Dismiss", fn: () => (ui.banner = null) }],
  };
}

let toastT;
export function showToast(text) {
  ui.toast = text;
  clearTimeout(toastT);
  toastT = setTimeout(() => (ui.toast = ""), prefs.settings?.toastMs ?? 7000);
}

export async function copy(e, text, key, label = text) {
  e.stopPropagation();
  await navigator.clipboard.writeText(text);
  showToast(label);
  ui.copied = key;
  setTimeout(() => {
    if (ui.copied === key) ui.copied = "";
  }, 900);
}

/** POST an action; the server's error text, or null when it worked. */
export async function post(ep, body) {
  const res = await fetch(`/api/${ep}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((e) => ({ ok: false, text: () => e.message }));
  return res.ok ? null : await res.text();
}

export async function act(ep, body, key, e) {
  e?.stopPropagation();
  ui.busy[key] = body;
  const err = await post(ep, body).finally(() => delete ui.busy[key]);
  if (err !== null) {
    errBanner(err);
    return false;
  }
  return true;
}

export async function scrollRow(path) {
  if (!path) return;
  await tick();
  document.querySelector(`[data-path="${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

// Opens a row's agent menu or PR card from its cell, as a click would.
export async function clickCell(w, col) {
  await scrollRow(w.path);
  document.querySelector(
    `.wt[data-path="${CSS.escape(w.path)}"] [data-col="${col}"] :is(a, button)`,
  )?.click();
}

export async function applyTheme(name, save = true) {
  const st = document.documentElement.style;
  let resolved = { vars: {}, dark: null };
  if (name !== "default") {
    ui.busy.theme = true;
    try {
      const r = await fetch(`/api/theme?name=${encodeURIComponent(name)}`);
      if (!r.ok) return errBanner(await r.text());
      resolved = resolveTheme(parseThemeText(await r.text()));
    } catch (e) {
      return errBanner(`theme failed to load: ${e.message ?? e}`);
    } finally {
      delete ui.busy.theme;
    }
  }
  for (const p of [...st].filter((p) => p.startsWith("--"))) {
    st.removeProperty(p);
  }
  st.removeProperty("color-scheme");
  for (const [k, v] of Object.entries(resolved.vars)) st.setProperty(k, v);
  if (resolved.dark !== null) {
    st.setProperty("color-scheme", resolved.dark ? "dark" : "light");
  }
  setFavicon(resolved.vars);
  try {
    localStorage.setItem("forest-theme", JSON.stringify(resolved));
  } catch {
    // storage is blocked; the theme still applies for this page
  }
  prefs.theme = name;
  if (save) saveLayout();
}

export async function importTheme(e) {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const text = await f.text();
  try {
    resolveTheme(parseThemeText(text));
  } catch (err) {
    return errBanner(`not a VS Code color theme: ${err.message ?? err}`);
  }
  const name = f.name.replace(/\.jsonc?$/i, "");
  if (await act("theme-import", { name, json: text }, "theme")) {
    await loadThemes();
    applyTheme(name);
  }
}

export async function importVsTheme(hit) {
  if (await act("theme-import", { path: hit.path }, "theme")) {
    await loadThemes();
    applyTheme(hit.name);
  }
}

export function renameField(el) {
  el.focus();
  const start = el.value.lastIndexOf("/") + 1;
  const dot = el.value.lastIndexOf(".");
  el.setSelectionRange(start, dot > start ? dot : el.value.length);
}
