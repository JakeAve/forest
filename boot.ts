import { join } from "@std/path";
import { createExec } from "./exec.ts";
import { createFiles } from "./files.ts";
import { createLog } from "./log.ts";
import { createRepo } from "./repo.ts";
import { createPrs } from "./prs.ts";
import { createPorts } from "./ports.ts";
import { createSse } from "./sse.ts";
import { createWatcher } from "./watcher.ts";
import { createStore } from "./store.ts";
import { createTools } from "./tools.ts";
import { BW, createRoutes } from "./routes.ts";
import type { Settings } from "./settings.ts";
import { newStats } from "./stats.ts";

// Builds the whole module graph and starts nothing: no timers, no watcher, no
// server. main.ts starts those; boot_test.ts drives the graph directly.
export function boot(opts: {
  settings: Settings;
  home: string;
  distDir: string;
  watchFs?: (root: string) => AsyncIterable<{ paths: string[] }>;
}) {
  const { settings, home, distDir } = opts;
  const dir = join(home, ".forest");
  const root = settings.root.replace(/^~/, home);
  const stats = newStats();
  const sh = createExec(stats);
  const repo = createRepo({ sh, root });
  const sse = createSse();
  const ports = createPorts(sh, stats);
  const prs = createPrs({
    sh,
    settings,
    stats,
    onChange: () => store.publish(),
  });
  const store = createStore({
    prFor: (r, w) => prs.prFor(r, w),
    procs: () => ports.current(),
    onSnapshot: (j) => sse.broadcast(j),
    stats,
  });
  const files = createFiles({
    sh,
    known: store.known,
    mergeBase: repo.mergeBase,
  });
  const log = createLog({ path: join(dir, "forest-log.jsonl"), stats });
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
    watchFs: opts.watchFs ?? ((r) => Deno.watchFs(r, { recursive: true })),
  });
  const tools = createTools({ store, files, settings, home });
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
    sse,
    stats,
    tools,
    desktop: !!BW,
  });
  return { root, stats, sse, log, watcher, routes };
}
