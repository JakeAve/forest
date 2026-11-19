import { clip, sessionTag, shortId } from "../parse.ts";
import { prefs } from "./prefs.svelte.js";
import { act, ago, clickCell, copy } from "./ui.svelte.js";
import { drill, menu } from "./menu.svelte.js";

class Agents {
  // Per-agent label, glyph and tone come from the server, so the UI names no
  // agent itself.
  meta = $state({});
  // The snapshot carries slim sessions; the rest (cwd, link, command) is
  // fetched per worktree as its menu opens, so a later copy needs no await.
  details = $state({});
  /** The agent session just resumed, for its toast. */
  opened = $state(null);
}
export const agents = new Agents();

export function loadAgents() {
  return fetch("/api/agents").then((r) => r.json()).then((m) => {
    agents.meta = Object.fromEntries(m.map((x) => [x.agent, x]));
  });
}

const detailsFor = {};
const sKey = (a) => `${a.agent}:${a.id}`;
export const full = (a) => ({
  label: a.agent,
  glyph: "•",
  tone: "dim",
  ...agents.meta[a.agent],
  ...agents.details[sKey(a)],
  ...a,
});

export function loadDetails(w) {
  if ((w.agents ?? []).every((a) => agents.details[sKey(a)])) {
    return Promise.resolve();
  }
  return (detailsFor[w.path] ??= fetch(
    `/api/t/sessions?wt=${encodeURIComponent(w.path)}`,
  ).then((r) => r.json()).then((list) => {
    for (const x of list) agents.details[sKey(x)] = x;
  }).catch(() => {}).finally(() => delete detailsFor[w.path]));
}

export const agentTip = (a) =>
  [
    `${a.label} · ${a.title || "untitled"}`,
    a.id,
    a.cwd && `started in ${a.cwd}`,
    `first mentioned this worktree ${ago(a.seenAt)} ago`,
  ].filter(Boolean).join("\n");

export const badgeTip = (w) =>
  `${full(w.agents[0]).label} · ${w.agents[0].title || "untitled"}\n${
    w.agents.length === 1 ? "1 session" : `${w.agents.length} sessions`
  }, click to view`;

const fmtAt = (ms) =>
  new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

let openedT;
export async function resume(a, e) {
  if (
    await act("agent-resume", { agent: a.agent, id: a.id }, "ag:" + a.id, e)
  ) {
    agents.opened = a;
    clearTimeout(openedT);
    openedT = setTimeout(
      () => (agents.opened = null),
      prefs.settings?.toastMs ?? 7000,
    );
  }
}

export const terminal = (a, e) =>
  act("agent-terminal", { agent: a.agent, id: a.id }, "at:" + a.id, e);

export const tagOf = (w, a) =>
  sessionTag(
    w.agents.findIndex((x) => sKey(x) === sKey(a)),
    w.agents.length,
    a.deep,
  );

export async function showActions(w, a, e) {
  await loadDetails(w);
  drill(sessionActions(w, a), e, a);
}

// Earliest mention first: the first is most likely the session that created it.
export function sessionItems(w) {
  loadDetails(w);
  const all = w.agents ?? [];
  const many = all.length > 1;
  return [
    { head: many ? "Agent sessions · most likely first" : "Agent session" },
    ...all.map((s) => {
      const a = full(s);
      return {
        agent: a,
        label: clip(a.title || `Untitled ${a.label} session`),
        tag: tagOf(w, a),
        sub: `${shortId(a.id)} · ${fmtAt(a.seenAt)}`,
        tip: agentTip(a),
        fn: (e) => resume(a, e),
        more: (e) => showActions(w, s, e),
      };
    }),
    "-",
    {
      label: many ? `Copy ${all.length} session IDs` : "Copy session ID",
      fn: (e) =>
        copy(
          e,
          all.map((a) => a.id).join("\n"),
          "ctx",
          many ? `${all.length} session IDs` : all[0].id,
        ),
    },
  ];
}

export function sessionActions(w, s) {
  const a = full(s);
  const tag = tagOf(w, a);
  return [
    { head: "Session actions" },
    {
      agent: a,
      label: `‹ ${clip(a.title || `Untitled ${a.label} session`, 40)}`,
      sub: [shortId(a.id), fmtAt(a.seenAt), tag].filter(Boolean).join(" · "),
      tip: "Back to all sessions",
      kbd: "←",
      back: true,
      keep: true,
      fn: (e) => drill(sessionItems(w), e),
    },
    "-",
    { label: `Open in ${a.label}`, kbd: "↩", fn: (e) => resume(a, e) },
    {
      label: "Resume in terminal",
      cmd: "session-terminal",
      sub: clip(a.command, 56),
      tip: a.command,
      fn: (e) => terminal(a, e),
    },
    "-",
    {
      label: "Copy session ID",
      cmd: "session-copy-id",
      sub: a.id,
      fn: (e) => copy(e, a.id, "ctx"),
    },
    {
      label: "Copy resume link",
      cmd: "session-copy-link",
      sub: clip(a.url, 56),
      fn: (e) => copy(e, full(a).url, "ctx", "resume link"),
    },
  ];
}

/** `cur`: w is the selected worktree, so its items show their shortcuts. */
export function agentItems(w, cur) {
  if (w.isPrimary && !w.agents?.length) return [];
  const [first, ...rest] = w.agents ?? [];
  if (!first) return [{ label: "No agent session found", disabled: true }, "-"];
  loadDetails(w);
  const a = full(first);
  return [
    {
      agent: a,
      label: `Resume ${a.label} session`,
      cmd: cur && "agent-resume",
      sub: clip(a.title || shortId(a.id)),
      tip: agentTip(a),
      fn: (e) => resume(a, e),
    },
    {
      label: rest.length ? "Agent sessions…" : "Session actions…",
      cmd: cur && "agent-sessions",
      keep: true,
      fn: (e) =>
        !menu.shown
          ? clickCell(w, "agent")
          : rest.length
          ? drill(sessionItems(w), e)
          : showActions(w, first, e),
    },
    { label: "Copy session ID", fn: (e) => copy(e, a.id, "ctx") },
    {
      label: "Copy resume link",
      fn: (e) => copy(e, full(a).url, "ctx", "resume link"),
    },
    "-",
  ];
}
