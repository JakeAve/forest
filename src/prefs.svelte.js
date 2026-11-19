export const AXES = { stack: "yy", sidebar: "xy", columns: "xx", rail: "yx" };
export const MODES = {
  text: ["text", "hex"],
  markup: ["text", "preview", "hex"],
  media: ["preview", "hex"],
};

export const COLUMNS = [
  {
    key: "branch",
    label: "Branch",
    align: "left",
    stretch: true,
    width: "12rem",
  },
  {
    key: "title",
    label: "Title",
    align: "left",
    stretch: true,
    width: "13rem",
  },
  {
    key: "ticket",
    label: "Ticket",
    align: "left",
    stretch: true,
    width: "4.5rem",
  },
  {
    key: "pr",
    label: "Pull request",
    align: "left",
    stretch: false,
    width: "8.5rem",
  },
  {
    key: "changes",
    label: "Changes",
    align: "right",
    stretch: false,
    width: "3.25rem",
  },
  {
    key: "sync",
    label: "Sync",
    align: "right",
    stretch: false,
    width: "3.5rem",
  },
  {
    key: "ports",
    label: "Running",
    align: "left",
    stretch: false,
    width: "8rem",
  },
  {
    key: "agent",
    label: "Agent",
    align: "left",
    stretch: false,
    width: "2.5rem",
  },
  {
    key: "active",
    label: "Active",
    align: "right",
    stretch: false,
    width: "2.875rem",
  },
];

class Prefs {
  settings = $state(null);
  zoom = $state(1);
  preset = $state("stack");
  panes = $state({
    stack: { b1: { h: "32%", c: false }, b2: { h: "24%", c: false } },
    sidebar: { b1: { h: "30%", c: false }, b2: { h: "40%", c: false } },
    columns: { b1: { h: "25%", c: false }, b2: { h: "30%", c: false } },
    rail: { b1: { h: "40%", c: false }, b2: { h: "34%", c: false } },
  });
  split = $state(50);
  max = $state(null);
  wrap = $state(false);
  modes = $state({ text: "text", markup: "text", media: "preview" });
  closed = $state({});
  widths = $state({});
  pinned = $state({});
  theme = $state("default");
  ready = $state(false);
  visibleCols = $derived(
    [
      ...new Set(
        this.settings?.columns?.length
          ? this.settings.columns
          : COLUMNS.filter((c) => c.key !== "title").map((c) => c.key),
      ),
    ].map((k) => COLUMNS.find((c) => c.key === k)).filter(Boolean),
  );
  lead = $derived(
    ["title", "branch", "ticket"].map((k) =>
      this.visibleCols.find((c) => c.key === k)
    ).find(Boolean),
  );
}
export const prefs = new Prefs();

export function loadSettings() {
  return fetch("/api/settings").then((r) => r.json())
    .then((s) => (prefs.settings = s));
}

let setT;
export function saveSettings() {
  clearTimeout(setT);
  setT = setTimeout(() =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prefs.settings),
    }).then((r) => r.json()).then((s) => (prefs.settings = s)), 400);
}

export function setDeliver(kind, v) {
  if (v === "off") delete prefs.settings.notify[kind];
  else prefs.settings.notify[kind] = v;
  saveSettings();
}

/** Resolves to the saved theme name, which the caller applies. */
export function loadLayout() {
  return fetch("/api/layout").then((r) => r.json()).then((l) => {
    if (l.panes) prefs.panes = { ...prefs.panes, ...l.panes };
    else if (l.b1) {
      prefs.panes.stack = { b1: l.b1, b2: l.b2 ?? prefs.panes.stack.b2 };
    }
    if (l.preset in AXES) prefs.preset = l.preset;
    if (l.split) prefs.split = l.split;
    if (l.wrap) prefs.wrap = true;
    for (const k in MODES) {
      if (MODES[k].includes(l.modes?.[k])) prefs.modes[k] = l.modes[k];
    }
    if (l.closed) prefs.closed = l.closed;
    if (l.widths) prefs.widths = l.widths;
    if (l.pinned) prefs.pinned = l.pinned;
    if (l.zoom) prefs.zoom = l.zoom;
    return l.theme;
  }).finally(() => (prefs.ready = true));
}

let saveT;
export function saveLayout() {
  clearTimeout(saveT);
  saveT = setTimeout(() =>
    fetch("/api/layout", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preset: prefs.preset,
        panes: prefs.panes,
        split: prefs.split,
        wrap: prefs.wrap,
        modes: prefs.modes,
        closed: prefs.closed,
        widths: prefs.widths,
        pinned: prefs.pinned,
        theme: prefs.theme,
        zoom: prefs.zoom,
      }),
    }), 500);
}

export const isX = (n) => AXES[prefs.preset][n - 1] === "x";

export function resize(n, el, size) {
  const band = prefs.panes[prefs.preset][`b${n}`];
  const min = isX(n)
    ? 14 * parseFloat(getComputedStyle(document.documentElement).fontSize)
    : el.firstElementChild.offsetHeight;
  band.h = Math.max(min, size) + "px";
  band.c = false;
}

export const paneSize = (n) =>
  prefs.panes[prefs.preset][`b${n}`].c && !isX(n)
    ? "var(--head)"
    : prefs.panes[prefs.preset][`b${n}`].h;

export function setPreset(p) {
  prefs.preset = p;
  prefs.max = null;
  saveLayout();
}

export function collapse(n) {
  if (isX(n)) return;
  prefs.max = null;
  const band = prefs.panes[prefs.preset][`b${n}`];
  band.c = !band.c;
  saveLayout();
}

export function toggleMax(n) {
  prefs.max = prefs.max === n ? null : n;
}

export function zoomBy(d) {
  prefs.zoom = d
    ? Math.round(Math.min(2, Math.max(0.6, prefs.zoom + d)) * 10) / 10
    : 1;
  saveLayout();
}

export function resetWidths(key) {
  if (key) delete prefs.widths[key];
  else prefs.widths = {};
  saveLayout();
}

export function setCols(keys) {
  prefs.settings.columns = keys.length ? keys : ["none"];
  saveSettings();
}

export function toggleCol(key) {
  const keys = prefs.visibleCols.map((c) => c.key);
  setCols(keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
}

export function moveCol(key, i) {
  const keys = prefs.visibleCols.map((c) => c.key).filter((k) => k !== key);
  keys.splice(i, 0, key);
  setCols(keys);
}
