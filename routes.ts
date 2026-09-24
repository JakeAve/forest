import { serveDir } from "@std/http/file-server";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { dirname, join, relative, resolve } from "@std/path";
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
} from "./parse.ts";
import type { Shell } from "./exec.ts";
import type { FilesApi } from "./files.ts";
import {
  guardThemeName,
  loadVsCodeTheme,
  scanVsCodeThemes,
  vscodeExtDirs,
} from "./themes.ts";
import type { PrsApi } from "./prs.ts";
import { enc, type SseApi } from "./sse.ts";
import type { WatcherApi } from "./watcher.ts";
import type { AutoRebaseApi } from "./autorebase.ts";
import type { StoreApi } from "./store.ts";
import { DEFAULTS, saveSettings, type Settings } from "./settings.ts";
import { type Stats, statsLine } from "./stats.ts";
import type { createTools } from "./tools.ts";
import type { Procs } from "./types.ts";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

export const BW = (Deno as unknown as {
  BrowserWindow?: new (opts: Record<string, unknown>) => unknown;
}).BrowserWindow;

export function createRoutes(deps: {
  settings: Settings;
  settingsPath: string;
  layoutPath: string;
  themesDir: string;
  distDir: string;
  home: string;
  root: string;
  sh: Shell;
  store: StoreApi;
  prs: PrsApi;
  ports: { current(): Map<string, Procs> };
  files: FilesApi;
  watcher: WatcherApi;
  autoRebase: AutoRebaseApi;
  sse: SseApi;
  stats: Stats;
  tools: ReturnType<typeof createTools>;
  desktop: boolean;
}) {
  const {
    settings: SETTINGS,
    settingsPath: SETTINGS_PATH,
    layoutPath: LAYOUT_PATH,
    themesDir: THEMES_DIR,
    home: HOME,
    root: ROOT,
    store,
    prs,
    ports,
    files,
    watcher,
    autoRebase,
    sse,
    stats,
    desktop,
  } = deps;
  const { exec, git, tryGit, gitIn } = deps.sh;
  const { byPath: repoByPath, known: knownWorktrees, repoPaths } = store;
  const { guardWt, guardRoot, guardPath, isLoose, looseRoots } = files;
  const { tools, callTool, toolError, buildMcp } = deps.tools;
  const mcpHandler = createMcpHandler(buildMcp);

  const gauges = () => ({ clients: sse.size(), ...watcher.gauges() });

  return async function routes(
    req: Request,
    info: Deno.ServeHandlerInfo,
  ): Promise<Response> {
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
          return json(
            await callTool(name, Object.fromEntries(url.searchParams)),
          );
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
          return json({ ...SETTINGS, desktop });
        }
        return json({ ...SETTINGS, desktop });
      }
      if (url.pathname === "/api/layout") {
        if (req.method === "PUT") {
          await Deno.mkdir(join(HOME, ".forest"), { recursive: true });
          await Deno.writeTextFile(
            LAYOUT_PATH,
            JSON.stringify(await req.json()),
          );
          return json({ ok: true });
        }
        return json(
          await Deno.readTextFile(LAYOUT_PATH).then(JSON.parse).catch(
            () => ({}),
          ),
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
        const { path, line } = parseOpenInput(
          url.searchParams.get("path") ?? "",
        );
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
            await autoRebase.rebase(wt);
            break;
          case "/api/auto-rebase":
            await autoRebase.set(wt, !!b.enable);
            return json({ ok: true });
          case "/api/update-branch": {
            const repo = knownWorktrees.get(wt)!;
            const n = Number(b.number);
            if (!Number.isInteger(n) || n <= 0) {
              throw new Error("bad pr number");
            }
            await autoRebase.updateBranch(wt, repo, n);
            break;
          }
          case "/api/auto-merge": {
            const repo = knownWorktrees.get(wt)!;
            const n = Number(b.number);
            if (!Number.isInteger(n) || n <= 0) {
              throw new Error("bad pr number");
            }
            await exec(
              wt,
              b.enable
                ? ["gh", "pr", "merge", String(n), "--auto", "--squash"]
                : ["gh", "pr", "merge", String(n), "--disable-auto"],
            );
            await prs.refreshOnePr(repo, n).catch(() => {});
            prs.refreshPrSoon(repo, n);
            // the merge landed on the remote, not locally — fetch so the
            // ahead/behind-vs-base afterMutation() recomputes below isn't
            // reading last sweep's now-stale refs.
            await git(wt, "fetch", "origin").catch(() => {});
            break;
          }
          case "/api/push":
            await git(
              wt,
              "push",
              "-u",
              "origin",
              `HEAD:${b.remote || b.branch}`,
            );
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
            const repo = knownWorktrees.get(wt)!;
            const n = Number(b.number);
            if (!Number.isInteger(n) || n <= 0) {
              throw new Error("bad pr number");
            }
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
            await prs.refreshOnePr(repo, n).catch(() => {});
            prs.refreshPrSoon(repo, n);
            break;
          }
          case "/api/wt-remove": {
            const force = b.force ? ["--force"] : [];
            const failed: { path: string; error: string }[] = [];
            for (const p of (b.wts ?? [b.wt]).map(guardWt)) {
              await git(
                knownWorktrees.get(p)!,
                "worktree",
                "remove",
                ...force,
                p,
              )
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
              const cmd = fillCommand(
                tpl.includes("{") ? tpl : tpl + " {slug}",
                {
                  slug,
                  repo,
                  path: repoPath,
                  root: ROOT,
                },
              );
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
              b.expect,
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
        fsRoot: deps.distDir,
        quiet: true,
      });
    } catch (e) {
      return new Response(String(e), { status: 400 });
    }
  };
}
