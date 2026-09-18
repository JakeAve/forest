import { join } from "@std/path";
import { boot } from "./boot.ts";
import { BW } from "./routes.ts";
import { loadSettings } from "./settings.ts";
import { bumpMax, MAX_FIELDS, statsLine } from "./stats.ts";

const HOME = Deno.env.get("HOME")!;
const SETTINGS = await loadSettings(join(HOME, ".forest", "settings.json"));
const DIST_DIR = join(import.meta.dirname!, "dist");
const { root, stats, sse, log, watcher, routes } = boot({
  settings: SETTINGS,
  home: HOME,
  distDir: DIST_DIR,
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
console.log(`forest on ${APP_URL}  root=${root}`);
if (!await Deno.stat(DIST_DIR).catch(() => null)) {
  console.warn("no dist/ to serve; run `deno task start`");
}
if (Deno.args.includes("--open")) {
  new Deno.Command("open", { args: [APP_URL] }).spawn();
}
