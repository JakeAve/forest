<script>
import SourcePane from "./SourcePane.svelte";
import FilesPane from "./FilesPane.svelte";
import WorktreesPane from "./WorktreesPane.svelte";
import Palette from "./Palette.svelte";
import Shortcuts from "./Shortcuts.svelte";
import Icon from "./Icon.svelte";
import Settings from "./Settings.svelte";
import Menu from "./Menu.svelte";
import Card from "./Card.svelte";
import Notify from "./Notify.svelte";
import { ICON, LAYOUTS } from "./icons.js";
import {
  collapse,
  isX,
  loadLayout,
  loadSettings,
  paneSize,
  prefs,
  resize,
  saveLayout,
  setPreset,
} from "./prefs.svelte.js";
import { applyTheme, loadThemes, ui } from "./ui.svelte.js";
import { applyRows, rows } from "./rows.svelte.js";
import { nav, onFs, onReady, onRows, urlQuery } from "./nav.svelte.js";
import { loadAgents } from "./agents.svelte.js";
import { cmds, kbdOf, loadPalTree, runKey } from "./commands.svelte.js";

loadSettings();
loadLayout().then((t) => t && applyTheme(t, false));

$effect(() => {
  document.documentElement.style.fontSize = prefs.zoom === 1
    ? ""
    : `${prefs.zoom * 100}%`;
});

// Dismissing hides this text; a different failure shows again.
let prOffHidden = $state("");
let b1El = $state(), b2El = $state();
let notify = $state();
loadThemes();
loadAgents();

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

$effect(() => {
  if (cmds.paletteOpen) loadPalTree();
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
    <button class="omni" onclick={() => (cmds.paletteOpen = true)}>
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
  <div class="panes {prefs.preset}" class:max={prefs.max} style:--b1={paneSize(1)} style:--b2={paneSize(2)}>
  <div class="band wts" class:maxed={prefs.max === 1} bind:this={b1El}>
    <WorktreesPane bind:this={ui.refs.wts} />
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="gutter g1" class:x={isX(1)} role="separator" tabindex="0"
       aria-orientation={isX(1) ? "vertical" : "horizontal"}
       onmousedown={(e) => drag(e, 1, b1El)} ondblclick={() => collapse(1)}
       onkeydown={(e) => gutterKey(e, 1, b1El)}></div>

  <div class="band files" class:maxed={prefs.max === 2} bind:this={b2El}>
    <FilesPane bind:this={ui.refs.files} />
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="gutter g2" class:x={isX(2)} role="separator" tabindex="0"
       aria-orientation={isX(2) ? "vertical" : "horizontal"}
       onmousedown={(e) => drag(e, 2, b2El)} ondblclick={() => collapse(2)}
       onkeydown={(e) => gutterKey(e, 2, b2El)}></div>

  <div class="band sourceband" class:maxed={prefs.max === 3}>
    <SourcePane bind:this={ui.refs.source} />
  </div>
  </div>
  {/if}
  <Menu />
  <Card />
</div>

<Palette items={cmds.paletteItems} bind:open={cmds.paletteOpen} />
<Shortcuts bind:open={cmds.shortcutsOpen} />

<Settings bind:this={ui.refs.settings}
  onshortcuts={() => (cmds.shortcutsOpen = true)} />

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
</style>
