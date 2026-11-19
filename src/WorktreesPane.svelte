<script>
import FilterInput from "./FilterInput.svelte";
import Icon from "./Icon.svelte";
import WtRow from "./WtRow.svelte";
import { bucketSummary, colsMin, colTemplate } from "../parse.ts";
import { ICON } from "./icons.js";
import {
  COLUMNS,
  moveCol,
  prefs,
  resetWidths,
  saveLayout,
  toggleCol,
  toggleMax,
} from "./prefs.svelte.js";
import { copy, ui } from "./ui.svelte.js";
import { menuKey, openMenu } from "./menu.svelte.js";
import {
  createWt,
  isOpen,
  match,
  removeWts,
  repoOf,
  rows,
  toggleAllShown,
  toggleRepo,
} from "./rows.svelte.js";
import { allItems, repoItems } from "./wtActions.js";

let { kbdOf } = $props();

let wtFilterEl = $state();

export function focusFilter() {
  wtFilterEl?.select();
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
  const cells = [
    ...colsEl.closest(".band").querySelectorAll(`[data-col="${key}"]`),
  ];
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
</script>

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
  <button class="btn max" class:on={prefs.max === 1} title={prefs.max === 1 ? "Restore panes" : "Full screen"}
          aria-label={prefs.max === 1 ? "Restore panes" : "Full screen"}
          onclick={() => toggleMax(1)}><Icon d={prefs.max === 1 ? ICON.min : ICON.max} /></button>
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
<div class="body">
  <div class="list" style:min-width={colMin}>
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
  </div>
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
          <WtRow {w} showRepo={!r} {movingCol} />
        {/each}
        {@render inner?.()}
      </div>
    {/if}
  </div>
{/snippet}

<style>
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
.cols > * {
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
.cols > .moving {
  background: color-mix(in srgb, var(--acc) var(--wash), transparent);
  color: var(--dimmer);
}
.cols .end {
  text-align: right;
}
.boot {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.6rem;
  color: var(--dim);
  font: 0.75rem var(--sans);
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
  .bhead:not(.selbar) > span:not(.sp, .cbx) {
    display: none;
  }
}
</style>
