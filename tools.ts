import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { matchWt } from "./src/filter.js";
import { normPath, ownerWorktree, qbool, qnum, selectWt } from "./parse.ts";
import type { FilesApi } from "./files.ts";
import type { StoreApi } from "./store.ts";
import type { Settings } from "./settings.ts";
import type { WtRow } from "./types.ts";

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
}) {
  const { store, files, settings, home: HOME } = deps;
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
    e.candidates = hit.candidates;
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
