<script>
import { clip, KINDS, snoozeKey } from "../parse.ts";
import { prefs, saveSettings, setDeliver } from "./prefs.svelte.js";
import { ago, copy, ui } from "./ui.svelte.js";
import { openMenu } from "./menu.svelte.js";
import { rows } from "./rows.svelte.js";
import { agents, full } from "./agents.svelte.js";

let { selectWt } = $props();

let inbox = $state([]);
let inboxEl = $state();
let toasts = $state([]);
const unread = $derived(inbox.filter((e) => !e.readAt).length);

export function refresh() {
  fetch("/api/notify").then((r) => r.json()).then((l) => (inbox = l));
}

export function push(ev) {
  if (inbox.some((x) => x.id === ev.id)) return;
  inbox = [ev, ...inbox];
  const d = prefs.settings?.notify[ev.kind];
  if (d !== "app" && d !== "both") return;
  toasts = [ev, ...toasts];
  setTimeout(
    () => (toasts = toasts.filter((t) => t.id !== ev.id)),
    prefs.settings?.toastMs ?? 7000,
  );
}

const notifyPost = (what, body) =>
  fetch(`/api/notify/${what}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function onInbox(e) {
  if (e.newState !== "open" || !unread) return;
  notifyPost("read", { all: true });
  const t = Date.now();
  for (const ev of inbox) ev.readAt ??= t;
}

function openEv(ev) {
  toasts = toasts.filter((t) => t.id !== ev.id);
  inboxEl?.hidePopover();
  if (ev.wt && rows.allWts.some((w) => w.path === ev.wt)) selectWt(ev.wt);
  else if (ev.url) open(ev.url, "_blank", "noreferrer");
}

function mute(path) {
  if (!prefs.settings.notifyMuted.includes(path)) {
    prefs.settings.notifyMuted.push(path);
  }
  saveSettings();
}

const evItems = (ev) => [
  { label: "Open", fn: () => openEv(ev) },
  { label: "Snooze", fn: () => notifyPost("snooze", { key: snoozeKey(ev) }) },
  "-",
  ev.wt && { label: "Mute worktree", fn: () => mute(ev.wt) },
  { label: "Mute repo", fn: () => mute(ev.repo) },
  {
    label: `Mute "${KINDS[ev.kind]?.label ?? ev.kind}"`,
    fn: () => setDeliver(ev.kind, "off"),
  },
];

function notifySettings() {
  inboxEl?.hidePopover();
  ui.refs.settings.open("notify");
}
</script>

<button class="circ bell" popovertarget="inbox" title="Notifications"
  aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
  {#if unread}<span class="n">{unread > 99 ? "99+" : unread}</span>{/if}</button>
<div class="toasts">
  {#each toasts.slice(0, 3) as ev (ev.id)}
    <button class="toast" onclick={() => openEv(ev)}>{ev.title} <span class="dim">{ev.body}</span></button>
  {/each}
  {#if toasts.length > 3}
    <button class="toast" onclick={() => inboxEl.showPopover()}>+{toasts.length - 3} more</button>
  {/if}
  {#if agents.opened}
    <button class="toast" onclick={(e) => {
      copy(e, full(agents.opened).command, "ctx", "resume command");
      agents.opened = null;
    }}>Opened {clip(agents.opened.title || "session", 40)} in {full(agents.opened).label}
      <span class="dim">· click to copy resume command</span></button>
  {/if}
  {#if ui.toast}
    <div class="toast" onclick={() => (ui.toast = "")} role="presentation">
      copied <span class="mono">{ui.toast}</span> to clipboard
    </div>
  {/if}
</div>
<div id="inbox" class="ctx inbox" popover bind:this={inboxEl}
  ontoggle={onInbox}>
  {#each inbox as ev (ev.id)}
    <div class="ev" oncontextmenu={(e) => openMenu(e, evItems(ev))} role="presentation">
      <button class="go" onclick={() => openEv(ev)}>
        <span class="t">{ev.title}</span><span class="ago">{ago(ev.at)}</span>
        <span class="b">{ev.body}</span></button>
      <button class="more" title="Snooze or mute" aria-label="Snooze or mute"
              onclick={(e) => openMenu(e, evItems(ev))}>⋯</button>
    </div>
  {:else}
    <div class="empty">Nothing yet — every kind starts off
      <button class="btn" onclick={notifySettings}>Choose kinds…</button></div>
  {/each}
</div>

<style>
.bell {
  position: relative;
}
.bell .n {
  position: absolute;
  top: -0.25rem;
  right: -0.375rem;
  min-width: 1rem;
  padding: 0 0.25rem;
  border-radius: 999px;
  background: var(--acc);
  color: var(--bg);
  font: 600 0.625rem/1rem var(--sans);
}
.ctx.inbox {
  inset: 3rem 0.5rem auto auto;
  width: min(26rem, calc(100vw - 1rem));
  max-height: calc(100vh - 4rem);
  overflow-y: auto;
}
.inbox .ev {
  display: flex;
  align-items: start;
  border-radius: 0.375rem;
}
.inbox .ev:hover {
  background: var(--hov);
}
.inbox .ev button.go {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0 0.5rem;
  white-space: normal;
}
.inbox .ev button.go:hover,
.inbox .ev button.more:hover {
  background: none;
  color: var(--fg);
}
.inbox .ev .b {
  grid-column: 1 / -1;
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inbox .ev .ago {
  color: var(--dimmer);
}
.inbox .ev button.more {
  width: auto;
  color: var(--dim);
}
.inbox .empty .btn {
  margin-top: 0.5rem;
}
.toasts {
  position: fixed;
  bottom: 0.75rem;
  right: 0.75rem;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: end;
  gap: 0.375rem;
}
</style>
