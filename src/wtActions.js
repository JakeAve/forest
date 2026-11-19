import { branchUrl, clip, prAb, prStatus, relWt, renamed } from "../parse.ts";
import { prefs, saveLayout } from "./prefs.svelte.js";
import { act, ago, copy, ui } from "./ui.svelte.js";
import { askInCard, drill } from "./menu.svelte.js";
import {
  isOpen,
  match,
  repoOf,
  rows,
  toggleAll,
  toggleRepo,
} from "./rows.svelte.js";
import { nav, selectWt } from "./nav.svelte.js";
import { agentItems } from "./agents.svelte.js";

export const rowBusy = (w) =>
  Object.keys(ui.busy).some((k) => k.endsWith(":" + w.path)) ||
  w.procs?.some((p) => ui.killing[p.pid]) ||
  w.agents?.some((a) => ui.busy["ag:" + a.id] || ui.busy["at:" + a.id]);

export async function killPid(p, e) {
  ui.killing[p.pid] = true;
  setTimeout(() => delete ui.killing[p.pid], 10_000);
  if (!await act("kill-pid", { pid: p.pid }, "kill:" + p.pid, e)) {
    delete ui.killing[p.pid];
  }
}
export const killItem = (p) => ({
  label: `Kill ${clip(p.command, 32)} (pid ${p.pid})`,
  danger: true,
  fn: (e) => killPid(p, e),
});
const portsOf = (p) => p.ports.map((n) => `:${n}`).join(" ");
export const procPreview = (p) =>
  [p.command.split(" ")[0].split("/").pop(), p.ports[0] && `:${p.ports[0]}`]
    .filter(Boolean)
    .join(" ");
export const procTip = (w) =>
  w.procs.slice(0, 8).map((p) => [clip(p.command, 40), portsOf(p)].join(" "))
    .concat(w.procs.length > 8 ? [`+${w.procs.length - 8} more`] : [])
    .join("\n") + "\nclick to view";
const procSub = (p) =>
  [
    portsOf(p),
    `pid ${p.pid}`,
    p.since && `up ${ago(p.since)}`,
    `${p.mb} MB`,
    `${p.cpu}%`,
  ]
    .filter(Boolean).join(" · ");
export function procItems(w) {
  const n = w.procs.length;
  return [
    { head: n > 1 ? `Running · ${n} processes` : "Running" },
    ...w.procs.map((p) => ({
      label: clip(p.command, 56),
      sub: procSub(p),
      tip: p.args,
      keep: true,
      fn: (e) => drill(procActions(w, p), e),
    })),
  ];
}
const procActions = (w, p) => [
  { head: "Process actions" },
  {
    label: `‹ ${clip(p.command, 40)}`,
    sub: procSub(p),
    tip: "Back to all processes",
    kbd: "←",
    back: true,
    keep: true,
    fn: (e) => drill(procItems(w), e),
  },
  "-",
  ...p.ports.map((port) => ({
    label: `Open :${port}`,
    fn: () => open(`http://localhost:${port}`, "_blank", "noreferrer"),
  })),
  {
    label: "Copy command",
    sub: clip(p.args, 56),
    tip: p.args,
    fn: (e) => copy(e, p.args, "ctx", "command"),
  },
  {
    label: "Copy pid",
    sub: String(p.pid),
    fn: (e) => copy(e, String(p.pid), "ctx"),
  },
  "-",
  killItem(p),
];
export const rebase = (w, e) =>
  act("rebase", { wt: w.path }, "rb:" + w.path, e);
export const updateBranch = (w, e) =>
  act("update-branch", { wt: w.path, number: w.pr.number }, "ub:" + w.path, e);
export const toggleAutoRebase = (w, e) =>
  act("auto-rebase", { wt: w.path, enable: !w.autoRebase }, "ar:" + w.path, e);
export const toggleAutoClose = (w, e) =>
  act("auto-close", { wt: w.path, enable: !w.autoClose }, "ac:" + w.path, e);
export const toggleAutoMerge = (w, e) =>
  act(
    "auto-merge",
    { wt: w.path, number: w.pr.number, enable: !w.pr.autoMerge },
    "am:" + w.path,
    e,
  );
export const push = (w, e) =>
  act(
    "push",
    { wt: w.path, remote: w.remote, branch: w.branch },
    "push:" + w.path,
    e,
  );
const prState = (w, action, e) =>
  act(
    "pr-state",
    { wt: w.path, number: w.pr.number, action },
    "ps:" + w.path,
    e,
  );

// The PR actions available on w. One list so the card's buttons and the
// context menu can't drift: `label` is the card's, `menu` the wordier one, and
// `confirm` is the question the card asks before an irreversible action.
export function prActions(w) {
  const p = w.pr;
  if (p?.state !== "OPEN") return [];
  const behind = prAb(w).behind;
  const ahead = prAb(w).ahead;
  const ps = ui.busy["ps:" + w.path]?.action;
  return [
    prStatus(p).tone === "ok" && !p.queue && {
      key: "merge",
      label: "Merge squash",
      menu: `Merge pull request #${p.number} (squash)`,
      cls: "ok",
      confirm: `Squash ${ahead} commit${
        ahead === 1 ? "" : "s"
      } into ${p.baseRefName}?`,
      wait: ps === "merge",
      go: (e) => prState(w, "merge", e),
    },
    behind > 0 && !p.queue && {
      key: "update",
      label: `Update branch ↓${behind}`,
      menu: `Update branch (↓${behind} from ${p.baseRefName})`,
      cls: "warn",
      wait: !!ui.busy["ub:" + w.path],
      go: (e) => updateBranch(w, e),
    },
    {
      key: "draft",
      label: p.isDraft ? "Ready for review" : "Convert to draft",
      menu: p.isDraft ? "Publish pull request" : "Convert to draft",
      cls: "",
      wait: ps === "ready" || ps === "draft",
      go: (e) => prState(w, p.isDraft ? "ready" : "draft", e),
    },
    {
      key: "close",
      label: "Close",
      menu: `Close pull request #${p.number}`,
      cls: "dg",
      confirm: `Close #${p.number} without merging?`,
      wait: ps === "close",
      go: (e) => prState(w, "close", e),
    },
  ].filter(Boolean);
}

export function repoItems(r, shown) {
  const wts = shown.filter((w) => !w.isPrimary);
  return [
    r.path && {
      label: "New worktree…",
      fn: () => {
        rows.creating = r.name;
        rows.slug = "";
      },
    },
    "-",
    {
      label: `Copy ${shown.length} branch names`,
      fn: (e) =>
        copy(
          e,
          shown.map((w) => w.branch).join("\n"),
          "ctx",
          `${shown.length} branch names`,
        ),
    },
    r.path && { label: "Copy repo path", fn: (e) => copy(e, r.path, "ctx") },
    "-",
    {
      label: isOpen(r.name) ? "Collapse" : "Expand",
      fn: () => toggleRepo(r.name),
    },
    wts.length > 0 && {
      label: r.path
        ? `Select ${wts.length} worktree${wts.length === 1 ? "" : "s"}`
        : `Select all in ${r.label}`,
      fn: () => {
        for (const w of wts) rows.checked[w.path] = true;
      },
    },
    wts.length > 0 && "-",
    wts.length > 0 && {
      label: `Remove ${wts.length} worktree${wts.length === 1 ? "" : "s"}…`,
      danger: true,
      fn: () => ((rows.confirmSel = false), (rows.confirming = wts)),
    },
  ];
}

export const allItems = () => [
  { label: rows.allClosed ? "Expand all" : "Collapse all", fn: toggleAll },
  {
    label: "Select all shown",
    fn: () => {
      for (const w of rows.selectable) rows.checked[w.path] = true;
    },
  },
];

export function wtItems(w, solo = false) {
  const t = !solo && rows.checked[w.path] && rows.checkedWts.length > 1
    ? rows.checkedWts
    : [w];
  const many = t.length > 1;
  const pin = t.every((x) => prefs.pinned[x.path]);
  const branches = t.map((x) => x.branch).join("\n");
  const paths = t.map((x) => x.path).join("\n");
  return [
    !many && { label: "Open", fn: () => selectWt(w.path) },
    !many && {
      label: "Open terminal here",
      cmd: w === nav.selWt && !nav.selDir && !nav.file && "open-terminal",
      fn: (e) => act("terminal", { wt: w.path }, "term:" + w.path, e),
    },
    !many && "-",
    ...(many ? [] : agentItems(w)),
    {
      label: many ? `Copy ${t.length} branch names` : "Copy branch name",
      fn: (e) =>
        copy(e, branches, "ctx", many ? `${t.length} branch names` : w.branch),
    },
    !many && renamed(w) && {
      label: "Copy remote branch name",
      fn: (e) => copy(e, w.remote, "ctx"),
    },
    {
      label: many ? `Copy ${t.length} paths` : "Copy path",
      fn: (e) => copy(e, paths, "ctx", many ? `${t.length} paths` : w.path),
    },
    !many && {
      label: "Copy path (relative)",
      fn: (e) => copy(e, relWt(repoOf(w), w), "ctx"),
    },
    "-",
    !many && branchUrl(repoOf(w), w) && {
      label: "Open remote branch",
      fn: () => open(branchUrl(repoOf(w), w), "_blank", "noreferrer"),
    },
    !many && w.pr && {
      label: `View pull request #${w.pr.number}`,
      fn: () => open(w.pr.url, "_blank", "noreferrer"),
    },
    !many && w.ticket && {
      label: `Open ticket ${w.ticket.key}`,
      fn: () => open(w.ticket.url, "_blank", "noreferrer"),
    },
    !many && w.ticket && {
      label: "Copy ticket link",
      cmd: w === nav.selWt && "copy-ticket",
      fn: (e) => copy(e, w.ticket.url, "ctx"),
    },
    !many && repoOf(w)?.webUrl && (!w.remote || w.ahead > 0) && {
      label: w.remote ? `Push (↑${w.ahead})` : "Push branch to remote",
      fn: (e) => push(w, e),
    },
    !many && repoOf(w)?.webUrl && !w.isPrimary && !w.pr && {
      label: "Compare & open pull request",
      fn: async (e) => {
        if (
          !w.remote && !(await push(w, e))
        ) {
          return;
        }
        open(
          `${repoOf(w).webUrl}/compare/${
            (w.remote ?? w.branch).split("/").map(encodeURIComponent).join("/")
          }?expand=1`,
          "_blank",
          "noreferrer",
        );
      },
    },
    !many && repoOf(w)?.webUrl && !w.isPrimary && !w.pr && {
      label: "Open pull request",
      fn: (e) =>
        act(
          "pr-create",
          { wt: w.path, remote: w.remote, branch: w.branch },
          "pc:" + w.path,
          e,
        ),
    },
    "-",
    {
      label: `${pin ? "Unpin" : "Pin"}${many ? ` ${t.length}` : ""}`,
      fn: () => {
        for (const x of t) {
          if (pin) delete prefs.pinned[x.path];
          else prefs.pinned[x.path] = true;
        }
        saveLayout();
      },
    },
    !many && w.pr?.state === "OPEN" && {
      label: w.pr.autoMerge ? "Disable auto-merge" : "Enable auto-merge",
      fn: (e) => toggleAutoMerge(w, e),
    },
    !many && !w.isPrimary && (w.autoRebase || w.pr?.state !== "MERGED") && {
      label: w.autoRebase ? "Disable auto-rebase" : "Enable auto-rebase",
      cmd: w === nav.selWt && "auto-rebase",
      fn: (e) => toggleAutoRebase(w, e),
    },
    !many && w.ticket?.info && (w.autoClose || w.pr?.state === "OPEN") && {
      label: w.autoClose
        ? "Don't close ticket on merge"
        : "Close ticket on merge",
      fn: (e) => toggleAutoClose(w, e),
    },
    ...(many ? [] : prActions(w).map((a) => ({
      label: a.confirm ? `${a.menu}…` : a.menu,
      danger: a.cls === "dg",
      fn: (e) => a.confirm ? askInCard(w, a, e) : a.go(e),
    }))),
    !many && {
      label: w.isPrimary ? "Pull" : "Fetch + rebase",
      fn: (e) => rebase(w, e),
    },
    !many && w.procs?.length > 0 && "-",
    ...(!many ? (w.procs ?? []).map(killItem) : []),
    !w.isPrimary && "-",
    !w.isPrimary && {
      label: many ? `Remove ${t.length} worktrees…` : "Remove worktree…",
      danger: true,
      fn: () => {
        rows.confirmSel = false;
        rows.confirming = t.filter((x) =>
          !x.isPrimary && (x === w || match(repoOf(x), x))
        );
      },
    },
  ];
}
