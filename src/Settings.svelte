<script>
import Icon from "./Icon.svelte";
import { KINDS } from "../parse.ts";
import { ICON } from "./icons.js";
import {
  COLUMNS,
  moveCol,
  prefs,
  resetWidths,
  saveSettings,
  setDeliver,
  toggleCol,
} from "./prefs.svelte.js";
import { applyTheme, importTheme, importVsTheme, ui } from "./ui.svelte.js";
import { rows } from "./rows.svelte.js";

// Until the commands store exists, App passes what it will own.
let { kbdOf, onshortcuts } = $props();

let dlg = $state();
let fileEl = $state();
let notifySec = $state();
let newRepo = $state("");
let newTicketRepo = $state("");
let vsThemes = $state([]);
let vsLoad;

const GROUPS = {
  act: "Act now",
  move: "Your move",
  life: "Lifecycle",
  clean: "Cleanup",
};
const DELIVER = { off: "Off", app: "In app", os: "macOS", both: "Both" };

export function open(section) {
  vsLoad ??= fetch("/api/vscode-themes").then((r) => r.json())
    .then((t) => (vsThemes = t));
  dlg.showModal();
  if (section === "notify") notifySec?.scrollIntoView({ block: "start" });
}

export function toggle() {
  if (dlg.open) dlg.close();
  else open();
}

function pickVsTheme(e) {
  const hit = vsThemes.find((t) => t.path === e.target.value);
  e.target.value = "";
  if (hit) importVsTheme(hit);
}

function addLauncher() {
  const name = newRepo.trim();
  if (!name || prefs.settings.launchers[name] !== undefined) return;
  prefs.settings.launchers[name] = "";
  newRepo = "";
}

function addTicket() {
  const name = newTicketRepo.trim();
  if (!name || prefs.settings.tickets[name] !== undefined) return;
  prefs.settings.tickets[name] = "";
  newTicketRepo = "";
}
</script>

<dialog class="settings" bind:this={dlg}>
  <div class="shead"><b>Settings</b><span class="sp"></span>
    <button class="circ x" title="Close (Esc)" aria-label="Close"
            onclick={() => dlg.close()}><Icon d={ICON.x} /></button></div>

  <h3 class="sec">Theme</h3>
  <div class="row">
    <label for="theme-sel">theme</label>
    <select id="theme-sel" class="theme" value={prefs.theme} disabled={ui.busy.theme}
            onchange={(e) => applyTheme(e.target.value)}>
      <option value="default">default</option>
      {#each ui.themes as t (t)}<option value={t}>{t}</option>{/each}
    </select>
    <button class="btn" class:wait={ui.busy.theme?.json} disabled={ui.busy.theme}
            onclick={() => fileEl.click()}>Import…</button>
    <input type="file" accept=".json,.jsonc" hidden bind:this={fileEl} onchange={importTheme}>
  </div>
  {#if vsThemes.length}
    <div class="row">
      <label for="vs-sel">installed</label>
      <select id="vs-sel" class="theme" value="" disabled={ui.busy.theme} onchange={pickVsTheme}>
        <option value="">Pick a VS Code theme…</option>
        {#each vsThemes as t (t.path)}<option value={t.path}>{t.name}</option>{/each}
      </select>
    </div>
  {/if}
  <div class="hint">Import any VS Code color theme JSON, or one VS Code already has</div>

  <h3 class="sec">Preferences</h3>
  {#each Object.entries(prefs.settings ?? {}) as [k, v] (k)}
    {#if typeof v === "number" || typeof v === "string"}
      <div class="row">
        <label for="set-{k}">{k}</label>
        {#if typeof v === "number"}
          <input id="set-{k}" type="number" min="0" bind:value={prefs.settings[k]} onchange={saveSettings}>
        {:else}
          <input id="set-{k}" type="text" bind:value={prefs.settings[k]} onchange={saveSettings}>
        {/if}
        {#if k === "port" || k === "root" || k === "host"}<span class="hint">restart</span>{/if}
      </div>
    {/if}
  {/each}

  <h3 class="sec">Columns</h3>
  {#each [...prefs.visibleCols, ...COLUMNS.filter((c) => !prefs.visibleCols.includes(c))] as c, i (c.key)}
    {@const on = prefs.visibleCols.includes(c)}
    <div class="row">
      <label class="colck">
        <input type="checkbox" class="cbxin" checked={on} onchange={() => toggleCol(c.key)}>
        <span class="cbx" class:on></span>{c.label}
      </label>
      {#if on}
        <button class="btn ib" title="Move up" aria-label="Move up" disabled={i === 0} onclick={() => moveCol(c.key, i - 1)}><Icon d={ICON.up} /></button>
        <button class="btn ib" title="Move down" aria-label="Move down" disabled={i === prefs.visibleCols.length - 1}
                onclick={() => moveCol(c.key, i + 1)}><Icon d={ICON.down} /></button>
      {/if}
    </div>
  {/each}
  <div class="row">
    <button class="btn" onclick={() => ((prefs.settings.columns = []), saveSettings(), resetWidths())}>Reset columns</button>
  </div>

  <h3 class="sec">Launchers</h3>
  {#each Object.entries(prefs.settings?.launchers ?? {}) as [repo] (repo)}
    <div class="row">
      <label for="l-{repo}">{repo}</label>
      <input id="l-{repo}" class="wide mono" type="text"
             bind:value={prefs.settings.launchers[repo]} onchange={saveSettings}>
    </div>
  {/each}
  <div class="row">
    <input class="lname" list="repo-names" placeholder="Repo name, or *"
           bind:value={newRepo} onkeydown={(e) => e.key === "Enter" && addLauncher()}>
    <datalist id="repo-names">
      {#each rows.repos as r (r.name)}<option value={r.name}></option>{/each}
    </datalist>
    <button class="btn ib" title="Add" aria-label="Add" disabled={!newRepo.trim()} onclick={addLauncher}><Icon d={ICON.plus} /></button>
  </div>
  <div class="hint">
    Shell command run in the repo to make a worktree, instead of plain
    <span class="mono">git worktree add</span>. <span class="mono">*</span> covers
    any repo without its own entry; empty removes it.
  </div>
  <div class="hint mono">{"{slug} {repo} {path} {root}"}</div>

  <h3 class="sec">Tickets</h3>
  {#each Object.entries(prefs.settings?.tickets ?? {}) as [repo] (repo)}
    <div class="row">
      <label for="t-{repo}">{repo}</label>
      <input id="t-{repo}" class="wide mono" type="text" placeholder="https://tracker/browse/{'{key}'}"
             bind:value={prefs.settings.tickets[repo]} onchange={saveSettings}>
    </div>
  {/each}
  <div class="row">
    <input class="lname" list="repo-names" placeholder="Repo name, or *"
           bind:value={newTicketRepo} onkeydown={(e) => e.key === "Enter" && addTicket()}>
    <button class="btn ib" title="Add" aria-label="Add" disabled={!newTicketRepo.trim()} onclick={addTicket}><Icon d={ICON.plus} /></button>
  </div>
  <div class="hint">
    URL for the ticket key found in a branch name, PR title or last commit
    (<span class="mono">ROM-123</span>). A <span class="mono">#123</span> always
    links to the repo's own issues.
  </div>
  <div class="hint mono">{"{key}"}</div>

  <h3 class="sec" bind:this={notifySec}>Notifications</h3>
  {#each Object.entries(GROUPS) as [g, name] (g)}
    <div class="sub">{name}</div>
    {#each Object.entries(KINDS).filter(([, k]) => k.group === g) as [kind, k] (kind)}
      <div class="row">
        <label class="kind" for="n-{kind}">{k.label}{#if k.hint}<span class="hint">{k.hint}</span>{/if}</label>
        <select id="n-{kind}" class="theme" value={prefs.settings?.notify[kind] ?? "off"}
                onchange={(e) => setDeliver(kind, e.target.value)}>
          {#each Object.entries(DELIVER) as [v, l] (v)}<option value={v}>{l}</option>{/each}
        </select>
      </div>
    {/each}
  {/each}
  <div class="sub">Muted</div>
  {#each prefs.settings?.notifyMuted ?? [] as p, i (p)}
    <div class="row">
      <span class="kind mono">{p}</span>
      <button class="btn ib" title="Unmute" aria-label="Unmute"
              onclick={() => (prefs.settings.notifyMuted.splice(i, 1), saveSettings())}><Icon d={ICON.x} /></button>
    </div>
  {:else}
    <div class="hint">Nothing muted. Mute a worktree or repo from an inbox row.</div>
  {/each}
  <div class="hint">
    Someone pushed to your branch and upstream branch gone only fire after a
    fetch, and Forest fetches only for auto-rebase worktrees. macOS delivery
    needs a one-time permission for Script Editor in System Settings,
    Notifications.
  </div>

  <h3 class="sec">Keyboard shortcuts</h3>
  <div class="row">
    <button class="btn" onclick={() => (dlg.close(), onshortcuts())}>
      View and rebind…{#if kbdOf("shortcuts")}<kbd>{kbdOf("shortcuts")}</kbd>{/if}</button>
  </div>
</dialog>

<style>
.sub {
  padding: 0.5rem 1rem 0.125rem;
  color: var(--dim);
  font-size: 0.8125rem;
  font-weight: 600;
}
.row .kind {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  color: var(--fg);
  font: 0.8125rem var(--sans);
  overflow-wrap: anywhere;
}
.row .kind.mono {
  font-family: var(--mono);
}
dialog.settings {
  margin: auto;
  border: 1px solid var(--line);
  border-radius: 0.875rem;
  background: var(--bg2);
  color: var(--fg);
  padding: 0 0 0.875rem;
  width: min(32rem, 92vw);
  max-height: min(40rem, 80vh);
  overflow-y: auto;
  font: 0.875rem var(--sans);
}
dialog.settings .btn {
  font-size: 0.8125rem;
}
dialog.settings::backdrop {
  background: color-mix(in srgb, var(--bg) 65%, transparent);
}
.shead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg2);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: var(--head);
  padding: 0 0.75rem 0 1rem;
  border-bottom: 1px solid var(--line);
  margin-bottom: 0.25rem;
  font-size: 1rem;
}
.sec {
  position: sticky;
  top: var(--head);
  scroll-margin-top: var(--head);
  z-index: 1;
  margin: 0;
  padding: 0.875rem 1rem 0.25rem;
  background: var(--bg2);
  font: 600 0.875rem var(--sans);
  color: var(--fg);
}
.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.1875rem 1rem;
}
.row label {
  width: 9.5rem;
  color: var(--dim);
  font: 0.8125rem var(--mono);
}
.row .colck {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}
.row input {
  background: var(--input);
  border: 1px solid var(--line);
  border-radius: 0.375rem;
  color: var(--fg);
  font: 0.8125rem var(--mono);
  padding: 0.1875rem 0.5rem;
  width: 6.5rem;
  outline: none;
}
.row input:focus {
  border-color: var(--acc);
}
.row input.wide {
  width: 100%;
}
.row input.lname {
  width: 9.5rem;
}
.row input.mono,
.hint.mono,
.hint .mono {
  font: 0.8125rem var(--mono);
}
.hint {
  padding: 0.125rem 1rem;
  color: var(--dimmer);
  font-size: 0.8125rem;
}
.row .hint {
  padding: 0;
}
select.theme {
  background: var(--input);
  border: 1px solid var(--line);
  border-radius: 0.375rem;
  color: var(--fg);
  font: 0.8125rem var(--sans);
  padding: 0.1875rem 0.375rem;
  outline: none;
  max-width: 12rem;
}
</style>
