<script>
import { parseQuery } from "./filter.js";

let { value = $bindable(""), label, kbd, count, onenter, onescape } = $props();

let el;
const parsed = $derived(parseQuery(value));

export const select = () => el?.select();

function key(e) {
  if (e.key === "Enter" && onenter) onenter(e.shiftKey);
  else if (e.key === "Escape") (value = ""), onescape?.();
  else return;
  e.preventDefault();
}
</script>

<span class="fbox">
  <input class="filter" class:re={parsed.re} class:bad={parsed.error}
    class:clearable={value} class:counted={count && value}
    placeholder={kbd ? `${label} ${kbd}` : label} aria-label={label}
    title={parsed.error ?? "Wrap in /slashes/ for a regex"}
    bind:this={el} bind:value onkeydown={key}>
  {#if count && value && !parsed.error}<span class="count">{count}</span>{/if}
  {#if value}<button class="clear" tabindex="-1" title="Clear (Esc)" aria-label="Clear"
    onclick={() => ((value = ""), el.focus())}><svg width="8" height="8" viewBox="0 0 8 8"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 1l6 6M7 1l-6 6"/></svg></button>{/if}
</span>

<style>
.fbox {
  position: relative;
  display: inline-flex;
}
.clearable {
  padding-right: 2rem;
}
.counted {
  padding-right: 4.75rem;
}
.clear {
  position: absolute;
  right: 0.625rem;
  top: 50%;
  transform: translateY(-50%);
  width: 1rem;
  height: 1rem;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--dim);
  cursor: pointer;
}
.clear:hover {
  color: var(--acc);
}
.count {
  position: absolute;
  right: 2rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--dim);
  font: 0.6875rem var(--mono);
  pointer-events: none;
}
.re {
  font-family: var(--mono);
}
.bad,
.bad:focus {
  border-color: var(--danger);
}
</style>
