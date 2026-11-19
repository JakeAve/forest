import { tick } from "svelte";
import { pathText, rank, rankBy, wtScore } from "./filter.js";
import { ancestorDirs, splitPath } from "../parse.ts";
import { LAYOUTS } from "./icons.js";
import { combo, label as keyLabel, resolve } from "./keys.js";
import {
  prefs,
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
  scrollRow,
  ui,
} from "./ui.svelte.js";
import { menu, menuSession } from "./menu.svelte.js";
import { rows, toggleAll, toggleCheck } from "./rows.svelte.js";
import {
  discardArm,
  nav,
  openAt,
  pick,
  selectWt,
  setBase,
} from "./nav.svelte.js";
import { full, loadDetails, resume, terminal } from "./agents.svelte.js";
import { repoItems, toggleAutoRebase, wtItems } from "./wtActions.js";

async function grep(v) {
  cmds.grepQ = v;
  const wt = nav.sel;
  const hits = v
    ? await fetch(
      `/api/grep?wt=${encodeURIComponent(wt)}&q=${encodeURIComponent(v)}`,
    ).then((r) => r.json())
    : [];
  if (cmds.grepQ === v && nav.sel === wt) cmds.grepHits = hits;
}

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
export const COMMANDS = [
  {
    id: "palette",
    label: "Command palette",
    keys: "cmd+k, cmd+p",
    run: () => (cmds.paletteOpen = !cmds.paletteOpen),
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    keys: "shift+slash, cmd+slash",
    run: () => (cmds.shortcutsOpen = !cmds.shortcutsOpen),
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
export const kbdOf = (id) =>
  cmds.keymap.byId[id]?.[0] && keyLabel(cmds.keymap.byId[id][0]);

async function focusFilter(n, focus) {
  if (prefs.max && prefs.max !== n) prefs.max = null;
  await tick();
  focus();
}

export function runKey(e) {
  const k = !e.defaultPrevented && !e.isComposing && combo(e);
  const c = k && COMMANDS.find((c) => c.id === cmds.keymap.byCombo.get(k));
  if (!c || (c.when && !c.when())) return;
  if (
    !/ctrl|alt|cmd/.test(k) &&
    e.target.closest?.("input, textarea, select, [contenteditable]")
  ) return;
  e.preventDefault();
  c.run(e);
}

export function bindKey(id, k) {
  const { [id]: _, ...rest } = prefs.settings.keys;
  prefs.settings.keys = k ? { ...rest, [id]: k } : rest;
  saveSettings();
}

// App calls this from an effect while the palette is open.
export function loadPalTree() {
  const wt = nav.sel;
  if (!cmds.paletteOpen || !wt || nav.treeOf === wt || nav.loose) return;
  fetch(`/api/tree?wt=${encodeURIComponent(wt)}`).then((r) => r.json())
    .then((t) => {
      if (nav.sel === wt) {
        cmds.palTree = { of: wt, files: t.files, dirs: t.dirs };
      }
    });
}

const asPalette = (items, detail) =>
  items.filter((i) => i && i !== "-").map((i) => ({
    ...i,
    kbd: i.kbd || (i.cmd && kbdOf(i.cmd)),
    group: "action",
    detail,
  }));

class Commands {
  paletteOpen = $state(false);
  shortcutsOpen = $state(false);
  grepQ = $state("");
  grepHits = $state([]);
  palTree = $state({ of: null, files: [], dirs: [] });
  keymap = $derived(resolve(COMMANDS, prefs.settings?.keys));
  paletteItems = $derived.by(() => {
    if (!cmds.paletteOpen) return [];
    const t = nav.treeOf === nav.sel || nav.loose
      ? { files: nav.tree, dirs: nav.treeDirs }
      : cmds.palTree.of === nav.sel
      ? cmds.palTree
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
        w.procs?.map((p) =>
          [p.command, ...p.ports.map((n) => `:${n}`)].join(" ")
        )
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
          query: () => cmds.grepQ,
          onquery: grep,
          sub: () =>
            cmds.grepHits.map((h) => ({
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
}

export const cmds = new Commands();
