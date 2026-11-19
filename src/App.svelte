<script>
import { tick } from "svelte";
import SourcePane from "./SourcePane.svelte";
import FilesPane from "./FilesPane.svelte";
import WorktreesPane from "./WorktreesPane.svelte";
import Palette from "./Palette.svelte";
import Shortcuts from "./Shortcuts.svelte";
import Icon from "./Icon.svelte";
import Settings from "./Settings.svelte";
import Menu from "./Menu.svelte";
import Card from "./Card.svelte";
import Notify from "./Notify.svelte";
import { pathText, rank, rankBy, wtScore } from "./filter.js";
import { ancestorDirs, splitPath } from "../parse.ts";
import { ICON, LAYOUTS } from "./icons.js";
import { combo, label as keyLabel, resolve } from "./keys.js";
import {
  collapse,
  isX,
  loadLayout,
  loadSettings,
  paneSize,
  prefs,
  resize,
  saveLayout,
  saveSettings,
  setPreset,
  toggleMax,
  zoomBy,
} from "./prefs.svelte.js";
import {
  act,
  applyTheme,
  clickCell,
  copy,
  loadThemes,
  scrollRow,
  ui,
} from "./ui.svelte.js";
import { menu, menuSession } from "./menu.svelte.js";
import { applyRows, rows, toggleAll, toggleCheck } from "./rows.svelte.js";
import {
  discardArm,
  nav,
  onFs,
  onReady,
  onRows,
  openAt,
  pick,
  selectWt,
  setBase,
  urlQuery,
} from "./nav.svelte.js";
import {
  full,
  loadAgents,
  loadDetails,
  resume,
  terminal,
} from "./agents.svelte.js";
import { repoItems, toggleAutoRebase, wtItems } from "./wtActions.js";

loadSettings();
loadLayout().then((t) => t && applyTheme(t, false));

$effect(() => {
  document.documentElement.style.fontSize = prefs.zoom === 1
    ? ""
    : `${prefs.zoom * 100}%`;
});

// Dismissing hides this text; a different failure shows again.
let prOffHidden = $state("");
let b1El = $state(), b2El = $state();
let notify = $state();
loadThemes();
loadAgents();

// Browsers cap HTTP/1.1 at 6 connections per host and each SSE stream holds
// one, so only visible tabs keep a stream. A reconnect gets a full snapshot.
let hidden = $state(document.hidden);
const onVis = () => (hidden = document.hidden);
document.addEventListener("visibilitychange", onVis);
$effect(() => () => document.removeEventListener("visibilitychange", onVis));

$effect(() => {
  if (hidden) return;
  const es = new EventSource("/api/events");
  es.onopen = () => notify?.refresh();
  es.addEventListener("notify", (e) => notify?.push(JSON.parse(e.data)));
  es.addEventListener("fs", (e) => onFs(JSON.parse(e.data)));
  es.addEventListener("status", (e) => {
    rows.boot = JSON.parse(e.data);
    if (rows.boot.phase === "ready") onReady();
  });
  es.onmessage = (e) => onRows(applyRows(JSON.parse(e.data)));
  return () => es.close();
});

$effect(() => {
  if (!prefs.settings) return;
  const tick = setInterval(
    () => (ui.now = Date.now()),
    prefs.settings.agoRefreshMs,
  );
  return () => clearInterval(tick);
});

$effect(() => {
  if (nav.restoring) return;
  const q = urlQuery();
  history.replaceState(
    null,
    "",
    q.size ? "?" + q.toString() : location.pathname,
  );
});

function drag(e, n, el) {
  e.preventDefault();
  prefs.max = null;
  const x = isX(n);
  const p0 = x ? e.clientX : e.clientY;
  const s0 = x ? el.offsetWidth : el.offsetHeight;
  const mv = (m) => resize(n, el, s0 + (x ? m.clientX : m.clientY) - p0);
  const up = () => {
    removeEventListener("mousemove", mv);
    removeEventListener("mouseup", up);
    saveLayout();
  };
  addEventListener("mousemove", mv);
  addEventListener("mouseup", up);
}

function gutterKey(e, n, el) {
  if (e.key === "Enter") return collapse(n);
  const d =
    (isX(n)
      ? { ArrowLeft: -20, ArrowRight: 20 }
      : { ArrowUp: -20, ArrowDown: 20 })[e.key];
  if (!d) return;
  e.preventDefault();
  prefs.max = null;
  resize(n, el, (isX(n) ? el.offsetWidth : el.offsetHeight) + d);
  saveLayout();
}

let paletteOpen = $state(false);
let grepQ = $state("");
let grepHits = $state([]);

async function grep(v) {
  grepQ = v;
  const wt = nav.sel;
  const hits = v
    ? await fetch(
      `/api/grep?wt=${encodeURIComponent(wt)}&q=${encodeURIComponent(v)}`,
    ).then((r) => r.json())
    : [];
  if (grepQ === v && nav.sel === wt) grepHits = hits;
}
let palTree = $state({ of: null, files: [], dirs: [] });

const desktop = () => prefs.settings?.desktop;
const hasFile = () => nav.sel && nav.file;
const termDir = () =>
  nav.selDir || nav.file?.split("/").slice(0, -1).join("/") || undefined;
function goWt(w) {
  selectWt(w.path);
  scrollRow(w.path);
}
function stepWt(d) {
  const i = rows.navWts.findIndex((w) => w.path === nav.sel);
  goWt(
    rows
      .navWts[Math.max(0, Math.min(rows.navWts.length - 1, i < 0 ? 0 : i + d))],
  );
}
const liveWt = () => !nav.loose && nav.selWt;
const focusedWt = () => {
  const el = document.activeElement;
  const path = el?.matches(".wt, .wt .cbx") && el.closest(".wt").dataset.path;
  return path && rows.allWts.find((w) => w.path === path && !w.isPrimary);
};

// Runs a t / c / l action on the popover's session, then closes the popover.
function onSession(fn) {
  const a = menuSession();
  menu.el?.hidePopover();
  fn(a);
}
const COMMANDS = [
  {
    id: "palette",
    label: "Command palette",
    keys: "cmd+k, cmd+p",
    run: () => (paletteOpen = !paletteOpen),
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    keys: "shift+slash, cmd+slash",
    run: () => (shortcutsOpen = !shortcutsOpen),
  },
  {
    id: "open-path",
    label: "Open path…",
    keys: "cmd+o",
    run: () => ui.refs.files?.editPath(),
  },
  {
    id: "settings",
    label: "Settings",
    keys: "cmd+comma",
    run: () => ui.refs.settings.toggle(),
  },
  {
    id: "next-wt",
    label: "Next worktree",
    section: "Worktrees",
    keys: "j",
    when: () => rows.navWts.length,
    run: () => stepWt(1),
  },
  {
    id: "prev-wt",
    label: "Previous worktree",
    section: "Worktrees",
    keys: "k",
    when: () => rows.navWts.length,
    run: () => stepWt(-1),
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `pinned-${n}`,
    label: `Pinned worktree ${n}`,
    section: "Worktrees",
    keys: `ctrl+${n}`,
    when: () => rows.pinnedWts[n - 1],
    run: () => goWt(rows.pinnedWts[n - 1]),
  })),
  {
    id: "auto-rebase",
    get label() {
      return liveWt()?.autoRebase
        ? "Disable auto-rebase"
        : "Enable auto-rebase";
    },
    section: "Worktrees",
    keys: "alt+cmd+r",
    when: () =>
      liveWt() && !nav.selWt.isPrimary && !ui.busy["ar:" + nav.selWt.path] &&
      (nav.selWt.autoRebase || nav.selWt.pr?.state !== "MERGED"),
    run: (e) => toggleAutoRebase(nav.selWt, e),
  },
  {
    id: "toggle-select",
    label: "Select worktree",
    section: "Worktrees",
    keys: "space",
    when: () => !!focusedWt(),
    run: (e) => {
      const w = focusedWt();
      if (w) toggleCheck(w, e);
    },
  },
  {
    id: "open-terminal",
    label: "Open terminal here",
    section: "Worktrees",
    keys: "ctrl+backquote",
    when: () => nav.sel,
    run: (e) =>
      act("terminal", { wt: nav.sel, path: termDir() }, "term:" + nav.sel, e),
  },
  {
    id: "reveal",
    label: "Reveal in Finder",
    section: "Files",
    keys: "alt+shift+cmd+r",
    when: () => nav.sel && (nav.selDir || nav.file),
    run: (e) =>
      act(
        "reveal",
        { wt: nav.sel, path: nav.selDir || nav.file },
        "reveal:" + nav.sel,
        e,
      ),
  },
  {
    id: "trash",
    label: "Move to Trash",
    section: "Files",
    keys: "cmd+backspace",
    // ⌘⌫ deletes a line while typing, so never steal it from a field or the editor
    when: () =>
      nav.sel && (nav.selDir || nav.file) &&
      !document.activeElement?.closest(
        "input, textarea, select, [contenteditable]",
      ),
    run: () => discardArm({ path: nav.selDir || nav.file, del: true }),
  },
  {
    id: "copy-ticket",
    label: "Copy ticket link",
    section: "Worktrees",
    keys: "alt+cmd+t",
    when: () => liveWt() && liveWt().ticket,
    run: (e) => copy(e, liveWt().ticket.url, "kbd"),
  },
  {
    id: "agent-sessions",
    label: "Agent sessions…",
    section: "Agent sessions",
    keys: "a",
    when: () => liveWt()?.agents?.length,
    run: () => clickCell(nav.selWt, "agent"),
  },
  {
    id: "pr-card",
    label: "Pull request…",
    section: "Worktrees",
    keys: "p",
    when: () => liveWt()?.pr,
    run: () => clickCell(nav.selWt, "pr"),
  },
  {
    id: "agent-resume",
    get label() {
      const a = liveWt()?.agents?.[0];
      return `Resume ${a?.label ?? "agent"} session`;
    },
    section: "Agent sessions",
    keys: "alt+cmd+a",
    when: () => liveWt()?.agents?.length,
    run: (e) => {
      loadDetails(nav.selWt);
      resume(nav.selWt.agents[0], e);
    },
  },
  {
    id: "session-terminal",
    label: "Resume session in terminal",
    section: "Agent sessions",
    keys: "t",
    when: menuSession,
    run: (e) => onSession((a) => terminal(a, e)),
  },
  {
    id: "session-copy-id",
    label: "Copy session ID",
    section: "Agent sessions",
    keys: "c",
    when: menuSession,
    run: (e) => onSession((a) => copy(e, a.id, "kbd")),
  },
  {
    id: "session-copy-link",
    label: "Copy session resume link",
    section: "Agent sessions",
    keys: "l",
    when: menuSession,
    run: (e) => onSession((a) => copy(e, full(a).url, "kbd", "resume link")),
  },
  ...["Worktrees", "Files", "Source"].map((name, i) => ({
    id: `max-${name.toLowerCase()}`,
    get label() {
      return `${prefs.max === i + 1 ? "Restore" : "Maximize"} ${name}`;
    },
    section: "View",
    keys: `alt+cmd+${i + 1}`,
    run: () => toggleMax(i + 1),
  })),
  {
    id: "cycle-mode",
    label: "Cycle text, preview and hex",
    section: "View",
    keys: "alt+cmd+v",
    when: () => hasFile() && nav.modeList.length > 1 && !nav.diffDirty,
    run: () => ui.refs.source?.cycleMode(),
  },
  {
    id: "filter-branches",
    label: "Focus branch filter",
    section: "Worktrees",
    keys: "alt+cmd+b",
    run: () => focusFilter(1, () => ui.refs.wts?.focusFilter()),
  },
  {
    id: "filter-files",
    label: "Focus file filter",
    section: "Files",
    keys: "alt+cmd+f",
    run: () => focusFilter(2, () => ui.refs.files?.focusFilter()),
  },
  {
    id: "find",
    label: "Find in file",
    section: "View",
    keys: "cmd+f",
    when: () => hasFile() && nav.mode === "text" && !nav.srcBinary,
    run: () => ui.refs.source?.focusFind(),
  },
  {
    id: "copy-path",
    label: "Copy path (relative)",
    section: "Files",
    keys: "alt+shift+cmd+c",
    when: hasFile,
    run: (e) => copy(e, nav.file, "kbd"),
  },
  {
    id: "copy-path-abs",
    label: "Copy path (absolute)",
    section: "Files",
    keys: "alt+cmd+c",
    when: hasFile,
    run: (e) => copy(e, `${nav.sel}/${nav.file}`, "kbd"),
  },
  {
    id: "zoom-in",
    label: "Zoom in",
    section: "View",
    keys: "cmd+equal, shift+cmd+equal, cmd+numpadadd",
    when: desktop,
    run: () => zoomBy(0.1),
  },
  {
    id: "zoom-out",
    label: "Zoom out",
    section: "View",
    keys: "cmd+minus, cmd+numpadsubtract",
    when: desktop,
    run: () => zoomBy(-0.1),
  },
  {
    id: "zoom-reset",
    label: "Reset zoom",
    section: "View",
    keys: "cmd+0, cmd+numpad0",
    when: desktop,
    run: () => zoomBy(0),
  },
];
const keymap = $derived(resolve(COMMANDS, prefs.settings?.keys));
const kbdOf = (id) => keymap.byId[id]?.[0] && keyLabel(keymap.byId[id][0]);

async function focusFilter(n, focus) {
  if (prefs.max && prefs.max !== n) prefs.max = null;
  await tick();
  focus();
}

function runKey(e) {
  const k = !e.defaultPrevented && !e.isComposing && combo(e);
  const c = k && COMMANDS.find((c) => c.id === keymap.byCombo.get(k));
  if (!c || (c.when && !c.when())) return;
  if (
    !/ctrl|alt|cmd/.test(k) &&
    e.target.closest?.("input, textarea, select, [contenteditable]")
  ) return;
  e.preventDefault();
  c.run(e);
}

let shortcutsOpen = $state(false);
function bindKey(id, k) {
  const { [id]: _, ...rest } = prefs.settings.keys;
  prefs.settings.keys = k ? { ...rest, [id]: k } : rest;
  saveSettings();
}

$effect(() => {
  const wt = nav.sel;
  if (!paletteOpen || !wt || nav.treeOf === wt || nav.loose) return;
  fetch(`/api/tree?wt=${encodeURIComponent(wt)}`).then((r) => r.json())
    .then((t) => {
      if (nav.sel === wt) palTree = { of: wt, files: t.files, dirs: t.dirs };
    });
});

const asPalette = (items, detail) =>
  items.filter((i) => i && i !== "-").map((i) => ({
    ...i,
    kbd: i.kbd || (i.cmd && kbdOf(i.cmd)),
    group: "action",
    detail,
  }));

const paletteItems = $derived.by(() => {
  if (!paletteOpen) return [];
  const t = nav.treeOf === nav.sel || nav.loose
    ? { files: nav.tree, dirs: nav.treeDirs }
    : palTree.of === nav.sel
    ? palTree
    : { files: [], dirs: [] };
  const pathItems = (kind, paths) =>
    paths.map((p) => {
      const [dir, name] = splitPath(p);
      return {
        group: kind === "dir" ? "folder" : "file",
        label: name,
        detail: dir || undefined,
        fn: () =>
          openAt({ wt: nav.sel, loose: nav.loose, kind, rel: p, line: 0 }),
      };
    });
  const cmd = (label, fn, kbd) => ({ group: "command", label, fn, kbd });
  const wtItem = (w) => ({
    group: "worktree",
    label: w.branch,
    detail: [
      w.repo,
      w.pr && `#${w.pr.number} ${w.pr.title}`,
      w.procs?.map((p) => [p.command, ...p.ports.map((n) => `:${n}`)].join(" "))
        .join(" · "),
    ].filter(Boolean).join(" · "),
    fn: () => {
      selectWt(w.path);
      scrollRow(w.path);
    },
    sub: () => asPalette(wtItems(w, true), w.branch),
  });
  return [
    ...[...rows.allWts].sort((a, b) =>
      !!prefs.pinned[b.path] - !!prefs.pinned[a.path] ||
      b.lastActivity - a.lastActivity
    ).map(wtItem),
    ...(nav.selWt && !nav.loose
      ? asPalette(wtItems(nav.selWt, true), nav.selWt.branch)
        .filter((i) => !COMMANDS.some((c) => c.label === i.label))
      : []),
    ...LAYOUTS.map(([p, name]) => cmd(`${name} layout`, () => setPreset(p))),
    ...(nav.loose ? [] : [
      cmd("Since branch point", () => setBase("branch")),
      cmd("Uncommitted", () => setBase("head")),
      cmd("All files", () => setBase("all")),
    ]),
    cmd("Toggle wrap", () => {
      prefs.wrap = !prefs.wrap;
      saveLayout();
    }),
    cmd(`${rows.allClosed ? "Expand" : "Collapse"} all worktrees`, toggleAll),
    {
      ...cmd("Filter branches…"),
      query: () => rows.q,
      onquery: (v) => (rows.q = v),
      sub: () =>
        rankBy(rows.shownWts, 50, (w) => wtScore(rows.q, w)).map(wtItem),
    },
    ...(nav.sel
      ? [{
        ...cmd("Filter files…"),
        query: () => nav.fq,
        onquery: (v) => (nav.fq = v),
        sub: () =>
          rank(
            nav.fq,
            nav.explore ? nav.tree : nav.files.map((f) => f.path),
            50,
            pathText,
          )
            .map((p) => ({
              group: "file",
              label: splitPath(p)[1],
              detail: splitPath(p)[0] || undefined,
              fn: () => (pick({ path: p }), scrollRow(p)),
            })),
      }, {
        ...cmd("Grep…"),
        query: () => grepQ,
        onquery: grep,
        sub: () =>
          grepHits.map((h) => ({
            group: "match",
            label: h.text,
            detail: `${h.path}:${h.line}`,
            fn: () =>
              openAt({
                wt: nav.sel,
                loose: nav.loose,
                kind: "file",
                rel: h.path,
                line: h.line,
              }),
          })),
      }]
      : []),
    cmd("Dirty only", () => (rows.dirtyOnly = !rows.dirtyOnly)),
    cmd("Running only", () => (rows.runningOnly = !rows.runningOnly)),
    ...COMMANDS.filter((c) => c.id !== "palette" && (!c.when || c.when()))
      .map((c) => cmd(c.label, c.run, kbdOf(c.id))),
    {
      ...cmd("Theme…", () => ui.refs.settings.open()),
      sub: () =>
        ["default", ...ui.themes].map((name) =>
          cmd(name, () => applyTheme(name))
        ),
    },
    ...rows.repos.map((r) => ({
      group: "repo",
      label: r.name,
      detail: r.path,
      fn: async () => {
        prefs.closed.__all = false;
        prefs.closed[r.name] = false;
        saveLayout();
        await tick();
        document.querySelector(`[data-repo="${CSS.escape(r.name)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      },
      sub: () => asPalette(repoItems(r, r.worktrees), r.name),
    })),
    ...pathItems("dir", [...new Set([...ancestorDirs(t.files), ...t.dirs])]),
    ...pathItems("file", t.files),
  ];
});
</script>

<svelte:window
  onkeydown={runKey}
/>

<div class="app" class:desktop={prefs.settings?.desktop}>
  <div class="tbar">
    <svg class="mark" width="18" height="18" viewBox="0 0 24 24" fill="none" role="img" aria-label="forest">
      <path d="M5.2 8.6 L7.3 13.8 L6.2 13.8 L8.9 19 L1.5 19 L4.2 13.8 L3.1 13.8 Z" fill="var(--mark2)"/>
      <path d="M18.9 10.6 L20.9 14.8 L19.8 14.8 L22.5 19 L15.3 19 L18 14.8 L16.9 14.8 Z" fill="var(--mark2)"/>
      <path d="M12 3.4 L14.6 8.6 L13.1 8.6 L16.1 13.8 L14.6 13.8 L17.1 19 L6.9 19 L9.4 13.8 L7.9 13.8 L10.9 8.6 L9.4 8.6 Z" fill="var(--acc)"/>
    </svg>
    <span class="path">{prefs.settings?.root ?? ""}</span>
    <span class="sp"></span>
    <button class="omni" onclick={() => (paletteOpen = true)}>
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>
      Search worktrees, files, commands{#if kbdOf("palette")}<kbd>{kbdOf("palette")}</kbd>{/if}</button>
    <span class="sp"></span>
    <div class="seg layouts" role="group" aria-label="Layout">
      {#each LAYOUTS as [p, name, d] (p)}
        <button class:on={prefs.preset === p} title="{name} layout" aria-label="{name} layout"
                aria-pressed={prefs.preset === p} onclick={() => setPreset(p)}>
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d={d}/></svg></button>
      {/each}
    </div>
    <Notify bind:this={notify} />
    <button class="circ" title="Settings {kbdOf('settings') ?? ''}" aria-label="Settings" onclick={() => ui.refs.settings.open()}>
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
  </div>

  {#if ui.banner}
    <div class="banner t-band" data-tone={ui.banner.kind}>
      <span>{ui.banner.text}</span><span class="sp"></span>
      {#each ui.banner.actions as a (a.label)}
        <button class="btn" class:p={a.primary} onclick={a.fn}>{a.label}</button>
      {/each}
    </div>
  {/if}

  {#if rows.prOff && rows.prOff.text !== prOffHidden}
    <div class="banner t-band" data-tone="warn" role="status" title={rows.prOff.detail}>
      <span>{rows.prOff.text}</span><span class="sp"></span>
      <button class="btn ib" title="Dismiss" aria-label="Dismiss"
              onclick={() => (prOffHidden = rows.prOff.text)}><Icon d={ICON.x} /></button>
    </div>
  {/if}

  {#if prefs.ready}
  <div class="panes {prefs.preset}" class:max={prefs.max} style:--b1={paneSize(1)} style:--b2={paneSize(2)}>
  <div class="band wts" class:maxed={prefs.max === 1} bind:this={b1El}>
    <WorktreesPane bind:this={ui.refs.wts} {kbdOf} />
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="gutter g1" class:x={isX(1)} role="separator" tabindex="0"
       aria-orientation={isX(1) ? "vertical" : "horizontal"}
       onmousedown={(e) => drag(e, 1, b1El)} ondblclick={() => collapse(1)}
       onkeydown={(e) => gutterKey(e, 1, b1El)}></div>

  <div class="band files" class:maxed={prefs.max === 2} bind:this={b2El}>
    <FilesPane bind:this={ui.refs.files} {kbdOf} />
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="gutter g2" class:x={isX(2)} role="separator" tabindex="0"
       aria-orientation={isX(2) ? "vertical" : "horizontal"}
       onmousedown={(e) => drag(e, 2, b2El)} ondblclick={() => collapse(2)}
       onkeydown={(e) => gutterKey(e, 2, b2El)}></div>

  <div class="band sourceband" class:maxed={prefs.max === 3}>
    <SourcePane bind:this={ui.refs.source} {kbdOf} />
  </div>
  </div>
  {/if}
  <Menu {kbdOf} {keymap} />
  <Card />
</div>

<Palette items={paletteItems} bind:open={paletteOpen} />
<Shortcuts commands={COMMANDS} {keymap} onbind={bindKey}
  bind:open={shortcutsOpen} />

<Settings bind:this={ui.refs.settings} {kbdOf}
  onshortcuts={() => (shortcutsOpen = true)} />

<style>
.omni {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2rem;
  width: min(24rem, 40vw);
  padding: 0 0.375rem 0 0.75rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--input);
  color: var(--dimmer);
  font: 0.8125rem var(--sans);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.omni:hover {
  border-color: var(--dimmer);
}
.omni kbd {
  margin-left: auto;
  padding: 0 0.3125rem;
  border: 1px solid var(--line);
  border-radius: 0.375rem;
  background: var(--bg3);
  color: var(--dim);
  font: 0.6875rem var(--mono);
}
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 0 0.5rem 0.5rem;
}
.tbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  height: 3rem;
  padding: 0 0.25rem;
  flex: none;
}
.app.desktop .tbar {
  padding-left: calc(82px - 0.5rem);
  min-height: 34px;
}
.tbar .mark {
  flex: none;
}
.tbar .path {
  color: var(--dimmer);
  font: 0.6875rem var(--mono);
}

.panes {
  flex: 1;
  min-height: 0;
  display: grid;
}
.panes.stack {
  grid-template:
    "w" minmax(var(--head), var(--b1))
    "g1" 0.625rem
    "f" minmax(var(--head), var(--b2))
    "g2" 0.625rem
    "d" minmax(var(--head), 1fr) / minmax(0, 1fr);
}
.panes.sidebar {
  grid-template:
    "w g1 f" minmax(var(--head), var(--b2))
    "w g1 g2" 0.625rem
    "w g1 d" minmax(var(--head), 1fr) /
    minmax(14rem, var(--b1)) 0.625rem minmax(14rem, 1fr);
}
.panes.columns {
  grid-template:
    "w g1 f g2 d" minmax(0, 1fr) /
    minmax(14rem, var(--b1)) 0.625rem minmax(14rem, var(--b2)) 0.625rem
    minmax(14rem, 1fr);
}
.panes.rail {
  grid-template:
    "w g2 d" minmax(var(--head), var(--b1))
    "g1 g2 d" 0.625rem
    "f g2 d" minmax(var(--head), 1fr) /
    minmax(14rem, var(--b2)) 0.625rem minmax(14rem, 1fr);
}
.panes.max {
  grid-template: "m" minmax(0, 1fr) / minmax(0, 1fr);
}
.panes.max > :not(.maxed) {
  display: none;
}
.panes.max > .maxed {
  grid-area: m;
}
.wts {
  grid-area: w;
}
.files {
  grid-area: f;
}
.sourceband {
  grid-area: d;
}
.g1 {
  grid-area: g1;
}
.g2 {
  grid-area: g2;
}
.gutter {
  display: grid;
  place-items: center;
  cursor: row-resize;
  outline: none;
}
.gutter.x {
  cursor: col-resize;
}
.gutter::after {
  content: "";
  width: 2.25rem;
  height: 0.25rem;
  border-radius: 999px;
  background: var(--line);
}
.gutter.x::after {
  width: 0.25rem;
  height: 2.25rem;
}
.gutter:hover::after,
.gutter:focus-visible::after {
  background: var(--acc);
}
.seg.layouts {
  flex: none;
}
.seg.layouts button {
  display: grid;
  place-items: center;
  padding: 0.25rem 0.5rem;
}
.banner {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.625rem 0.5rem 1rem;
  margin-bottom: 0.5rem;
  font-size: 0.75rem;
  flex: none;
  border-radius: 0.875rem;
}
.banner .sp {
  flex: 1;
}
</style>
