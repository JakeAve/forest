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
    class:counted={count && value}
    placeholder={kbd ? `${label} ${kbd}` : label} aria-label={label}
    title={parsed.error ?? "Wrap in /slashes/ for a regex"}
    bind:this={el} bind:value onkeydown={key}>
  {#if count && value && !parsed.error}<span class="count">{count}</span>{/if}
</span>

<style>
.fbox {
  position: relative;
  display: inline-flex;
}
.counted {
  padding-right: 3.5rem;
}
.count {
  position: absolute;
  right: 0.75rem;
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
