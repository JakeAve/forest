<script>
import { untrack } from "svelte";
import { byteChar, byteClass, fmtSize } from "../parse.ts";

let { src, note = "" } = $props();

const COLS = 16;
const CHUNK = 1 << 16;
const OVERSCAN = 20;
// ponytail: past MAX_PX the scrollbar is scaled, so one wheel tick skips rows on huge files
const MAX_PX = 1 << 23;

let el = $state();
let probe = $state();
let size = $state(null);
let chunks = $state({});
let top = $state(0);
let height = $state(0);
let hover = $state(-1);
let pending = new Set();

const rowH = $derived(Math.ceil(probe?.height || 18));
const rows = $derived(size ? Math.ceil(size / COLS) : 0);
const spaceH = $derived(Math.min(rows * rowH, MAX_PX));
const scale = $derived(
  spaceH > height ? (rows * rowH - height) / (spaceH - height) : 1,
);
const at = $derived(top * scale);
const first = $derived(Math.max(0, Math.floor(at / rowH) - OVERSCAN));
const last = $derived(
  Math.min(rows, Math.ceil((at + height) / rowH) + OVERSCAN),
);
const shown = $derived(
  Array.from({ length: last - first }, (_, i) => first + i),
);
const chunkOf = (row) => Math.floor(row * COLS / CHUNK);
const byteAt = (o) => chunks[Math.floor(o / CHUNK)]?.bytes[o % CHUNK];
const hex2 = (b) => b.toString(16).padStart(2, "0");
const cols = (row) => Array.from({ length: COLS }, (_, i) => row * COLS + i);

async function load(i) {
  const at = src;
  const key = `${i}#${at}`;
  if (chunks[i]?.at === at || pending.has(key)) return;
  pending.add(key);
  const r = await fetch(at, {
    headers: { Range: `bytes=${i * CHUNK}-${(i + 1) * CHUNK - 1}` },
  }).catch(() => null);
  const bytes = r?.ok
    ? await r.arrayBuffer().then((b) => new Uint8Array(b), () => null)
    : null;
  pending.delete(key);
  if (at !== src) return;
  if (!bytes) return void (size ??= 0);
  const total = r.headers.get("content-range")?.split("/")[1];
  size = Number(total ?? r.headers.get("content-length") ?? 0);
  chunks[i] = { at, bytes };
}

$effect(() => {
  void src;
  const a = chunkOf(first);
  const b = chunkOf(Math.max(first, last - 1));
  untrack(() => {
    for (let c = a; c <= b; c++) load(c);
  });
});

function over(e) {
  const o = e.target.dataset?.o;
  hover = o === undefined ? -1 : Number(o);
}
</script>

<div class="hexwrap">
  <div class="note">
    {note || (size === null ? "" : fmtSize(size))}{#if size === null}
      <span class="late"><span class="spin"></span> Loading…</span>
    {/if}{#if hover >= 0}
      <span class="at">0x{hover.toString(16)} · {hover}</span>
    {/if}
  </div>
  <div class="row probe" bind:contentRect={probe}>0</div>
  <!-- svelte-ignore a11y_mouse_events_have_key_events -->
  <div class="hex" bind:this={el} bind:clientHeight={height}
    onscroll={() => (top = el.scrollTop)} onmouseover={over}
    onmouseleave={() => (hover = -1)}
    role="presentation">
    <div class="space" style:height="{spaceH}px">
      <div class="rows"
        style:transform="translateY({first * rowH - at + top}px)">
        {#each shown as r (r)}
          <div class="row" style:height="{rowH}px" style:line-height="{rowH}px">
            <span class="off">{(r * COLS).toString(16).padStart(8, "0")}</span>
            <span class="bytes">
              {#each cols(r) as o (o)}
                {@const b = o < size ? byteAt(o) : undefined}
                <span class="b {b === undefined ? '' : byteClass(b)}" class:on={o === hover}
                      data-o={b === undefined ? undefined : o}>{b === undefined ? "  " : hex2(b)}</span>
              {/each}
            </span>
            <span class="ascii">
              {#each cols(r) as o (o)}
                {@const b = o < size ? byteAt(o) : undefined}
                <span class="c {b === undefined ? '' : byteClass(b)}" class:on={o === hover}
                      data-o={b === undefined ? undefined : o}>{b === undefined ? " " : byteChar(b)}</span>
              {/each}
            </span>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
.hexwrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  font: 0.75rem var(--mono);
}
.note {
  display: flex;
  gap: 1rem;
  padding: 0.5rem 1rem;
  color: var(--dimmer);
}
.at {
  color: var(--dim);
}
.hex {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 1rem;
}
.row {
  display: flex;
  gap: 1.5rem;
  white-space: pre;
}
.probe {
  position: absolute;
  visibility: hidden;
  height: 1.5em;
}
.space {
  overflow: hidden;
}
.off {
  color: var(--dimmer);
}
.bytes {
  display: flex;
  gap: 1ch;
}
.bytes .b:nth-child(8) {
  margin-right: 1ch;
}
.ascii {
  display: flex;
}
.nul {
  color: var(--dimmer);
}
.txt {
  color: var(--tk-prop);
}
.ws {
  color: var(--tk-str);
}
.ctl {
  color: var(--tk-kw);
}
.hi {
  color: var(--tk-ty);
}
.on {
  background: var(--hl);
  color: var(--hlfg);
}
</style>
