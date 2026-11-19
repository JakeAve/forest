<script>
// DOM contract other code relies on:
// - `.wt[data-path]`: `scrollRow` (ui) finds the row by `data-path`;
//   `focusedWt` (App) matches `.wt, .wt .cbx`.
// - `[data-col]` cells: `clickCell` (ui) clicks
//   `.wt[data-path] [data-col] :is(a, button)`; `fitCol` (WorktreesPane)
//   measures every `[data-col]` in the band.
// - `.cbx`: the row checkbox `focusedWt` matches.
import {
  bucket,
  colTemplate,
  dirName,
  prAb,
  prStatus,
  renamed,
} from "../parse.ts";
import { AC_ICON, AM_ICON, AR_ICON, GLYPH, TICKET_ST } from "./icons.js";
import { prefs } from "./prefs.svelte.js";
import { ago } from "./ui.svelte.js";
import { menuKey, openCard, openMenu } from "./menu.svelte.js";
import { checkRange, repoOf, rows, toggleCheck } from "./rows.svelte.js";
import { nav, selectWt } from "./nav.svelte.js";
import { badgeTip, full, sessionItems } from "./agents.svelte.js";
import {
  procItems,
  procPreview,
  procTip,
  rowBusy,
  wtItems,
} from "./wtActions.js";

let { w, showRepo, movingCol } = $props();

const colGrid = $derived(
  colTemplate(prefs.visibleCols, prefs.lead, prefs.widths),
);
</script>

{#key rows.touched[w.path]}
  <div class="wt" class:sel={nav.sel === w.path}
  class:touch={rows.touched[w.path]} class:selecting={rows.selecting}
  class:cached={repoOf(w)?.cached}
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

<style>
.wt .c {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wt .moving {
  background: color-mix(in srgb, var(--acc) var(--wash), transparent);
  color: var(--dimmer);
}
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
.wt.touch {
  animation: flash 1.4s ease-out;
}
.wt .cbx {
  visibility: hidden;
  justify-self: start;
}
.wt:hover .cbx,
.wt:focus-within .cbx,
.wt .cbx.on,
.wt.selecting .cbx {
  visibility: visible;
}
</style>
