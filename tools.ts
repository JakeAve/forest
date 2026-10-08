import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { matchWt, rank } from "./src/filter.js";
import {
  type Draft,
  type Kind,
  KINDS,
  normPath,
  ownerWorktree,
  qbool,
  qnum,
  selectWt,
  sessionTag,
} from "./parse.ts";
import type { ActionsApi } from "./actions.ts";
import type { AutoCloseApi } from "./autoclose.ts";
import type { AutoRebaseApi } from "./autorebase.ts";
import type { FilesApi } from "./files.ts";
import { factsNow } from "./notify.ts";
import type { StoreApi } from "./store.ts";
import type { SessionsApi } from "./sessions.ts";
import type { Settings } from "./settings.ts";
import type { SessionInfo, WtRow } from "./types.ts";

// ---- tools ----

// No kind: reads, over GET or MCP. "write": undone by calling it again.
// "destructive": refuses anything that would lose work. Writes take POST.
export type Tool = {
  kind?: "write" | "destructive";
  desc: string;
  input: Record<string, z.ZodType>;
  run: (a: Record<string, unknown>) => unknown | Promise<unknown>;
};

// Always active while a worktree exists, or fire on falling: no use to wait on.
const EDGE_ONLY = new Set<string>([
  "wt-added",
  "wt-removed",
  "branch-switched",
  "server-died",
  "automerge-changed",
]);
const WAITABLE = (Object.keys(KINDS) as Kind[]).filter((k) =>
  !EDGE_ONLY.has(k)
);

export class ToolError extends Error {
  candidates?: unknown[];
}

export function createTools(deps: {
  store: StoreApi;
  files: FilesApi;
  settings: Settings;
  home: string;
  sessions: Pick<SessionsApi, "all">;
  actions: Pick<ActionsApi, "autoMerge" | "removeWts">;
  autoRebase: Pick<AutoRebaseApi, "set">;
  autoClose: Pick<AutoCloseApi, "set">;
  log: (o: Record<string, unknown>) => void;
}) {
  const {
    store,
    files,
    settings,
    sessions,
    actions,
    autoRebase,
    autoClose,
    log,
    home: HOME,
  } = deps;
  const { byPath: repoByPath, known: knownWorktrees } = store;

  function wtRows(): WtRow[] {
    return [...repoByPath.values()]
      .flatMap((r) =>
        r.worktrees.map((w) => ({
          ...w,
          webUrl: r.webUrl,
          defaultBranch: r.defaultBranch,
        }))
      )
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  function resolveWt(sel: string): WtRow {
    const hit = selectWt(sel, wtRows(), HOME);
    if ("wt" in hit) return hit.wt;
    const e = new ToolError(
      hit.candidates.length ? "ambiguous worktree" : "no worktree matches",
    );
    // enough to pick one and retry, not each worktree's whole row
    e.candidates = hit.candidates.map(({ repo, branch, path }) => ({
      repo,
      branch,
      path,
    }));
    throw e;
  }

  // ponytail: an abandoned wait holds its timer until timeout; pass req.signal through if they pile up
  const waiters = new Set<(active: Draft[]) => void>();
  const active = () => [
    ...factsNow([...repoByPath.values()], settings, Date.now()).active.values(),
  ];
  function wake() {
    if (!waiters.size) return;
    const a = active();
    for (const w of waiters) w(a);
  }

  const tools: Record<string, Tool> = {
    snapshot: {
      desc: "Every repo forest watches, with its worktrees, status and PRs.",
      input: {},
      run: () =>
        [...repoByPath.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    wts: {
      desc:
        "Worktrees, newest activity first; q fuzzy-matches branch, repo, ticket key and #PR number, or is a substring of an agent session title or id, or is a regex when wrapped in /slashes/.",
      input: {
        q: z.string().optional(),
        dirty: qbool.optional(),
        running: qbool.optional(),
        pr: z.enum(["open", "merged", "closed", "none"]).optional(),
        recent: qnum.optional(),
      },
      run: (a) => {
        const pr = a.pr as string | undefined;
        let rows = wtRows().filter((w) =>
          matchWt(
            {
              q: a.q as string | undefined,
              dirtyOnly: a.dirty as boolean | undefined,
              runningOnly: a.running as boolean | undefined,
            },
            w.repo,
            w,
          )
        );
        if (pr) {
          rows = rows.filter((w) =>
            pr === "none" ? w.pr === null : w.pr?.state === pr.toUpperCase()
          );
        }
        return a.recent === undefined
          ? rows
          : rows.slice(0, a.recent as number);
      },
    },
    whoami: {
      desc: "The worktree that owns a path, or null.",
      input: { path: z.string() },
      run: (a) => {
        const owner = ownerWorktree(
          normPath(String(a.path), HOME),
          [...knownWorktrees.keys()],
        );
        return wtRows().find((w) => w.path === owner) ?? null;
      },
    },
    sessions: {
      desc:
        "Coding agent sessions (Claude Code, Codex, …) linked to worktrees, each with its transcript path, resume link and resume command. By wt (most likely creator first), by id (or a unique prefix) with the worktrees it touched, or q fuzzy-matching titles (/slashes/ for a regex).",
      input: {
        wt: z.string().optional(),
        id: z.string().optional(),
        q: z.string().optional(),
      },
      run: (a) => {
        const info = sessions.all();
        const key = (s: { agent: string; id: string }) => `${s.agent}:${s.id}`;
        const linked = (k: string) =>
          wtRows().flatMap((w) => {
            const i = w.agents.findIndex((s) => key(s) === k);
            if (i < 0) return [];
            const s = w.agents[i];
            return [{
              wt: w.path,
              repo: w.repo,
              branch: w.branch,
              seenAt: s.seenAt,
              tag: sessionTag(i, w.agents.length, s.deep),
            }];
          });
        if (a.wt !== undefined) {
          const w = resolveWt(String(a.wt));
          return w.agents.map((s, i) => ({
            ...info.get(key(s)),
            seenAt: s.seenAt,
            tag: sessionTag(i, w.agents.length, s.deep),
          }));
        }
        if (a.id !== undefined) {
          const id = String(a.id);
          const hits = [...info.values()].filter((s) => s.id.startsWith(id));
          if (hits.length !== 1) {
            const e = new ToolError(
              hits.length ? "ambiguous session id" : "no session matches",
            );
            e.candidates = hits.slice(0, 20).map(({ agent, id, title }) => ({
              agent,
              id,
              title,
            }));
            throw e;
          }
          return { ...hits[0], wts: linked(key(hits[0])) };
        }
        if (a.q !== undefined) {
          return rank(String(a.q), [...info.values()], 20, (s) => s.title)
            .map((s: SessionInfo) => ({ ...s, wts: linked(key(s)) }));
        }
        throw new ToolError("pass wt, id or q");
      },
    },
    files: {
      desc:
        "Changed files in a worktree, since the branch point or uncommitted; q fuzzy-matches the path, or is a regex when wrapped in /slashes/.",
      input: {
        wt: z.string(),
        q: z.string().optional(),
        base: z.enum(["branch", "head"]).optional(),
      },
      run: (a) =>
        files.listFiles(
          resolveWt(String(a.wt)).path,
          String(a.base ?? "branch"),
          a.q as string | undefined,
        ),
    },
    link: {
      desc:
        "A forest URL that opens a worktree, optionally at a file and line.",
      input: {
        wt: z.string(),
        file: z.string().optional(),
        line: z.coerce.number().int().min(0).optional(),
        base: z.enum(["branch", "head"]).optional(),
      },
      run: (a) => {
        const p = new URLSearchParams({ wt: resolveWt(String(a.wt)).path });
        for (const k of ["file", "line", "base"]) {
          if (a[k] !== undefined) p.set(k, String(a[k]));
        }
        const host =
          settings.host === "0.0.0.0" || settings.host === "127.0.0.1"
            ? "forest-app.localhost"
            : settings.host;
        return { url: `http://${host}:${settings.port}/?${p}` };
      },
    },
    wait: {
      desc:
        "Block until a worktree has any of the given event kinds active, or timeout seconds pass (default 600, max 3600). for is comma-separated kinds or groups (act, move, life, clean). Returns the matching events, [] on timeout. An event already active returns at once; pass its key back in seen (comma-separated) to wait for the next one, and a seen key counts again once it clears.",
      input: {
        wt: z.string(),
        for: z.string(),
        seen: z.string().optional(),
        timeout: qnum.pipe(z.number().max(3600)).optional(),
      },
      run: (a) => {
        const w = resolveWt(String(a.wt));
        const want = new Set<string>();
        for (const n of String(a.for).split(",")) {
          const ks = WAITABLE.filter((k) => k === n || KINDS[k].group === n);
          if (!ks.length) {
            throw new ToolError(
              `can't wait for ${n}; use ${WAITABLE.join(", ")}`,
            );
          }
          for (const k of ks) want.add(k);
        }
        const seen = new Set(a.seen ? String(a.seen).split(",") : []);
        const match = (all: Draft[]) => {
          const live = all.filter((d) => d.wt === w.path && want.has(d.kind));
          for (const k of seen) {
            if (!live.some((d) => d.key === k)) seen.delete(k);
          }
          return live.filter((d) => !seen.has(d.key)).map((
            { scope: _, ...d },
          ) => d);
        };
        const hits = match(active());
        const ms = ((a.timeout as number | undefined) ?? 600) * 1000;
        if (hits.length || !ms) return hits;
        return new Promise((resolve) => {
          const done = (out: unknown[]) => {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(out);
          };
          const check = (all: Draft[]) => {
            const h = match(all);
            if (h.length) done(h);
          };
          const timer = setTimeout(() => done([]), ms);
          waiters.add(check);
        });
      },
    },
    set_auto_merge: {
      kind: "write",
      desc:
        "Turn GitHub auto-merge (squash) on or off for a worktree's open PR. GitHub still waits for checks and reviews before merging.",
      input: { wt: z.string(), enable: qbool },
      run: async (a) => {
        const w = resolveWt(String(a.wt));
        if (w.pr && !a.enable && w.pr.state !== "OPEN") {
          return { pr: w.pr.number, autoMerge: false };
        }
        if (w.pr?.state !== "OPEN") throw new ToolError("no open PR");
        await actions.autoMerge(w.path, w.pr.number, a.enable as boolean);
        return { pr: w.pr.number, autoMerge: a.enable };
      },
    },
    set_auto_rebase: {
      kind: "write",
      desc:
        "Turn auto-rebase on or off for a worktree: it follows origin/HEAD on a timer (update-branch on GitHub when it has an open PR), and stops after a conflict until base moves.",
      input: { wt: z.string(), enable: qbool },
      run: async (a) => {
        const w = resolveWt(String(a.wt));
        await autoRebase.set(w.path, a.enable as boolean);
        return { wt: w.path, autoRebase: a.enable };
      },
    },
    set_auto_close: {
      kind: "write",
      desc:
        "Turn close-ticket-on-merge on or off for a worktree: once its PR merges (or now, if it already has), its ticket moves to its done status through the ticket command, then this turns itself off. Safe to arm before the PR exists.",
      input: { wt: z.string(), enable: qbool },
      run: async (a) => {
        const w = resolveWt(String(a.wt));
        if (a.enable && !w.ticket?.info) {
          throw new ToolError("no ticket status");
        }
        await autoClose.set(w.path, a.enable as boolean);
        return {
          wt: w.path,
          ticket: w.ticket?.key ?? null,
          autoClose: a.enable,
        };
      },
    },
    remove_wts: {
      kind: "destructive",
      desc:
        "Remove worktrees with git worktree remove, never --force; branches and commits stay. Refuses the primary checkout, uncommitted or untracked changes, a rebase or merge in progress, and a worktree with a listening process.",
      input: { wts: z.array(z.string()).min(1) },
      run: async (a) => {
        const rows = (a.wts as string[]).map(resolveWt);
        const refused = rows.flatMap((w) => {
          const why = w.isPrimary
            ? "primary checkout"
            : w.dirty
            ? "uncommitted or untracked changes"
            : w.state
            ? `${w.state} in progress`
            : w.ports.length
            ? `listening on ${w.ports.join(", ")}`
            : "";
          return why ? [{ path: w.path, error: why }] : [];
        });
        const ok = rows.filter((w) => !refused.some((r) => r.path === w.path));
        const failed = ok.length
          ? await actions.removeWts(ok.map((w) => w.path))
          : [];
        return {
          removed: ok.map((w) => w.path).filter((p) =>
            !failed.some((f) => f.path === p)
          ),
          refused: [...refused, ...failed],
        };
      },
    },
  };

  const callTool = async (name: string, raw: Record<string, unknown>) => {
    const t = tools[name];
    const args = z.object(t.input).parse(raw);
    if (!t.kind) return await t.run(args);
    try {
      const out = await t.run(args);
      log({ type: "agentTool", tool: name, args, out });
      return out;
    } catch (e) {
      log({ type: "agentTool", tool: name, args, error: String(e) });
      throw e;
    }
  };

  const toolError = (e: unknown) => ({
    error: e instanceof Error ? e.message : String(e),
    ...(e instanceof ToolError && e.candidates
      ? { candidates: e.candidates }
      : {}),
  });

  function buildMcp() {
    const mcp = new McpServer({ name: "forest", version: "0" });
    for (const [name, tool] of Object.entries(tools)) {
      mcp.registerTool(
        name,
        {
          description: tool.desc,
          inputSchema: tool.input,
          annotations: {
            readOnlyHint: !tool.kind,
            destructiveHint: tool.kind === "destructive",
            idempotentHint: true,
          },
        },
        async (args: Record<string, unknown>) => {
          try {
            const out = await callTool(name, args);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(out) }],
            };
          } catch (e) {
            return {
              isError: true,
              content: [{
                type: "text" as const,
                text: JSON.stringify(toolError(e)),
              }],
            };
          }
        },
      );
    }
    return mcp;
  }

  return { tools, callTool, toolError, buildMcp, wake };
}
