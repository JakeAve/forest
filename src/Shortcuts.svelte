<script>
import { rank } from "./filter.js";
import { combo, label } from "./keys.js";

let { commands, keymap, onbind, open = $bindable(false) } = $props();
let dlg, input;
let q = $state("");
let recording = $state(null);

const shown = $derived(q ? rank(q, commands, 999, (c) => c.label) : commands);
const sections = $derived(
  Object.entries(Object.groupBy(shown, (c) => c.section ?? "General")),
);
const keysOf = (id) => [...new Set(keymap.byId[id].map(label))];

$effect(() => {
  if (open && !dlg.open) {
    q = "";
    recording = null;
    dlg.showModal();
    input.focus();
  } else if (!open && dlg.open) dlg.close();
});

function record(e) {
  if (!recording || e.key === "Tab") return;
  e.preventDefault();
  const k = combo(e);
  if (!k) return;
  if (k !== "escape") onbind(recording, k === "backspace" ? null : k);
  recording = null;
  input.focus();
}
</script>

<dialog bind:this={dlg} onclose={() => (open = false)} onkeydown={record}>
  <input bind:this={input} bind:value={q} placeholder="Filter shortcuts…"
    spellcheck="false" autocomplete="off">
  <div class="list">
    {#each sections as [name, cmds] (name)}
      <div class="sec">{name}</div>
      {#each cmds as c (c.id)}
        <button class:on={recording === c.id}
                onclick={() => (recording = recording === c.id ? null : c.id)}>
          <span class="l">{c.label}</span>
          {#if recording === c.id}
            <span class="hint">Press keys · ⎋ cancel · ⌫ default</span>
          {:else}
            {#each keysOf(c.id) as k (k)}<kbd>{k}</kbd>{/each}
          {/if}
        </button>
      {/each}
    {:else}
      <div class="none">no matches</div>
    {/each}
  </div>
  <div class="foot">Click a shortcut to rebind it</div>
</dialog>

<style>
dialog {
  margin: 12vh auto auto;
  width: min(32rem, 92vw);
  border: 1px solid var(--line);
  border-radius: 0.875rem;
  background: var(--bg2);
  color: var(--fg);
  font: 0.75rem var(--sans);
  padding: 0;
  overflow: hidden;
}
dialog::backdrop {
  background: color-mix(in srgb, var(--bg) 65%, transparent);
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
  max-height: min(28rem, 64vh);
  overflow-y: auto;
  padding: 0.25rem;
}
.sec {
  padding: 0.625rem 0.625rem 0.25rem;
  color: var(--dim);
  font-weight: 600;
}
button {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  color: var(--fg);
  font: inherit;
  padding: 0.3125rem 0.625rem;
  border-radius: 0.375rem;
  cursor: pointer;
}
button:hover {
  background: var(--hov);
}
.l {
  margin-right: auto;
}
kbd {
  padding: 0 0.3125rem;
  border: 1px solid var(--line);
  border-radius: 0.25rem;
  color: var(--dim);
  font: 0.6875rem var(--mono);
}
.on,
.on:hover {
  background: var(--hl);
  color: var(--hlfg);
}
.hint {
  color: inherit;
  font-size: 0.6875rem;
}
.none,
.foot {
  padding: 0.25rem 0.625rem;
  color: var(--dim);
}
.foot {
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--line);
  font-size: 0.6875rem;
}
</style>
