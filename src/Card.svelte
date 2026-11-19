<script>
import Icon from "./Icon.svelte";
import { dur, prAb, prStatus } from "../parse.ts";
import { CHECK, ICON, TAG, TICKET_ST, VERDICT } from "./icons.js";
import { act, ago, copy, ui } from "./ui.svelte.js";
import {
  card,
  hideCard,
  noteOutside,
  placeCard,
  runAction,
} from "./menu.svelte.js";
import { rows } from "./rows.svelte.js";
import {
  prActions,
  toggleAutoClose,
  toggleAutoMerge,
  toggleAutoRebase,
  updateBranch,
} from "./wtActions.js";

const cardWt = $derived(
  card.shown && rows.allWts.find((w) => w.path === card.shown.path),
);

$effect(() => {
  if (!card.shown) return;
  const outside = (ev) => {
    if (card.el?.contains(ev.target)) return;
    if (ev.type === "pointerdown") noteOutside(ev);
    hideCard();
  };
  const onKey = (ev) => ev.key === "Escape" && hideCard();
  addEventListener("pointerdown", outside, true);
  addEventListener("keydown", onKey, true);
  addEventListener("scroll", outside, true);
  return () => {
    removeEventListener("pointerdown", outside, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", outside, true);
  };
});

const runFor = (c) =>
  !c.startedAt
    ? c.bucket === "pending" ? "queued" : "–"
    : c.bucket === "pending"
    ? `${dur(ui.now - c.startedAt)}…`
    : dur((c.completedAt ?? c.startedAt) - c.startedAt);
</script>

<div class="ctx card" popover="manual" role="dialog" aria-label="Pull request"
  bind:this={card.el}>
  {#if card.shown?.kind === "ticket" && cardWt?.ticket?.info}
    {@const t = cardWt.ticket}
    {@const ti = t.info}
    <div class="top">
      <div class="r">
        <a class="port" href={t.url} target="_blank" rel="noreferrer">{t.key} ↗</a>
        {#if ti.status}<span class="st t-edge" data-tone={TICKET_ST[ti.category] ?? "ask"}>{ti.status}</span>{/if}
        {#if ti.assignee}<span class="ago">{ti.assignee}</span>{/if}
        <button class="circ x" title="Close (Esc)" aria-label="Close"
                onclick={hideCard}><Icon d={ICON.x} /></button>
      </div>
      <div class="ttl">{ti.title}</div>
    </div>
    {#if ti.actions?.length}
      <section class="practs">
        {#each ti.actions as to (to)}
          <button class="btn" class:wait={ui.busy["tk:" + cardWt.path]?.to === to} disabled={ui.busy["tk:" + cardWt.path]}
                  onclick={(e) => act("ticket", { wt: cardWt.path, to }, "tk:" + cardWt.path, e)}>Mark {to.replace(/_/g, " ")}</button>
        {/each}
      </section>
    {/if}
    {#if cardWt.autoClose || cardWt.pr?.state === "OPEN"}
      <section>
        <label class="r">
          <input type="checkbox" class="cbxin" checked={!!cardWt.autoClose} disabled={ui.busy["ac:" + cardWt.path]}
                 onchange={(e) => toggleAutoClose(cardWt, e)}>
          <span class="cbx" class:on={!!cardWt.autoClose}></span>Close {t.key} on merge
        </label>
        {#if cardWt.autoClose?.error}
          <div class="r" data-tone="bad">{cardWt.autoClose.error}</div>
        {/if}
      </section>
    {/if}
    <section class="foot">
      <a class="btn" href={t.url} target="_blank" rel="noreferrer">Open ticket ↗</a>
      <button class="btn ib" title="Copy link" aria-label="Copy link"
              onclick={(e) => copy(e, t.url, "tklink:" + t.url)}><Icon d={ICON.copy} /></button>
    </section>
  {:else if cardWt?.pr}
    {@const w = cardWt}
    {@const p = w.pr}
    {@const c = p.card}
    {@const s = prStatus(p)}
    <div class="top">
      <div class="r">
        <a class="pr t-solid" data-tone={s.tone} href={p.url} target="_blank" rel="noreferrer">#{p.number} ↗</a>
        <span class="st t-edge" data-tone={s.tone}>{s.label}</span>
        {#if c}<span class="dim t">by {c.author} · {ago(c.createdAt)}</span><span class="ago">updated {ago(c.updatedAt)}</span>{/if}
        <button class="circ x" title="Close (Esc)" aria-label="Close"
                onclick={hideCard}><Icon d={ICON.x} /></button>
      </div>
      <div class="ttl">{p.title}</div>
      {#if c}
        <div class="r sm">
          <span class="dim t">{p.baseRefName} ← {c.headRefName}</span>
          <span class="ago"><span class="pl">+{c.additions}</span> <span class="mi">−{c.deletions}</span> · {c.changedFiles} files</span>
        </div>
      {/if}
    </div>
    {@const acts = prActions(w)}
    {#if acts.length}
      {@const ask = card.asking?.path === w.path &&
        acts.find((a) => a.key === card.asking.key)}
      <section class="practs">
        {#if ask}
          <span class="q">{ask.confirm}</span>
          <button class="btn {ask.cls}" class:wait={ask.wait} disabled={ui.busy["ps:" + w.path]}
                  onclick={(e) => runAction(ask, w, e)}>{ask.label}</button>
          <button class="btn" onclick={() => (card.asking = null)}>Cancel</button>
        {:else}
          {#each acts as a (a.key)}
            <button class="btn {a.cls}" class:wait={a.wait}
                    disabled={ui.busy["ps:" + w.path] || ui.busy["ub:" + w.path]}
                    onclick={(e) => runAction(a, w, e)}>{a.label}</button>
          {/each}
        {/if}
      </section>
    {/if}
    {#if p.state === "OPEN"}
      {@const behind = prAb(w).behind}
      <section>
        <div class="hd"><span>Merge</span></div>
        {#if p.mergeable === "CONFLICTING"}
          <div class="r" data-tone="bad">Conflicts with {p.baseRefName}</div>
        {:else}
          <div class="r dim">No conflicts</div>
        {/if}
        {#if p.queue}
          <div class="r" data-tone="ok">In merge queue · position {p.queue.position}, {p.queue.state.toLowerCase().replace("_", " ")}</div>
        {/if}
        <div class="r" data-tone={behind ? "warn" : "off"}>
          <span>{behind ? `↓${behind} behind` : "Up to date with"} {p.baseRefName}</span>
          {#if behind > 0 && !p.queue}
            <button class="btn" class:wait={ui.busy["ub:" + w.path]} disabled={ui.busy["ub:" + w.path]}
                    onclick={(e) => updateBranch(w, e)}>Update branch</button>
          {/if}
        </div>
        <label class="r">
          <input type="checkbox" class="cbxin" checked={p.autoMerge} disabled={ui.busy["am:" + w.path]}
                 onchange={(e) => toggleAutoMerge(w, e)}>
          <span class="cbx" class:on={p.autoMerge}></span>Auto-merge (squash)
        </label>
        <label class="r">
          <input type="checkbox" class="cbxin" checked={!!w.autoRebase} disabled={ui.busy["ar:" + w.path]}
                 onchange={(e) => toggleAutoRebase(w, e)}>
          <span class="cbx" class:on={!!w.autoRebase}></span>Auto-rebase
        </label>
        {#if w.autoRebase?.error}
          <div class="r" data-tone="bad">{w.autoRebase.error}</div>
        {/if}
        {#if w.ticket?.info}
          <label class="r">
            <input type="checkbox" class="cbxin" checked={!!w.autoClose} disabled={ui.busy["ac:" + w.path]}
                   onchange={(e) => toggleAutoClose(w, e)}>
            <span class="cbx" class:on={!!w.autoClose}></span>Close {w.ticket.key} on merge
          </label>
        {/if}
      </section>
    {/if}
    {#if c}
      {#if c.reviews.length || c.awaiting.length}
        <section>
          <div class="hd"><span>Reviews</span></div>
          {#each c.reviews as rv (rv.login)}
            <a class="r lk" href={rv.url} target="_blank" rel="noreferrer">
              <span class="t">{rv.login}</span>
              <span data-tone={VERDICT[rv.state]?.[1]}>{VERDICT[rv.state]?.[0]}</span>
              <span class="ago">{ago(rv.at)}</span><span class="go">↗</span>
            </a>
          {/each}
          {#if c.awaiting.length}
            <details ontoggle={placeCard}>
              <summary class="hd">{c.awaiting.length} awaiting review</summary>
              {#each c.awaiting as login (login)}
                <div class="r dim">{login}</div>
              {/each}
            </details>
          {/if}
        </section>
      {/if}
      {#if c.threads.length}
        {@const open = c.threads.filter((t) => !t.resolved)}
        {@const done = c.threads.filter((t) => t.resolved)}
        <section>
          <div class="hd"><span>Code threads</span>
            <span><span data-tone={open.length ? "warn" : undefined}>{open.length} unresolved</span> of {c.threads.length}</span></div>
          {#each open as t (t.url)}
            <details class="th" ontoggle={placeCard}>
              <summary title="Click to expand or collapse">
                <span class="r0">
                  <span>{t.login}</span>
                  <span class="mono dim t">{t.path}{t.line ? `:${t.line}` : ""}</span>
                  {#if t.tag}<span class="tag" data-tone={TAG[t.tag] ?? "off"}>{t.tag}</span>{/if}
                  <span class="ago">{ago(t.at)}</span>
                  <a class="go" href={t.url} target="_blank" rel="noreferrer" title="Open on GitHub">↗</a>
                </span>
                <span class="txt">{t.body}</span>
                <span class="meta">{t.replies ? `${t.replies} repl${t.replies === 1 ? "y" : "ies"} · last by ${t.lastBy}` : "No replies"}</span>
              </summary>
            </details>
          {/each}
          {#if done.length}
            <details ontoggle={placeCard}>
              <summary class="hd">{done.length} resolved</summary>
              {#each done as t (t.url)}
                <a class="r lk" href={t.url} target="_blank" rel="noreferrer">
                  <span>{t.login}</span>
                  <span class="mono dim t">{t.path}{t.line ? `:${t.line}` : ""}</span>
                  <span class="ago">{ago(t.at)}</span><span class="go">↗</span>
                </a>
              {/each}
            </details>
          {/if}
        </section>
      {/if}
      {#if c.comments.length}
        <section>
          <details ontoggle={placeCard}>
            <summary class="hd"><span>Comments</span><span>{c.comments.length}</span></summary>
            {#each c.comments as cm (cm.url)}
              <a class="th flat" href={cm.url} target="_blank" rel="noreferrer">
                <span class="r0"><span>{cm.login}</span>{#if cm.review}<span class="dim">review</span>{/if}
                  <span class="ago">{ago(cm.at)}</span><span class="go">↗</span></span>
                <span class="txt dim">{cm.body}</span>
              </a>
            {/each}
          </details>
        </section>
      {/if}
      {#if c.checks.length}
        {@const req = c.checks.filter((k) => k.required)}
        {@const opt = c.checks.filter((k) => !k.required)}
        {#snippet checkRow(k)}
          <a class="r lk chk {k.bucket}" href={k.url} target="_blank" rel="noreferrer">
            <span class="g" data-tone={CHECK[k.bucket]?.[1] ?? "off"}>{#if k.bucket === "pending"}<span class="spin"></span>{:else}{CHECK[k.bucket]?.[0] ?? "○"}{/if}</span>
            <span class="t">{k.name}</span>
            <span class="dur" data-tone={k.bucket === "pending" ? "warn" : undefined}>{runFor(k)}</span>
            <span class="fin">{k.bucket === "pending" ? "–" : ago(k.completedAt)}</span>
            <span class="go">↗</span>
          </a>
        {/snippet}
        <section>
          <div class="hd"><span>{req.length ? "Required checks" : "Checks"}</span>
            <span class="cols"><span class="dur">ran for</span><span class="fin">finished</span><span class="go"></span></span></div>
          {#each req.length ? req : opt as k, i (k.url + i)}
            {@render checkRow(k)}
          {/each}
          {#if req.length && opt.length}
            {@const bad = opt.filter((k) => k.bucket === "fail").length}
            <details ontoggle={placeCard}>
              <summary class="hd"><span>{opt.length} optional checks{#if bad} · <span data-tone="bad">{bad} failing</span>{/if}</span></summary>
              {#each opt as k, i (k.url + i)}
                {@render checkRow(k)}
              {/each}
            </details>
          {/if}
        </section>
      {/if}
    {/if}
    <section class="foot">
      <a class="btn" href={p.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
      <a class="btn" href="{p.url}/files" target="_blank" rel="noreferrer">Files changed</a>
      <button class="btn ib" title="Copy link" aria-label="Copy link"
              onclick={(e) => copy(e, p.url, "prlink:" + p.url)}><Icon d={ICON.copy} /></button>
    </section>
  {/if}
</div>

<style>
.card .ago + .x {
  margin-left: 0;
}
.card {
  width: 27rem;
  max-width: calc(100vw - 1rem);
  max-height: min(40rem, calc(100vh - 1rem));
  overflow-y: auto;
  padding: 0 0 0.25rem;
  font: 0.75rem var(--sans);
  color: var(--fg);
}
.card .top {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg2);
  padding: 0.625rem 0.75rem 0.5rem;
}
.card .r,
.card .r0 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.card section .r {
  padding: 0.1875rem 0.375rem;
  border-radius: 0.375rem;
}
.card .ttl {
  font-size: 0.8125rem;
  line-height: 1.35;
  margin: 0.25rem 0 0.375rem;
}
.card .sm {
  font: 0.6875rem var(--mono);
}
.card .st {
  padding: 0 0.4375rem;
  font-size: 0.6875rem;
}
.card .st,
.card .top .pr {
  flex-shrink: 0;
  white-space: nowrap;
}
.card section {
  border-top: 1px solid var(--line);
  padding: 0.5rem 0.375rem;
}
.card .hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  color: var(--dim);
  font-size: 0.6875rem;
  padding: 0 0.375rem;
  margin-bottom: 0.25rem;
}
.card summary.hd {
  justify-content: flex-start;
}
.card summary.hd > span + span {
  margin-left: auto;
}
.card summary {
  list-style: none;
  cursor: pointer;
  margin: 0.25rem 0 0;
}
.card summary::-webkit-details-marker {
  display: none;
}
.card summary::before {
  content: "▶";
  display: inline-block;
  font-size: 0.5625rem;
  margin-right: 0.3125rem;
}
.card details[open] > summary::before {
  transform: rotate(90deg);
}
.card summary:hover {
  color: var(--fg);
}
.card a.lk,
.card a.th {
  color: inherit;
  text-decoration: none;
}
.card a.lk:hover,
.card a.th:hover {
  background: var(--hl);
}
.card .go {
  width: 0.625rem;
  color: var(--dim);
  font-size: 0.6875rem;
  visibility: hidden;
}
.card a:hover .go {
  visibility: visible;
}
.card .th {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 0.375rem 0.5rem;
  margin: 0 0.375rem 0.3125rem;
}
.card details.th > summary {
  display: flex;
  flex-direction: column;
  margin: 0;
  color: inherit;
}
.card details.th > summary::before {
  content: none;
}
.card details.th:hover {
  background: var(--hl);
}
.card details.th .go {
  text-decoration: none;
}
.card details.th:hover .go,
.card details.th .go:focus-visible {
  visibility: visible;
}
.card details.th[open] .txt {
  display: block;
  max-height: none;
  white-space: pre-line;
}
.card .th.flat {
  background: none;
  border-color: transparent;
  margin: 0;
}
.card .r0 > :first-child {
  flex: none;
  white-space: nowrap;
}
.card .th .txt {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-height: 2.8em;
  line-height: 1.4;
  margin: 0.1875rem 0 0.125rem;
}
.card .th .meta {
  display: block;
  color: var(--dimmer);
  font-size: 0.6875rem;
}
.card .tag {
  font: 0.6875rem var(--mono);
}
.card .t {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card .ago {
  margin-left: auto;
  color: var(--dimmer);
  font: 0.6875rem var(--mono);
  white-space: nowrap;
}
.card .cols {
  position: sticky;
  top: 0;
  z-index: 2;
  height: var(--colsh);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.625rem;
  background: var(--bg2);
  color: var(--dim);
  font-size: 0.6875rem;
  white-space: nowrap;
}
.card .cols > * {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card .pl {
  color: var(--addfg);
}
.card .mi {
  color: var(--delfg);
}
.card .dur,
.card .fin {
  flex: none;
  text-align: right;
  font: 0.6875rem var(--mono);
  color: var(--dim);
}
.card .dur {
  width: 4.25rem;
  margin-left: auto;
}
.card .fin {
  width: 3.25rem;
  color: var(--dimmer);
}
.card .cols .dur,
.card .cols .fin {
  font-family: var(--sans);
  color: var(--dim);
}
.card .dim {
  color: var(--dim);
}
.card .mono {
  font: 0.6875rem var(--mono);
}
.card label.r {
  cursor: pointer;
}
.card .cbx {
  flex: none;
}
.card .g {
  width: 1em;
  flex: none;
  text-align: center;
  font: 0.75rem var(--mono);
}
.card .foot {
  display: flex;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem 0.25rem;
}
.card .practs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
}
.card .practs .q {
  flex: 1;
  font-size: 0.75rem;
  color: var(--fg);
}
.card .btn.ok {
  color: var(--addfg);
  border-color: color-mix(in srgb, var(--acc) var(--ink), var(--line));
  background: var(--add);
}
.card .btn.warn {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) var(--edge), var(--line));
}
.card .foot .btn {
  text-decoration: none;
}
</style>
