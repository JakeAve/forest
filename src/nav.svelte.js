import { ancestorDirs } from "../parse.ts";
import { MODES, prefs } from "./prefs.svelte.js";
import { act, copy, errBanner, scrollRow, ui } from "./ui.svelte.js";
import { rows } from "./rows.svelte.js";

const initialParams = new URLSearchParams(location.search);

class Nav {
  sel = $state(null);
  file = $state(null);
  selDir = $state(null);
  loose = $state(false);
  explore = $state(false);
  base = $state("branch");
  pendingLine = $state(0);
  files = $state([]);
  filesOf = $state(null);
  tree = $state([]);
  treeDirs = $state([]);
  treeIgnored = $state([]);
  loadedDirs = $state({});
  treeOf = $state(null);
  openDirs = $state({});
  fresh = $state({}); // rel path -> when it last changed on disk, for the row flash
  diffTick = $state(0);
  fq = $state("");
  diffDirty = $state(false);
  srcBinary = $state(false);
  renaming = $state(null);
  headRename = $state(false);
  discarding = $state(null);
  restoring = $state(initialParams.has("path") || initialParams.has("wt"));
  selWt = $derived(rows.allWts.find((w) => w.path === this.sel));
  selFile = $derived(this.files.find((f) => f.path === this.file));
  isHtml = $derived(/\.html?$/i.test(this.file ?? ""));
  isMd = $derived(/\.(md|markdown)$/i.test(this.file ?? ""));
  isSvg = $derived(/\.svg$/i.test(this.file ?? ""));
  mediaType = $derived(
    /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i.test(this.file ?? "")
      ? "img"
      : /\.(mp4|webm|mov|m4v|ogv)$/i.test(this.file ?? "")
      ? "video"
      : /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(this.file ?? "")
      ? "audio"
      : /\.pdf$/i.test(this.file ?? "")
      ? "pdf"
      : null,
  );
  kind = $derived(
    this.mediaType
      ? "media"
      : this.isHtml || this.isMd || this.isSvg
      ? "markup"
      : "text",
  );
  mode = $derived(prefs.modes[this.kind]);
  modeList = $derived(
    this.kind === "text" && this.srcBinary ? ["hex"] : MODES[this.kind],
  );
}
export const nav = new Nav();

let restored = false;
let markBooted;
const booted = new Promise((r) => (markBooted = r));

export function onFs({ wt, paths }) {
  if (wt !== nav.sel) return;
  nav.fresh = Object.fromEntries(paths.map((p) => [p, Date.now()]));
  if (nav.explore) loadTree();
  else loadFiles();
  if (nav.file && paths.includes(nav.file)) nav.diffTick++;
}

export function onReady() {
  markBooted();
  if (nav.loose && nav.sel) {
    fetch(`/api/open?path=${encodeURIComponent(nav.sel)}`);
  }
}

/** Takes what `applyRows` returned. */
export function onRows(prev) {
  if (!restored) {
    restored = true;
    restoreUrl();
  }
  const { sel } = nav;
  if (sel && !nav.loose && !rows.allWts.some((w) => w.path === sel)) {
    nav.sel = null;
    nav.file = null;
    nav.files = [];
  } else if (sel && rows.touched[sel] && prev.get(sel) !== undefined) {
    loadFiles();
    if (nav.explore) loadTree();
    nav.diffTick++;
  }
}

async function restoreUrl() {
  const line = Math.max(0, Math.floor(Number(initialParams.get("line")) || 0));
  const path = initialParams.get("path");
  if (path) {
    try {
      await booted;
      await openPath(path);
      const f = initialParams.get("file");
      if (f && nav.loose) {
        nav.file = f;
        reveal(f);
        nav.pendingLine = line;
        scrollRow(f);
      }
    } finally {
      nav.restoring = false;
    }
    return;
  }
  nav.restoring = false;
  const wt = initialParams.get("wt");
  if (!wt || !rows.allWts.some((w) => w.path === wt)) return;
  nav.base = initialParams.get("base") === "head" ? "head" : "branch";
  nav.explore = initialParams.get("tree") === "1";
  nav.sel = wt;
  nav.file = initialParams.get("file") || null;
  if (nav.explore) {
    reveal(nav.file);
    loadTree().then(() => scrollRow(nav.file));
  }
  nav.pendingLine = line;
  loadFiles();
}

export function urlQuery() {
  const q = new URLSearchParams();
  const { sel, file, pendingLine } = nav;
  if (sel && nav.loose) {
    q.set("path", sel);
    if (file) q.set("file", file);
    if (pendingLine) q.set("line", pendingLine);
  } else if (sel) {
    q.set("wt", sel);
    if (file) q.set("file", file);
    q.set("base", nav.base);
    if (nav.explore) q.set("tree", "1");
    if (pendingLine) q.set("line", pendingLine);
  }
  return q;
}

export async function loadFiles() {
  const wt = nav.sel;
  if (nav.loose) {
    nav.files = [];
    nav.filesOf = wt;
    return;
  }
  const res = await fetch(
    `/api/files?wt=${encodeURIComponent(wt)}&base=${nav.base}`,
  );
  const data = await res.json();
  if (nav.sel !== wt) return;
  nav.files = data.files;
  nav.filesOf = wt;
  if (!nav.explore && !nav.files.some((f) => f.path === nav.file)) {
    nav.file = nav.files[0]?.path ?? null;
  }
}

export async function loadTree() {
  const wt = nav.sel;
  const t = await (await fetch(`/api/tree?wt=${encodeURIComponent(wt)}`))
    .json();
  if (nav.sel !== wt) return;
  nav.tree = t.files;
  nav.treeDirs = t.dirs;
  nav.treeIgnored = t.ignored;
  nav.loadedDirs = {};
  nav.treeOf = wt;
  await loadOpenDirs();
}

export async function loadOpenDirs() {
  for (;;) {
    const todo = nav.treeDirs.filter((d) =>
      nav.openDirs[d] && !nav.loadedDirs[d]
    );
    if (!todo.length) return;
    await Promise.all(todo.map(loadDir));
  }
}

async function loadDir(dir) {
  const wt = nav.sel;
  nav.loadedDirs[dir] = true;
  const q = `wt=${encodeURIComponent(wt)}&dir=${encodeURIComponent(dir)}`;
  const t = await (await fetch(`/api/tree?${q}`)).json().catch(() => ({}));
  if (nav.sel !== wt || !t.files) return;
  nav.tree = [...new Set([...nav.tree, ...t.files])];
  nav.treeDirs = [...new Set([...nav.treeDirs, ...t.dirs])];
}

export function reveal(path) {
  for (const d of ancestorDirs(path ? [path] : [])) nav.openDirs[d] = true;
}

export async function openPath(text) {
  const from = nav.sel ? `&from=${encodeURIComponent(nav.sel)}` : "";
  const res = await fetch(`/api/open?path=${encodeURIComponent(text)}${from}`);
  if (!res.ok) {
    errBanner(await res.text());
    return false;
  }
  if (ui.banner?.kind === "bad") ui.banner = null;
  await openAt(await res.json());
  return true;
}

function clearTree() {
  nav.selDir = null;
  nav.tree = [];
  nav.treeDirs = [];
  nav.treeIgnored = [];
  nav.loadedDirs = {};
  nav.treeOf = null;
  nav.openDirs = {};
}

export async function openAt(r) {
  const same = nav.sel === r.wt;
  nav.loose = r.loose;
  nav.explore = true;
  if (!same) clearTree();
  nav.sel = r.wt;
  if (r.kind === "file") {
    nav.file = r.rel;
    nav.pendingLine = r.line;
    reveal(r.rel);
  } else {
    if (r.rel) {
      reveal(r.rel);
      nav.openDirs[r.rel] = true;
    }
    if (!same) {
      nav.file = null;
      nav.pendingLine = 0;
    }
  }
  loadFiles();
  await loadTree();
  if (r.rel) await scrollRow(r.rel);
}

export function selectWt(path) {
  nav.loose = false;
  nav.pendingLine = 0;
  nav.sel = path;
  nav.file = null;
  clearTree();
  loadFiles();
  if (nav.explore) loadTree();
}

export function pick(f) {
  nav.pendingLine = 0;
  nav.selDir = null;
  nav.file = f.path;
  if (nav.explore) reveal(f.path);
}

export function toggleDir(path) {
  nav.selDir = path;
  if (nav.openDirs[path]) return delete nav.openDirs[path];
  nav.openDirs[path] = true;
  if (nav.treeDirs.includes(path) && !nav.loadedDirs[path]) loadOpenDirs();
}

export function setBase(b) {
  if (b === "all") {
    if (nav.explore) return;
    nav.explore = true;
    if (nav.sel) loadTree().then(() => scrollRow(nav.file));
    return;
  }
  if (nav.base === b && !nav.explore) return;
  nav.explore = false;
  nav.pendingLine = 0;
  nav.base = b;
  if (nav.sel) loadFiles();
}

export function startRename(f, e, head = false) {
  e?.stopPropagation();
  const { file } = nav;
  if (nav.diffDirty && (file === f.path || file?.startsWith(f.path + "/"))) {
    return errBanner("Unsaved edits — save or undo them before renaming.");
  }
  if (head) nav.headRename = true;
  else nav.renaming = f.path;
}

export async function renameKey(e, from, base = from.replace(/[^/]*$/, "")) {
  e.stopPropagation();
  if (e.key === "Escape") return (nav.renaming = nav.headRename = null);
  if (e.key !== "Enter") return;
  const name = e.target.value.replace(/^\/+/, "");
  const to = base + name;
  nav.renaming = nav.headRename = null;
  if (!name.trim() || to === from) return;
  const dir = nav.treeDirs.includes(from) ||
    nav.tree.some((q) => q.startsWith(from + "/"));
  if (!await act("rename", { wt: nav.sel, from, to }, "rename")) return;
  dropPath(from);
  if (nav.explore) await loadTree();
  land(to, dir);
}

export function land(path, dir) {
  if (dir) {
    // ponytail: git can't list an empty dir, so it shows only until the next
    // tree load; it sticks once a file lands in it
    nav.treeDirs = [...new Set([...nav.treeDirs, path])];
    reveal(path);
    nav.openDirs[path] = true;
    nav.selDir = path;
  } else {
    nav.tree = [...new Set([...nav.tree, path])];
    pick({ path });
  }
  scrollRow(path);
  loadFiles();
}

export function dropPath(p) {
  const gone = (q) => q === p || q.startsWith(p + "/");
  nav.tree = nav.tree.filter((q) => !gone(q));
  nav.treeDirs = nav.treeDirs.filter((q) => !gone(q));
  if (nav.file && gone(nav.file)) nav.file = null;
  if (nav.selDir && gone(nav.selDir)) nav.selDir = null;
}

export async function op(ep, body, e) {
  await act(ep, { wt: nav.sel, ...body }, ep, e);
  loadFiles();
  nav.diffTick++;
}

export function discardArm(f, e) {
  e?.stopPropagation();
  nav.discarding = f;
}

export async function confirmDiscard() {
  const f = nav.discarding;
  nav.discarding = null;
  if (!f.del) {
    return op("discard", { path: f.path, untracked: f.status === "U" });
  }
  dropPath(f.path);
  const ok = await act("delete", { wt: nav.sel, path: f.path }, "delete");
  if (!ok && nav.explore) loadTree();
  loadFiles();
}

export function fileItems(f, mode) {
  const { sel, file, selDir } = nav;
  const dir = f.dir ? f.path : f.path.split("/").slice(0, -1).join("/");
  const cur = selDir ? selDir === f.path : file === f.path;
  return [
    {
      label: "Open terminal here",
      cmd: cur && "open-terminal",
      fn: (e) =>
        act(
          "terminal",
          { wt: sel, path: dir || undefined },
          "term:" + sel,
          e,
        ),
    },
    {
      label: "Reveal in Finder",
      cmd: cur && "reveal",
      fn: (e) => act("reveal", { wt: sel, path: f.path }, "reveal:" + sel, e),
    },
    "-",
    {
      label: "Copy path (relative)",
      cmd: file === f.path && "copy-path",
      fn: (e) => copy(e, f.path, f.path + ":r"),
    },
    {
      label: "Copy path (absolute)",
      cmd: file === f.path && "copy-path-abs",
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
    "-",
    { label: "Rename", fn: (e) => startRename(f, e) },
    {
      label: "Move to Trash",
      cmd: cur && "trash",
      danger: true,
      fn: (e) => discardArm({ path: f.path, del: true }, e),
    },
  ];
}
