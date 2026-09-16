<script>
import { tick, untrack } from "svelte";
import Diff from "./Diff.svelte";
import Palette from "./Palette.svelte";
import { matchPath, matchWt, pathText, rank, wtText } from "./filter.js";
import {
  ancestorDirs,
  clampMenu,
  discardPrompt,
  isIgnoredPath,
  removeSummary,
  TREE_CAP,
  treeRows,
  trimSeps,
} from "../parse.ts";
import { parseThemeText, resolveTheme } from "./theme.js";

let settings = $state(null);
fetch("/api/settings").then((r) => r.json()).then((s) => (settings = s));

let zoom = $state(1);
$effect(() => {
  document.documentElement.style.fontSize = zoom === 1 ? "" : `${zoom * 100}%`;
});
function zoomKey(e) {
  if (!settings?.desktop || !e.metaKey) return;
  const d = e.key === "-"
    ? -0.1
    : e.key === "=" || e.key === "+"
    ? 0.1
    : e.key === "0"
    ? 0
    : null;
  if (d === null) return;
  e.preventDefault();
  zoom = d ? Math.round(Math.min(2, Math.max(0.6, zoom + d)) * 10) / 10 : 1;
  saveLayout();
}

let b1 = $state({ h: "32%", c: false });
let b2 = $state({ h: "24%", c: false });
let split = $state(50);
let max = $state(null);
let wrap = $state(false);
let closed = $state({});
let pinned = $state({});
let checked = $state({});
let ready = $state(false);
// boot progress from the server's `status` SSE event; the repo list streams in
// during the first sweep, so this says what is still coming.
let boot = $state({ phase: "repos", done: 0, total: 0 });
fetch("/api/layout").then((r) => r.json()).then((l) => {
  if (l.b1) b1 = l.b1;
  if (l.b2) b2 = l.b2;
  if (l.split) split = l.split;
  if (l.wrap) wrap = true;
  if (l.closed) closed = l.closed;
  if (l.pinned) pinned = l.pinned;
  if (l.zoom) zoom = l.zoom;
  if (l.theme) applyTheme(l.theme);
}).finally(() => (ready = true));

let saveT;
function saveLayout() {
  clearTimeout(saveT);
  saveT = setTimeout(() =>
    fetch("/api/layout", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        b1,
        b2,
        split,
        wrap,
        closed,
        pinned,
        theme,
        zoom,
      }),
    }), 500);
}

let repos = $state([]);
let sel = $state(null);
let files = $state([]);
let file = $state(null);
let base = $state("branch");
let explore = $state(false);
let loose = $state(false);
let tree = $state([]);
let treeDirs = $state([]);
let treeIgnored = $state([]);
let loadedDirs = $state({});
let treeOf = $state(null);
let openEl = $state();
let editingPath = $state(false);
let openDirs = $state({});
let showDiff = $state(false);
let q = $state("");
let fq = $state("");
let dirtyOnly = $state(false);
let runningOnly = $state(false);
let copied = $state("");
let diffRef = $state();
let diffDirty = $state(false);
let diffTick = $state(0);
let banner = $state(null);
let discarding = $state(null);
let touched = $state({});
let now = $state(Date.now());
let b1El = $state(), b2El = $state();
let themes = $state([]);
let vsThemes = $state([]);
let theme = $state("default");
let fileEl = $state();
let dlg = $state();
let newRepo = $state("");
let creating = $state(null);
let slug = $state("");
let busy = $state({});
let pendingLine = $state(0);
let removing = $state(false);
let confirming = $state(null);
let menu = $state(null);
let menuEl = $state();
let restored = false;
const initialParams = new URLSearchParams(location.search);
let restoring = $state(initialParams.has("path"));
let markBooted;
const booted = new Promise((r) => (markBooted = r));
fetch("/api/themes").then((r) => r.json()).then((t) => (themes = t));
fetch("/api/vscode-themes").then((r) => r.json()).then((t) => (vsThemes = t));

const selWt = $derived(
  repos.flatMap((r) => r.worktrees).find((w) => w.path === sel),
);
const selFile = $derived(files.find((f) => f.path === file));
const shownFiles = $derived(files.filter((f) => matchPath(fq, f.path)));
const stagedFiles = $derived(shownFiles.filter((f) => f.staged));
const unstagedFiles = $derived(shownFiles.filter((f) => f.unstaged));
const committedFiles = $derived(
  shownFiles.filter((f) => !f.staged && !f.unstaged),
);
const sectioned = $derived(
  stagedFiles.length > 0 || committedFiles.length > 0,
);
const byPath = $derived(new Map(files.map((f) => [f.path, f])));
const changedDirs = $derived(ancestorDirs(files.map((f) => f.path)));
const treeMatches = $derived(
  fq ? rank(fq, tree, Infinity, pathText) : [],
);
// ponytail: filter results capped at 500 rows; virtualize if that's ever too few
const treeShown = $derived(
  fq
    ? treeMatches.slice(0, 500).map((p) => ({ path: p, depth: 0, dir: false }))
    : treeRows(tree, openDirs, treeDirs),
);
const totalWts = $derived(repos.reduce((n, r) => n + r.worktrees.length, 0));
const filtering = $derived(q !== "" || dirtyOnly || runningOnly);

const renamed = (w) => (w.remote && w.remote !== w.branch ? w.remote : null);
const branchUrl = (w) =>
  repoOf(w)?.webUrl && w.remote
    ? `${repoOf(w).webUrl}/tree/${
      w.remote.split("/").map(encodeURIComponent).join("/")
    }`
    : null;

const dirName = (w) => {
  const d = w.path.split("/").pop();
  return !w.isPrimary && d !== w.branch.split("/").pop() ? d : null;
};

const sig = (w) => `${w.head}:${w.dirty}:${w.lastActivity}`;
const match = (r, w) => matchWt({ q, dirtyOnly, runningOnly }, r?.name, w);

const allWts = $derived(repos.flatMap((r) => r.worktrees));
const repoOf = (w) => repos.find((r) => r.name === w.repo);
const shownWts = $derived(allWts.filter((w) => match(repoOf(w), w)));
const pinnedWts = $derived(shownWts.filter((w) => pinned[w.path]));
const checkedWts = $derived(allWts.filter((w) => checked[w.path]));
const selectable = $derived(shownWts.filter((w) => !w.isPrimary));
const allShownChecked = $derived(
  selectable.length > 0 && selectable.every((w) => checked[w.path]),
);
const someShownChecked = $derived(selectable.some((w) => checked[w.path]));
const recentWts = $derived(
  shownWts.filter((w) => !pinned[w.path])
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, settings?.recentCount ?? 10),
);
const allClosed = $derived(closed.__all ?? true);

$effect(() => {
  const es = new EventSource("/api/events");
  es.addEventListener("status", (e) => {
    boot = JSON.parse(e.data);
    if (boot.phase !== "ready") return;
    markBooted();
    if (loose && sel) fetch(`/api/open?path=${encodeURIComponent(sel)}`);
  });
  es.onmessage = (e) => {
    const next = JSON.parse(e.data);
    const prev = new Map(
      repos.flatMap((r) => r.worktrees).map((w) => [w.path, sig(w)]),
    );
    for (const w of next.flatMap((r) => r.worktrees)) {
      if (prev.size && prev.get(w.path) !== sig(w)) {
        touched[w.path] = Date.now();
      }
    }
    repos = next;
    for (const p of Object.keys(checked)) {
      if (!next.some((r) => r.worktrees.some((w) => w.path === p))) {
        delete checked[p];
      }
    }
    if (!restored) {
      restored = true;
      restoreUrl();
    }
    if (
      sel && !loose &&
      !next.flatMap((r) => r.worktrees).some((w) => w.path === sel)
    ) {
      sel = null;
      file = null;
      files = [];
    } else if (sel && touched[sel] && prev.get(sel) !== undefined) {
      loadFiles();
      if (explore) loadTree();
      diffTick++;
    }
  };
  return () => es.close();
});

$effect(() => {
  if (!settings) return;
  const tick = setInterval(() => (now = Date.now()), settings.agoRefreshMs);
  return () => clearInterval(tick);
});

async function restoreUrl() {
  const line = Math.max(0, Math.floor(Number(initialParams.get("line")) || 0));
  const path = initialParams.get("path");
  if (path) {
    try {
      await booted;
      await openPath(path);
      const f = initialParams.get("file");
      if (f && loose) {
        file = f;
        reveal(f);
        pendingLine = line;
        scrollRow(f);
      }
    } finally {
      restoring = false;
    }
    return;
  }
  const wt = initialParams.get("wt");
  if (!wt || !repos.flatMap((r) => r.worktrees).some((w) => w.path === wt)) {
    return;
  }
  base = initialParams.get("base") === "head" ? "head" : "branch";
  explore = initialParams.get("tree") === "1";
  sel = wt;
  file = initialParams.get("file") || null;
  if (explore) {
    reveal(file);
    loadTree().then(() => scrollRow(file));
  }
  pendingLine = line;
  loadFiles();
}

$effect(() => {
  if (restoring) return;
  const q = new URLSearchParams();
  if (sel && loose) {
    q.set("path", sel);
    if (file) q.set("file", file);
    if (pendingLine) q.set("line", pendingLine);
  } else if (sel) {
    q.set("wt", sel);
    if (file) q.set("file", file);
    q.set("base", base);
    if (explore) q.set("tree", "1");
    if (pendingLine) q.set("line", pendingLine);
  }
  history.replaceState(
    null,
    "",
    q.size ? "?" + q.toString() : location.pathname,
  );
});

async function loadFiles() {
  if (loose) {
    files = [];
    return;
  }
  const res = await fetch(
    `/api/files?wt=${encodeURIComponent(sel)}&base=${base}`,
  );
  const data = await res.json();
  files = data.files;
  if (!explore && !files.some((f) => f.path === file)) {
    file = files[0]?.path ?? null;
  }
}

async function loadTree() {
  const wt = sel;
  const t = await (await fetch(`/api/tree?wt=${encodeURIComponent(wt)}`))
    .json();
  if (sel !== wt) return;
  tree = t.files;
  treeDirs = t.dirs;
  treeIgnored = t.ignored;
  loadedDirs = {};
  treeOf = wt;
  await loadOpenDirs();
}

async function loadOpenDirs() {
  for (;;) {
    const todo = treeDirs.filter((d) => openDirs[d] && !loadedDirs[d]);
    if (!todo.length) return;
    await Promise.all(todo.map(loadDir));
  }
}

async function loadDir(dir) {
  const wt = sel;
  loadedDirs[dir] = true;
  const q = `wt=${encodeURIComponent(wt)}&dir=${encodeURIComponent(dir)}`;
  const t = await (await fetch(`/api/tree?${q}`)).json().catch(() => ({}));
  if (sel !== wt || !t.files) return;
  tree = [...new Set([...tree, ...t.files])];
  treeDirs = [...new Set([...treeDirs, ...t.dirs])];
}

function reveal(path) {
  for (const d of ancestorDirs(path ? [path] : [])) openDirs[d] = true;
}

async function openPath(text) {
  const from = sel ? `&from=${encodeURIComponent(sel)}` : "";
  const res = await fetch(`/api/open?path=${encodeURIComponent(text)}${from}`);
  if (!res.ok) {
    errBanner(await res.text());
    return false;
  }
  if (banner?.kind === "err") banner = null;
  await openAt(await res.json());
  return true;
}

function openKey(e) {
  if (!e.metaKey || e.key !== "o") return;
  e.preventDefault();
  editPath();
}

async function editPath() {
  editingPath = true;
  await tick();
  openEl.value = sel ?? "";
  openEl.focus();
  openEl.select();
}

async function openBoxKey(e) {
  if (e.key === "Escape") return openEl.blur();
  if (e.key !== "Enter" || !openEl.value.trim()) return;
  if (await openPath(openEl.value.trim())) editingPath = false;
}

async function openAt(r) {
  const same = sel === r.wt;
  loose = r.loose;
  explore = true;
  if (!same) {
    tree = [];
    treeDirs = [];
    treeIgnored = [];
    loadedDirs = {};
    treeOf = null;
    openDirs = {};
  }
  sel = r.wt;
  if (r.kind === "file") {
    file = r.rel;
    pendingLine = r.line;
    reveal(r.rel);
  } else {
    if (r.rel) {
      reveal(r.rel);
      openDirs[r.rel] = true;
    }
    if (!same) {
      file = null;
      pendingLine = 0;
    }
  }
  loadFiles();
  await loadTree();
  if (r.rel) await scrollRow(r.rel);
}

$effect(() => {
  if (!fq) scrollRow(untrack(() => file));
});

async function scrollRow(path) {
  if (!path) return;
  await tick();
  document.querySelector(`[data-path="${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

function selectWt(path) {
  loose = false;
  pendingLine = 0;
  sel = path;
  file = null;
  tree = [];
  treeDirs = [];
  treeIgnored = [];
  treeOf = null;
  loadedDirs = {};
  openDirs = {};
  loadFiles();
  if (explore) loadTree();
}

function pick(f) {
  pendingLine = 0;
  file = f.path;
  if (explore) reveal(f.path);
}

function toggleDir(path) {
  if (openDirs[path]) return delete openDirs[path];
  openDirs[path] = true;
  if (treeDirs.includes(path) && !loadedDirs[path]) loadOpenDirs();
}

function setBase(b) {
  if (b === "all") {
    if (explore) return;
    explore = true;
    if (sel) loadTree().then(() => scrollRow(file));
    return;
  }
  if (base === b && !explore) return;
  explore = false;
  pendingLine = 0;
  base = b;
  if (sel) loadFiles();
}

function copyKey(e) {
  if (!e.metaKey || !e.altKey || e.code !== "KeyC" || !sel || !file) return;
  e.preventDefault();
  copy(e, e.shiftKey ? file : `${sel}/${file}`, "kbd");
}

function toggleAllShown() {
  const on = !allShownChecked;
  for (const w of selectable) {
    if (on) checked[w.path] = true;
    else delete checked[w.path];
  }
}

function toggleCheck(w, e) {
  e.stopPropagation();
  if (checked[w.path]) delete checked[w.path];
  else checked[w.path] = true;
}

function toggleAll() {
  closed.__all = !allClosed;
  saveLayout();
}

function toggleRepo(name) {
  closed[name] = !closed[name];
  saveLayout();
}

function drag(e, band, el) {
  e.preventDefault();
  max = null;
  const y0 = e.clientY, h0 = el.offsetHeight;
  const mv = (m) => {
    band.h = Math.max(26, h0 + m.clientY - y0) + "px";
    band.c = false;
  };
  const up = () => {
    removeEventListener("mousemove", mv);
    removeEventListener("mouseup", up);
    saveLayout();
  };
  addEventListener("mousemove", mv);
  addEventListener("mouseup", up);
}

function collapse(band) {
  max = null;
  band.c = !band.c;
  saveLayout();
}

function gutterKey(e, band, el) {
  if (e.key === "Enter") return collapse(band);
  const d = { ArrowUp: -20, ArrowDown: 20 }[e.key];
  if (!d) return;
  e.preventDefault();
  max = null;
  band.h = Math.max(26, el.offsetHeight + d) + "px";
  band.c = false;
  saveLayout();
}

// while a PR is open, "behind" should mean behind its base branch, not behind
// this worktree's own pushed remote (which is usually 0 once it's pushed).
function prAb(w) {
  const open = w.pr?.state === "OPEN";
  return {
    ahead: open ? w.aheadMain : w.ahead,
    behind: open ? w.behindMain : w.behind,
  };
}

function prTimer(pr) {
  if (pr.ci?.state === "fail") {
    return { cls: "fail", label: "failing", text: ago(pr.ciSince) };
  }
  if (pr.ci?.state === "pending") {
    return { cls: "pending", label: "running", text: ago(pr.ciSince) };
  }
  if (pr.reviewDecision === "APPROVED") {
    return { cls: "approved", label: "approved", text: ago(pr.reviewSince) };
  }
  // fallback: every PR gets some timer, even once merged/closed and its CI
  // detail has been dropped.
  return {
    cls: pr.state === "MERGED"
      ? "merged"
      : pr.state === "CLOSED"
      ? "closed"
      : "open",
    label: pr.state.toLowerCase(),
    text: ago(pr.stateSince),
  };
}

function ago(ms) {
  if (!ms) return "—";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function splitPath(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

const relWt = (r, w) =>
  w.path === r.path
    ? "."
    : w.path.startsWith(r.path + "/")
    ? w.path.slice(r.path.length + 1)
    : w.path;

let toast = $state("");
let toastT;
function showToast(text) {
  toast = text;
  clearTimeout(toastT);
  toastT = setTimeout(() => (toast = ""), settings?.toastMs ?? 7000);
}

async function copy(e, text, key, label = text) {
  e.stopPropagation();
  await navigator.clipboard.writeText(text);
  showToast(label);
  copied = key;
  setTimeout(() => {
    if (copied === key) copied = "";
  }, 900);
}

function errBanner(text) {
  banner = {
    kind: "err",
    text,
    actions: [{ label: "dismiss", fn: () => (banner = null) }],
  };
}

function conflictBanner() {
  banner = {
    kind: "warn",
    text:
      `${file} changed on disk while you had unsaved edits — not saved. Use discard to reload it.`,
    actions: [{ label: "dismiss", fn: () => (banner = null) }],
  };
}

async function act(ep, body, key, e) {
  e?.stopPropagation();
  busy[key] = true;
  const res = await fetch(`/api/${ep}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  delete busy[key];
  if (!res.ok) {
    errBanner(await res.text());
    return false;
  }
  return true;
}

async function op(ep, body, e) {
  await act(ep, { wt: sel, ...body }, ep, e);
  loadFiles();
  diffTick++;
}

const rebase = (w, e) => act("rebase", { wt: w.path }, "rb:" + w.path, e);
const updateBranch = (w, e) =>
  act("update-branch", { wt: w.path, number: w.pr.number }, "ub:" + w.path, e);
const toggleAutoMerge = (w, e) =>
  act(
    "auto-merge",
    { wt: w.path, number: w.pr.number, enable: !w.pr.autoMerge },
    "am:" + w.path,
    e,
  );
const push = (w, e) =>
  act(
    "push",
    { wt: w.path, remote: w.remote, branch: w.branch },
    "push:" + w.path,
    e,
  );
const prState = (w, action, e) =>
  act(
    "pr-state",
    { wt: w.path, number: w.pr.number, action },
    "ps:" + w.path,
    e,
  );

async function removeWts(wts, force) {
  const live = wts.filter((w) => allWts.some((a) => a.path === w.path));
  if (!live.length) return (confirming = null);
  banner = null;
  removing = true;
  const res = await fetch("/api/wt-remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wts: live.map((w) => w.path), force }),
  });
  removing = false;
  confirming = null;
  if (!res.ok) return errBanner(await res.text());
  const { failed } = await res.json();
  const stuck = live.filter((w) => failed.some((f) => f.path === w.path));
  for (const w of live) if (!stuck.includes(w)) delete checked[w.path];
  if (!stuck.length) return;
  banner = {
    kind: "warn",
    text: removeSummary(live.length, stuck.map((w) => w.branch)),
    actions: [
      {
        label: "force remove",
        primary: true,
        fn: () => removeWts(stuck, true),
      },
      { label: "dismiss", fn: () => (banner = null) },
    ],
  };
}

let menuReturn = null;

async function openMenu(e, items, viaKey) {
  e.preventDefault();
  e.stopPropagation();
  const box = e.currentTarget.getBoundingClientRect();
  menuReturn = viaKey ? e.currentTarget : null;
  menu = {
    x: e.clientX ?? Math.round(box.left + 16),
    y: e.clientY ?? Math.round(box.bottom),
    items: trimSeps(items.filter(Boolean)),
  };
  await tick();
  if (!menuEl || !menu) return;
  menuEl.showPopover();
  const r = menuEl.getBoundingClientRect();
  const p = clampMenu(
    menu.x,
    menu.y,
    r.width,
    r.height,
    innerWidth,
    innerHeight,
  );
  menuEl.style.left = `${p.x}px`;
  menuEl.style.top = `${p.y}px`;
  if (viaKey) menuEl.querySelector("button")?.focus();
}

function menuKey(e, items) {
  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
    openMenu(e, items, true);
  }
}

function closeMenu() {
  menu = null;
  menuReturn?.focus();
  menuReturn = null;
}

$effect(() => {
  if (!menu) return;
  const hide = () => {
    menuEl?.hidePopover();
    closeMenu();
  };
  const onDown = (ev) => !menuEl?.contains(ev.target) && hide();
  const onKey = (ev) => ev.key === "Escape" && hide();
  addEventListener("pointerdown", onDown, true);
  addEventListener("keydown", onKey, true);
  addEventListener("scroll", hide, true);
  return () => {
    removeEventListener("pointerdown", onDown, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", hide, true);
  };
});

function runItem(item, e) {
  menuEl?.hidePopover();
  item.fn(e);
}

function wtItems(w, solo = false) {
  const t = !solo && checked[w.path] && checkedWts.length > 1
    ? checkedWts
    : [w];
  const many = t.length > 1;
  const pin = t.every((x) => pinned[x.path]);
  const branches = t.map((x) => x.branch).join("\n");
  const paths = t.map((x) => x.path).join("\n");
  return [
    !many && { label: "Open", fn: () => selectWt(w.path) },
    !many && "-",
    {
      label: many ? `Copy ${t.length} branch names` : "Copy branch name",
      fn: (e) =>
        copy(e, branches, "ctx", many ? `${t.length} branch names` : w.branch),
    },
    !many && renamed(w) && {
      label: "Copy remote branch name",
      fn: (e) => copy(e, w.remote, "ctx"),
    },
    {
      label: many ? `Copy ${t.length} paths` : "Copy path",
      fn: (e) => copy(e, paths, "ctx", many ? `${t.length} paths` : w.path),
    },
    !many && {
      label: "Copy path (relative)",
      fn: (e) => copy(e, relWt(repoOf(w), w), "ctx"),
    },
    "-",
    !many && branchUrl(w) && {
      label: "Open remote branch",
      fn: () => open(branchUrl(w), "_blank", "noreferrer"),
    },
    !many && w.pr && {
      label: `View pull request #${w.pr.number}`,
      fn: () => open(w.pr.url, "_blank", "noreferrer"),
    },
    !many && repoOf(w)?.webUrl && (!w.remote || w.ahead > 0) && {
      label: w.remote ? `Push (↑${w.ahead})` : "Push branch to remote",
      fn: (e) => push(w, e),
    },
    !many && repoOf(w)?.webUrl && !w.isPrimary && !w.pr && {
      label: "Compare & open pull request",
      fn: async (e) => {
        if (
          !w.remote && !(await push(w, e))
        ) {
          return;
        }
        open(
          `${repoOf(w).webUrl}/compare/${
            (w.remote ?? w.branch).split("/").map(encodeURIComponent).join("/")
          }?expand=1`,
          "_blank",
          "noreferrer",
        );
      },
    },
    !many && repoOf(w)?.webUrl && !w.isPrimary && !w.pr && {
      label: "Open pull request",
      fn: (e) =>
        act(
          "pr-create",
          { wt: w.path, remote: w.remote, branch: w.branch },
          "pc:" + w.path,
          e,
        ),
    },
    !many && w.pr?.state === "OPEN" && w.behindMain > 0 && {
      label: `Update branch (↓${w.behindMain} from ${w.pr.baseRefName})`,
      fn: (e) => updateBranch(w, e),
    },
    "-",
    {
      label: `${pin ? "Unpin" : "Pin"}${many ? ` ${t.length}` : ""}`,
      fn: () => {
        for (const x of t) {
          if (pin) delete pinned[x.path];
          else pinned[x.path] = true;
        }
        saveLayout();
      },
    },
    !many && w.pr?.state === "OPEN" && {
      label: w.pr.autoMerge ? "Disable auto-merge" : "Enable auto-merge",
      fn: (e) => toggleAutoMerge(w, e),
    },
    !many && w.pr?.state === "OPEN" && {
      label: w.pr.isDraft ? "Publish pull request" : "Convert to draft",
      fn: (e) => prState(w, w.pr.isDraft ? "ready" : "draft", e),
    },
    !many && w.pr?.state === "OPEN" && {
      label: `Close pull request #${w.pr.number}`,
      fn: (e) => prState(w, "close", e),
    },
    !many && {
      label: w.isPrimary ? "Pull" : "Fetch + rebase",
      fn: (e) => rebase(w, e),
    },
    !many && w.procs?.length > 0 && "-",
    ...(!many
      ? (w.procs ?? []).map((p) => ({
        label: `Kill pid ${p.pid} (:${p.port})`,
        danger: true,
        fn: (e) => act("kill-pid", { pid: p.pid }, "kill:" + p.pid, e),
      }))
      : []),
    !w.isPrimary && "-",
    !w.isPrimary && {
      label: many ? `Remove ${t.length} worktrees…` : "Remove worktree…",
      danger: true,
      fn: () => (confirming = t.filter((x) => !x.isPrimary)),
    },
  ];
}

function repoItems(r, shown) {
  const wts = shown.filter((w) => !w.isPrimary);
  return [
    {
      label: "New worktree…",
      fn: () => {
        creating = r.name;
        slug = "";
      },
    },
    "-",
    {
      label: `Copy ${shown.length} branch names`,
      fn: (e) =>
        copy(
          e,
          shown.map((w) => w.branch).join("\n"),
          "ctx",
          `${shown.length} branch names`,
        ),
    },
    { label: "Copy repo path", fn: (e) => copy(e, r.path, "ctx") },
    "-",
    {
      label: closed[r.name] ? "Expand" : "Collapse",
      fn: () => toggleRepo(r.name),
    },
    wts.length > 0 && {
      label: `Select ${wts.length} worktree${wts.length === 1 ? "" : "s"}`,
      fn: () => {
        for (const w of wts) checked[w.path] = true;
      },
    },
    wts.length > 0 && "-",
    wts.length > 0 && {
      label: `Remove ${wts.length} worktree${wts.length === 1 ? "" : "s"}…`,
      danger: true,
      fn: () => (confirming = wts),
    },
  ];
}

function fileItems(f, mode) {
  return [
    {
      label: "Copy path (relative)",
      kbd: file === f.path && "⌥⇧⌘C",
      fn: (e) => copy(e, f.path, f.path + ":r"),
    },
    {
      label: "Copy path (absolute)",
      kbd: file === f.path && "⌥⌘C",
      fn: (e) => copy(e, sel + "/" + f.path, f.path + ":a"),
    },
    "-",
    mode === "staged" && {
      label: "Unstage",
      fn: (e) => op("unstage", { path: f.path }, e),
    },
    mode === "unstaged" && {
      label: "Stage",
      fn: (e) => op("stage", { path: f.path }, e),
    },
    mode === "unstaged" && {
      label: "Discard changes",
      danger: true,
      fn: (e) => discardArm(f, e),
    },
  ];
}

async function createWt(r) {
  const s = slug.trim();
  if (!s) return;
  if (await act("wt-create", { repo: r.name, slug: s }, "new:" + r.name)) {
    creating = null;
    slug = "";
  }
}

function addLauncher() {
  const name = newRepo.trim();
  if (!name || settings.launchers[name] !== undefined) return;
  settings.launchers[name] = "";
  newRepo = "";
}

let setT;
function saveSettings() {
  clearTimeout(setT);
  setT = setTimeout(() =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    }).then((r) => r.json()).then((s) => (settings = s)), 400);
}

async function applyTheme(name) {
  const st = document.documentElement.style;
  let resolved = { vars: {}, dark: null };
  if (name !== "default") {
    busy.theme = true;
    try {
      const r = await fetch(`/api/theme?name=${encodeURIComponent(name)}`);
      if (!r.ok) return errBanner(await r.text());
      resolved = resolveTheme(parseThemeText(await r.text()));
    } catch (e) {
      return errBanner(`theme failed to load: ${e.message ?? e}`);
    } finally {
      delete busy.theme;
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
  theme = name;
  saveLayout();
}

async function importTheme(e) {
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
    themes = await (await fetch("/api/themes")).json();
    applyTheme(name);
  }
}

async function importVsTheme(e) {
  const path = e.target.value;
  e.target.value = "";
  const hit = vsThemes.find((t) => t.path === path);
  if (hit && await act("theme-import", { path }, "theme")) {
    themes = await (await fetch("/api/themes")).json();
    applyTheme(hit.name);
  }
}

function toggleMax(n) {
  max = max === n ? null : n;
}

let paletteOpen = $state(false);
let palTree = $state({ of: null, files: [], dirs: [] });

function paletteKey(e) {
  if (!e.metaKey || e.altKey || e.shiftKey || !["k", "p"].includes(e.key)) {
    return;
  }
  e.preventDefault();
  paletteOpen = !paletteOpen;
}

$effect(() => {
  const wt = sel;
  if (!paletteOpen || !wt || treeOf === wt || loose) return;
  fetch(`/api/tree?wt=${encodeURIComponent(wt)}`).then((r) => r.json())
    .then((t) => {
      if (sel === wt) palTree = { of: wt, files: t.files, dirs: t.dirs };
    });
});

const asPalette = (items, detail) =>
  items.filter((i) => i && i !== "-").map((i) => ({
    ...i,
    group: "action",
    detail,
  }));

const paletteItems = $derived.by(() => {
  if (!paletteOpen) return [];
  const t = treeOf === sel || loose
    ? { files: tree, dirs: treeDirs }
    : palTree.of === sel
    ? palTree
    : { files: [], dirs: [] };
  const pathItems = (kind, paths) =>
    paths.map((p) => {
      const [dir, name] = splitPath(p);
      return {
        group: kind === "dir" ? "folder" : "file",
        label: name,
        detail: dir || undefined,
        fn: () => openAt({ wt: sel, loose, kind, rel: p, line: 0 }),
      };
    });
  const cmd = (label, fn, kbd) => ({ group: "command", label, fn, kbd });
  const wtItem = (w) => ({
    group: "worktree",
    label: w.branch,
    detail: [
      w.repo,
      w.pr && `#${w.pr.number} ${w.pr.title}`,
      w.ports?.map((p) => `:${p}`).join(" "),
    ].filter(Boolean).join(" · "),
    fn: () => {
      selectWt(w.path);
      scrollRow(w.path);
    },
    sub: () => asPalette(wtItems(w, true), w.branch),
  });
  return [
    ...[...allWts].sort((a, b) =>
      !!pinned[b.path] - !!pinned[a.path] || b.lastActivity - a.lastActivity
    ).map(wtItem),
    ...(selWt && !loose ? asPalette(wtItems(selWt, true), selWt.branch) : []),
    cmd("Settings", () => dlg.showModal()),
    ...["Worktrees", "Files", "Diff"].map((name, i) =>
      cmd(
        `${max === i + 1 ? "Restore" : "Maximize"} ${name}`,
        () => toggleMax(i + 1),
      )
    ),
    ...(loose ? [] : [
      cmd("Since branch point", () => setBase("branch")),
      cmd("Uncommitted", () => setBase("head")),
      cmd("All files", () => setBase("all")),
    ]),
    cmd("Toggle wrap", () => {
      wrap = !wrap;
      saveLayout();
    }),
    cmd(`${allClosed ? "Expand" : "Collapse"} all worktrees`, toggleAll),
    {
      ...cmd("Filter branches…"),
      query: () => q,
      onquery: (v) => (q = v),
      sub: () => rank(q, shownWts, 50, wtText).map(wtItem),
    },
    ...(sel
      ? [{
        ...cmd("Filter files…"),
        query: () => fq,
        onquery: (v) => (fq = v),
        sub: () =>
          rank(fq, explore ? tree : files.map((f) => f.path), 50, pathText)
            .map((p) => ({
              group: "file",
              label: splitPath(p)[1],
              detail: splitPath(p)[0] || undefined,
              fn: () => (pick({ path: p }), scrollRow(p)),
            })),
      }]
      : []),
    cmd("Dirty only", () => (dirtyOnly = !dirtyOnly)),
    cmd("Running only", () => (runningOnly = !runningOnly)),
    cmd("Open path…", editPath, "⌘O"),
    {
      ...cmd("Theme…", () => dlg.showModal()),
      sub: () =>
        ["default", ...themes].map((name) => cmd(name, () => applyTheme(name))),
    },
    ...repos.map((r) => ({
      group: "repo",
      label: r.name,
      detail: r.path,
      fn: async () => {
        closed.__all = false;
        closed[r.name] = false;
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

function discardArm(f, e) {
  e.stopPropagation();
  discarding = f;
}

function confirmDiscard() {
  const f = discarding;
  discarding = null;
  op("discard", { path: f.path, untracked: f.status === "U" });
}
</script>

<svelte:window
  onkeydown={(e) => (zoomKey(e), copyKey(e), openKey(e), paletteKey(e))}
/>

<div class="app" class:desktop={settings?.desktop}>
  <div class="tbar">
    <svg class="mark" width="18" height="18" viewBox="0 0 24 24" fill="none" role="img" aria-label="forest">
      <path d="M5.2 8.6 L7.3 13.8 L6.2 13.8 L8.9 19 L1.5 19 L4.2 13.8 L3.1 13.8 Z" fill="var(--mark2)"/>
      <path d="M18.9 10.6 L20.9 14.8 L19.8 14.8 L22.5 19 L15.3 19 L18 14.8 L16.9 14.8 Z" fill="var(--mark2)"/>
      <path d="M12 3.4 L14.6 8.6 L13.1 8.6 L16.1 13.8 L14.6 13.8 L17.1 19 L6.9 19 L9.4 13.8 L7.9 13.8 L10.9 8.6 L9.4 8.6 Z" fill="var(--acc)"/>
    </svg>
    <span class="path">{settings?.root ?? ""}</span>
    <span class="sp"></span>
    <button class="gear" title="settings" aria-label="settings"
            onclick={() => dlg.showModal()}>⚙</button>
  </div>

  {#if banner}
    <div class="banner {banner.kind}">
      <span>{banner.text}</span><span class="sp"></span>
      {#each banner.actions as a (a.label)}
        <button class="btn" class:p={a.primary} onclick={a.fn}>{a.label}</button>
      {/each}
    </div>
  {/if}

  {#if ready}
  {#snippet maxBtn(n)}
    <button class="btn max" class:on={max === n} title={max === n ? "restore panes" : "full screen"}
            aria-label={max === n ? "restore panes" : "full screen"}
            onclick={() => toggleMax(n)}>{max === n ? "⤡" : "⤢"}</button>
  {/snippet}
  <div class="band" class:grow={max === 1} bind:this={b1El}
       style:height={max ? (max === 1 ? null : "1.625rem") : b1.c ? "1.625rem" : b1.h}>
    <div class="bhead">
      {#if selectable.length}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <span
          class="cbx"
          class:on={allShownChecked}
          class:some={!allShownChecked && someShownChecked}
          role="checkbox"
          aria-checked={allShownChecked}
          aria-label="select all {selectable.length} shown"
          title="select all {selectable.length} shown"
          tabindex="0"
          onclick={toggleAllShown}
          onkeydown={(e) => e.key === "Enter" && toggleAllShown()}
        ></span>
      {/if}
      <b>Worktrees</b><span>{filtering
          ? `${shownWts.length} of ${totalWts} matching`
          : `${totalWts} across ${repos.length} repos`}</span><span
        class="sp"
      ></span>
      <input class="filter" placeholder="filter branches" bind:value={q} />
      <button
        class="btn"
        class:on={dirtyOnly}
        onclick={() => (dirtyOnly = !dirtyOnly)}>dirty only</button
      >
      <button
        class="btn"
        class:on={runningOnly}
        onclick={() => (runningOnly = !runningOnly)}>running only</button
      >
      {@render maxBtn(1)}
    </div>
    {#if checkedWts.length || confirming}
      <div class="bhead selbar" class:confirm={confirming}>
        {#if confirming}
          <b>remove {confirming.length} worktree{confirming.length === 1
              ? ""
              : "s"}?</b>
          <span class="meta names">{confirming.map((w) => w.branch).join(", ")}
          </span>
          <span class="sp"></span>
          <button
            class="btn dg"
            disabled={removing}
            onclick={() => removeWts(confirming, false)}
            >{removing ? "removing…" : "remove"}</button
          >
          <button class="btn" onclick={() => (confirming = null)}>cancel</button
          >
        {:else}
          <b>{checkedWts.length} selected</b>
          {#if checkedWts.some((w) => !match(repoOf(w), w))}
            <span class="meta">{checkedWts.filter((w) => !match(repoOf(w), w))
                .length} hidden by the filter</span>
          {/if}
          <span class="sp"></span>
          <button
            class="btn"
            onclick={(e) =>
              copy(
                e,
                checkedWts.map((w) => w.branch).join("\n"),
                "sel:br",
                `${checkedWts.length} branch names`,
              )}>copy branches</button
          >
          <button
            class="btn"
            onclick={(e) =>
              copy(
                e,
                checkedWts.map((w) => w.path).join("\n"),
                "sel:pa",
                `${checkedWts.length} paths`,
              )}>copy paths</button
          >
          <button class="btn dg" onclick={() => (confirming = checkedWts)}
            >remove</button
          >
          <button
            class="btn"
            onclick={() => {
              checked = {};
              confirming = null;
            }}>clear</button
          >
        {/if}
      </div>
    {/if}
    <div class="body">
      {#if pinnedWts.length}
        <div class="repo st"><span class="rn">Pinned</span><span class="ct">{pinnedWts.length}</span></div>
        {#each pinnedWts as w (w.path)}
          {@render wtRow(w, true)}
        {/each}
      {/if}
      {#if recentWts.length}
        <div class="repo st"><span class="rn">Recent</span><span class="ct">{recentWts.length}</span></div>
        {#each recentWts as w (w.path)}
          {@render wtRow(w, true)}
        {/each}
      {/if}
      <div class="repo" role="button" tabindex="0"
           onclick={toggleAll}
           onkeydown={(e) => e.key === "Enter" && toggleAll()}>
        <span class="car">{allClosed ? "▶" : "▼"}</span>
        <span class="rn">All worktrees</span>
        <span class="ct">{shownWts.length}</span>
      </div>
      {#if boot.phase !== "ready"}
        <div class="boot">
          <span class="spin"></span>
          {#if boot.phase === "repos"}
            reading branches{boot.total ? ` ${boot.done}/${boot.total}` : ""}…
          {:else}
            loading pull requests…
          {/if}
        </div>
      {/if}
      {#if !allClosed}
      {#each repos as r (r.name)}
        {@const wts = r.worktrees.filter((w) => match(r, w))}
        {#if wts.length || !filtering}
          <div class="repo" role="button" tabindex="0" data-repo={r.name}
               onclick={() => toggleRepo(r.name)}
               onkeydown={(e) => e.key === "Enter" ? toggleRepo(r.name) : menuKey(e, repoItems(r, wts))}
               oncontextmenu={(e) => openMenu(e, repoItems(r, wts))}>
            <span class="car">{closed[r.name] ? "▶" : "▼"}</span>
            <span class="rn">{r.name}</span>
            <span class="ct">{r.worktrees.length} worktree{r.worktrees.length > 1 ? "s" : ""}</span>
            <span class="sp"></span>
            <button class="cbtn plus" title="new worktree"
                    onclick={(e) => { e.stopPropagation(); creating = creating === r.name ? null : r.name; slug = ""; }}>+ new</button>
          </div>
          {#if creating === r.name}
            <div class="newwt">
              <!-- svelte-ignore a11y_autofocus -->
              <input class="filter" autofocus placeholder="branch / slug" bind:value={slug}
                     onkeydown={(e) => { if (e.key === "Enter") createWt(r); if (e.key === "Escape") creating = null; }}>
              <button class="btn" disabled={busy["new:" + r.name]} onclick={() => createWt(r)}>
                {busy["new:" + r.name] ? "creating…" : "create"}</button>
            </div>
          {/if}
          {#if !closed[r.name]}
            {#each wts as w (w.path)}
              {@render wtRow(w, false)}
            {/each}
          {/if}
        {/if}
      {/each}
      {/if}
    </div>
  </div>
  {#snippet wtRow(w, showRepo)}
    {#key touched[w.path]}
      <div class="wt" class:sel={sel === w.path} class:touch={touched[w.path]}
           role="button" tabindex="0" data-path={w.path} onclick={() => selectWt(w.path)}
           onkeydown={(e) => e.key === "Enter" ? selectWt(w.path) : menuKey(e, wtItems(w))}
           oncontextmenu={(e) => openMenu(e, wtItems(w))}>
        {#if w.isPrimary}
          <span></span>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <span class="cbx" class:on={checked[w.path]} role="checkbox"
                aria-checked={!!checked[w.path]} aria-label="select {w.branch}" tabindex="0"
                onclick={(e) => toggleCheck(w, e)}
                onkeydown={(e) => e.key === "Enter" && toggleCheck(w, e)}></span>
        {/if}
        <span class="br" title={[w.branch, renamed(w) && `pushed as ${renamed(w)}`, dirName(w) &&
          `in ${dirName(w)}/`].filter(Boolean).join(" · ")}>{#if
          showRepo}<span class="rp">{w.repo}</span>{/if}{w.branch}{#if
          renamed(w)}<span class="rb">{renamed(w)}</span>{/if}{#if
          dirName(w)}<span class="dir">{dirName(w)}</span>{/if}</span>
        <span class="prc">
          {#if w.pr}
            {@const t = prTimer(w.pr)}
            <a class="port pr" class:merged={w.pr.state === "MERGED"}
               class:closed={w.pr.state === "CLOSED"}
               class:pending={w.pr.ci?.state === "pending"}
               class:fail={w.pr.ci?.state === "fail"}
               class:draft={w.pr.isDraft} class:automerge={w.pr.autoMerge}
               href={w.pr.url}
               target="_blank" rel="noreferrer"
               title={[
                 `${w.pr.state.toLowerCase()} PR #${w.pr.number}`,
                 w.pr.ci?.state && `CI ${w.pr.ci.state}${
                   w.pr.ci.failing?.length ? `: ${w.pr.ci.failing.join(", ")}` : ""
                 }`,
                 w.pr.reviewDecision &&
                 w.pr.reviewDecision.toLowerCase().replaceAll("_", " "),
                 w.pr.isDraft && "draft",
                 w.pr.autoMerge && "auto-merge enabled",
                 w.pr.title,
               ].filter(Boolean).join(" · ")}
               onclick={(e) => e.stopPropagation()}>#{w.pr.number}{w.pr.reviewDecision ===
              "CHANGES_REQUESTED" ? "!" : ""}{#if w.pr.autoMerge}
                <svg class="am-icon" viewBox="0 0 16 16" width="10" height="10">
                  <path d="M1.896 4.559a6.25 6.25 0 0 1 8.839 0 .75.75 0 0 1-1.06 1.061 4.75 4.75 0 1 0 0 6.717L13.03 8.98l-1.553-1.554A.25.25 0 0 1 11.654 7h4.096a.25.25 0 0 1 .25.25v4.096a.25.25 0 0 1-.427.177l-1.482-1.482-3.356 3.356a6.25 6.25 0 0 1-8.839-8.838Z" />
                </svg>
              {/if}</a>
            {#if t}
              <span class="prt {t.cls}" title="{t.label} for {t.text}">{t.text}</span>
            {/if}
          {/if}
        </span>
        <span class="ports">
          {#each w.ports ?? [] as p}
            <a class="port" href="http://localhost:{p}" target="_blank" rel="noreferrer"
               title="running on port {p}" onclick={(e) => e.stopPropagation()}>:{p}</a>
          {/each}
        </span>
        <span class="dirty" class:zero={!w.dirty}>{w.dirty ? "●" + w.dirty : "—"}</span>
        <span class="ab" class:behind={prAb(w).behind > 0}
              title={w.pr?.state === "OPEN"
                ? `${prAb(w).behind} behind ${w.pr.baseRefName}, ${
                  prAb(w).ahead
                } ahead${
                  prAb(w).behind > 0 ? " — right-click to update branch" : ""
                }`
                : null}>{(prAb(w).ahead ? `↑${prAb(w).ahead}` : "") +
              (prAb(w).behind ? ` ↓${prAb(w).behind}` : "") || "—"}</span>
        <span class="ago">{ago(w.lastActivity)}</span>
      </div>
    {/key}
  {/snippet}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="gutter" role="separator" aria-orientation="horizontal" tabindex="0"
       onmousedown={(e) => drag(e, b1, b1El)} ondblclick={() => collapse(b1)}
       onkeydown={(e) => gutterKey(e, b1, b1El)}></div>

  <div class="band" class:grow={max === 2} bind:this={b2El}
       style:height={max ? (max === 2 ? null : "1.625rem") : b2.c ? "1.625rem" : b2.h}>
    <div class="bhead"><b>{explore ? "Files" : "Changed files"}</b>
      {#if editingPath}
        <input class="filter open" placeholder="open path…" bind:this={openEl}
               onkeydown={openBoxKey} onblur={() => (editingPath = false)}>
      {:else}
        <button class="meta pth" title="open a path… ⌘O" onclick={editPath}
                oncontextmenu={(e) => sel && openMenu(e, [
                  {
                    label: "Copy path (relative)",
                    fn: (e) => copy(e, selWt ? relWt(repoOf(selWt), selWt) : sel, "ctx"),
                  },
                  { label: "Copy path (absolute)", fn: (e) => copy(e, sel, "ctx") },
                ])}>{loose ? sel : selWt ? `${selWt.repo} · ${selWt.branch}` : "open path… ⌘O"}</button>
        <span class="sp"></span>
      {/if}
      <input class="filter" placeholder="filter files" bind:value={fq}>
      {#if !loose}<div class="seg">
        <button class:on={!explore && base === "branch"} onclick={() => setBase("branch")}>since branch point</button>
        <button class:on={!explore && base === "head"} onclick={() => setBase("head")}>uncommitted</button>
        <button class:on={explore} onclick={() => setBase("all")}>all files</button>
      </div>{/if}
      {@render maxBtn(2)}
    </div>
    {#if discarding}
      <div class="bhead selbar confirm">
        <b>{discardPrompt(discarding.path, discarding.status === "U")}</b>
        <span class="sp"></span>
        <button class="btn dg" onclick={confirmDiscard}>
          {discarding.status === "U" ? "delete" : "discard"}</button>
        <button class="btn" onclick={() => (discarding = null)}>cancel</button>
      </div>
    {/if}
    <div class="body">
      {#snippet fileRow(f, mode)}
        {@const [dir, name] = splitPath(f.path)}
        <div class="f" class:sel={file === f.path} role="button" tabindex="0"
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
          <span class="p"><span class="dir">{dir}</span>{name}</span>
          <span class="acts">
            {#if mode === "staged"}
              <button onclick={(e) => op("unstage", { path: f.path }, e)}>unstage</button>
            {:else if mode === "unstaged"}
              <button onclick={(e) => op("stage", { path: f.path }, e)}>stage</button>
              <button class="dg" title="discard changes"
                      onclick={(e) => discardArm(f, e)}>↺</button>
            {/if}
          </span>
          <span class="n"><span class="pl">+{f.added}</span><span class="mi">−{f.removed}</span></span>
        </div>
      {/snippet}
      {#snippet treeRow(r)}
        {@const [dir, name] = fq ? splitPath(r.path) : ["", r.path.split("/").pop()]}
        {@const f = byPath.get(r.path)}
        <div class="f tr" class:sel={file === r.path} class:ign={isIgnoredPath(r.path, treeIgnored)} role="button" tabindex="0" data-path={r.path}
             style:padding-left="{0.625 + r.depth * 0.875}rem"
             onclick={() => r.dir ? toggleDir(r.path) : pick(r)}
             onkeydown={(e) => e.key === "Enter" ? (r.dir ? toggleDir(r.path) : pick(r)) : menuKey(e, fileItems(r))}
             oncontextmenu={(e) => openMenu(e, fileItems(r))}>
          <span class="car">{r.dir ? (openDirs[r.path] ? "▼" : "▶") : ""}</span>
          <span class="p" title={r.path}><span class="dir">{dir}</span>{name}{r.dir ? "/" : ""}</span>
          {#if f}
            <span class="st {f.status}">{f.status === "U" ? "?" : f.status}</span>
          {:else if r.dir && changedDirs.has(r.path)}
            <span class="st M">●</span>
          {:else}
            <span></span>
          {/if}
        </div>
      {/snippet}
      {#if !sel}
        <div class="empty">select a worktree</div>
      {:else if explore}
        {#if loose && !tree.length && treeOf === sel}
          <div class="empty">empty folder</div>
        {:else if fq && !treeMatches.length}
          <div class="empty">no matches</div>
        {:else}
          {#each treeShown as r (r.path)}{@render treeRow(r)}{/each}
          {#if treeMatches.length > treeShown.length}
            <div class="empty">{treeMatches.length - treeShown.length} more — narrow the filter</div>
          {/if}
          {#if loose && tree.length >= TREE_CAP}
            <div class="empty">showing first {TREE_CAP} files — narrow the path</div>
          {/if}
        {/if}
      {:else if !files.length}
        <div class="empty">no changes</div>
      {:else if !shownFiles.length}
        <div class="empty">no matches</div>
      {:else if sectioned}
        {#if stagedFiles.length}
          <div class="sechd">staged · {stagedFiles.length}<span class="sp"></span>
            <button onclick={(e) => op("unstage", { path: "." }, e)}>unstage all</button></div>
          {#each stagedFiles as f (f.path)}{@render fileRow(f, "staged")}{/each}
        {/if}
        {#if unstagedFiles.length}
          <div class="sechd">unstaged · {unstagedFiles.length}<span class="sp"></span>
            <button onclick={(e) => op("stage", { path: "." }, e)}>stage all</button></div>
          {#each unstagedFiles as f (f.path)}{@render fileRow(f, "unstaged")}{/each}
        {/if}
        {#if committedFiles.length}
          <div class="sechd">committed · {committedFiles.length}</div>
          {#each committedFiles as f (f.path)}{@render fileRow(f, "committed")}{/each}
        {/if}
      {:else}
        {#each unstagedFiles as f (f.path)}{@render fileRow(f, "unstaged")}{/each}
      {/if}
    </div>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="gutter" role="separator" aria-orientation="horizontal" tabindex="0"
       onmousedown={(e) => drag(e, b2, b2El)} ondblclick={() => collapse(b2)}
       onkeydown={(e) => gutterKey(e, b2, b2El)}></div>

  <div class="band" class:grow={max !== 1 && max !== 2}
       style:height={max === 1 || max === 2 ? "1.625rem" : null}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="bhead" oncontextmenu={(e) => file && openMenu(e, fileItems({ path: file }))}>
      <b>{file ?? (explore ? "File" : "Diff")}</b><span class="sp"></span>
      {#if explore && selFile}
        <div class="seg">
          <button class:on={!showDiff} onclick={() => (showDiff = false)}>view</button>
          <button class:on={showDiff} onclick={() => (showDiff = true)}>diff</button>
        </div>
      {/if}
      {#if diffDirty}
        <span class="unsaved">● unsaved — ⌘S</span>
        <button class="btn p" onclick={() => diffRef?.save()}>save</button>
        <button class="btn" title="discard editor changes, reload from disk"
                onclick={() => { banner = null; diffRef?.reloadTheirs(); }}>discard</button>
      {/if}
      <label class="meta wraplbl">
        <input type="checkbox" class="cbxin" bind:checked={wrap} onchange={saveLayout}>
        <span class="cbx" class:on={wrap}></span>wrap
      </label>
      {#if selFile}<span class="meta mono">+{selFile.added} −{selFile.removed}</span>{/if}
      {@render maxBtn(3)}
    </div>
    <div class="body">
      {#if sel && file && settings}
        <Diff bind:this={diffRef} wt={sel} path={file} {base} tick={diffTick} line={pendingLine}
              collapse={{ margin: settings.collapseMargin, minSize: settings.collapseMinSize }}
              single={explore && !(selFile && showDiff)}
              {split} onsplit={(s) => { split = s; saveLayout(); }} {wrap}
              onstate={(d) => (diffDirty = d)}
              onconflict={conflictBanner}
              onerror={errBanner}
              oncopy={showToast}
              onsaved={loadFiles} />
      {:else}
        <div class="empty">select a file</div>
      {/if}
    </div>
  </div>
  {/if}
  <div class="ctx" popover="manual" bind:this={menuEl}
       ontoggle={(e) => e.newState === "closed" && closeMenu()}>
    {#each menu?.items ?? [] as it, i (i)}
      {#if it === "-"}
        <hr>
      {:else}
        <button class:dg={it.danger} onclick={(e) => runItem(it, e)}>{it.label}{#if it.kbd}<kbd>{it.kbd}</kbd>{/if}</button>
      {/if}
    {/each}
  </div>
  {#if toast}
    <div class="toast" onclick={() => (toast = "")} role="presentation">
      copied <span class="mono">{toast}</span> to clipboard
    </div>
  {/if}
</div>

<Palette items={paletteItems} bind:open={paletteOpen} />

<dialog class="settings" bind:this={dlg}>
  <div class="shead"><b>Settings</b><span class="sp"></span>
    <button class="btn" onclick={() => dlg.close()}>close</button></div>

  <div class="sec">theme</div>
  <div class="row">
    <label for="theme-sel">theme</label>
    <select id="theme-sel" class="theme" value={theme} disabled={busy.theme}
            onchange={(e) => applyTheme(e.target.value)}>
      <option value="default">default</option>
      {#each themes as t (t)}<option value={t}>{t}</option>{/each}
    </select>
    <button class="btn" disabled={busy.theme} onclick={() => fileEl.click()}>
      {busy.theme ? "applying…" : "import…"}</button>
    <input type="file" accept=".json,.jsonc" hidden bind:this={fileEl} onchange={importTheme}>
  </div>
  {#if vsThemes.length}
    <div class="row">
      <label for="vs-sel">installed</label>
      <select id="vs-sel" class="theme" value="" disabled={busy.theme} onchange={importVsTheme}>
        <option value="">pick a VS Code theme…</option>
        {#each vsThemes as t (t.path)}<option value={t.path}>{t.name}</option>{/each}
      </select>
    </div>
  {/if}
  <div class="hint">import any VS Code color theme JSON, or one VS Code already has</div>

  <div class="sec">preferences</div>
  {#each Object.entries(settings ?? {}) as [k, v] (k)}
    {#if typeof v === "number" || typeof v === "string"}
      <div class="row">
        <label for="set-{k}">{k}</label>
        {#if typeof v === "number"}
          <input id="set-{k}" type="number" min="0" bind:value={settings[k]} onchange={saveSettings}>
        {:else}
          <input id="set-{k}" type="text" bind:value={settings[k]} onchange={saveSettings}>
        {/if}
        {#if k === "port" || k === "root" || k === "host"}<span class="hint">restart</span>{/if}
      </div>
    {/if}
  {/each}

  <div class="sec">launchers</div>
  {#each Object.entries(settings?.launchers ?? {}) as [repo] (repo)}
    <div class="row">
      <label for="l-{repo}">{repo}</label>
      <input id="l-{repo}" class="wide mono" type="text"
             bind:value={settings.launchers[repo]} onchange={saveSettings}>
    </div>
  {/each}
  <div class="row">
    <input class="lname" list="repo-names" placeholder="repo name, or *"
           bind:value={newRepo} onkeydown={(e) => e.key === "Enter" && addLauncher()}>
    <datalist id="repo-names">
      {#each repos as r (r.name)}<option value={r.name}></option>{/each}
    </datalist>
    <button class="btn" disabled={!newRepo.trim()} onclick={addLauncher}>add</button>
  </div>
  <div class="hint">
    shell command run in the repo to make a worktree, instead of plain
    <span class="mono">git worktree add</span>. <span class="mono">*</span> covers
    any repo without its own entry; empty removes it.
  </div>
  <div class="hint mono">{"{slug} {repo} {path} {root}"}</div>
</dialog>

<style>
.gear {
  background: none;
  border: none;
  color: var(--dim);
  font-size: 0.875rem;
  line-height: 1;
  padding: 0.125rem;
  cursor: pointer;
}
.gear:hover {
  color: var(--acc);
}
dialog.settings {
  margin: auto;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--bg2);
  color: var(--fg);
  padding: 0 0 0.875rem;
  width: min(27.5rem, 92vw);
  font: 0.75rem var(--sans);
}
dialog.settings::backdrop {
  background: color-mix(in srgb, var(--bg) 65%, transparent);
}
.shead {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2.125rem;
  padding: 0 0.75rem;
  border-bottom: 1px solid var(--line);
  margin-bottom: 0.25rem;
}
.sec {
  padding: 0.75rem 0.75rem 0.25rem;
  font-size: 0.65625rem;
  text-transform: uppercase;
  letter-spacing: .09em;
  color: var(--dim);
}
.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.1875rem 0.75rem;
}
.row label {
  width: 8.125rem;
  color: var(--dim);
  font: 0.6875rem var(--mono);
}
.row input {
  background: var(--input);
  border: 1px solid var(--line);
  border-radius: 0.25rem;
  color: var(--fg);
  font: 0.6875rem var(--mono);
  padding: 0.125rem 0.375rem;
  width: 5.75rem;
  outline: none;
}
.row input:focus {
  border-color: var(--acc);
}
.row input.wide {
  width: 100%;
}
.row input.lname {
  width: 8.125rem;
}
.row input.mono,
.hint.mono,
.hint .mono {
  font: 0.6875rem var(--mono);
}
.btn:disabled {
  opacity: .4;
  cursor: default;
}
.hint {
  padding: 0.125rem 0.75rem;
  color: var(--dimmer);
  font-size: 0.6875rem;
}
.row .hint {
  padding: 0;
}
.toast {
  position: fixed;
  bottom: 0.75rem;
  right: 0.75rem;
  z-index: 20;
  max-width: 60vw;
  padding: 0.4375rem 0.6875rem;
  border: 1px solid var(--line);
  border-radius: 0.375rem;
  background: var(--bg2);
  color: var(--fg);
  font-size: 0.75rem;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.tbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  height: 2.125rem;
  padding: 0 0.75rem;
  background: var(--bg2);
  border-bottom: 1px solid var(--line);
  flex: none;
}
.app.desktop .tbar {
  padding-left: 82px;
  min-height: 34px;
}
.tbar .mark {
  flex: none;
}
.tbar .path {
  color: var(--dimmer);
  font: 0.6875rem var(--mono);
}
.sp {
  flex: 1;
}

.band {
  display: flex;
  flex-direction: column;
  min-height: 1.625rem;
  overflow: hidden;
  flex: 0 1 auto;
}
.band.grow {
  flex: 1;
}
.bhead {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 1.625rem;
  padding: 0 0.625rem;
  flex: none;
  background: var(--bg2);
  border-bottom: 1px solid var(--line);
  font-size: 0.65625rem;
  text-transform: uppercase;
  letter-spacing: .09em;
  color: var(--dim);
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
.bhead.selbar {
  background: color-mix(in srgb, var(--acc) 12%, var(--bg2));
  border-bottom-color: color-mix(in srgb, var(--acc) 30%, var(--line));
}
.bhead.selbar.confirm {
  background: color-mix(in srgb, var(--danger) 14%, var(--bg2));
  border-bottom-color: color-mix(in srgb, var(--danger) 35%, var(--line));
}
.bhead .names {
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.bhead b {
  color: var(--fg);
  font-weight: 600;
  letter-spacing: .09em;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: none;
}
.bhead .meta {
  color: var(--dimmer);
  text-transform: none;
  letter-spacing: 0;
}
.bhead .mono {
  font: 0.6875rem var(--mono);
}
.bhead .wraplbl {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-right: 1rem;
  cursor: pointer;
}
.cbxin {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.cbxin:focus-visible + .cbx {
  outline: 1px solid var(--acc);
  outline-offset: 1px;
}
.body {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.gutter {
  height: 0.3125rem;
  flex: none;
  background: var(--line);
  cursor: row-resize;
}
.gutter:hover {
  background: var(--acc);
}

.seg {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 0.25rem;
  overflow: hidden;
}
.seg button {
  background: var(--bg3);
  color: var(--dim);
  border: 0;
  font: 0.625rem var(--sans);
  letter-spacing: .05em;
  padding: 0.125rem 0.5rem;
  cursor: pointer;
  text-transform: uppercase;
}
.seg button + button {
  border-left: 1px solid var(--line);
}
.seg button.on {
  background: var(--hl);
  color: var(--acc);
}
.btn {
  background: var(--bg3);
  border: 1px solid var(--line);
  color: var(--dim);
  border-radius: 0.25rem;
  font: 0.625rem var(--sans);
  letter-spacing: .05em;
  padding: 0.125rem 0.5rem;
  cursor: pointer;
  text-transform: uppercase;
}
.btn:hover {
  color: var(--fg);
  border-color: var(--dimmer);
}
.btn.max {
  flex: none;
  padding: 0 0.375rem;
}
.btn.on {
  color: var(--acc);
}
.btn.dg {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
}
.btn.dg:hover {
  color: var(--danger);
  border-color: var(--danger);
}
input.filter {
  background: var(--input);
  border: 1px solid var(--line);
  border-radius: 0.25rem;
  color: var(--fg);
  font: 0.6875rem var(--sans);
  padding: 0.125rem 0.5rem;
  width: 9.375rem;
  outline: none;
}
input.filter.open {
  flex: 1;
  font-family: var(--mono);
}
.bhead .pth {
  background: none;
  border: 1px solid transparent;
  border-radius: 0.25rem;
  font: inherit;
  padding: 0.125rem 0.375rem;
  cursor: text;
}
.bhead .pth:hover {
  border-color: var(--line);
}
input.filter:focus {
  border-color: var(--acc);
}
select.theme {
  background: var(--input);
  border: 1px solid var(--line);
  border-radius: 0.25rem;
  color: var(--fg);
  font: 0.6875rem var(--sans);
  padding: 0.0625rem 0.25rem;
  outline: none;
  max-width: 10rem;
}

.repo {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.1875rem 0.625rem;
  cursor: pointer;
  color: var(--dim);
  font-size: 0.75rem;
  user-select: none;
}
.repo:hover {
  background: var(--bg2);
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
.wt {
  display: grid;
  grid-template-columns:
    0.75rem 1fr 5rem minmax(5.25rem, auto) 4.625rem 3.875rem 2.875rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0.1875rem 0.625rem 0.1875rem 0.5rem;
  cursor: pointer;
  font-size: 0.75rem;
  border-left: 2px solid transparent;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 40%, transparent);
}
.wt:last-child {
  border-bottom: none;
}
.wt:nth-child(even) {
  background: color-mix(in srgb, var(--bg3) 45%, var(--bg));
}
.wt:hover {
  background: var(--bg2);
}
.wt.sel {
  background: var(--hl);
  border-left-color: var(--acc);
}
.wt .br {
  font-family: var(--mono);
  font-size: 0.71875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wt.sel .br {
  color: var(--hlfg);
}
.repo.st {
  cursor: default;
  padding-left: 1.1875rem;
}
.repo.st:hover {
  background: none;
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
.prc,
.ports {
  display: flex;
  justify-content: center;
  gap: 0.25rem;
}
.port {
  font: 0.625rem var(--mono);
  color: var(--acc);
  border: 1px solid var(--dimmer);
  border-radius: 0.1875rem;
  padding: 0 0.25rem;
  text-decoration: none;
}
.port:hover {
  border-color: var(--acc);
  text-decoration: underline;
}
.pr {
  border-color: transparent;
  color: var(--bg);
  background: var(--acc);
}
.am-icon {
  fill: currentColor;
  vertical-align: -1px;
  margin-left: 0.125rem;
}
.prt {
  font: 0.625rem var(--mono);
  white-space: nowrap;
}
.prt.pending {
  color: var(--warn);
}
.prt.fail {
  color: var(--danger);
}
.prt.approved {
  color: var(--acc);
}
.prt.open {
  color: var(--dim);
}
.prt.merged {
  color: var(--merged);
}
.prt.closed {
  color: var(--dim);
}
.pr.draft {
  border-color: var(--acc);
  color: var(--acc);
  background: transparent;
}
.pr.pending {
  background: var(--warn);
}
.pr.fail {
  background: var(--danger);
}
.pr.merged {
  border-color: transparent;
  color: var(--bg);
  background: var(--merged);
}
.pr.closed {
  border-color: transparent;
  color: var(--bg);
  background: var(--dim);
}
.pr:hover {
  border-color: transparent;
  filter: brightness(1.15);
  text-decoration: underline;
}
.pr.draft:hover {
  border-color: var(--acc);
  filter: none;
}
.wt .dirty {
  font: 0.6875rem var(--mono);
  color: var(--warn);
  text-align: right;
}
.wt .dirty.zero {
  color: var(--dimmer);
}
.wt .ab {
  font: 0.6875rem var(--mono);
  color: var(--dim);
  text-align: right;
}
.wt .ab.behind {
  color: var(--warn);
}
.wt .ago {
  font: 0.6875rem var(--mono);
  color: var(--dimmer);
  text-align: right;
}
@keyframes flash {
  0% {
    background: color-mix(in srgb, var(--acc) 22%, var(--bg));
  }
  100% {
    background: transparent;
  }
}
.wt.touch {
  animation: flash 1.4s ease-out;
}

.f {
  display: grid;
  grid-template-columns: 0.875rem 1rem 1fr auto 5.75rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.625rem;
  cursor: pointer;
  font: 0.75rem var(--mono);
  border-left: 2px solid transparent;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 40%, transparent);
}
.f:last-child {
  border-bottom: none;
}
.f:nth-child(even) {
  background: color-mix(in srgb, var(--bg3) 45%, var(--bg));
}
.f:hover {
  background: var(--bg2);
}
.f.sel {
  background: var(--hl);
  border-left-color: var(--acc);
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
  white-space: nowrap;
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
.n .pl {
  color: var(--addfg);
}
.n .mi {
  color: var(--delfg);
  margin-left: 0.375rem;
}

.empty {
  color: var(--dimmer);
  padding: 1.5rem;
  text-align: center;
  font: 0.75rem var(--sans);
}

.boot {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.6rem;
  color: var(--dim);
  font: 0.75rem var(--sans);
}

.boot .spin {
  width: 0.7rem;
  height: 0.7rem;
  border: 2px solid var(--dimmer);
  border-top-color: var(--acc);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .boot .spin {
    animation: none;
  }
}

.sechd {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.1875rem 0.625rem;
  font: 0.625rem var(--sans);
  text-transform: uppercase;
  letter-spacing: .09em;
  color: var(--dim);
  background: var(--bg3);
  border-block: 1px solid var(--line);
}
.sechd .sp {
  flex: 1;
}
.sechd button {
  background: none;
  border: 0;
  color: var(--dim);
  font: 0.625rem var(--sans);
  text-transform: uppercase;
  letter-spacing: .05em;
  cursor: pointer;
}
.sechd button:hover {
  color: var(--fg);
}
.cbx {
  width: 0.6875rem;
  height: 0.6875rem;
  border: 1px solid var(--dimmer);
  border-radius: 0.125rem;
  cursor: pointer;
  position: relative;
  justify-self: center;
}
.cbx.on {
  background: var(--acc);
  border-color: var(--acc);
}
.cbx.some {
  border-color: var(--acc);
}
.cbx.some::after {
  content: "";
  position: absolute;
  inset: 0.1875rem 0.0625rem;
  border-top: 0.125rem solid var(--acc);
}
.bhead .cbx {
  flex: none;
}
.cbx.on::after {
  content: "";
  position: absolute;
  left: 0.1875rem;
  top: 0;
  width: 0.1875rem;
  height: 0.4375rem;
  border: solid var(--bg);
  border-width: 0 0.1rem 0.1rem 0;
  transform: rotate(42deg);
}
.acts {
  display: flex;
  gap: 0.1875rem;
  justify-content: flex-end;
}
.acts button {
  font: 0.625rem var(--sans);
  color: var(--dim);
  cursor: pointer;
  padding: 0 0.25rem;
  border: 1px solid var(--line);
  border-radius: 0.1875rem;
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
  padding: 0.4375rem 0.75rem;
  font-size: 0.75rem;
  flex: none;
  border-bottom: 1px solid var(--line);
}
.banner .sp {
  flex: 1;
}
.banner.err {
  background: color-mix(in srgb, var(--danger) 14%, var(--bg));
  color: color-mix(in srgb, var(--danger) 65%, var(--fg));
  border-bottom-color: color-mix(in srgb, var(--danger) 35%, var(--bg));
}
.banner.warn {
  background: color-mix(in srgb, var(--warn) 14%, var(--bg));
  color: color-mix(in srgb, var(--warn) 65%, var(--fg));
  border-bottom-color: color-mix(in srgb, var(--warn) 35%, var(--bg));
}
.btn.p {
  color: var(--acc);
  border-color: var(--acc);
}
.unsaved {
  color: var(--warn);
  text-transform: none;
  letter-spacing: 0;
  font: 0.6875rem var(--mono);
}
.repo .plus {
  visibility: hidden;
}
.repo:hover .plus,
.repo:focus-within .plus {
  visibility: visible;
}
.ctx {
  position: fixed;
  margin: 0;
  inset: auto;
  padding: 0.1875rem;
  min-width: 11rem;
  background: var(--bg2);
  border: 1px solid var(--line);
  border-radius: 0.3125rem;
  box-shadow: 0 0.5rem 1.5rem color-mix(in srgb, var(--bg) 70%, transparent);
}
.ctx button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--fg);
  font: 0.75rem var(--sans);
  padding: 0.25rem 0.625rem;
  border-radius: 0.1875rem;
  cursor: pointer;
  white-space: nowrap;
}
.ctx kbd {
  float: right;
  margin-left: 1.5rem;
  color: var(--dimmer);
  font: 0.6875rem var(--mono);
}
.ctx button:hover {
  background: var(--hl);
  color: var(--hlfg);
}
.ctx button.dg {
  color: var(--danger);
}
.ctx button.dg:hover {
  background: color-mix(in srgb, var(--danger) 22%, var(--bg2));
  color: var(--danger);
}
.ctx hr {
  border: none;
  border-top: 1px solid var(--line);
  margin: 0.1875rem 0.3125rem;
}
.newwt {
  display: flex;
  gap: 0.375rem;
  padding: 0.1875rem 0.625rem 0.1875rem 1.75rem;
}
</style>
