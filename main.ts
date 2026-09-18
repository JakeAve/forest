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
import { loadSettings } from "./settings.ts";
import { bumpMax, MAX_FIELDS, newStats, statsLine } from "./stats.ts";

const HOME = Deno.env.get("HOME")!;
const SETTINGS_PATH = join(HOME, ".forest", "settings.json");
const SETTINGS = await loadSettings(SETTINGS_PATH);
const ROOT = SETTINGS.root.replace(/^~/, HOME);
const LAYOUT_PATH = join(HOME, ".forest", "layout.json");
const THEMES_DIR = join(HOME, ".forest", "themes");
const DIST_DIR = join(import.meta.dirname!, "dist");
const stats = newStats();
const sh = createExec(stats);
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

// ---- files & diff ----

const files = createFiles({
  sh,
  known: store.known,
  mergeBase: repo.mergeBase,
  home: HOME,
});

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

const tools = createTools({ store, files, settings: SETTINGS, home: HOME });

const routes = createRoutes({
  settings: SETTINGS,
  settingsPath: SETTINGS_PATH,
  layoutPath: LAYOUT_PATH,
  themesDir: THEMES_DIR,
  distDir: DIST_DIR,
  home: HOME,
  root: ROOT,
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
  log.line({
    type: "stats",
    ...statsLine(stats, SETTINGS, { clients: sse.size(), ...watcher.gauges() }),
  });
  // statsLine() is synchronous and already spread above, so the window closes
  // here: every *Max on the next line describes only the coming minute.
  for (const k of MAX_FIELDS) stats[k] = 0;
  stats.subprocessPeak = stats.subprocessInflight; // children still running
}, 60_000);

watcher.start();

// ---- server ----

const server = Deno.serve({
  hostname: SETTINGS.host,
  port: SETTINGS.port,
}, routes);

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
if (!await Deno.stat(DIST_DIR).catch(() => null)) {
  console.warn("no dist/ to serve; run `deno task start`");
}
if (Deno.args.includes("--open")) {
  new Deno.Command("open", { args: [APP_URL] }).spawn();
}
