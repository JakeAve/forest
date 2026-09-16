<script>
import { rank } from "./filter.js";

let { items, open = $bindable(false) } = $props();
let dlg, input, list;
let q = $state("");
let stack = $state([]);
let idx = $state(0);

const top = $derived(stack.at(-1));
const src = $derived(top?.sub() ?? items);
const shown = $derived(
  top?.onquery ? src : q.startsWith(">")
    ? rank(
      q.slice(1).trim(),
      src.filter((i) => i.group === "command" || i.group === "action"),
    )
    : rank(q, src),
);

$effect(() => {
  if (open && !dlg.open) {
    q = "";
    stack = [];
    idx = 0;
    dlg.showModal();
    input.focus();
  } else if (!open && dlg.open) dlg.close();
});

$effect(() => {
  shown;
  list?.children[idx]?.scrollIntoView({ block: "nearest" });
});

function run(it, e) {
  if (!it.fn) return drill([...stack, it]);
  dlg.close();
  it.fn(e);
}

function drill(next) {
  stack = next;
  q = next.at(-1)?.query?.() ?? "";
  next.at(-1)?.onquery?.(q);
  idx = 0;
}

function key(e) {
  if (e.isComposing) return;
  const it = shown[idx], n = shown.length;
  const atEnd = input.selectionStart === q.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (n) idx = (idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (it) run(it, e);
  } else if (e.key === "Tab" || (e.key === "ArrowRight" && atEnd && it?.sub)) {
    e.preventDefault();
    if (it?.sub) drill([...stack, it]);
  } else if (
    (e.key === "ArrowLeft" || e.key === "Backspace") && !q && stack.length
  ) {
    e.preventDefault();
    drill(stack.slice(0, -1));
  }
}
</script>

<dialog bind:this={dlg} onclose={() => (open = false)}>
  {#if stack.length}
    <div class="crumb">{stack.map((s) => s.label).join(" › ")}</div>
  {/if}
  <input
    bind:this={input}
    bind:value={q}
    oninput={() => ((idx = 0), top?.onquery?.(q))}
    onkeydown={key}
    placeholder={stack.length ? "filter…" : "search, or > for commands"}
    spellcheck="false"
    autocomplete="off"
  >
  <div class="list" bind:this={list}>
    {#each shown as it, i}
      <button
        tabindex="-1"
        class:on={i === idx}
        class:dg={it.danger}
        onmousemove={() => (idx = i)}
        onclick={(e) => run(it, e)}
      >
        <span class="l">{it.label}</span>
        {#if it.detail}<span class="d">{it.detail}</span>{/if}
        <span class="g">{it.group}</span>
        {#if it.kbd}<kbd>{it.kbd}</kbd>{/if}
        {#if it.sub}<span class="s">›</span>{/if}
      </button>
    {:else}
      <div class="none">no matches</div>
    {/each}
  </div>
</dialog>

<style>
dialog {
  margin: 12vh auto auto;
  width: min(40rem, 92vw);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--bg2);
  color: var(--fg);
  font: 0.75rem var(--sans);
  overflow: hidden;
}
dialog::backdrop {
  background: color-mix(in srgb, var(--bg) 65%, transparent);
}
.crumb {
  padding: 0.5rem 0.75rem 0;
  color: var(--dim);
  font-size: 0.6875rem;
}
input {
  width: 100%;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--line);
  color: var(--fg);
  font: 0.8125rem var(--sans);
  padding: 0.625rem 0.75rem;
  outline: none;
}
input::placeholder {
  color: var(--dimmer);
}
.list {
  max-height: min(24rem, 60vh);
  overflow-y: auto;
  padding: 0.1875rem;
}
button {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  color: var(--fg);
  font: inherit;
  padding: 0.25rem 0.625rem;
  border-radius: 0.1875rem;
  cursor: pointer;
  white-space: nowrap;
}
.l,
.d {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.d {
  flex-shrink: 100;
  color: var(--dim);
}
.g {
  margin-left: auto;
  color: var(--dimmer);
  font-size: 0.625rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
kbd {
  color: var(--dimmer);
  font: 0.6875rem var(--mono);
}
.s {
  color: var(--dim);
}
.on {
  background: var(--hl);
  color: var(--hlfg);
}
.dg {
  color: var(--danger);
}
.dg.on {
  background: color-mix(in srgb, var(--danger) 22%, var(--bg2));
  color: var(--danger);
}
.none {
  padding: 0.25rem 0.625rem;
  color: var(--dim);
}
</style>
