import { clip, prAb, prStatus } from "../parse.ts";
import { act, ago, copy, ui } from "./ui.svelte.js";
import { drill } from "./menu.svelte.js";
import { isOpen, rows, toggleAll, toggleRepo } from "./rows.svelte.js";

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
