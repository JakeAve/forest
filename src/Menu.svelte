<script>
import Icon from "./Icon.svelte";
import { ICON } from "./icons.js";
import { combo } from "./keys.js";
import {
  closeMenu,
  curItem,
  hideMenu,
  menu,
  noteOutside,
  runItem,
} from "./menu.svelte.js";

// Until the commands store exists, App passes what it will own.
let { kbdOf, keymap } = $props();

$effect(() => {
  if (!menu.shown) return;
  const onDown = (ev) => {
    if (menu.el?.contains(ev.target)) return;
    noteOutside(ev);
    hideMenu();
  };
  const onKey = (ev) => (ev.key === "Escape" ? hideMenu() : menuNav(ev));
  addEventListener("pointerdown", onDown, true);
  addEventListener("keydown", onKey, true);
  const onScroll = (ev) => menu.el?.contains(ev.target) || hideMenu();
  addEventListener("scroll", onScroll, true);
  return () => {
    removeEventListener("pointerdown", onDown, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", onScroll, true);
  };
});

// ↑ ↓ (and whatever moves between worktrees) step through items; → opens a
// session's actions, ← goes back. Runs in capture so a menu opened with the
// mouse navigates too, and j / k move here instead of between worktrees.
function menuNav(e) {
  const k = combo(e);
  const step = k === "arrowdown" || keymap.byId["next-wt"]?.includes(k)
    ? 1
    : k === "arrowup" || keymap.byId["prev-wt"]?.includes(k)
    ? -1
    : 0;
  const back = menu.shown?.items.find((x) => x.back);
  if (step) {
    const bs = [
      ...menu.el.querySelectorAll("button:not(:disabled, .more, .x)"),
    ];
    const i = bs.indexOf(document.activeElement);
    bs.at(i < 0 ? (step > 0 ? 0 : -1) : (i + step) % bs.length)?.focus();
  } else if (k === "arrowleft" && back) back.fn(e);
  else if (k === "arrowright" && curItem()?.more) curItem().more(e);
  else return;
  e.preventDefault();
  e.stopPropagation();
}
</script>

<div class="ctx" popover="manual" bind:this={menu.el}
  ontoggle={(e) => e.newState === "closed" && closeMenu()}>
  {#each menu.shown?.items ?? [] as it, i (i)}
    {#if it === "-"}
      <hr>
    {:else if it.head}
      <div class="grp">{it.head}{#if i === 0 && menu.shown.closable}<button class="circ x" title="Close (Esc)"
        aria-label="Close" onclick={hideMenu}><Icon d={ICON.x} /></button>{/if}</div>
    {:else}
      {@const kbd = it.kbd || (it.cmd && kbdOf(it.cmd))}
      {#snippet item()}
        <button class:dg={it.danger} disabled={it.disabled} title={it.tip}
                onclick={(e) => runItem(it, e)}
                data-i={i}
                onpointerenter={() => (menu.cur = it)}
                oncontextmenu={(e) => { if (it.more) { e.preventDefault(); it.more(e); } }}
                >{#if it.agent}<span class="ag"
                style="--ag: var(--{it.agent.tone})">{it.agent.glyph}</span>{/if}{it.label}{#if
                it.tag}<span class="mtag" class:lead={it.tag === "created"}>{it.tag}</span>{/if}{#if kbd}<kbd>{kbd}</kbd>{/if}{#if it.sub}<small>{it.sub}</small>{/if}</button>
      {/snippet}
      {#if it.more}
        <div class="split">
          {@render item()}
          <button class="more" tabindex="-1" title="Session actions"
                  aria-label="Session actions" onclick={(e) => it.more(e)}>›</button>
        </div>
      {:else}
        {@render item()}
      {/if}
    {/if}
  {/each}
</div>

<style>
.ctx .grp:has(.x) {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-top: 0.25rem;
}
</style>
