<script>
import Source from "./Source.svelte";
import FilterInput from "./FilterInput.svelte";
import Hex from "./Hex.svelte";
import Icon from "./Icon.svelte";
import { fmtCount, fmtSize, rawUrl } from "../parse.ts";
import { ICON } from "./icons.js";
import { marked } from "marked";
import { prefs, saveLayout, toggleMax } from "./prefs.svelte.js";
import { ago, errBanner, renameField, showToast, ui } from "./ui.svelte.js";
import { openMenu } from "./menu.svelte.js";
import {
  fileItems,
  loadFiles,
  nav,
  renameKey,
  startRename,
} from "./nav.svelte.js";
import { kbdOf } from "./commands.svelte.js";

const MODE_LABEL = { text: "Text", preview: "Preview", hex: "Hex" };

let showDiff = $state(false);
let previewSrc = $state("");
let previewReady = $state(false);
let srcBodyEl = $state();
let rawView = null;
let lq = $state("");
let findEl = $state();
let found = $state({ i: 0, n: 0 });
let diffRef = $state();
let srcInfo = $state(null);
let diskAt = $state(0); // when the open file last changed on disk

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

export function focusFind() {
  findEl?.select();
}

export function cycleMode() {
  const l = nav.modeList;
  setMode(l[(l.indexOf(nav.mode) + 1) % l.length]);
}

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
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="bhead"
  oncontextmenu={(e) => nav.file && openMenu(e, fileItems({ path: nav.file }))}>
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
  <button class="btn max" class:on={prefs.max === 3} title={prefs.max === 3 ? "Restore panes" : "Full screen"}
          aria-label={prefs.max === 3 ? "Restore panes" : "Full screen"}
          onclick={() => toggleMax(3)}><Icon d={prefs.max === 3 ? ICON.min : ICON.max} /></button>
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
    {#if !previewReady}<div class="empty late"><span class="spin"></span> Loading…</div>{/if}
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
    <div class="empty late"><span class="spin"></span> Loading…</div>
  {:else}
    <div class="empty">Select a file</div>
  {/if}
</div>

<style>
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
.body {
  margin: 0 0.5rem 0.5rem;
  padding: 0;
  background: var(--bg);
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 0.625rem;
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
.unsaved {
  font: 0.6875rem var(--mono);
}
</style>
