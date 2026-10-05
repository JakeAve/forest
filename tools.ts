import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { matchWt, rank } from "./src/filter.js";
import {
  normPath,
  ownerWorktree,
  qbool,
  qnum,
  selectWt,
  sessionTag,
} from "./parse.ts";
import type { FilesApi } from "./files.ts";
import type { StoreApi } from "./store.ts";
import type { SessionsApi } from "./sessions.ts";
import type { Settings } from "./settings.ts";
import type { SessionInfo, WtRow } from "./types.ts";

// ---- tools ----

export type Tool = {
  desc: string;
  input: Record<string, z.ZodType>;
  run: (a: Record<string, unknown>) => unknown | Promise<unknown>;
};

export class ToolError extends Error {
  candidates?: unknown[];
}

export function createTools(deps: {
  store: StoreApi;
  files: FilesApi;
  settings: Settings;
  home: string;
  sessions: Pick<SessionsApi, "all">;
}) {
  const { store, files, settings, sessions, home: HOME } = deps;
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

  const tools: Record<string, Tool> = {
    snapshot: {
      desc: "Every repo forest watches, with its worktrees, status and PRs.",
      input: {},
      run: () =>
        [...repoByPath.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    wts: {
      desc:
        "Worktrees, newest activity first; q fuzzy-matches branch and repo name.",
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
        "Coding agent sessions (Claude Code, Codex, …) linked to worktrees, each with its transcript path, resume link and resume command. By wt (most likely creator first), by id (or a unique prefix) with the worktrees it touched, or q fuzzy-matching titles.",
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
        "Changed files in a worktree, since the branch point or uncommitted; q fuzzy-matches the path.",
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
  };

  const callTool = async (name: string, raw: Record<string, unknown>) =>
    await tools[name].run(z.object(tools[name].input).parse(raw));

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
        { description: tool.desc, inputSchema: tool.input },
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

  return { tools, callTool, toolError, buildMcp };
}
