<script>
import { tick, untrack } from "svelte";
import FilterInput from "./FilterInput.svelte";
import Icon from "./Icon.svelte";
import { matchPath, pathText, rank } from "./filter.js";
import {
  ancestorDirs,
  commonPrefix,
  discardPrompt,
  isIgnoredPath,
  relWt,
  splitPath,
  TREE_CAP,
  treeRows,
} from "../parse.ts";
import { ICON } from "./icons.js";
import { prefs, toggleMax } from "./prefs.svelte.js";
import { copy, post, renameField, scrollRow } from "./ui.svelte.js";
import { menuKey, openMenu } from "./menu.svelte.js";
import { repoOf } from "./rows.svelte.js";
import {
  confirmDiscard,
  discardArm,
  dropPath,
  fileItems,
  land,
  loadOpenDirs,
  nav,
  op,
  openPath,
  pick,
  renameKey,
  reveal,
  setBase,
  toggleDir,
} from "./nav.svelte.js";

let { kbdOf } = $props();

let openEl = $state();
let editingPath = $state(false);
let completions = $state([]);
let completeHi = $state(-1);
let growEl = $state();
/** The inline new-entry row: the folder it sits in, its text, a refusal. */
let drafting = $state(null);
let fileFilterEl = $state();

$effect(() => {
  void nav.sel;
  drafting = null;
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

export async function editPath() {
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

export function focusFilter() {
  fileFilterEl?.select();
}
</script>

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
  <button class="btn max" class:on={prefs.max === 2} title={prefs.max === 2 ? "Restore panes" : "Full screen"}
          aria-label={prefs.max === 2 ? "Restore panes" : "Full screen"}
          onclick={() => toggleMax(2)}><Icon d={prefs.max === 2 ? ICON.min : ICON.max} /></button>
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
  {#snippet loadingRow()}<div class="empty late"><span class="spin"></span> Loading…</div>{/snippet}
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

<style>
input.filter.open {
  flex: 1;
  font-family: var(--mono);
  anchor-name: --open-box;
  border-radius: 0.75rem;
  transition: border-radius 0.12s;
}
input.filter.open.grown {
  border-radius: 0.75rem 0.75rem 0 0;
  border-bottom-color: var(--line);
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
.bhead:not(.selbar) {
  flex-wrap: wrap;
  height: auto;
  min-height: var(--head);
  padding-block: 0.375rem;
  row-gap: 0.375rem;
}
.bhead:not(.selbar) > b {
  flex: none;
}
.bhead .seg {
  min-width: 0;
}
.bhead .seg button {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bhead .pth:hover {
  border-color: var(--line);
}

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
</style>
