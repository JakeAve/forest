import { matchWt } from "./filter.js";
import { orderWts, prOffSummary, removeSummary } from "../parse.ts";
import { prefs, saveLayout } from "./prefs.svelte.js";
import { act, errBanner, ui } from "./ui.svelte.js";

class Rows {
  repos = $state([]);
  // boot progress from the server's `status` SSE event; the repo list streams in
  // during the first sweep, so this says what is still coming.
  boot = $state({ phase: "repos", done: 0, total: 0 });
  touched = $state({});
  q = $state("");
  dirtyOnly = $state(false);
  runningOnly = $state(false);
  checked = $state({});
  confirming = $state(null);
  confirmSel = $state(false);
  removing = $state(false);
  creating = $state(null);
  slug = $state("");
  prOff = $derived(prOffSummary(this.repos));
  totalWts = $derived(this.repos.reduce((n, r) => n + r.worktrees.length, 0));
  filtering = $derived(this.q !== "" || this.dirtyOnly || this.runningOnly);
  allWts = $derived(this.repos.flatMap((r) => r.worktrees));
  shownWts = $derived(this.allWts.filter((w) => match(repoOf(w), w)));
  pinnedWts = $derived(this.shownWts.filter((w) => prefs.pinned[w.path]));
  checkedWts = $derived(this.allWts.filter((w) => this.checked[w.path]));
  selecting = $derived(this.checkedWts.length > 0);
  hiddenChecked = $derived(
    this.checkedWts.filter((w) => !match(repoOf(w), w)).length,
  );
  selectable = $derived(this.shownWts.filter((w) => !w.isPrimary));
  allShownChecked = $derived(
    this.selectable.length > 0 &&
      this.selectable.every((w) => this.checked[w.path]),
  );
  someShownChecked = $derived(
    this.selectable.some((w) => this.checked[w.path]),
  );
  recentWts = $derived(
    this.shownWts.filter((w) => !prefs.pinned[w.path])
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, prefs.settings?.recentCount ?? 10),
  );
  allClosed = $derived(isClosed("__all"));
  repoWts = $derived.by(() => {
    const top = new Set(
      [
        ...(isOpen("__pinned") ? this.pinnedWts : []),
        ...(isOpen("__recent") ? this.recentWts : []),
      ].map((w) => w.path),
    );
    return Object.fromEntries(this.repos.map((r) => [
      r.name,
      orderWts(r.worktrees.filter((w) => match(r, w) && !top.has(w.path))),
    ]));
  });
  navWts = $derived([
    ...(isOpen("__pinned") ? this.pinnedWts : []),
    ...(isOpen("__recent") ? this.recentWts : []),
    ...(isOpen("__all")
      ? this.repos.flatMap((r) => isOpen(r.name) ? this.repoWts[r.name] : [])
      : []),
  ]);
}
export const rows = new Rows();

const sig = (w) => `${w.head}:${w.dirty}:${w.lastActivity}`;
export const match = (r, w) =>
  matchWt(
    { q: rows.q, dirtyOnly: rows.dirtyOnly, runningOnly: rows.runningOnly },
    r?.name,
    w,
  );
export const repoOf = (w) => rows.repos.find((r) => r.name === w.repo);
export const isClosed = (k) => prefs.closed[k] ?? k === "__all";
export const isOpen = (k) => rows.filtering || !isClosed(k);

/** Takes an SSE snapshot; returns the previous rows' signatures by path. */
export function applyRows(next) {
  const prev = new Map(rows.allWts.map((w) => [w.path, sig(w)]));
  for (const w of next.flatMap((r) => r.worktrees)) {
    if (prev.size && prev.get(w.path) !== sig(w)) {
      rows.touched[w.path] = Date.now();
    }
  }
  rows.repos = next;
  for (const p of Object.keys(rows.checked)) {
    if (!next.some((r) => r.worktrees.some((w) => w.path === p))) {
      delete rows.checked[p];
    }
  }
  return prev;
}

export function toggleAllShown() {
  const on = !rows.allShownChecked;
  for (const w of rows.selectable) {
    if (on) rows.checked[w.path] = true;
    else delete rows.checked[w.path];
  }
}

let lastToggled = null;
export function toggleCheck(w, e) {
  e.stopPropagation();
  lastToggled = w.path;
  if (rows.checked[w.path]) delete rows.checked[w.path];
  else rows.checked[w.path] = true;
}

export function checkRange(w) {
  const { navWts } = rows;
  const j = navWts.findIndex((x) => x.path === w.path);
  let i = navWts.findIndex((x) => x.path === lastToggled);
  if (i < 0) i = j;
  for (const x of navWts.slice(Math.min(i, j), Math.max(i, j) + 1)) {
    if (!x.isPrimary) rows.checked[x.path] = true;
  }
  lastToggled = w.path;
}

export function toggleAll() {
  toggleRepo("__all");
}

export function toggleRepo(name) {
  if (rows.filtering) return;
  prefs.closed[name] = !isClosed(name);
  saveLayout();
}

export async function removeWts(wts, force) {
  const live = wts.filter((w) => rows.allWts.some((a) => a.path === w.path));
  if (!live.length) return (rows.confirming = null);
  ui.banner = null;
  rows.removing = true;
  const res = await fetch("/api/wt-remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wts: live.map((w) => w.path), force }),
  });
  rows.removing = false;
  rows.confirming = null;
  if (!res.ok) return errBanner(await res.text());
  const { failed } = await res.json();
  const stuck = live.filter((w) => failed.some((f) => f.path === w.path));
  for (const w of live) if (!stuck.includes(w)) delete rows.checked[w.path];
  if (!stuck.length) return;
  ui.banner = {
    kind: "warn",
    text: removeSummary(live.length, stuck.map((w) => w.branch)),
    actions: [
      {
        label: "Force remove",
        primary: true,
        fn: () => removeWts(stuck, true),
      },
      { label: "Dismiss", fn: () => (ui.banner = null) },
    ],
  };
}

export async function createWt(r) {
  const s = rows.slug.trim();
  if (!s) return;
  if (await act("wt-create", { repo: r.name, slug: s }, "new:" + r.name)) {
    rows.creating = null;
    rows.slug = "";
  }
}
