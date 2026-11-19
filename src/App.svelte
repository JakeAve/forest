<script>
import { tick, untrack } from "svelte";
import Source from "./Source.svelte";
import FilterInput from "./FilterInput.svelte";
import Palette from "./Palette.svelte";
import Shortcuts from "./Shortcuts.svelte";
import Hex from "./Hex.svelte";
import Icon from "./Icon.svelte";
import Settings from "./Settings.svelte";
import Menu from "./Menu.svelte";
import Card from "./Card.svelte";
import Notify from "./Notify.svelte";
import { matchPath, pathText, rank, rankBy, wtScore } from "./filter.js";
import {
  ancestorDirs,
  bucket,
  bucketSummary,
  colsMin,
  colTemplate,
  commonPrefix,
  dirName,
  discardPrompt,
  fmtCount,
  fmtSize,
  isIgnoredPath,
  prAb,
  prStatus,
  rawUrl,
  relWt,
  renamed,
  splitPath,
  TREE_CAP,
  treeRows,
} from "../parse.ts";
import {
  AC_ICON,
  AM_ICON,
  AR_ICON,
  GLYPH,
  ICON,
  LAYOUTS,
  TICKET_ST,
} from "./icons.js";
import { combo, label as keyLabel, resolve } from "./keys.js";
import { marked } from "marked";
import {
  collapse,
  COLUMNS,
  isX,
  loadLayout,
  loadSettings,
  moveCol,
  paneSize,
  prefs,
  resetWidths,
  resize,
  saveLayout,
  saveSettings,
  setPreset,
  toggleCol,
  toggleMax,
  zoomBy,
} from "./prefs.svelte.js";
import {
  act,
  ago,
  applyTheme,
  clickCell,
  copy,
  errBanner,
  loadThemes,
  post,
  scrollRow,
  showToast,
  ui,
} from "./ui.svelte.js";
import {
  hideMenu,
  menu,
  menuKey,
  menuSession,
  openCard,
  openMenu,
} from "./menu.svelte.js";
import {
  applyRows,
  checkRange,
  createWt,
  isOpen,
  match,
  removeWts,
  repoOf,
  rows,
  toggleAll,
  toggleAllShown,
  toggleCheck,
  toggleRepo,
} from "./rows.svelte.js";
import {
  confirmDiscard,
  discardArm,
  dropPath,
  fileItems,
  land,
  loadFiles,
  loadOpenDirs,
  nav,
  onFs,
  onReady,
  onRows,
  op,
  openAt,
  openPath,
  pick,
  renameKey,
  reveal,
  selectWt,
  setBase,
  startRename,
  toggleDir,
  urlQuery,
} from "./nav.svelte.js";
import {
  agents,
  badgeTip,
  full,
  loadAgents,
  loadDetails,
  resume,
  sessionItems,
  terminal,
} from "./agents.svelte.js";
import {
  allItems,
  procItems,
  procPreview,
  procTip,
  rebase,
  repoItems,
  rowBusy,
  toggleAutoRebase,
  wtItems,
} from "./wtActions.js";

loadSettings();
loadLayout().then((t) => t && applyTheme(t, false));

$effect(() => {
  document.documentElement.style.fontSize = prefs.zoom === 1
    ? ""
    : `${prefs.zoom * 100}%`;
});

const MODE_LABEL = { text: "Text", preview: "Preview", hex: "Hex" };

let openEl = $state();
let editingPath = $state(false);
let completions = $state([]);
let completeHi = $state(-1);
let growEl = $state();
/** The inline new-entry row: the folder it sits in, its text, a refusal. */
let drafting = $state(null);
let showDiff = $state(false);
let previewSrc = $state("");
let previewReady = $state(false);
let srcBodyEl = $state();
let rawView = null;
let lq = $state("");
let findEl = $state();
let wtFilterEl = $state();
let fileFilterEl = $state();
let found = $state({ i: 0, n: 0 });
let diffRef = $state();
// Dismissing hides this text; a different failure shows again.
let prOffHidden = $state("");
let srcInfo = $state(null);
let diskAt = $state(0); // when the open file last changed on disk
let b1El = $state(), b2El = $state();
let notify = $state();
loadThemes();
loadAgents();

$effect(() => {
  void nav.sel;
  drafting = null;
});

const rawSrc = $derived(rawUrl(nav.sel ?? "", nav.file ?? ""));
$effect(() => {
  void nav.sel, void nav.file;
  diskAt = 0;
  srcInfo = null;
  nav.srcBinary = false;
  previewSrc = "";
  previewReady = false;
  rawView = null;
});

const MD_VARS = [
  "--bg",
  "--bg2",
  "--bg3",
  "--fg",
  "--dim",
  "--line",
  "--acc",
  "--mono",
  "--sans",
];
const MD_CSS =
  `body{margin:0;padding:1.5rem 2rem;max-width:52rem;font:14px/1.6 var(--sans);background:var(--bg);color:var(--fg)}
h1,h2{border-bottom:1px solid var(--line);padding-bottom:.3em}
h1,h2,h3,h4,h5,h6{margin:1.5em 0 .6em;line-height:1.25}
a{color:var(--acc)}
code{background:var(--bg3);border-radius:6px;padding:.2em .4em;font:85% var(--mono)}
pre{background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:1rem;overflow:auto}
pre code{background:none;padding:0;font-size:100%}
blockquote{margin:0;padding:0 1em;color:var(--dim);border-left:.25em solid var(--line)}
table{border-collapse:collapse}
th,td{border:1px solid var(--line);padding:.4em .8em}
img{max-width:100%}
hr{border:0;border-top:1px solid var(--line)}`;

// the iframe is its own document, so the app's theme vars are copied in
function mdDoc(src) {
  const cs = getComputedStyle(document.documentElement);
  const vars = MD_VARS.map((v) => `${v}:${cs.getPropertyValue(v)}`).join(";");
  return `<!doctype html><meta charset="utf-8"><style>:root{color-scheme:${
    cs.colorScheme || "dark"
  };${vars}}
${MD_CSS}</style>${marked.parse(src, { async: false })}`;
}

function setMode(m) {
  if (m === nav.mode) return;
  if (nav.mode === "text") {
    rawView = { top: srcBodyEl.scrollTop, head: diffRef?.cursor() ?? 0 };
  }
  prefs.modes[nav.kind] = m;
  saveLayout();
}

function restoreRawView() {
  if (nav.mode !== "text" || !rawView) return;
  const { top, head } = rawView;
  rawView = null;
  diffRef?.setCursor(head);
  // the editor keeps measuring for several frames after build, and a pending
  // line jump scrolls in its own frame, so hold the offset until it settles
  let frames = 20;
  const stop = () => (frames = 0);
  srcBodyEl.addEventListener("wheel", stop, { once: true, passive: true });
  const hold = () => {
    if (frames-- <= 0) return srcBodyEl.removeEventListener("wheel", stop);
    srcBodyEl.scrollTop = top;
    requestAnimationFrame(hold);
  };
  hold();
}

$effect(() => {
  if (
    !(nav.mode === "preview" && (nav.isHtml || nav.isMd) && nav.sel && nav.file)
  ) {
    return void (previewReady = false);
  }
  void nav.diffTick, void prefs.theme;
  const q = `wt=${encodeURIComponent(nav.sel)}&path=${
    encodeURIComponent(nav.file)
  }`;
  fetch(`/api/file?${q}&base=${nav.base}`).then((r) => r.json()).then((d) => {
    const raw = d.work ?? d.base ?? "";
    const next = nav.isMd ? mdDoc(raw) : raw;
    if (next !== previewSrc) previewReady = false;
    previewSrc = next;
  });
});

const shownFiles = $derived(nav.files.filter((f) => matchPath(nav.fq, f.path)));
const stagedFiles = $derived(shownFiles.filter((f) => f.staged));
const unstagedFiles = $derived(shownFiles.filter((f) => f.unstaged));
const committedFiles = $derived(
  shownFiles.filter((f) => !f.staged && !f.unstaged),
);
const sectioned = $derived(
  stagedFiles.length > 0 || committedFiles.length > 0,
);
const byPath = $derived(new Map(nav.files.map((f) => [f.path, f])));
const changedDirs = $derived(ancestorDirs(nav.files.map((f) => f.path)));
const treeMatches = $derived(
  nav.fq ? rank(nav.fq, nav.tree, Infinity, pathText) : [],
);
// ponytail: filter results capped at 500 rows; virtualize if that's ever too few
const treeShown = $derived(
  nav.fq
    ? treeMatches.slice(0, 500).map((p) => ({ path: p, depth: 0, dir: false }))
    : treeRows(nav.tree, nav.openDirs, nav.treeDirs),
);
// the draft row goes first among its folder's children
const treeView = $derived.by(() => {
  if (!drafting) return treeShown;
  const at = drafting.dir
    ? treeShown.findIndex((r) => r.path === drafting.dir)
    : -1;
  const depth = at < 0 ? 0 : treeShown[at].depth + 1;
  const list = [...treeShown];
  list.splice(at + 1, 0, { path: "\0draft", draft: true, depth });
  return list;
});

// Browsers cap HTTP/1.1 at 6 connections per host and each SSE stream holds
// one, so only visible tabs keep a stream. A reconnect gets a full snapshot.
let hidden = $state(document.hidden);
const onVis = () => (hidden = document.hidden);
document.addEventListener("visibilitychange", onVis);
$effect(() => () => document.removeEventListener("visibilitychange", onVis));

$effect(() => {
  if (hidden) return;
  const es = new EventSource("/api/events");
  es.onopen = () => notify?.refresh();
  es.addEventListener("notify", (e) => notify?.push(JSON.parse(e.data)));
  es.addEventListener("fs", (e) => onFs(JSON.parse(e.data)));
  es.addEventListener("status", (e) => {
    rows.boot = JSON.parse(e.data);
    if (rows.boot.phase === "ready") onReady();
  });
  es.onmessage = (e) => onRows(applyRows(JSON.parse(e.data)));
  return () => es.close();
});

$effect(() => {
  if (!prefs.settings) return;
  const tick = setInterval(
    () => (ui.now = Date.now()),
    prefs.settings.agoRefreshMs,
  );
  return () => clearInterval(tick);
});

$effect(() => {
  if (nav.restoring) return;
  const q = urlQuery();
  history.replaceState(
    null,
    "",
    q.size ? "?" + q.toString() : location.pathname,
  );
});

async function editPath() {
  editingPath = true;
  await tick();
  openEl.value = nav.sel ?? "";
  openEl.focus();
  openEl.select();
  completeOpen();
}

function startNew() {
  const dir = nav.selDir ??
    (nav.file?.includes("/") ? nav.file.replace(/\/[^/]*$/, "") : "");
  nav.fq = "";
  setBase("all");
  if (dir) {
    reveal(dir + "/");
    if (nav.treeOf === nav.sel) loadOpenDirs();
  }
  drafting = { dir, name: "", err: null };
}

// the confirm button takes focus, so Enter confirms and Esc cancels
const focusOn = (el) => el.focus();

function draftField(el) {
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

// The row lands before the server answers; a refusal puts the draft back with
// the typed name and the error, so it reads as one step, not a banner later.
async function draftKey(e) {
  e.stopPropagation();
  if (e.key === "Escape") return (drafting = null);
  if (e.key !== "Enter") return;
  const { dir } = drafting;
  const name = e.target.value.replace(/^\/+/, "");
  if (!name.replace(/\//g, "").trim()) {
    drafting = { dir, name, err: "Name can't be blank" };
    return;
  }
  const path = (dir ? dir + "/" : "") + name;
  const isDir = path.endsWith("/");
  const clean = path.replace(/\/+$/, "");
  drafting = null;
  if (isDir) nav.treeDirs = [...new Set([...nav.treeDirs, clean])];
  else nav.tree = [...new Set([...nav.tree, clean])];
  const err = await post("new", { wt: nav.sel, path });
  if (err) {
    dropPath(clean);
    drafting = { dir, name, err };
    return;
  }
  land(clean, isDir);
}

function renameField(el) {
  el.focus();
  const start = el.value.lastIndexOf("/") + 1;
  const dot = el.value.lastIndexOf(".");
  el.setSelectionRange(start, dot > start ? dot : el.value.length);
}

let completeTimer;
function completeOpen() {
  clearTimeout(completeTimer);
  completeTimer = setTimeout(async () => {
    const from = nav.sel ? `&from=${encodeURIComponent(nav.sel)}` : "";
    const r = await fetch(
      `/api/complete?path=${encodeURIComponent(openEl.value)}${from}`,
    );
    completions = r.ok ? await r.json() : [];
    completeHi = -1;
  }, 80);
}

$effect(() => {
  growEl?.togglePopover(completions.length > 0);
});
$effect(() => {
  growEl?.children[completeHi]?.scrollIntoView({ block: "nearest" });
});

const leaf = (c) => c.slice(c.lastIndexOf("/", c.length - 2) + 1);

async function pickCompletion(c) {
  openEl.value = c;
  if (c.endsWith("/")) return completeOpen();
  completions = [];
  if (await openPath(c)) editingPath = false;
}

async function openBoxKey(e) {
  const n = completions.length;
  if (e.key === "Escape") {
    if (n) return (completions = []);
    return openEl.blur();
  }
  if (n && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    completeHi = e.key === "ArrowDown"
      ? (completeHi + 1) % n
      : (completeHi <= 0 ? n : completeHi) - 1;
    return;
  }
  if (e.key === "Tab" && n) {
    e.preventDefault();
    if (completeHi >= 0) return pickCompletion(completions[completeHi]);
    const common = commonPrefix(completions);
    openEl.value = common.length > openEl.value.length
      ? common
      : completions[0];
    return completeOpen();
  }
  if (e.key !== "Enter") return;
  if (completeHi >= 0) return pickCompletion(completions[completeHi]);
  if (!openEl.value.trim()) return;
  if (await openPath(openEl.value.trim())) editingPath = false;
}

$effect(() => {
  if (!nav.fq) scrollRow(untrack(() => nav.file));
});

function drag(e, n, el) {
  e.preventDefault();
  prefs.max = null;
  const x = isX(n);
  const p0 = x ? e.clientX : e.clientY;
  const s0 = x ? el.offsetWidth : el.offsetHeight;
  const mv = (m) => resize(n, el, s0 + (x ? m.clientX : m.clientY) - p0);
  const up = () => {
    removeEventListener("mousemove", mv);
    removeEventListener("mouseup", up);
    saveLayout();
  };
  addEventListener("mousemove", mv);
  addEventListener("mouseup", up);
}

function gutterKey(e, n, el) {
  if (e.key === "Enter") return collapse(n);
  const d =
    (isX(n)
      ? { ArrowLeft: -20, ArrowRight: 20 }
      : { ArrowUp: -20, ArrowDown: 20 })[e.key];
  if (!d) return;
  e.preventDefault();
  prefs.max = null;
  resize(n, el, (isX(n) ? el.offsetWidth : el.offsetHeight) + d);
  saveLayout();
}

const colGrid = $derived(
  colTemplate(prefs.visibleCols, prefs.lead, prefs.widths),
);
const colMin = $derived(colsMin(prefs.visibleCols, prefs.lead, prefs.widths));
let colsEl = $state();
// a header gesture in flight: `size` drags a column edge, `move` drags a
// column to a new slot. `x` is where the guide line is drawn.
let colOp = $state(null);
const movingCol = $derived(colOp?.kind === "move" ? colOp.key : null);

function listBox() {
  const r = colsEl.closest(".body").getBoundingClientRect();
  return { top: r.top, h: r.height };
}

const halfGap = () => parseFloat(getComputedStyle(colsEl).columnGap) / 2;

function track(e, cls, move, done) {
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  document.documentElement.classList.add(cls);
  const esc = (k) => k.key === "Escape" && end(null);
  const end = (u) => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    removeEventListener("keydown", esc, true);
    document.documentElement.classList.remove(cls);
    done(u?.type === "pointerup" ? u : null);
    colOp = null;
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  addEventListener("keydown", esc, true);
}

function sizeCol(e, col) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const cell = e.currentTarget.parentElement;
  const left = cell.getBoundingClientRect().left;
  const w0 = cell.offsetWidth;
  const prev = prefs.widths[col.key];
  let moved = false;
  const at = (w) =>
    colOp = {
      kind: "size",
      key: col.key,
      x: left + w + halfGap(),
      ...listBox(),
    };
  at(w0);
  track(e, "colsizing", (m) => {
    moved = true;
    const w = Math.max(24, Math.round(w0 + m.clientX - e.clientX));
    prefs.widths[col.key] = w + "px";
    at(w);
  }, (u) => {
    if (!moved) return;
    if (u) return saveLayout();
    if (prev) prefs.widths[col.key] = prev;
    else delete prefs.widths[col.key];
  });
}

function fitCol(key) {
  const cells = [...b1El.querySelectorAll(`[data-col="${key}"]`)];
  for (const c of cells) {
    c.style.cssText = "width: max-content; container-type: normal";
  }
  const w = Math.max(24, ...cells.map((c) => c.offsetWidth));
  for (const c of cells) c.style.cssText = "";
  prefs.widths[key] = Math.ceil(w) + "px";
  saveLayout();
}

function grabCol(e, col) {
  if (e.button !== 0) return;
  const cells = [...colsEl.querySelectorAll(".h")];
  const from = prefs.visibleCols.indexOf(col);
  const rects = cells.map((c) => c.getBoundingClientRect());
  const r0 = rects[from];
  const others = rects.filter((_, i) => i !== from);
  const g = halfGap();
  let to = from;
  track(e, "colmoving", (m) => {
    if (!colOp && Math.abs(m.clientX - e.clientX) < 4) return;
    const x = m.clientX;
    to = others.filter((r) => r.left + r.width / 2 < x).length;
    colOp = {
      kind: "move",
      key: col.key,
      label: col.label,
      x: to < others.length ? others[to].left - g : others.at(-1).right + g,
      ghost: Math.min(
        Math.max(r0.left + x - e.clientX, rects[0].left),
        rects.at(-1).right - r0.width,
      ),
      w: r0.width,
      ...listBox(),
    };
  }, (u) => u && colOp && to !== from && moveCol(col.key, to));
}

const colItems = (key) => [
  key && { label: "Autofit width", fn: () => fitCol(key) },
  key && prefs.widths[key] &&
  { label: "Reset width", fn: () => resetWidths(key) },
  Object.keys(prefs.widths).length &&
  { label: "Reset all widths", fn: () => resetWidths() },
  "-",
  ...COLUMNS.map((c) => ({
    label: (prefs.visibleCols.includes(c) ? "✓ " : "") + c.label,
    fn: () => toggleCol(c.key),
  })),
];

function conflictBanner() {
  ui.banner = {
    kind: "warn",
    text: `${nav.file} changed on disk while you have unsaved edits.`,
    actions: [
      {
        label: "Reload from disk",
        fn: () => {
          ui.banner = null;
          diffRef?.reloadTheirs();
        },
      },
      { label: "Keep mine", fn: () => (ui.banner = null) },
    ],
  };
}
let paletteOpen = $state(false);
let grepQ = $state("");
let grepHits = $state([]);

async function grep(v) {
  grepQ = v;
  const wt = nav.sel;
  const hits = v
    ? await fetch(
      `/api/grep?wt=${encodeURIComponent(wt)}&q=${encodeURIComponent(v)}`,
    ).then((r) => r.json())
    : [];
  if (grepQ === v && nav.sel === wt) grepHits = hits;
}
let palTree = $state({ of: null, files: [], dirs: [] });

const desktop = () => prefs.settings?.desktop;
const hasFile = () => nav.sel && nav.file;
const termDir = () =>
  nav.selDir || nav.file?.split("/").slice(0, -1).join("/") || undefined;
function goWt(w) {
  selectWt(w.path);
  scrollRow(w.path);
}
function stepWt(d) {
  const i = rows.navWts.findIndex((w) => w.path === nav.sel);
  goWt(
    rows
      .navWts[Math.max(0, Math.min(rows.navWts.length - 1, i < 0 ? 0 : i + d))],
  );
}
const liveWt = () => !nav.loose && nav.selWt;
const focusedWt = () => {
  const el = document.activeElement;
  const path = el?.matches(".wt, .wt .cbx") && el.closest(".wt").dataset.path;
  return path && rows.allWts.find((w) => w.path === path && !w.isPrimary);
};

// Runs a t / c / l action on the popover's session, then closes the popover.
function onSession(fn) {
  const a = menuSession();
  menu.el?.hidePopover();
  fn(a);
}
const COMMANDS = [
  {
    id: "palette",
    label: "Command palette",
    keys: "cmd+k, cmd+p",
    run: () => (paletteOpen = !paletteOpen),
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    keys: "shift+slash, cmd+slash",
    run: () => (shortcutsOpen = !shortcutsOpen),
  },
  { id: "open-path", label: "Open path…", keys: "cmd+o", run: editPath },
  {
    id: "settings",
    label: "Settings",
    keys: "cmd+comma",
    run: () => ui.refs.settings.toggle(),
  },
  {
    id: "next-wt",
    label: "Next worktree",
    section: "Worktrees",
    keys: "j",
    when: () => rows.navWts.length,
    run: () => stepWt(1),
  },
  {
    id: "prev-wt",
    label: "Previous worktree",
    section: "Worktrees",
    keys: "k",
    when: () => rows.navWts.length,
    run: () => stepWt(-1),
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `pinned-${n}`,
    label: `Pinned worktree ${n}`,
    section: "Worktrees",
    keys: `ctrl+${n}`,
    when: () => rows.pinnedWts[n - 1],
    run: () => goWt(rows.pinnedWts[n - 1]),
  })),
  {
    id: "auto-rebase",
    get label() {
      return liveWt()?.autoRebase
        ? "Disable auto-rebase"
        : "Enable auto-rebase";
    },
    section: "Worktrees",
    keys: "alt+cmd+r",
    when: () =>
      liveWt() && !nav.selWt.isPrimary && !ui.busy["ar:" + nav.selWt.path] &&
      (nav.selWt.autoRebase || nav.selWt.pr?.state !== "MERGED"),
    run: (e) => toggleAutoRebase(nav.selWt, e),
  },
  {
    id: "toggle-select",
    label: "Select worktree",
    section: "Worktrees",
    keys: "space",
    when: () => !!focusedWt(),
    run: (e) => {
      const w = focusedWt();
      if (w) toggleCheck(w, e);
    },
  },
  {
    id: "open-terminal",
    label: "Open terminal here",
    section: "Worktrees",
    keys: "ctrl+backquote",
    when: () => nav.sel,
    run: (e) =>
      act("terminal", { wt: nav.sel, path: termDir() }, "term:" + nav.sel, e),
  },
  {
    id: "reveal",
    label: "Reveal in Finder",
    section: "Files",
    keys: "alt+shift+cmd+r",
    when: () => nav.sel && (nav.selDir || nav.file),
    run: (e) =>
      act(
        "reveal",
        { wt: nav.sel, path: nav.selDir || nav.file },
        "reveal:" + nav.sel,
        e,
      ),
  },
  {
    id: "trash",
    label: "Move to Trash",
    section: "Files",
    keys: "cmd+backspace",
    // ⌘⌫ deletes a line while typing, so never steal it from a field or the editor
    when: () =>
      nav.sel && (nav.selDir || nav.file) &&
      !document.activeElement?.closest(
        "input, textarea, select, [contenteditable]",
      ),
    run: () => discardArm({ path: nav.selDir || nav.file, del: true }),
  },
  {
    id: "copy-ticket",
    label: "Copy ticket link",
    section: "Worktrees",
    keys: "alt+cmd+t",
    when: () => liveWt() && liveWt().ticket,
    run: (e) => copy(e, liveWt().ticket.url, "kbd"),
  },
  {
    id: "agent-sessions",
    label: "Agent sessions…",
    section: "Agent sessions",
    keys: "a",
    when: () => liveWt()?.agents?.length,
    run: () => clickCell(nav.selWt, "agent"),
  },
  {
    id: "pr-card",
    label: "Pull request…",
    section: "Worktrees",
    keys: "p",
    when: () => liveWt()?.pr,
    run: () => clickCell(nav.selWt, "pr"),
  },
  {
    id: "agent-resume",
    get label() {
      const a = liveWt()?.agents?.[0];
      return `Resume ${a?.label ?? "agent"} session`;
    },
    section: "Agent sessions",
    keys: "alt+cmd+a",
    when: () => liveWt()?.agents?.length,
    run: (e) => {
      loadDetails(nav.selWt);
      resume(nav.selWt.agents[0], e);
    },
  },
  {
    id: "session-terminal",
    label: "Resume session in terminal",
    section: "Agent sessions",
    keys: "t",
    when: menuSession,
    run: (e) => onSession((a) => terminal(a, e)),
  },
  {
    id: "session-copy-id",
    label: "Copy session ID",
    section: "Agent sessions",
    keys: "c",
    when: menuSession,
    run: (e) => onSession((a) => copy(e, a.id, "kbd")),
  },
  {
    id: "session-copy-link",
    label: "Copy session resume link",
    section: "Agent sessions",
    keys: "l",
    when: menuSession,
    run: (e) => onSession((a) => copy(e, full(a).url, "kbd", "resume link")),
  },
  ...["Worktrees", "Files", "Source"].map((name, i) => ({
    id: `max-${name.toLowerCase()}`,
    get label() {
      return `${prefs.max === i + 1 ? "Restore" : "Maximize"} ${name}`;
    },
    section: "View",
    keys: `alt+cmd+${i + 1}`,
    run: () => toggleMax(i + 1),
  })),
  {
    id: "cycle-mode",
    label: "Cycle text, preview and hex",
    section: "View",
    keys: "alt+cmd+v",
    when: () => hasFile() && nav.modeList.length > 1 && !nav.diffDirty,
    run: () =>
      setMode(
        nav
          .modeList[(nav.modeList.indexOf(nav.mode) + 1) % nav.modeList.length],
      ),
  },
  {
    id: "filter-branches",
    label: "Focus branch filter",
    section: "Worktrees",
    keys: "alt+cmd+b",
    run: () => focusFilter(1, wtFilterEl),
  },
  {
    id: "filter-files",
    label: "Focus file filter",
    section: "Files",
    keys: "alt+cmd+f",
    run: () => focusFilter(2, fileFilterEl),
  },
  {
    id: "find",
    label: "Find in file",
    section: "View",
    keys: "cmd+f",
    when: () => hasFile() && nav.mode === "text" && !nav.srcBinary,
    run: () => findEl?.select(),
  },
  {
    id: "copy-path",
    label: "Copy path (relative)",
    section: "Files",
    keys: "alt+shift+cmd+c",
    when: hasFile,
    run: (e) => copy(e, nav.file, "kbd"),
  },
  {
    id: "copy-path-abs",
    label: "Copy path (absolute)",
    section: "Files",
    keys: "alt+cmd+c",
    when: hasFile,
    run: (e) => copy(e, `${nav.sel}/${nav.file}`, "kbd"),
  },
  {
    id: "zoom-in",
    label: "Zoom in",
    section: "View",
    keys: "cmd+equal, shift+cmd+equal, cmd+numpadadd",
    when: desktop,
    run: () => zoomBy(0.1),
  },
  {
    id: "zoom-out",
    label: "Zoom out",
    section: "View",
    keys: "cmd+minus, cmd+numpadsubtract",
    when: desktop,
    run: () => zoomBy(-0.1),
  },
  {
    id: "zoom-reset",
    label: "Reset zoom",
    section: "View",
    keys: "cmd+0, cmd+numpad0",
    when: desktop,
    run: () => zoomBy(0),
  },
];
const keymap = $derived(resolve(COMMANDS, prefs.settings?.keys));
const kbdOf = (id) => keymap.byId[id]?.[0] && keyLabel(keymap.byId[id][0]);

async function focusFilter(n, el) {
  if (prefs.max && prefs.max !== n) prefs.max = null;
  await tick();
  el?.select();
}

function runKey(e) {
  const k = !e.defaultPrevented && !e.isComposing && combo(e);
  const c = k && COMMANDS.find((c) => c.id === keymap.byCombo.get(k));
  if (!c || (c.when && !c.when())) return;
  if (
    !/ctrl|alt|cmd/.test(k) &&
    e.target.closest?.("input, textarea, select, [contenteditable]")
  ) return;
  e.preventDefault();
  c.run(e);
}

let shortcutsOpen = $state(false);
function bindKey(id, k) {
  const { [id]: _, ...rest } = prefs.settings.keys;
  prefs.settings.keys = k ? { ...rest, [id]: k } : rest;
  saveSettings();
}

$effect(() => {
  const wt = nav.sel;
  if (!paletteOpen || !wt || nav.treeOf === wt || nav.loose) return;
  fetch(`/api/tree?wt=${encodeURIComponent(wt)}`).then((r) => r.json())
    .then((t) => {
      if (nav.sel === wt) palTree = { of: wt, files: t.files, dirs: t.dirs };
    });
});

const asPalette = (items, detail) =>
  items.filter((i) => i && i !== "-").map((i) => ({
    ...i,
    kbd: i.kbd || (i.cmd && kbdOf(i.cmd)),
    group: "action",
    detail,
  }));

const paletteItems = $derived.by(() => {
  if (!paletteOpen) return [];
  const t = nav.treeOf === nav.sel || nav.loose
    ? { files: nav.tree, dirs: nav.treeDirs }
    : palTree.of === nav.sel
    ? palTree
    : { files: [], dirs: [] };
  const pathItems = (kind, paths) =>
    paths.map((p) => {
      const [dir, name] = splitPath(p);
      return {
        group: kind === "dir" ? "folder" : "file",
        label: name,
        detail: dir || undefined,
        fn: () =>
          openAt({ wt: nav.sel, loose: nav.loose, kind, rel: p, line: 0 }),
      };
    });
  const cmd = (label, fn, kbd) => ({ group: "command", label, fn, kbd });
  const wtItem = (w) => ({
    group: "worktree",
    label: w.branch,
    detail: [
      w.repo,
      w.pr && `#${w.pr.number} ${w.pr.title}`,
      w.procs?.map((p) => [p.command, ...p.ports.map((n) => `:${n}`)].join(" "))
        .join(" · "),
    ].filter(Boolean).join(" · "),
    fn: () => {
      selectWt(w.path);
      scrollRow(w.path);
    },
    sub: () => asPalette(wtItems(w, true), w.branch),
  });
  return [
    ...[...rows.allWts].sort((a, b) =>
      !!prefs.pinned[b.path] - !!prefs.pinned[a.path] ||
      b.lastActivity - a.lastActivity
    ).map(wtItem),
    ...(nav.selWt && !nav.loose
      ? asPalette(wtItems(nav.selWt, true), nav.selWt.branch)
        .filter((i) => !COMMANDS.some((c) => c.label === i.label))
      : []),
    ...LAYOUTS.map(([p, name]) => cmd(`${name} layout`, () => setPreset(p))),
    ...(nav.loose ? [] : [
      cmd("Since branch point", () => setBase("branch")),
      cmd("Uncommitted", () => setBase("head")),
      cmd("All files", () => setBase("all")),
    ]),
    cmd("Toggle wrap", () => {
      prefs.wrap = !prefs.wrap;
      saveLayout();
    }),
    cmd(`${rows.allClosed ? "Expand" : "Collapse"} all worktrees`, toggleAll),
    {
      ...cmd("Filter branches…"),
      query: () => rows.q,
      onquery: (v) => (rows.q = v),
      sub: () =>
        rankBy(rows.shownWts, 50, (w) => wtScore(rows.q, w)).map(wtItem),
    },
    ...(nav.sel
      ? [{
        ...cmd("Filter files…"),
        query: () => nav.fq,
        onquery: (v) => (nav.fq = v),
        sub: () =>
          rank(
            nav.fq,
            nav.explore ? nav.tree : nav.files.map((f) => f.path),
            50,
            pathText,
          )
            .map((p) => ({
              group: "file",
              label: splitPath(p)[1],
              detail: splitPath(p)[0] || undefined,
              fn: () => (pick({ path: p }), scrollRow(p)),
            })),
      }, {
        ...cmd("Grep…"),
        query: () => grepQ,
        onquery: grep,
        sub: () =>
          grepHits.map((h) => ({
            group: "match",
            label: h.text,
            detail: `${h.path}:${h.line}`,
            fn: () =>
              openAt({
                wt: nav.sel,
                loose: nav.loose,
                kind: "file",
                rel: h.path,
                line: h.line,
              }),
          })),
      }]
      : []),
    cmd("Dirty only", () => (rows.dirtyOnly = !rows.dirtyOnly)),
    cmd("Running only", () => (rows.runningOnly = !rows.runningOnly)),
    ...COMMANDS.filter((c) => c.id !== "palette" && (!c.when || c.when()))
      .map((c) => cmd(c.label, c.run, kbdOf(c.id))),
    {
      ...cmd("Theme…", () => ui.refs.settings.open()),
      sub: () =>
        ["default", ...ui.themes].map((name) =>
          cmd(name, () => applyTheme(name))
        ),
    },
    ...rows.repos.map((r) => ({
      group: "repo",
      label: r.name,
      detail: r.path,
      fn: async () => {
        prefs.closed.__all = false;
        prefs.closed[r.name] = false;
        saveLayout();
        await tick();
        document.querySelector(`[data-repo="${CSS.escape(r.name)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      },
      sub: () => asPalette(repoItems(r, r.worktrees), r.name),
    })),
    ...pathItems("dir", [...new Set([...ancestorDirs(t.files), ...t.dirs])]),
    ...pathItems("file", t.files),
  ];
});
</script>

<svelte:window
  onkeydown={runKey}
/>

<div class="app" class:desktop={prefs.settings?.desktop}>
  <div class="tbar">
    <svg class="mark" width="18" height="18" viewBox="0 0 24 24" fill="none" role="img" aria-label="forest">
      <path d="M5.2 8.6 L7.3 13.8 L6.2 13.8 L8.9 19 L1.5 19 L4.2 13.8 L3.1 13.8 Z" fill="var(--mark2)"/>
      <path d="M18.9 10.6 L20.9 14.8 L19.8 14.8 L22.5 19 L15.3 19 L18 14.8 L16.9 14.8 Z" fill="var(--mark2)"/>
      <path d="M12 3.4 L14.6 8.6 L13.1 8.6 L16.1 13.8 L14.6 13.8 L17.1 19 L6.9 19 L9.4 13.8 L7.9 13.8 L10.9 8.6 L9.4 8.6 Z" fill="var(--acc)"/>
    </svg>
    <span class="path">{prefs.settings?.root ?? ""}</span>
    <span class="sp"></span>
    <button class="omni" onclick={() => (paletteOpen = true)}>
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>
      Search worktrees, files, commands{#if kbdOf("palette")}<kbd>{kbdOf("palette")}</kbd>{/if}</button>
    <span class="sp"></span>
    <div class="seg layouts" role="group" aria-label="Layout">
      {#each LAYOUTS as [p, name, d] (p)}
        <button class:on={prefs.preset === p} title="{name} layout" aria-label="{name} layout"
                aria-pressed={prefs.preset === p} onclick={() => setPreset(p)}>
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d={d}/></svg></button>
      {/each}
    </div>
    <Notify bind:this={notify} />
    <button class="circ" title="Settings {kbdOf('settings') ?? ''}" aria-label="Settings" onclick={() => ui.refs.settings.open()}>
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
  </div>

  {#if ui.banner}
    <div class="banner t-band" data-tone={ui.banner.kind}>
      <span>{ui.banner.text}</span><span class="sp"></span>
      {#each ui.banner.actions as a (a.label)}
        <button class="btn" class:p={a.primary} onclick={a.fn}>{a.label}</button>
      {/each}
    </div>
  {/if}

  {#if rows.prOff && rows.prOff.text !== prOffHidden}
    <div class="banner t-band" data-tone="warn" role="status" title={rows.prOff.detail}>
      <span>{rows.prOff.text}</span><span class="sp"></span>
      <button class="btn ib" title="Dismiss" aria-label="Dismiss"
              onclick={() => (prOffHidden = rows.prOff.text)}><Icon d={ICON.x} /></button>
    </div>
  {/if}

  {#if prefs.ready}
  {#snippet loadingRow()}<div class="empty late"><span class="spin"></span> Loading…</div>{/snippet}
  {#snippet maxBtn(n)}
    <button class="btn max" class:on={prefs.max === n} title={prefs.max === n ? "Restore panes" : "Full screen"}
            aria-label={prefs.max === n ? "Restore panes" : "Full screen"}
            onclick={() => toggleMax(n)}><Icon d={prefs.max === n ? ICON.min : ICON.max} /></button>
  {/snippet}
  <div class="panes {prefs.preset}" class:max={prefs.max} style:--b1={paneSize(1)} style:--b2={paneSize(2)}>
  <div class="band wts" class:maxed={prefs.max === 1} class:selecting={rows.selecting} bind:this={b1El}>
    <div class="bhead">
      {#if rows.selectable.length}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <span
          class="cbx"
          class:on={rows.allShownChecked}
          class:some={!rows.allShownChecked && rows.someShownChecked}
          role="checkbox"
          aria-checked={rows.allShownChecked}
          aria-label="select all {rows.selectable.length} shown"
          title="select all {rows.selectable.length} shown"
          tabindex="0"
          onclick={toggleAllShown}
          onkeydown={(e) => e.key === "Enter" && toggleAllShown()}
        ></span>
      {/if}
      <b>Worktrees</b><span>{rows.filtering
          ? `${rows.shownWts.length} of ${rows.totalWts} matching`
          : `${rows.totalWts} across ${rows.repos.length} repos`}</span><span
        class="sp"
      ></span>
      <FilterInput bind:this={wtFilterEl} bind:value={rows.q} label="Filter branches"
                   kbd={kbdOf("filter-branches")} />
      <button
        class="btn"
        class:on={rows.dirtyOnly}
        onclick={() => (rows.dirtyOnly = !rows.dirtyOnly)}>Dirty only</button
      >
      <button
        class="btn"
        class:on={rows.runningOnly}
        onclick={() => (rows.runningOnly = !rows.runningOnly)}>Running only</button
      >
      {@render maxBtn(1)}
    </div>
    {#if rows.checkedWts.length || rows.confirming}
      <div class="bhead selbar" class:confirm={rows.confirming}>
        {#if rows.confirming}
          <b>Remove {rows.confirming.length} worktree{rows.confirming.length === 1
              ? ""
              : "s"}?</b>
          <span class="meta names">{rows.confirming.map((w) => w.branch).join(", ")}
          </span>
          {#if rows.confirmSel && rows.hiddenChecked}
            <span class="meta">{rows.hiddenChecked} hidden by the filter are kept</span>
          {/if}
          <span class="sp"></span>
          <button
            class="btn dg"
            class:wait={rows.removing}
            disabled={rows.removing}
            onclick={() => removeWts(rows.confirming, false)}>Remove</button
          >
          <button class="btn" onclick={() => (rows.confirming = null)}>Cancel</button
          >
        {:else}
          <b>{rows.checkedWts.length} selected</b>
          <span class="sp"></span>
          <button
            class="btn"
            onclick={(e) =>
              copy(
                e,
                rows.checkedWts.map((w) => w.branch).join("\n"),
                "sel:br",
                `${rows.checkedWts.length} branch names`,
              )}>Copy branches</button
          >
          <button
            class="btn"
            onclick={(e) =>
              copy(
                e,
                rows.checkedWts.map((w) => w.path).join("\n"),
                "sel:pa",
                `${rows.checkedWts.length} paths`,
              )}>Copy paths</button
          >
          <button class="btn dg" disabled={rows.hiddenChecked === rows.checkedWts.length}
                  onclick={() => ((rows.confirmSel = true), (rows.confirming = rows.checkedWts.filter((w) => match(repoOf(w), w))))}
            >Remove</button
          >
          <button
            class="btn ib"
            title="Clear selection"
            aria-label="Clear selection"
            onclick={() => {
              rows.checked = {};
              rows.confirming = null;
            }}><Icon d={ICON.x} /></button
          >
        {/if}
      </div>
    {/if}
    <div class="body"><div class="list" style:min-width={colMin}>
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
      <div class="cols" style:grid-template-columns={colGrid} tabindex="0" bind:this={colsEl}
           onkeydown={(e) => menuKey(e, colItems())}
           oncontextmenu={(e) => openMenu(e, colItems(e.target.closest?.("[data-col]")?.dataset.col))}>
        <span></span>
        {#each prefs.visibleCols as col (col.key)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span class="h" class:end={col.align === "right"} class:moving={movingCol === col.key} data-col={col.key}
                onpointerdown={(e) => grabCol(e, col)}><span class="lbl">{col.label}</span><i
                class="colsz" class:on={colOp?.kind === "size" && colOp.key === col.key}
                title="Drag to resize · double-click to fit"
                onpointerdown={(e) => sizeCol(e, col)} ondblclick={() => fitCol(col.key)}></i></span>
        {/each}
      </div>
      {#if colOp?.x != null}
        <div class="colguide" style:left="{colOp.x}px" style:top="{colOp.top}px" style:height="{colOp.h}px"></div>
      {/if}
      {#if colOp?.ghost != null}
        <div class="colghost" style:left="{colOp.ghost}px" style:top="{colOp.top}px"
             style:width="{colOp.w}px" style:height="{colOp.h}px"><span>{colOp.label}</span></div>
      {/if}
      {#if rows.pinnedWts.length}
        {@render container("__pinned", "Pinned", rows.pinnedWts.length, bucketSummary(rows.pinnedWts),
          () => repoItems({ name: "__pinned", label: "Pinned" }, rows.pinnedWts), rows.pinnedWts)}
      {/if}
      {#if rows.recentWts.length}
        {@render container("__recent", "Recent", rows.recentWts.length, bucketSummary(rows.recentWts),
          () => repoItems({ name: "__recent", label: "Recent" }, rows.recentWts), rows.recentWts)}
      {/if}
      {#if rows.boot.phase !== "ready"}
        <div class="boot">
          <span class="spin"></span>
          {#if rows.boot.phase === "repos"}
            reading branches{rows.boot.total ? ` ${rows.boot.done}/${rows.boot.total}` : ""}…
          {:else}
            loading pull requests…
          {/if}
        </div>
      {/if}
      {#if !rows.filtering || rows.repos.some((r) => rows.repoWts[r.name].length)}
        {@render container("__all", "All worktrees", rows.shownWts.length, bucketSummary(rows.shownWts), allItems, [], allRepos)}
      {/if}
    </div></div>
  </div>
  {#snippet allRepos()}
    {#each rows.repos as r (r.name)}
      {#if rows.repoWts[r.name].length || !rows.filtering}
        {@const shown = r.worktrees.filter((w) => match(r, w))}
        {@render container(r.name, r.name, r.worktrees.length, bucketSummary(shown),
          () => repoItems(r, shown), rows.repoWts[r.name], null, r)}
      {/if}
    {/each}
  {/snippet}
  {#snippet container(key, label, count, summary, items, wts, inner, r)}
    <div class="box">
      <div class="repo" role="button" tabindex="0" data-repo={r?.name}
           onclick={() => toggleRepo(key)}
           onkeydown={(e) => e.key === "Enter" ? toggleRepo(key) : menuKey(e, items())}
           oncontextmenu={(e) => openMenu(e, items())}>
        <span class="car">{isOpen(key) ? "▼" : "▶"}</span>
        <span class="rn">{label}</span>
        <span class="ct">{count}{#if summary}<span class="sum">{` · ${summary}`}</span>{/if}</span>
        {#if r}
          {#if r.cached}<span class="ct late" title="Last known state; refreshing"><span class="spin"></span> cached</span>{/if}
          <span class="sp"></span>
          <button class="circ plus" title="New worktree" aria-label="New worktree"
                  onclick={(e) => { e.stopPropagation(); rows.creating = rows.creating === r.name ? null : r.name; rows.slug = ""; }}><Icon d={ICON.plus} /></button>
        {/if}
      </div>
      {#if r && rows.creating === r.name}
        <div class="newwt">
          <!-- svelte-ignore a11y_autofocus -->
          <input class="filter" autofocus placeholder="Branch or slug" bind:value={rows.slug}
                 onkeydown={(e) => { if (e.key === "Enter") createWt(r); if (e.key === "Escape") rows.creating = null; }}>
          <button class="btn" class:wait={ui.busy["new:" + r.name]} disabled={ui.busy["new:" + r.name]}
                  onclick={() => createWt(r)}>Create</button>
        </div>
      {/if}
      {#if isOpen(key)}
        <div class="kids">
          {#each wts as w (w.path)}
            {@render wtRow(w, !r)}
          {/each}
          {@render inner?.()}
        </div>
      {/if}
    </div>
  {/snippet}
  {#snippet wtRow(w, showRepo)}
    {#key rows.touched[w.path]}
      <div class="wt" class:sel={nav.sel === w.path} class:touch={rows.touched[w.path]} class:cached={repoOf(w)?.cached}
           class:done={bucket(w) === "done"} style:grid-template-columns={colGrid}
           role="button" tabindex="0" data-path={w.path}
           onclick={(e) => w.isPrimary || !(e.metaKey || e.shiftKey) ? selectWt(w.path)
             : e.metaKey ? toggleCheck(w, e) : checkRange(w)}
           onmousedown={(e) => e.shiftKey && e.preventDefault()}
           onkeydown={(e) => e.key === "Enter" ? selectWt(w.path) : menuKey(e, wtItems(w))}
           oncontextmenu={(e) => openMenu(e, wtItems(w))}>
        {#if w.pr}{@const s = prStatus(w.pr)}<i class="t-bar" class:loud={s.weight === "loud"} data-tone={s.tone}></i>{/if}
        {#if rowBusy(w)}
          <span class="late" role="status" aria-label="working"><span class="spin"></span></span>
        {:else if w.isPrimary}
          <span></span>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <span class="cbx" class:on={rows.checked[w.path]} role="checkbox"
                aria-checked={!!rows.checked[w.path]} aria-label="select {w.branch}" tabindex="0"
                onclick={(e) => toggleCheck(w, e)}
                onkeydown={(e) => e.key === "Enter" && toggleCheck(w, e)}></span>
        {/if}
        {#each prefs.visibleCols as col (col.key)}
          <span class="c" class:end={col.align === "right"} class:lead={col === prefs.lead} class:moving={movingCol === col.key} data-col={col.key}>{#if col.key === "branch"}<span class="br" title={[w.branch, renamed(w) && `pushed as ${renamed(w)}`, dirName(w) &&
              `in ${dirName(w)}/`, repoOf(w)?.cached && "last known state; refreshing"].filter(Boolean).join(" · ")}>{#if
              showRepo}<span class="rp">{w.repo}</span>{/if}{w.branch}{#if
              renamed(w)}<span class="rb">{renamed(w)}</span>{/if}{#if
              dirName(w)}<span class="dir">{dirName(w)}</span>{/if}</span>{:else if
            col.key === "title"}{w.pr?.title || w.branch}{:else if
            col.key === "ticket"}{#if w.ticket}{@const ti = w.ticket.info}<a href={w.ticket.url} target="_blank" rel="noreferrer"
                class="tkl" data-tone={ti?.category ? TICKET_ST[ti.category] ?? "off" : undefined}
                aria-haspopup={ti ? "dialog" : undefined}
                aria-label={ti ? `${w.ticket.key}, ${ti.status}${w.autoClose ? ", closes on merge" : ""}: ${ti.title}` : undefined}
                title={ti ? "⌘-click to open the ticket" : `open ticket ${w.ticket.key}`}
                onclick={(e) => ti ? openCard(w, e, "ticket") : e.stopPropagation()}>{w.ticket.key}{#if
                ti?.category}<span class="tkd" data-tone={TICKET_ST[ti.category] ?? "off"}></span>{/if}{#if
                w.autoClose}<svg class="g ac" data-tone={w.autoClose.error ? "bad" : "done"} viewBox="0 0 16 16">{@html AC_ICON}</svg>{/if}</a>{/if}{:else if
            col.key === "pr"}{#if w.pr}{@const s = prStatus(w.pr)}<a
                class="prl" data-tone={s.tone} href={w.pr.url}
                target="_blank" rel="noreferrer"
                aria-label={[`${s.label}, PR #${w.pr.number}`, w.pr.title]
                  .filter(Boolean).join(": ")}
                aria-haspopup="dialog" title="⌘-click to open on GitHub"
                onclick={(e) => openCard(w, e)}>#{w.pr.number}{#if w.pr.autoMerge}<svg class="g am" viewBox="0 0 16 16">{@html AM_ICON}</svg>{/if}{#if w.autoRebase}<svg class="g ar" class:err={w.autoRebase.error} viewBox="0 0 16 16">{@html AR_ICON}</svg>{/if}<span
                class="pst" class:t-pill={s.weight === "loud"} data-tone={s.tone}
                title="{s.sinceLabel} for {ago(s.since)}">{#if s.glyph}<svg class="g" viewBox="0 0 16 16">{@html GLYPH[s.glyph]}</svg>{/if}{s.label.toLowerCase()}{s.since ? ` ${ago(s.since)}` : ""}</span></a>{:else if
              w.autoRebase}<span class="port ar" class:err={w.autoRebase.error}
                title={w.autoRebase.error ?? "auto-rebase on"}><svg class="g ar" viewBox="0 0 16 16">{@html AR_ICON}</svg></span>{/if}{:else if
            col.key === "changes"}{#if w.dirty}<span>●{w.dirty}</span>{/if}{:else if
            col.key === "sync"}{@const ab = prAb(w)}{#if ab.ahead || ab.behind}<span data-tone={ab.behind > 0 ? "warn" : undefined}
                title={w.pr?.state === "OPEN"
                  ? `${ab.behind} behind ${w.pr.baseRefName}, ${ab.ahead} ahead${
                    ab.behind > 0 ? " — right-click to update branch" : ""
                  }`
                  : null}>{[ab.ahead && `↑${ab.ahead}`, ab.behind && `↓${ab.behind}`].filter(Boolean).join(" ")}</span>{/if}{:else if
            col.key === "ports"}{#if w.procs?.length}<button class="ag pcell" style="--ag: var(--mid)" aria-haspopup="menu"
                aria-label="{w.procs.length} running {w.procs.length === 1 ? "process" : "processes"}"
                title={procTip(w)}
                onclick={(e) => openMenu(e, procItems(w), e.detail === 0)}><i>{w.procs.length}</i><span>{procPreview(w.procs[0])}</span></button>{/if}{:else if
            col.key === "agent"}{#if w.agents?.length}{@const a = full(w.agents[0])}{@const n = w.agents.filter((x) => x.deep).length}<button
                class="ag" style="--ag: var(--{a.tone})" aria-haspopup="menu"
                title={badgeTip(w)}
                onclick={(e) => openMenu(e, sessionItems(w), e.detail === 0)}>{a.glyph}{#if n > 1}<i>{n}</i>{/if}</button>{/if}{:else if
            col.key === "active"}{ago(w.lastActivity)}{/if}</span>
        {/each}
      </div>
    {/key}
  {/snippet}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="gutter g1" class:x={isX(1)} role="separator" tabindex="0"
       aria-orientation={isX(1) ? "vertical" : "horizontal"}
       onmousedown={(e) => drag(e, 1, b1El)} ondblclick={() => collapse(1)}
       onkeydown={(e) => gutterKey(e, 1, b1El)}></div>

  <div class="band files" class:maxed={prefs.max === 2} bind:this={b2El}>
    <div class="bhead"><b>{nav.explore ? "Files" : "Changed files"}</b>
      {#if editingPath}
        <input class="filter open" class:grown={completions.length} placeholder="Open path…"
               bind:this={openEl} role="combobox" aria-controls="open-complete"
               aria-expanded={completions.length > 0} aria-autocomplete="list"
               aria-activedescendant={completeHi >= 0 ? `oc-${completeHi}` : undefined}
               oninput={completeOpen} onkeydown={openBoxKey}
               onblur={() => ((editingPath = false), (completions = []))}>
        <div id="open-complete" class="grow" popover="manual" role="listbox" bind:this={growEl}>
          {#each completions as c, i (c)}
            <button id="oc-{i}" role="option" tabindex="-1" aria-selected={i === completeHi}
                    class:on={i === completeHi} onmousedown={(e) => e.preventDefault()}
                    onclick={() => pickCompletion(c)}>{leaf(c)}</button>
          {/each}
        </div>
      {:else}
        {@const where = nav.loose ? nav.sel : nav.selWt ? `${nav.selWt.repo} · ${nav.selWt.branch}` : null}
        <button class="meta pth" title="{where ? `${where} · ` : ""}open a path… {kbdOf('open-path') ?? ''}" onclick={editPath}
                oncontextmenu={(e) => nav.sel && openMenu(e, [
                  {
                    label: "Copy path (relative)",
                    fn: (e) => copy(e, nav.selWt ? relWt(repoOf(nav.selWt), nav.selWt) : nav.sel, "ctx"),
                  },
                  { label: "Copy path (absolute)", fn: (e) => copy(e, nav.sel, "ctx") },
                ])}>{where ?? `Open path… ${kbdOf("open-path") ?? ""}`}</button>
      {/if}
      {#if nav.sel}
        <button class="btn max" title="New file or folder" aria-label="New file or folder"
                onmousedown={(e) => e.preventDefault()} onclick={startNew}><Icon d={ICON.plus} /></button>
      {/if}
      <FilterInput bind:this={fileFilterEl} bind:value={nav.fq} label="Filter files"
                   kbd={kbdOf("filter-files")} />
      {#if !nav.loose}<div class="seg">
        <button class:on={!nav.explore && nav.base === "branch"} onclick={() => setBase("branch")}>Since branch point</button>
        <button class:on={!nav.explore && nav.base === "head"} onclick={() => setBase("head")}>Uncommitted</button>
        <button class:on={nav.explore} onclick={() => setBase("all")}>All files</button>
      </div>{/if}
      {@render maxBtn(2)}
    </div>
    {#if nav.discarding}
      <div class="bhead selbar confirm">
        <b class="pre">{nav.discarding.del
            ? `Move ${nav.discarding.path} to Trash?`
            : discardPrompt(nav.discarding.path, nav.discarding.status === "U")}</b>
        <span class="sp"></span>
        <button class="btn dg" onclick={confirmDiscard} use:focusOn
                onkeydown={(e) => e.key === "Escape" && (nav.discarding = null)}>
          {nav.discarding.del ? "Move to Trash" : nav.discarding.status === "U" ? "Delete" : "Discard"}</button>
        <button class="btn" onclick={() => (nav.discarding = null)}>Cancel</button>
      </div>
    {/if}
    <div class="body">
      {#snippet rowName(path, name)}
        {#if nav.renaming === path}
          <input class="ren" value={name} use:renameField
                 onkeydown={(e) => renameKey(e, path)} onblur={() => (nav.renaming = null)}
                 onclick={(e) => e.stopPropagation()}>
        {:else}{name}{/if}
      {/snippet}
      {#snippet fileRow(f, mode)}
        {@const [dir, name] = splitPath(f.path)}
        {#key nav.fresh[f.path]}
        <div class="f" class:touch={nav.fresh[f.path]} class:sel={nav.file === f.path} role="button" tabindex="0"
             onclick={() => pick(f)}
             onkeydown={(e) => e.key === "Enter" ? pick(f) : menuKey(e, fileItems(f, mode))}
             oncontextmenu={(e) => openMenu(e, fileItems(f, mode))}>
          {#if mode === "committed"}
            <span></span>
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <span class="cbx" class:on={mode === "staged"} role="checkbox"
                  aria-checked={mode === "staged"} aria-label="staged" tabindex="0"
                  onclick={(e) => op(mode === "staged" ? "unstage" : "stage", { path: f.path }, e)}
                  onkeydown={(e) => e.key === "Enter" && op(mode === "staged" ? "unstage" : "stage", { path: f.path }, e)}></span>
          {/if}
          <span class="st {f.status}">{f.status === "U" ? "?" : f.status}</span>
          <span class="p"><span class="dir">{dir}</span>{@render rowName(f.path, name)}</span>
          <span class="acts">
            {#if mode === "staged"}
              <button title="Unstage" aria-label="Unstage" onclick={(e) => op("unstage", { path: f.path }, e)}><Icon d={ICON.minus} /></button>
            {:else if mode === "unstaged"}
              <button title="Stage" aria-label="Stage" onclick={(e) => op("stage", { path: f.path }, e)}><Icon d={ICON.plus} /></button>
              <button class="dg" title="Discard changes" aria-label="Discard changes"
                      onclick={(e) => discardArm(f, e)}><Icon d={ICON.undo} /></button>
            {/if}
          </span>
          <span class="n"><span class="pl">+{f.added}</span><span class="mi">−{f.removed}</span></span>
        </div>
        {/key}
      {/snippet}
      {#snippet draftRow(r)}
        <div class="f tr draft" class:bad={drafting.err} title={drafting.err}
             style:padding-left="{0.625 + r.depth * 0.875}rem">
          <span class="car"></span>
          <span class="p"><input class="ren" value={drafting.name} use:draftField
                 placeholder="Name, end with / for a folder" aria-label="New file or folder name"
                 aria-invalid={!!drafting.err}
                 oninput={() => drafting.err && (drafting.err = null)}
                 onkeydown={draftKey} onblur={() => (drafting = null)}></span>
          <span class="err">{drafting.err ?? ""}</span>
        </div>
      {/snippet}
      {#snippet treeRow(r)}
        {@const [dir, name] = nav.fq ? splitPath(r.path) : ["", r.path.split("/").pop()]}
        {@const f = byPath.get(r.path)}
        {#key nav.fresh[r.path]}
        <div class="f tr" class:touch={nav.fresh[r.path]} class:sel={r.dir ? nav.selDir === r.path : !nav.selDir && nav.file === r.path} class:ign={isIgnoredPath(r.path, nav.treeIgnored)} role="button" tabindex="0" data-path={r.path}
             style:padding-left="{0.625 + r.depth * 0.875}rem"
             onclick={() => r.dir ? toggleDir(r.path) : pick(r)}
             onkeydown={(e) => e.key === "Enter" ? (r.dir ? toggleDir(r.path) : pick(r)) : menuKey(e, fileItems(r))}
             oncontextmenu={(e) => openMenu(e, fileItems(r))}>
          <span class="car">{r.dir ? (nav.openDirs[r.path] ? "▼" : "▶") : ""}</span>
          <span class="p" title={r.path}><span class="dir">{dir}</span>{@render rowName(r.path, name)}{r.dir && nav.renaming !== r.path ? "/" : ""}</span>
          {#if f}
            <span class="st {f.status}">{f.status === "U" ? "?" : f.status}</span>
          {:else if r.dir && changedDirs.has(r.path)}
            <span class="st M">●</span>
          {:else}
            <span></span>
          {/if}
        </div>
        {/key}
      {/snippet}
      {#if !nav.sel}
        {#if nav.restoring}{@render loadingRow()}{:else}<div class="empty">Select a worktree</div>{/if}
      {:else if nav.explore}
        {#if nav.treeOf !== nav.sel}
          {@render loadingRow()}
        {:else if nav.loose && !nav.tree.length && !drafting}
          <div class="empty">Empty folder</div>
        {:else if nav.fq && !treeMatches.length}
          <div class="empty">No matches</div>
        {:else}
          {#each treeView as r (r.path)}{#if r.draft}{@render draftRow(r)}{:else}{@render treeRow(r)}{/if}{/each}
          {#if treeMatches.length > treeShown.length}
            <div class="empty">{treeMatches.length - treeShown.length} more, narrow the filter</div>
          {/if}
          {#if nav.loose && nav.tree.length >= TREE_CAP}
            <div class="empty">Showing the first {TREE_CAP} files, live updates off · narrow the path</div>
          {/if}
        {/if}
      {:else if nav.filesOf !== nav.sel}
        {@render loadingRow()}
      {:else if !nav.files.length}
        <div class="empty">No changes</div>
      {:else if !shownFiles.length}
        <div class="empty">No matches</div>
      {:else if sectioned}
        {#if stagedFiles.length}
          <div class="sechd"><b>Staged</b>{stagedFiles.length}<span class="sp"></span>
            <button title="Unstage all" aria-label="Unstage all" onclick={(e) => op("unstage", { path: "." }, e)}><Icon d={ICON.minus} /></button></div>
          {#each stagedFiles as f (f.path)}{@render fileRow(f, "staged")}{/each}
        {/if}
        {#if unstagedFiles.length}
          <div class="sechd"><b>Unstaged</b>{unstagedFiles.length}<span class="sp"></span>
            <button title="Stage all" aria-label="Stage all" onclick={(e) => op("stage", { path: "." }, e)}><Icon d={ICON.plus} /></button></div>
          {#each unstagedFiles as f (f.path)}{@render fileRow(f, "unstaged")}{/each}
        {/if}
        {#if committedFiles.length}
          <div class="sechd"><b>Committed</b>{committedFiles.length}</div>
          {#each committedFiles as f (f.path)}{@render fileRow(f, "committed")}{/each}
        {/if}
      {:else}
        {#each unstagedFiles as f (f.path)}{@render fileRow(f, "unstaged")}{/each}
      {/if}
    </div>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="gutter g2" class:x={isX(2)} role="separator" tabindex="0"
       aria-orientation={isX(2) ? "vertical" : "horizontal"}
       onmousedown={(e) => drag(e, 2, b2El)} ondblclick={() => collapse(2)}
       onkeydown={(e) => gutterKey(e, 2, b2El)}></div>

  <div class="band sourceband" class:maxed={prefs.max === 3}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="bhead" oncontextmenu={(e) => nav.file && openMenu(e, fileItems({ path: nav.file }))}>
      {#if nav.headRename}
        <input class="ren" value={nav.file} use:renameField
               onkeydown={(e) => renameKey(e, nav.file, "")} onblur={() => (nav.headRename = false)}>
      {:else if nav.file}
        <button class="nm" title="Rename" onclick={(e) => startRename({ path: nav.file }, e, true)}>{nav.file}</button>
        {#if srcInfo}
          <span class="meta mono finfo" title={srcInfo.size === null ? null : `${fmtCount(srcInfo.size)} bytes`}>
            {[
              srcInfo.lines === null ? null : `${fmtCount(srcInfo.lines)} ${srcInfo.lines === 1 ? "line" : "lines"}`,
              srcInfo.size === null ? null : fmtSize(srcInfo.size),
            ].filter(Boolean).join(" · ")}
          </span>
        {/if}
      {:else}
        <b>Source</b>
      {/if}
      <span class="sp"></span>
      {#if diskAt && ui.now - diskAt < 60_000}
        <span class="meta" title={new Date(diskAt).toLocaleTimeString()}>Updated {ago(diskAt)}</span>
      {/if}
      {#if nav.diffDirty}
        <span class="unsaved" data-tone="warn">● Unsaved ⌘S</span>
        <button class="btn ib p" title="Save" aria-label="Save" onclick={() => diffRef?.save()}>
          <Icon d={ICON.save} /></button>
        <button class="btn ib" title="Discard editor changes, reload from disk" aria-label="Discard"
                onclick={() => { ui.banner = null; diffRef?.reloadTheirs(); }}>
          <Icon d={ICON.undo} /></button>
      {/if}
      {#if nav.mode === "text" && !nav.srcBinary}
        <FilterInput bind:this={findEl} bind:value={lq} label="Find" kbd={kbdOf("find")}
                     onenter={(back) => diffRef?.findStep(back ? -1 : 1)}
                     count="{found.i}/{found.n}"
                     onescape={() => diffRef?.setCursor(diffRef.cursor())} />
        <label class="meta wraplbl">
          <input type="checkbox" class="cbxin" bind:checked={prefs.wrap} onchange={saveLayout}>
          <span class="cbx" class:on={prefs.wrap}></span>Wrap
        </label>
      {/if}
      {#if nav.explore && nav.selFile}
        <div class="seg">
          <button class:on={!showDiff} disabled={nav.mode !== "text"} onclick={() => (showDiff = false)}>View</button>
          <button class:on={showDiff} disabled={nav.mode !== "text"} onclick={() => (showDiff = true)}>Diff</button>
        </div>
      {/if}
      {#if nav.file && nav.modeList.length > 1}
        <div class="seg" title={kbdOf("cycle-mode")}>
          {#each nav.modeList as m (m)}
            <button class:on={m === nav.mode} aria-pressed={m === nav.mode} disabled={nav.diffDirty}
                    title={nav.diffDirty ? "Save or discard edits first" : null}
                    onclick={() => setMode(m)}>{MODE_LABEL[m]}</button>
          {/each}
        </div>
      {/if}
      {#if nav.selFile}<span class="meta mono">+{nav.selFile.added} −{nav.selFile.removed}</span>{/if}
      {@render maxBtn(3)}
    </div>
    <div class="body" bind:this={srcBodyEl}>
      {#if nav.mode === "hex" && nav.sel && nav.file}
        {#key nav.file}<Hex src="{rawSrc}&t={nav.diffTick}" />{/key}
      {:else if nav.mode === "preview" && (nav.mediaType === "img" || nav.isSvg) && nav.sel && nav.file}
        <img class="media" src="{rawSrc}&t={nav.diffTick}" alt={nav.file}>
      {:else if nav.mode === "preview" && nav.mediaType === "video" && nav.sel && nav.file}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="media" src={rawSrc} controls muted></video>
      {:else if nav.mode === "preview" && nav.mediaType === "audio" && nav.sel && nav.file}
        <audio class="audio" src={rawSrc} controls></audio>
      {:else if nav.mode === "preview" && nav.mediaType === "pdf" && nav.sel && nav.file}
        <iframe class="preview ready" title="Preview of {nav.file}" src="{rawSrc}&t={nav.diffTick}"></iframe>
      {:else if nav.mode === "preview" && previewSrc}
        {#if !previewReady}{@render loadingRow()}{/if}
        {#key previewSrc}
          <iframe class="preview" class:md={nav.isMd} class:ready={previewReady} title="Preview of {nav.file}"
                  sandbox="allow-scripts" srcdoc={previewSrc}
                  onload={() => (previewReady = true)}></iframe>
        {/key}
      {:else if nav.sel && nav.file && prefs.settings}
        <Source bind:this={diffRef} wt={nav.sel} path={nav.file} base={nav.base} tick={nav.diffTick} line={nav.pendingLine}
              collapse={{ margin: prefs.settings.collapseMargin, minSize: prefs.settings.collapseMinSize }}
              single={nav.explore && !(nav.selFile && showDiff)}
              split={prefs.split} onsplit={(s) => { prefs.split = s; saveLayout(); }} wrap={prefs.wrap} find={lq} onfind={(f) => (found = f)}
              onstate={(d) => (nav.diffDirty = d)}
              onconflict={conflictBanner}
              onupdated={() => (diskAt = Date.now())}
              onerror={errBanner}
              oncopy={showToast}
              onsaved={loadFiles}
              onready={restoreRawView}
              onbinary={(b) => (nav.srcBinary = b)}
              oninfo={(i) => (srcInfo = i)} />
      {:else if nav.restoring}
        {@render loadingRow()}
      {:else}
        <div class="empty">Select a file</div>
      {/if}
    </div>
  </div>
  </div>
  {/if}
  <Menu {kbdOf} {keymap} />
  <Card />
</div>

<Palette items={paletteItems} bind:open={paletteOpen} />
<Shortcuts commands={COMMANDS} {keymap} onbind={bindKey}
  bind:open={shortcutsOpen} />

<Settings bind:this={ui.refs.settings} {kbdOf}
  onshortcuts={() => (shortcutsOpen = true)} />

<style>
.omni {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2rem;
  width: min(24rem, 40vw);
  padding: 0 0.375rem 0 0.75rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--input);
  color: var(--dimmer);
  font: 0.8125rem var(--sans);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.omni:hover {
  border-color: var(--dimmer);
}
.omni kbd {
  margin-left: auto;
  padding: 0 0.3125rem;
  border: 1px solid var(--line);
  border-radius: 0.375rem;
  background: var(--bg3);
  color: var(--dim);
  font: 0.6875rem var(--mono);
}
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 0 0.5rem 0.5rem;
}
.tbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  height: 3rem;
  padding: 0 0.25rem;
  flex: none;
}
.app.desktop .tbar {
  padding-left: calc(82px - 0.5rem);
  min-height: 34px;
}
.tbar .mark {
  flex: none;
}
.tbar .path {
  color: var(--dimmer);
  font: 0.6875rem var(--mono);
}

.panes {
  flex: 1;
  min-height: 0;
  display: grid;
}
.panes.stack {
  grid-template:
    "w" minmax(var(--head), var(--b1))
    "g1" 0.625rem
    "f" minmax(var(--head), var(--b2))
    "g2" 0.625rem
    "d" minmax(var(--head), 1fr) / minmax(0, 1fr);
}
.panes.sidebar {
  grid-template:
    "w g1 f" minmax(var(--head), var(--b2))
    "w g1 g2" 0.625rem
    "w g1 d" minmax(var(--head), 1fr) /
    minmax(14rem, var(--b1)) 0.625rem minmax(14rem, 1fr);
}
.panes.columns {
  grid-template:
    "w g1 f g2 d" minmax(0, 1fr) /
    minmax(14rem, var(--b1)) 0.625rem minmax(14rem, var(--b2)) 0.625rem
    minmax(14rem, 1fr);
}
.panes.rail {
  grid-template:
    "w g2 d" minmax(var(--head), var(--b1))
    "g1 g2 d" 0.625rem
    "f g2 d" minmax(var(--head), 1fr) /
    minmax(14rem, var(--b2)) 0.625rem minmax(14rem, 1fr);
}
.panes.max {
  grid-template: "m" minmax(0, 1fr) / minmax(0, 1fr);
}
.panes.max > :not(.maxed) {
  display: none;
}
.panes.max > .maxed {
  grid-area: m;
}
.wts {
  grid-area: w;
}
.files {
  grid-area: f;
}
.sourceband {
  grid-area: d;
}
.g1 {
  grid-area: g1;
}
.g2 {
  grid-area: g2;
}
.bhead .wraplbl {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-right: 1rem;
  cursor: pointer;
}
.preview {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
  opacity: 0;
}
.preview.md {
  background: var(--bg);
}
.preview.ready {
  opacity: 1;
}
.audio {
  display: block;
  width: min(100%, 32rem);
  margin: 1rem auto;
}
.media {
  display: block;
  max-width: 100%;
  max-height: 100%;
  margin: auto;
  object-fit: contain;
  background: repeating-conic-gradient(var(--bg2) 0 25%, var(--bg3) 0 50%) 0 0 /
    16px 16px;
}
.preview:not(.ready) {
  height: 0;
}
.sourceband .body {
  margin: 0 0.5rem 0.5rem;
  padding: 0;
  background: var(--bg);
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 0.625rem;
}
.gutter {
  display: grid;
  place-items: center;
  cursor: row-resize;
  outline: none;
}
.gutter.x {
  cursor: col-resize;
}
.gutter::after {
  content: "";
  width: 2.25rem;
  height: 0.25rem;
  border-radius: 999px;
  background: var(--line);
}
.gutter.x::after {
  width: 0.25rem;
  height: 2.25rem;
}
.gutter:hover::after,
.gutter:focus-visible::after {
  background: var(--acc);
}
.seg.layouts {
  flex: none;
}
.seg.layouts button {
  display: grid;
  place-items: center;
  padding: 0.25rem 0.5rem;
}
.f .p input.ren {
  font: inherit;
  width: 60%;
}
.f.tr.draft {
  grid-template-columns: 0.875rem 1fr auto;
  cursor: default;
}
.f.draft .p input.ren {
  width: 100%;
}
.f.draft.bad input.ren {
  border-color: var(--danger);
}
.f.draft .err {
  color: var(--danger);
  font: 0.6875rem var(--sans);
  white-space: nowrap;
}
.bhead .finfo {
  flex: none;
  white-space: nowrap;
}
.bhead input.ren {
  font: 600 0.875rem var(--sans);
  flex: 1;
  min-width: 0;
}
.bhead .nm {
  white-space: pre;
  background: none;
  border: 1px solid transparent;
  border-radius: 0.25rem;
  color: var(--fg);
  font: 600 0.875rem var(--sans);
  padding: 0 0.25rem;
  margin-left: -0.3125rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
}
.bhead .nm:hover {
  border-color: var(--line);
}
.grow {
  position-anchor: --open-box;
  inset: auto;
  top: anchor(bottom);
  left: anchor(left);
  width: anchor-size(width);
  margin: 0;
  max-height: 16rem;
  overflow-y: auto;
  padding: 0.25rem;
  background: var(--input);
  border: 1px solid var(--acc);
  border-top: none;
  border-radius: 0 0 0.75rem 0.75rem;
  box-shadow: 0 0.5rem 1.5rem color-mix(in srgb, var(--bg) 70%, transparent);
  clip-path: inset(0 -2rem -2rem);
  transition: clip-path 0.12s, display 0.12s allow-discrete, overlay 0.12s
    allow-discrete;
}
@starting-style {
  .grow:popover-open {
    clip-path: inset(0 -2rem 100%);
  }
}
.grow button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 0.5rem;
  color: var(--fg);
  font: 0.75rem var(--mono);
  padding: 0.25rem 0.5rem;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grow button:hover {
  background: var(--hov);
}
.grow button.on {
  background: var(--hl);
  color: var(--hlfg);
}
.bhead .pth {
  flex: 1 1 6rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  background: none;
  border: 1px solid transparent;
  border-radius: 999px;
  font: 0.75rem var(--mono);
  padding: 0.1875rem 0.5rem;
  cursor: text;
}
.files > .bhead:not(.selbar) {
  flex-wrap: wrap;
  height: auto;
  min-height: var(--head);
  padding-block: 0.375rem;
  row-gap: 0.375rem;
}
.files > .bhead:not(.selbar) > b {
  flex: none;
}
.files > .bhead .seg {
  min-width: 0;
}
.files > .bhead .seg button {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bhead .pth:hover {
  border-color: var(--line);
}
.repo {
  position: sticky;
  top: var(--colsh);
  left: calc(0.375rem + var(--depth, 0) * var(--indent));
  width: calc(100cqw - 0.75rem - var(--depth, 0) * var(--indent));
  scroll-margin-top: var(--colsh);
  z-index: 1;
  height: var(--repoh);
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.3125rem 0.625rem;
  border-radius: 0.5rem;
  background: var(--bg2);
  cursor: pointer;
  color: var(--dim);
  font-size: 0.75rem;
  user-select: none;
}
.list > .box {
  margin-top: 0.375rem;
}
.kids {
  --depth: 1;
  margin-left: calc(var(--indent) - 1px);
  border-left: 1px solid var(--line);
}
.kids .kids {
  --depth: 2;
}
.kids .repo {
  top: calc(var(--colsh) + var(--repoh));
  scroll-margin-top: calc(var(--colsh) + var(--repoh));
}
.repo .sum {
  color: var(--dim);
}
.repo:hover {
  background: var(--hov);
}
.repo .car {
  width: 0.5625rem;
  color: var(--dimmer);
  font-size: 0.5625rem;
}
.repo .rn {
  color: var(--fg);
  font-weight: 600;
}
.repo .ct {
  color: var(--dimmer);
  font-size: 0.6875rem;
}
.cols {
  position: sticky;
  top: 0;
  z-index: 2;
  height: var(--colsh);
  align-items: center;
  display: grid;
  gap: 0.5rem;
  padding: 0.25rem 0.625rem;
  background: var(--bg2);
  color: var(--dim);
  font-size: 0.6875rem;
  white-space: nowrap;
}
.cols > *,
.wt .c {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cols > .h {
  position: relative;
  overflow: visible;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: start;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.cols > .h.end {
  justify-content: end;
}
.cols .lbl {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cols > .h:hover {
  color: var(--fg);
}
.colsz {
  position: absolute;
  z-index: 1;
  top: -0.25rem;
  bottom: -0.25rem;
  right: calc(-0.25rem - 0.3125rem);
  width: 0.625rem;
  cursor: col-resize;
  touch-action: none;
}
.colsz::after {
  content: "";
  position: absolute;
  left: calc(50% - 0.5px);
  top: 0.375rem;
  bottom: 0.375rem;
  width: 1px;
  background: var(--line);
}
.colsz:hover::after,
.colsz.on::after {
  left: calc(50% - 1px);
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--acc);
}
.colguide {
  position: fixed;
  z-index: 20;
  width: 2px;
  margin-left: -1px;
  background: var(--acc);
  pointer-events: none;
}
.colghost {
  position: fixed;
  z-index: 19;
  border: 1px solid var(--acc);
  border-radius: 0.25rem;
  background: color-mix(in srgb, var(--acc) var(--wash), transparent);
  pointer-events: none;
}
.colghost span {
  display: block;
  height: var(--colsh, 1.375rem);
  padding: 0 0.375rem;
  line-height: var(--colsh, 1.375rem);
  background: var(--bg3);
  color: var(--fg);
  font-size: 0.6875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cols > .moving,
.wt .moving {
  background: color-mix(in srgb, var(--acc) var(--wash), transparent);
  color: var(--dimmer);
}
.cols .end,
.wt .end {
  text-align: right;
}
.wt {
  position: relative;
  scroll-margin-top: calc(var(--colsh) + var(--depth) * var(--repoh));
  display: grid;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3125rem 0.625rem;
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 0.75rem;
}
.wt:hover {
  background: var(--hov);
}
.wt.sel {
  background: color-mix(in srgb, var(--fg) var(--wash), var(--bg));
}
.wt > .t-bar {
  position: absolute;
  left: 0.125rem;
  top: 0.375rem;
  bottom: 0.375rem;
}
.wt .br {
  font-family: var(--mono);
  font-size: 0.71875rem;
}
.wt .c a {
  font: 0.6875rem var(--mono);
  color: var(--fg);
  text-decoration: none;
}
.wt .c a:hover {
  text-decoration: underline;
}
.wt .c .g {
  width: 10px;
  height: 10px;
  vertical-align: -1px;
}
.wt .pst {
  font: 0.625rem var(--mono);
}
.wt .c[data-col="pr"],
.wt .prl {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
}
.wt .c .prl:hover {
  text-decoration: none;
}
.wt .t-pill {
  display: inline-block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  padding: 0 0.375rem;
}
.ag.pcell {
  max-width: 100%;
  justify-content: flex-start;
}
.ag.pcell span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wt [data-col="title"],
.wt [data-col="branch"] {
  color: var(--dim);
}
.wt .lead,
.wt .lead a {
  color: var(--fg);
}
.wt [data-col="changes"],
.wt [data-col="sync"],
.wt [data-col="active"] {
  font: 0.6875rem var(--mono);
  color: var(--mid);
}
.wt.done .c,
.wt.done .c * {
  color: var(--dim);
}
.wt.done .c [data-tone] {
  color: color-mix(in srgb, var(--tone) var(--ink), var(--bg));
}
.wt.done .tkd {
  border-color: color-mix(in srgb, var(--tone) var(--ink), var(--bg));
}
.wt.done .tkd:not([data-tone="off"]) {
  background: color-mix(in srgb, var(--tone) var(--ink), var(--bg));
}
.wt.done .ag {
  background: color-mix(in srgb, var(--dim) var(--wash), transparent);
  border-color: color-mix(in srgb, var(--dim) var(--edge), transparent);
}
.wt.cached .br {
  color: var(--dim);
  font-style: italic;
}
.wt .br .rp {
  color: var(--dim);
}
.wt .br .rp::after {
  content: " · ";
}
.wt .br .rb {
  color: var(--dim);
}
.wt .br .rb::before {
  content: " → ";
  color: var(--dimmer);
}
.wt .br .dir {
  color: var(--dim);
}
.wt .br .dir::before {
  content: " (";
}
.wt .br .dir::after {
  content: ")";
}
.tkl {
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
}
.port.ar {
  display: inline-flex;
  align-items: center;
  padding: 0 0.3rem;
}
.port.ar .g {
  width: 10px;
  height: 10px;
}
.g.ar.err,
.port.ar.err {
  color: var(--danger);
}
.wt.touch,
.f.touch {
  animation: flash 1.4s ease-out;
}

.f {
  display: grid;
  grid-template-columns: 0.875rem 1rem 1fr auto 5.75rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3125rem 0.625rem;
  border-radius: 0.5rem;
  cursor: pointer;
  font: 0.75rem var(--mono);
}
.f:hover {
  background: var(--hov);
}
.f.sel {
  background: var(--hl);
  box-shadow: inset 3px 0 0 var(--acc);
}
.f.tr {
  grid-template-columns: 0.875rem 1fr 1rem;
}
.f.tr .car {
  color: var(--dimmer);
  font-size: 0.5625rem;
}
.f .st {
  font-weight: 700;
  font-size: 0.6875rem;
  text-align: center;
}
.st.M {
  color: var(--warn);
}
.st.A {
  color: var(--addfg);
}
.st.D {
  color: var(--delfg);
}
.st.U {
  color: var(--untr);
}
.f .p {
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.71875rem;
}
.f .p .dir {
  color: var(--dim);
}
.f.tr.ign:not(.sel) .p,
.f.tr.ign:not(.sel) .p .dir {
  color: var(--dimmer);
}
.f.sel .p {
  color: var(--hlfg);
}
.f .n {
  text-align: right;
  font-size: 0.6875rem;
  white-space: nowrap;
}
.pl {
  color: var(--addfg);
}
.mi {
  color: var(--delfg);
}
.n .mi {
  margin-left: 0.375rem;
}

.boot {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.6rem;
  color: var(--dim);
  font: 0.75rem var(--sans);
}

.sechd {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 0.625rem 0.25rem;
  font: 0.75rem var(--sans);
  color: var(--dimmer);
}
.sechd b {
  color: var(--fg);
  font-weight: 600;
}
.sechd .sp {
  flex: 1;
}
.sechd button {
  background: var(--bg3);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0.125rem 0.375rem;
  color: var(--dim);
  cursor: pointer;
}
.sechd button:hover {
  color: var(--fg);
}
.wt .cbx {
  visibility: hidden;
  justify-self: start;
}
.wt:hover .cbx,
.wt:focus-within .cbx,
.wt .cbx.on,
.selecting .wt .cbx {
  visibility: visible;
}
.acts {
  display: flex;
  gap: 0.1875rem;
  justify-content: flex-end;
}
.acts button,
.sechd button {
  display: grid;
  place-items: center;
}
.acts button {
  color: var(--dim);
  cursor: pointer;
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg3);
}
.acts button:hover {
  color: var(--fg);
}
.acts button.dg:hover {
  color: var(--danger);
  border-color: var(--danger);
}
.banner {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.625rem 0.5rem 1rem;
  margin-bottom: 0.5rem;
  font-size: 0.75rem;
  flex: none;
  border-radius: 0.875rem;
}
.banner .sp {
  flex: 1;
}
.unsaved {
  font: 0.6875rem var(--mono);
}
.repo .plus {
  visibility: hidden;
}
.repo:hover .plus,
.repo:focus-within .plus {
  visibility: visible;
}
.newwt {
  display: flex;
  gap: 0.375rem;
  padding: 0.1875rem 0.625rem 0.1875rem 1.75rem;
}
@container (width < 40rem) {
  .wts .bhead:not(.selbar) > span:not(.sp, .cbx) {
    display: none;
  }
}
</style>
