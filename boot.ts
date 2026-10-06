import { join } from "@std/path";
import { createCache } from "./cache.ts";
import { createExec } from "./exec.ts";
import { createFiles } from "./files.ts";
import { createLog } from "./log.ts";
import { createRepo } from "./repo.ts";
import { createPrs } from "./prs.ts";
import { createPorts } from "./ports.ts";
import { createSse } from "./sse.ts";
import { createWatcher } from "./watcher.ts";
import { createAutoRebase } from "./autorebase.ts";
import { createStore } from "./store.ts";
import { PROVIDERS } from "./agents.ts";
import { createSessions, denoFs, type SessionFs } from "./sessions.ts";
import { createNotify, fileInbox } from "./notify.ts";
import { createTools } from "./tools.ts";
import { BW, createRoutes } from "./routes.ts";
import type { Settings } from "./settings.ts";
import { ticketFor } from "./parse.ts";
import { newStats } from "./stats.ts";

// Builds the whole module graph and starts nothing: no timers, no watcher, no
// server. main.ts starts those; boot_test.ts drives the graph directly.
export function boot(opts: {
  settings: Settings;
  home: string;
  distDir: string;
  watchFs?: (root: string) => AsyncIterable<{ paths: string[] }>;
  notifyOs?: boolean;
  sessionFs?: SessionFs;
}) {
  const { settings, home, distDir } = opts;
  const dir = join(home, ".forest");
  const root = settings.root.replace(/^~/, home);
  // what was last seen under this root; another root keeps its own
  const rootDir = join(dir, "roots", encodeURIComponent(root));
  const stats = newStats();
  const sh = createExec(stats);
  const repo = createRepo({ sh, root });
  const sse = createSse();
  const ports = createPorts(sh, stats);
  const log = createLog({ path: join(dir, "forest-log.jsonl"), stats });
  const notify = createNotify({
    sh,
    settings,
    sse,
    inbox: fileInbox(join(rootDir, "inbox.json")),
    now: Date.now,
    os: opts.notifyOs ?? Deno.build.os === "darwin",
    log: (o) => log.line(o),
  });
  const prs = createPrs({
    sh,
    settings,
    stats,
    onChange: () => store.publish(),
  });
  const sessions = createSessions({
    home,
    providers: PROVIDERS,
    fs: opts.sessionFs ?? denoFs,
    onChange: () => store.publish(),
  });
  const store = createStore({
    prFor: (r, w) => prs.prFor(r, w),
    ticket: (r, w) =>
      ticketFor(
        settings.tickets[r.name] ?? settings.tickets["*"],
        r.webUrl,
        ...(w.branch === r.defaultBranch
          ? []
          : [w.branch, w.pr?.title, w.subject]),
      ),
    autoRebase: (wt) => autoRebase.status(wt),
    prError: (r) => prs.prError(r),
    procs: () => ports.current(),
    prListed: (r) => prs.listed(r),
    agents: (wts) => sessions.ready() ? sessions.forWts(wts) : null,
    onSnapshot: (j) => {
      sse.broadcast(j);
      notify.observe(j);
      cache.save(j);
    },
    stats,
  });
  const cache = createCache({
    path: join(rootDir, "cache.json"),
    store,
    prs,
    log: (o) => log.line(o),
  });
  const watchFs = opts.watchFs ??
    ((r: string) => Deno.watchFs(r, { recursive: true }));
  const files = createFiles({
    sh,
    known: store.known,
    mergeBase: repo.mergeBase,
    watchFs,
    onChange: (wt, paths) => sse.emit("fs", JSON.stringify({ wt, paths })),
  });
  const watcher = createWatcher({
    repo,
    prs,
    ports,
    store,
    sse,
    stats,
    settings,
    root,
    log: (o) => log.line(o),
    watchFs,
  });
  const autoRebase = createAutoRebase({
    sh,
    store,
    prs,
    path: join(dir, "autorebase.json"),
    afterMutation: () => watcher.afterMutation(),
    log: (o) => log.line(o),
  });
  const tools = createTools({ store, files, settings, home, sessions });
  const routes = createRoutes({
    settings,
    settingsPath: join(dir, "settings.json"),
    layoutPath: join(dir, "layout.json"),
    themesDir: join(dir, "themes"),
    distDir,
    home,
    root,
    sh,
    store,
    prs,
    ports,
    files,
    watcher,
    autoRebase,
    notify,
    sse,
    stats,
    tools,
    sessions,
    desktop: !!BW,
  });
  return {
    root,
    stats,
    sse,
    log,
    cache,
    watcher,
    autoRebase,
    notify,
    sessions,
    routes,
  };
}
