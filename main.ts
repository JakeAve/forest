import { serveDir } from "@std/http/file-server";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { dirname, join, relative, resolve } from "@std/path";
import { matchWt } from "./src/filter.js";
import { resolveTheme } from "./src/theme.js";
import {
  coerceSettings,
  fillCommand,
  isLocalRequest,
  normPath,
  ownerWorktree,
  parseDiffHunks,
  parseGrep,
  parseOpenInput,
  qbool,
  qnum,
  selectWt,
} from "./parse.ts";
import { createExec } from "./exec.ts";
import { createFiles } from "./files.ts";
import { createLog } from "./log.ts";
import {
  guardThemeName,
  loadVsCodeTheme,
  scanVsCodeThemes,
  vscodeExtDirs,
} from "./themes.ts";
import { createRepo } from "./repo.ts";
import { createPrs } from "./prs.ts";
import { createPorts } from "./ports.ts";
import { createSse, enc } from "./sse.ts";
import { createWatcher } from "./watcher.ts";
import { createStore } from "./store.ts";
import { DEFAULTS, loadSettings, saveSettings } from "./settings.ts";
import { bumpMax, MAX_FIELDS, newStats, statsLine } from "./stats.ts";
import type { WtRow } from "./types.ts";

const HOME = Deno.env.get("HOME")!;
const SETTINGS_PATH = join(HOME, ".forest", "settings.json");
const SETTINGS = await loadSettings(SETTINGS_PATH);
const ROOT = SETTINGS.root.replace(/^~/, HOME);
const LAYOUT_PATH = join(HOME, ".forest", "layout.json");
const THEMES_DIR = join(HOME, ".forest", "themes");
const stats = newStats();
const sh = createExec(stats);
const { exec, git, tryGit, gitIn } = sh;
const repo = createRepo({ sh, root: ROOT });
const sse = createSse();
const ports = createPorts(sh, stats);

// ---- open pull requests ----

const prs = createPrs({
  sh,
  settings: SETTINGS,
  stats,
  onChange: () => store.publish(),
});

const store = createStore({
  prFor: (r, w) => prs.prFor(r, w),
  procs: () => ports.current(),
  onSnapshot: (j) => sse.broadcast(j),
  stats,
});
const { byPath: repoByPath, known: knownWorktrees, repoPaths } = store;

// ---- files & diff ----

const files = createFiles({
  sh,
  known: store.known,
  mergeBase: repo.mergeBase,
  home: HOME,
});
const { guardWt, guardRoot, guardPath, isLoose, looseRoots } = files;

const LOG_PATH = join(HOME, ".forest", "forest-log.jsonl");
const log = createLog({ path: LOG_PATH, stats });

const watcher = createWatcher({
  repo,
  prs,
  ports,
  store,
  sse,
  stats,
  settings: SETTINGS,
  root: ROOT,
  log: (o) => log.line(o),
  watchFs: (r) => Deno.watchFs(r, { recursive: true }),
});

const gauges = () => ({ clients: sse.size(), ...watcher.gauges() });

// A 250ms timer that fires late means the loop was blocked. Machine-independent
// stress signal: it moves when we are starved, whatever else the box is doing.
const LAG_MS = 250;
let lagLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const lag = Math.max(0, now - lagLast - LAG_MS);
  lagLast = now;
  stats.lagSamplesTotal++;
  stats.lagMsTotal += lag;
  bumpMax(stats, "lagMsMax", lag);
}, LAG_MS);

setInterval(sse.ping, 20_000);

setInterval(() => {
  log.line({ type: "stats", ...statsLine(stats, SETTINGS, gauges()) });
  // statsLine() is synchronous and already spread above, so the window closes
  // here: every *Max on the next line describes only the coming minute.
  for (const k of MAX_FIELDS) stats[k] = 0;
  stats.subprocessPeak = stats.subprocessInflight; // children still running
}, 60_000);

watcher.start();

// ---- server ----

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const BW = (Deno as unknown as {
  BrowserWindow?: new (opts: Record<string, unknown>) => unknown;
}).BrowserWindow;

// ---- tools ----

type Tool = {
  desc: string;
  input: Record<string, z.ZodType>;
  run: (a: Record<string, unknown>) => unknown | Promise<unknown>;
};

class ToolError extends Error {
  candidates?: unknown[];
}

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
      return a.recent === undefined ? rows : rows.slice(0, a.recent as number);
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
    desc: "A forest URL that opens a worktree, optionally at a file and line.",
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
      const host = SETTINGS.host === "0.0.0.0" || SETTINGS.host === "127.0.0.1"
        ? "forest-app.localhost"
        : SETTINGS.host;
      return { url: `http://${host}:${SETTINGS.port}/?${p}` };
    },
  },
};

const callTool = (name: string, raw: Record<string, unknown>) =>
  tools[name].run(z.object(tools[name].input).parse(raw));

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
const mcpHandler = createMcpHandler(buildMcp);

const server = Deno.serve({
  hostname: SETTINGS.host,
  port: SETTINGS.port,
}, async (req, info) => {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/api/events") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          sse.add(c);
          c.enqueue(enc(`data: ${store.snapshot()}\n\n`));
          // a client that connects after boot must not be left on a spinner
          c.enqueue(sse.statusChunk());
        },
        cancel() {
          sse.remove(ctrl);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
    if (url.pathname === "/api/stats") {
      return json(statsLine(stats, SETTINGS, gauges()));
    }
    if (url.pathname === "/mcp") {
      return hostHeaderValidationResponse(req, [
        ...localhostAllowedHostnames(),
        "forest-server.localhost",
      ]) ??
        originValidationResponse(req, localhostAllowedOrigins()) ??
        mcpHandler.fetch(req);
    }
    if (url.pathname.startsWith("/api/t/")) {
      const name = url.pathname.slice("/api/t/".length);
      if (!Object.hasOwn(tools, name)) {
        return new Response("not found", { status: 404 });
      }
      try {
        return json(await callTool(name, Object.fromEntries(url.searchParams)));
      } catch (e) {
        return new Response(JSON.stringify(toolError(e)), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (url.pathname === "/api/settings") {
      if (req.method === "PUT") {
        Object.assign(SETTINGS, coerceSettings(DEFAULTS, await req.json()));
        await saveSettings(SETTINGS_PATH, SETTINGS);
        return json({ ...SETTINGS, desktop: !!BW });
      }
      return json({ ...SETTINGS, desktop: !!BW });
    }
    if (url.pathname === "/api/layout") {
      if (req.method === "PUT") {
        await Deno.mkdir(join(HOME, ".forest"), { recursive: true });
        await Deno.writeTextFile(LAYOUT_PATH, JSON.stringify(await req.json()));
        return json({ ok: true });
      }
      return json(
        await Deno.readTextFile(LAYOUT_PATH).then(JSON.parse).catch(() => ({})),
      );
    }
    if (url.pathname === "/api/themes") {
      const names: string[] = [];
      try {
        for await (const e of Deno.readDir(THEMES_DIR)) {
          if (e.name.endsWith(".json")) names.push(e.name.slice(0, -5));
        }
      } catch {
        // dir not created until first import
      }
      return json(names.sort());
    }
    if (url.pathname === "/api/vscode-themes") {
      return json(await scanVsCodeThemes(vscodeExtDirs(HOME)));
    }
    if (url.pathname === "/api/theme") {
      const name = guardThemeName(url.searchParams.get("name"));
      return new Response(
        await Deno.readTextFile(join(THEMES_DIR, name + ".json")),
      );
    }
    const mode = url.searchParams.get("base") === "head" ? "head" : "branch";
    if (url.pathname === "/api/files") {
      return json(
        await files.listFiles(guardWt(url.searchParams.get("wt")), mode),
      );
    }
    if (url.pathname === "/api/file") {
      return json(
        await files.fileContents(
          guardRoot(url.searchParams.get("wt"), req, info),
          guardPath(url.searchParams.get("path")),
          mode,
        ),
      );
    }
    if (url.pathname === "/api/open") {
      const host = (info.remoteAddr as Deno.NetAddr).hostname;
      if (!isLocalRequest(host, req.headers.get("host"))) {
        return new Response("Forest only opens paths for this machine", {
          status: 403,
        });
      }
      if (!watcher.booted()) {
        return new Response("still scanning, try again", { status: 503 });
      }
      const { path, line } = parseOpenInput(url.searchParams.get("path") ?? "");
      let p = normPath(path, HOME);
      const from = url.searchParams.get("from");
      if (!p.startsWith("/")) {
        if (!from) return new Response("not found", { status: 404 });
        p = resolve(from, p);
      }
      p = resolve(p);
      let real: string, stat: Deno.FileInfo;
      try {
        real = await Deno.realPath(p);
        stat = await Deno.stat(real);
      } catch (e) {
        return e instanceof Deno.errors.PermissionDenied
          ? new Response("not readable", { status: 403 })
          : new Response("not found", { status: 404 });
      }
      const kind = stat.isDirectory ? "dir" : "file";
      const wts = [...knownWorktrees.keys()];
      let target = real;
      let owner = ownerWorktree(real, wts);
      if (!owner) {
        owner = ownerWorktree(p, wts);
        if (owner) target = p;
      }
      if (!owner) {
        target = real;
        owner = ownerWorktree(real, [...looseRoots]);
        if (!owner) {
          owner = stat.isDirectory ? real : dirname(real);
          looseRoots.add(owner);
        }
      }
      return json({
        wt: owner,
        rel: relative(owner, target),
        kind,
        loose: isLoose(owner),
        line,
      });
    }
    if (url.pathname === "/api/tree") {
      const wt = guardRoot(url.searchParams.get("wt"), req, info);
      const dir = url.searchParams.get("dir");
      if (dir) return json(await files.listDir(wt, guardPath(dir)));
      if (!isLoose(wt)) return json(await files.listTree(wt));
      return json(await files.walkTree(wt));
    }
    if (url.pathname === "/api/grep") {
      const wt = guardRoot(url.searchParams.get("wt"), req, info);
      const q = url.searchParams.get("q");
      if (!q) return json([]);
      // ponytail: no file cap on loose roots, so grepping a huge folder is slow
      const out = await tryGit(
        wt,
        "grep",
        ...(isLoose(wt)
          ? ["--no-index", "--exclude-standard"]
          : ["--untracked"]),
        "-z",
        "-n",
        "-I",
        "-i",
        "-F",
        "--max-count",
        "5",
        "-e",
        q,
      );
      return json(parseGrep(out ?? ""));
    }
    if (url.pathname === "/api/hunks") {
      const wt = guardRoot(url.searchParams.get("wt"), req, info);
      if (isLoose(wt)) return json([]);
      const d = await tryGit(
        wt,
        "diff",
        "--no-renames",
        "--",
        guardPath(url.searchParams.get("path")),
      );
      return json(parseDiffHunks(d ?? ""));
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const b = await req.json();
      const noWt = url.pathname === "/api/wt-create" ||
        url.pathname === "/api/theme-import" ||
        url.pathname === "/api/wt-remove" ||
        url.pathname === "/api/kill-pid";
      const wt = noWt
        ? ""
        : ["/api/save", "/api/new", "/api/rename", "/api/delete"]
            .includes(url.pathname)
        ? guardRoot(b.wt ?? null, req, info)
        : guardWt(b.wt ?? null);
      switch (url.pathname) {
        case "/api/rebase":
          await git(wt, "fetch", "origin");
          try {
            await git(wt, "rebase", "origin/HEAD");
          } catch (e) {
            await git(wt, "rebase", "--abort").catch(() => {});
            throw new Error(
              `rebase failed — aborted, use a terminal. ${
                (e as Error).message
              }`,
            );
          }
          break;
        case "/api/update-branch": {
          const n = Number(b.number);
          if (!Number.isInteger(n) || n <= 0) throw new Error("bad pr number");
          await exec(wt, [
            "gh",
            "api",
            "-X",
            "PUT",
            `repos/{owner}/{repo}/pulls/${n}/update-branch`,
          ]);
          await prs.refreshOnePr(knownWorktrees.get(wt)!, n).catch(() => {});
          prs.refreshPrSoon(knownWorktrees.get(wt)!, n);
          break;
        }
        case "/api/auto-merge": {
          const n = Number(b.number);
          if (!Number.isInteger(n) || n <= 0) throw new Error("bad pr number");
          await exec(
            wt,
            b.enable
              ? ["gh", "pr", "merge", String(n), "--auto", "--squash"]
              : ["gh", "pr", "merge", String(n), "--disable-auto"],
          );
          await prs.refreshOnePr(knownWorktrees.get(wt)!, n).catch(() => {});
          prs.refreshPrSoon(knownWorktrees.get(wt)!, n);
          // the merge landed on the remote, not locally — fetch so the
          // ahead/behind-vs-base afterMutation() recomputes below isn't
          // reading last sweep's now-stale refs.
          await git(wt, "fetch", "origin").catch(() => {});
          break;
        }
        case "/api/push":
          await git(wt, "push", "-u", "origin", `HEAD:${b.remote || b.branch}`);
          break;
        case "/api/pr-create": {
          const repo = knownWorktrees.get(wt)!;
          if (!b.remote) {
            await git(wt, "push", "-u", "origin", `HEAD:${b.branch}`);
          }
          await exec(wt, [
            "gh",
            "pr",
            "create",
            "--fill",
            "--head",
            String(b.remote || b.branch),
          ]);
          prs.expire(repo);
          await prs.refreshPrs([repoByPath.get(repo)!]).catch(() => {});
          break;
        }
        case "/api/pr-state": {
          const n = Number(b.number);
          if (!Number.isInteger(n) || n <= 0) throw new Error("bad pr number");
          const args = b.action === "close"
            ? ["close", String(n)]
            : b.action === "draft"
            ? ["ready", String(n), "--undo"]
            : b.action === "ready"
            ? ["ready", String(n)]
            // no --delete-branch: the worktree still tracks it, and Forest's
            // own remove flow is what should retire a branch.
            : b.action === "merge"
            ? ["merge", String(n), "--squash"]
            : null;
          if (!args) throw new Error("bad pr action");
          await exec(wt, ["gh", "pr", ...args]);
          await prs.refreshOnePr(knownWorktrees.get(wt)!, n).catch(() => {});
          prs.refreshPrSoon(knownWorktrees.get(wt)!, n);
          break;
        }
        case "/api/wt-remove": {
          const force = b.force ? ["--force"] : [];
          const failed: { path: string; error: string }[] = [];
          for (const p of (b.wts ?? [b.wt]).map(guardWt)) {
            await git(knownWorktrees.get(p)!, "worktree", "remove", ...force, p)
              .catch((e) => failed.push({ path: p, error: e.message }));
          }
          watcher.afterMutation();
          return json({ ok: !failed.length, failed });
        }
        case "/api/kill-pid": {
          const pid = Number(b.pid);
          const known = [...ports.current().values()].some((procs) =>
            procs.some((p) => p.pid === pid)
          );
          if (!Number.isInteger(pid) || !known) {
            throw new Error("not a known listening process");
          }
          Deno.kill(pid, "SIGTERM");
          break;
        }
        case "/api/wt-create": {
          const repoPath = repoPaths.get(String(b.repo));
          if (!repoPath) throw new Error("unknown repo");
          const slug = String(b.slug ?? "").trim();
          if (!/^[\w][\w/.-]*$/.test(slug) || slug.includes("..")) {
            throw new Error("bad branch name");
          }
          const repo = String(b.repo);
          const tpl = SETTINGS.launchers[repo] ?? SETTINGS.launchers["*"];
          if (tpl) {
            const cmd = fillCommand(tpl.includes("{") ? tpl : tpl + " {slug}", {
              slug,
              repo,
              path: repoPath,
              root: ROOT,
            });
            await exec(repoPath, ["sh", "-c", cmd]);
          } else {
            await git(
              repoPath,
              "worktree",
              "add",
              `${repoPath}-wt/${slug.replace(/\//g, "-")}`,
              "-b",
              slug,
            );
          }
          break;
        }
        case "/api/theme-import": {
          let name = b.name, text = String(b.json);
          if (b.path) {
            const hit = (await scanVsCodeThemes(vscodeExtDirs(HOME))).find((
              t,
            ) => t.path === b.path);
            if (!hit) throw new Error("not an installed VS Code theme");
            const theme = await loadVsCodeTheme(hit.path);
            resolveTheme(theme);
            name = hit.name;
            text = JSON.stringify(theme);
          }
          await Deno.mkdir(THEMES_DIR, { recursive: true });
          await Deno.writeTextFile(
            join(THEMES_DIR, guardThemeName(name) + ".json"),
            text,
          );
          break;
        }
        case "/api/stage":
          await git(wt, "add", "--", guardPath(b.path));
          break;
        case "/api/unstage":
          await git(wt, "restore", "--staged", "--", guardPath(b.path));
          break;
        case "/api/discard":
          if (b.untracked) await Deno.remove(join(wt, guardPath(b.path)));
          else await git(wt, "checkout", "--", guardPath(b.path));
          break;
        case "/api/stage-hunk":
          await gitIn(wt, String(b.patch), "apply", "--cached");
          break;
        case "/api/discard-hunk":
          await gitIn(wt, String(b.patch), "apply", "--reverse");
          break;
        case "/api/new":
          await files.newEntry(wt, b.path);
          break;
        case "/api/rename":
          await files.rename(wt, b.from, b.to);
          break;
        case "/api/delete":
          await files.remove(wt, b.path);
          break;
        case "/api/save": {
          const r = await files.save(
            wt,
            b.path,
            b.expect ?? null,
            String(b.content),
          );
          if (r !== "ok") {
            return new Response(JSON.stringify(r), {
              status: 409,
              headers: { "content-type": "application/json" },
            });
          }
          break;
        }
        default:
          return new Response("not found", { status: 404 });
      }
      watcher.afterMutation();
      return json({ ok: true });
    }
    return serveDir(req, {
      fsRoot: join(import.meta.dirname!, "dist"),
      quiet: true,
    });
  } catch (e) {
    return new Response(String(e), { status: 400 });
  }
});

if (BW) {
  new BW({
    url: `http://localhost:${(server.addr as Deno.NetAddr).port}/`,
    title: "forest",
    width: 1440,
    height: 900,
    transparentTitlebar: true,
  });
}

const APP_URL = `http://forest-app.localhost:${SETTINGS.port}`;
console.log(`forest on ${APP_URL}  root=${ROOT}`);
if (!await Deno.stat(join(import.meta.dirname!, "dist")).catch(() => null)) {
  console.warn("no dist/ to serve; run `deno task start`");
}
if (Deno.args.includes("--open")) {
  new Deno.Command("open", { args: [APP_URL] }).spawn();
}
