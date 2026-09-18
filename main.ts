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
  backoffOver,
  classifyPath,
  coerceSettings,
  diffSnapshots,
  fillCommand,
  hotBackoff,
  type HotState,
  isLocalRequest,
  normPath,
  ownerWorktree,
  parseDiffHunks,
  parseGrep,
  parseOpenInput,
  pool,
  qbool,
  qnum,
  rateWindow,
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
import { createRepo, REPO_JOBS } from "./repo.ts";
import { createPrs } from "./prs.ts";
import { createPorts } from "./ports.ts";
import { createSse, enc } from "./sse.ts";
import { createStore } from "./store.ts";
import { DEFAULTS, loadSettings, saveSettings } from "./settings.ts";
import { bumpMax, MAX_FIELDS, newStats, statsLine } from "./stats.ts";
import type { Repo, WtRow } from "./types.ts";

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

let booted = false;

// ---- divergence: the actual experiment ----
// When the safety-net sweep asked for a check. A timestamp, not a flag,
// because the tick can land while a sweep is already in flight: that sweep
// read its repos before the request existed, so it must not answer it. Only a
// sweep that STARTED at or after the request may.
let checkRequestedAt = 0;
// Repos marked dirty or recomputed since the current sweep started. The whole
// sweep is the window: a repo read early, written mid-sweep and recomputed by
// the watcher before the sweep ends looks quiescent at the final instant yet
// legitimately disagrees. Excluding that repo is what keeps the rest measured.
let touched = new Set<string>();

const DIVERGENCE_STAT = {
  branch: "divergenceBranchTotal",
  head: "divergenceHeadTotal",
  ahead: "divergenceAheadTotal",
  behind: "divergenceBehindTotal",
  dirty: "divergenceDirtyTotal",
  lastActivity: "divergenceLastActivityTotal",
  remote: "divergenceRemoteTotal",
  worktreeAdded: "divergenceWorktreeAddedTotal",
  worktreeRemoved: "divergenceWorktreeRemovedTotal",
  repoAdded: "divergenceRepoAddedTotal",
  repoRemoved: "divergenceRepoRemovedTotal",
} as const;

// A divergence is a measurement, never an error path: this must not be able to
// fail the sweep that called it.
function recordDivergences(truth: Map<string, Repo>) {
  try {
    // The one genuinely global case: an unknown path means a repo may have
    // appeared or vanished, which no per-repo exclusion can describe.
    if (rootDirty || rootRescanning) {
      stats.divergenceChecksSkippedTotal++;
      return;
    }
    // A repo still dirty at check time has not caught up yet, and a repo in
    // backoff is dirty for as long as its interval — deliberately stale, by
    // our own decision. Judging it would report our backoff as a missed event
    // and make the metric cry wolf, so the exclusion is "touched during the
    // window OR still owed a recompute". The cost is that a repo which is
    // never both quiet and clean is never judged; what says how much that
    // costs is divergenceReposExcludedTotal vs divergenceReposCheckedTotal
    // (and watchDirty per line). NOT hotWts: backoff is a subset of dirty,
    // so hotWts can read 0 while repos are being excluded every check.
    // `dirty` holds worktree paths but the comparison is per repo, so map them
    // back before the union: a repo with any worktree still owed a recompute is
    // not judgeable, exactly as when the whole repo was the unit.
    const excluded = touched.union(
      new Set([...dirty].map((wt) => knownWorktrees.get(wt) ?? wt)),
    );
    let checked = 0;
    for (const p of truth.keys()) if (!excluded.has(p)) checked++;
    stats.divergenceReposCheckedTotal += checked;
    stats.divergenceReposExcludedTotal += truth.size - checked;
    for (const d of diffSnapshots(repoByPath, truth, excluded)) {
      stats.divergencesTotal++;
      const k = DIVERGENCE_STAT[d.field as keyof typeof DIVERGENCE_STAT];
      if (k) stats[k]++;
      log.line({ type: "divergence", ...d });
    }
  } catch (e) {
    stats.errorsTotal++;
    console.error(e);
  }
}

// Re-entrancy guard #1: global, because a sweep touches every repo — two at
// once are pure duplicate work. But a caller arriving mid-sweep may have just
// mutated a worktree this sweep already read, so it must NOT join: it gets a
// sweep that starts after the current one ends. At most one is queued.
let sweeping: Promise<void> | null = null;
let queuedSweep: Promise<void> | null = null;

function sweepAll(): Promise<void> {
  if (sweeping) {
    return queuedSweep ??= sweeping.catch(() => {}).then(() => {
      queuedSweep = null;
      return sweepAll();
    });
  }
  sweeping = (async () => {
    const startedAt = Date.now();
    // repos already dirty at sweep start belong to the window too: the watcher
    // knows about them and simply has not caught up yet
    touched = new Set([...dirty].map((wt) => knownWorktrees.get(wt) ?? wt));
    const t0 = performance.now();
    const dirs = await repo.repoDirs();
    if (!booted) sse.setStatus({ phase: "repos", done: 0, total: dirs.length });
    let done = 0;
    const repos = await pool(
      REPO_JOBS,
      dirs,
      async (d) => {
        const r = await repo.computeRepo(d.name, d.path);
        // Boot only: land each repo as it resolves so the list fills in rather
        // than appearing all at once. knownWorktrees is rebuilt from a partial
        // map here, so an early event may classify as unknown and force one
        // extra root rescan — it self-corrects on the next publish.
        if (!booted) {
          if (r) repoByPath.set(r.path, r);
          sse.setStatus({ done: ++done });
          store.publish();
        }
        return r;
      },
    );
    const next = new Map<string, Repo>();
    for (const r of repos) if (r) next.set(r.path, r);
    if (checkRequestedAt && startedAt >= checkRequestedAt) {
      checkRequestedAt = 0;
      recordDivergences(next);
    }
    repoByPath.clear();
    for (const [k, v] of next) repoByPath.set(k, v);
    stats.gitMs = Math.round(performance.now() - t0);
    stats.gitMsTotal += stats.gitMs;
    bumpMax(stats, "gitMsMax", stats.gitMs);
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

// everything, the old way. The timed loop when watch is off, and the startup
// sweep either way. pollMs spans the whole cycle, git sweep through PRs.
async function poll() {
  const t0 = performance.now();
  await sweepAll();
  const repos = [...repoByPath.values()];
  // PRs are decoration; the repo list is the content. Start the gh fan-out but
  // paint without it — at boot that is ~half the wait, and it is the only stage
  // that depends on the network. The PR tags land on the second publish.
  const prsDone = prs.refreshPrs(repos);
  await ports.refresh();
  store.publish();
  if (!booted) sse.setStatus({ phase: "prs" });
  await prsDone;
  store.publish();
  if (!booted) {
    booted = true;
    sse.setStatus({ phase: "ready" });
  }
  stats.pollsTotal++;
  stats.pollMs = Math.round(performance.now() - t0);
  stats.pollMsTotal += stats.pollMs;
  bumpMax(stats, "pollMsMax", stats.pollMs);
}

// ---- watcher: invalidate, never compute ----

// storm mode is exactly "stop being a watcher": events are dropped and the
// timed loop polls everything on pollMs, which is what Forest did before this
// branch. Degrading to the old behaviour is the whole point of the valve.
const mode = (): "watch" | "poll" =>
  SETTINGS.watch && watcherUp && !storm ? "watch" : "poll";
let watcherUp = false;
const dirty = new Set<string>(); // repo paths

// ---- storm mode: defence of last resort ----
// A flood the ignore list did not anticipate. Above watchStormRate we stop
// acting on events, force one full sweep so no repo is left behind, and let
// the timed loop poll everything until the flood is over. Events are still
// classified and counted throughout — entry and exit have to measure the same
// population, or ignorable traffic would pin the watcher off.
let storm = false;
let stormTickAt = 0; // last time watchStormMsTotal was topped up
let stormStartedAt = 0;
let stormQuietSince = 0; // when the rate first dropped under threshold/4
const STORM_WINDOW_MS = 5000;
const stormWindow = rateWindow(STORM_WINDOW_MS, 10);
const eventRate = (now: number) =>
  stormWindow.count(now) / (STORM_WINDOW_MS / 1000);
// counted only while the rate is already elevated (the run-up) and then
// throughout the storm itself, so it always names the live offender rather
// than a lifetime histogram. ponytail: capped at 1000 keys and keyed by parent
// dir — enough to write an ignore rule from.
const offenders = new Map<string, number>();
// the top prefixes are the deliverable: they name the missing ignore rule
function topOffenders() {
  const top = [...offenders].sort((a, b) => b[1] - a[1]).slice(0, 3);
  offenders.clear();
  return top;
}

function enterStorm(rate: number) {
  storm = true;
  stormStartedAt = stormTickAt = Date.now();
  stormQuietSince = 0;
  stats.watchStormEntriesTotal++;
  const top = topOffenders();
  console.error(
    `forest: storm mode, ${Math.round(rate)} events/s; top paths: ` +
      (top.map(([p, n]) => `${p} (${n})`).join(", ") || "none recorded"),
  );
  log.line({
    type: "storm",
    rate: Math.round(rate),
    top: top.map(([prefix, count]) => ({ prefix, count })),
  });
  // every repo is suspect while events are being dropped
  markRoot();
}
let rootDirty = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let firstMarkAt = 0; // when the current dirty batch was first marked
let pending = false; // a drain timer is armed and has not fired yet

// ---- per-repo backoff ----
// One entry per repo that has recomputed recently; `st` is set only while the
// repo is in backoff. Dropped again as soon as both are empty, so the map is
// the hot set, not a registry of every repo.
const hot = new Map<
  string,
  { win: ReturnType<typeof rateWindow>; st?: HotState }
>();

function hotEntry(path: string) {
  let h = hot.get(path);
  if (!h) hot.set(path, h = { win: rateWindow(60_000) });
  return h;
}

// Leaving backoff has to be checked when nothing is happening — that is what
// quiet means — so it rides the timed loop rather than the drain.
function sweepHot() {
  const now = Date.now();
  for (const [path, h] of hot) {
    if (h.st && !dirty.has(path) && backoffOver(h.st, now)) {
      h.st = undefined;
      stats.watchBackoffExitsTotal++;
    }
    if (!h.st && !h.win.count(now)) hot.delete(path); // cold: forget it
  }
}

// ponytail: one global debounce timer, not one per repo — a repo that never
// goes quiet delays every other dirty repo with it. Per-repo timers if that
// shows up; the per-repo backoff is the real answer.
function schedule() {
  if (!firstMarkAt) firstMarkAt = Date.now();
  // max wait: past the ceiling, stop deferring and let the armed timer fire.
  // A pure trailing debounce never drains at all under a steady event stream.
  if (pending && Date.now() - firstMarkAt >= SETTINGS.watchMaxWaitMs) return;
  clearTimeout(debounceTimer);
  pending = true;
  debounceTimer = setTimeout(() => {
    pending = false;
    drain().catch((e) => {
      stats.errorsTotal++;
      console.error(e);
    });
  }, SETTINGS.watchDebounceMs);
}

// `dirty` holds worktree paths, not repo paths: one changed file only
// invalidates the worktree it is in.
function markWt(wt: string) {
  if (dirty.has(wt)) stats.watchDebounceCollapsedTotal++;
  dirty.add(wt);
  schedule();
}

// A .git path is repo-wide (shared refs, or a linked worktree's metadata that
// names it but not its path), so every worktree of the repo is marked. That
// costs what the old per-repo invalidation always cost; it is just no longer
// what the common case pays.
function markRepo(repo: string) {
  for (const [wt, r] of knownWorktrees) if (r === repo) markWt(wt);
}

function markRoot() {
  if (rootDirty) stats.watchRootCollapsedTotal++;
  rootDirty = true;
  schedule();
}

// Re-entrancy guard #2: global, because drain is the single consumer of the
// single dirty set. It already fans out across repos through `pool`, so a
// per-repo lock would only add bookkeeping — and a repo re-dirtied during its
// own recompute is not lost, it stays in the set and the trailing schedule()
// picks it up.
let draining = false;
// a root rescan's own sweep can't be checked: it exists because a path
// resolved to no repo, so repoByPath is stale by definition, not by miss
let rootRescanning = false;

async function drain() {
  if (draining) return schedule();
  draining = true;
  const dt0 = performance.now();
  firstMarkAt = 0; // this batch is being consumed; the next mark starts a new one
  try {
    if (rootDirty) {
      // a new directory under ROOT may be a new repo: only a full sweep knows
      rootDirty = false;
      dirty.clear();
      stats.watchRootRescansTotal++;
      // poll() can throw (readDir, gh JSON). Losing the flag here would hide a
      // newly cloned repo until an unrelated event: put it back and retry.
      rootRescanning = true;
      await poll().catch((e) => {
        rootDirty = true;
        stats.errorsTotal++;
        console.error(e);
      }).finally(() => {
        rootRescanning = false;
      });
    } else {
      const now = Date.now();
      const todo = [...dirty];
      dirty.clear();
      // backoff gate: a hot repo is put back in the dirty set instead of being
      // recomputed. It is never dropped — it stays dirty, the trailing
      // schedule() below keeps firing, and it runs when its interval is up.
      const run: string[] = [];
      for (const path of todo) {
        const h = hotEntry(path);
        const d = hotBackoff(
          h.st,
          h.win.count(now),
          now,
          SETTINGS.watchHotThreshold,
          SETTINGS.watchBackoffMaxMs,
        );
        if (!h.st && d.state) stats.watchBackoffEntriesTotal++;
        h.st = d.state; // only sweepHot clears it: exiting needs quiet, not a drain
        if (d.run) run.push(path);
        else dirty.add(path); // deferred, not dropped
      }
      // Group by repo so the two repo-level calls are paid once even when
      // several worktrees of the same repo changed in one batch.
      const byRepo = new Map<string, Set<string>>();
      for (const wt of run) {
        const repo = knownWorktrees.get(wt);
        if (!repo) continue; // vanished between mark and drain
        const set = byRepo.get(repo) ?? new Set<string>();
        set.add(wt);
        byRepo.set(repo, set);
      }
      await pool(REPO_JOBS, [...byRepo], async ([path, wts]) => {
        touched.add(path); // recomputed inside a sweep window: not judgeable
        const known = repoByPath.get(path);
        if (!known) return;
        const rt0 = performance.now();
        const fresh = await (async () => {
          const partial = await repo.recomputeWorktrees(known, wts);
          // null means the worktree list moved: only a full recompute can say
          // what the repo looks like now
          return partial ?? await repo.computeRepo(known.name, path);
        })().catch((e) => {
          stats.errorsTotal++;
          console.error(e);
          return known;
        });
        // computeRepo returns null for a transient git failure too, so only a
        // vanished .git is proof the repo is gone; otherwise keep what we had
        if (fresh) repoByPath.set(path, fresh);
        else if (!await repo.exists(path)) {
          repoByPath.delete(path);
        }
        stats.watchRecomputesTotal++;
        const rms = performance.now() - rt0;
        stats.recomputeMsTotal += rms;
        bumpMax(stats, "recomputeMsMax", rms);
        for (const wt of wts) hotEntry(wt).win.add(Date.now());
      });
      if (run.length) store.publish();
    }
  } finally {
    draining = false;
    const dms = performance.now() - dt0;
    stats.drainsTotal++;
    stats.drainMsTotal += dms;
    bumpMax(stats, "drainMsMax", dms);
    // inside the finally: a throw that skipped this would leave deferred repos
    // dirty with no timer — never recomputed, and never judged either.
    if (dirty.size || rootDirty) schedule();
  }
}

const BUCKET_STAT = {
  ignore: "watchIgnoredTotal",
  refs: "watchRefsTotal",
  index: "watchIndexTotal",
  worktree: "watchWorktreeTotal",
  unknown: "watchUnknownTotal",
} as const;

function onEvent(ev: Deno.FsEvent) {
  if (!SETTINGS.watch || !watcherUp) return; // act like poll
  const now = Date.now();
  for (const path of ev.paths) {
    stats.watchEventsTotal++;
    // knownWorktrees is already "every repo and worktree path -> repo path":
    // a repo's primary worktree path is the repo path.
    const { bucket, repo, wt } = classifyPath(path, ROOT, knownWorktrees);
    stats[BUCKET_STAT[bucket]]++;
    // Classification runs in a storm too, so entry and exit measure the same
    // population: an ignored flood (`npm ci` in node_modules) must not hold us
    // off the watcher. Measured, it is not the expensive part either — the
    // rate window costs about what the string scan does. What bounds the work
    // is dropping the event below, not skipping the classify.
    if (bucket === "ignore") continue;
    const rate = stormWindow.add(now) / (STORM_WINDOW_MS / 1000);
    // during a storm this keeps naming what is holding it open, which is the
    // input to the next ignore rule
    if (storm || rate > SETTINGS.watchStormRate / 4) {
      const dir = dirname(path);
      if (offenders.size < 1000 || offenders.has(dir)) {
        offenders.set(dir, (offenders.get(dir) ?? 0) + 1);
      }
    } else if (offenders.size) offenders.clear();
    if (storm) continue; // counted, never marked: that is what bounds the work
    if (rate > SETTINGS.watchStormRate) return enterStorm(rate);
    // a push writes refs/remotes/<remote>/<branch>, and `gh pr create` opens the
    // PR a beat after it: look shortly after the ref, not on it. A repo gh cannot
    // read is left in its backoff -- pushing to it does not fix the auth.
    if (
      repo && bucket === "refs" && path.includes("/refs/remotes/")
    ) {
      prs.pushSoon(repo, now);
    }
    if (wt) markWt(wt);
    else if (repo) markRepo(repo);
    else markRoot();
  }
}

async function watchLoop() {
  let backoff = 1000;
  let first = true;
  while (true) {
    let w: Deno.FsWatcher;
    try {
      w = Deno.watchFs(ROOT, { recursive: true });
    } catch (e) {
      // non-local filesystem, permissions: log once, keep today's polling
      if (first) {
        console.error("forest: watchFs unavailable, polling instead:", e);
        return;
      }
      // a failed re-open retries the OPEN; looping onto the dead stream would
      // spin restarts forever
      console.error("forest: watcher re-open failed:", e);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    watcherUp = true;
    if (!first) {
      backoff = 1000;
      // whatever this sweep finds is the downtime, not a missed event, so it
      // declines any pending check rather than logging the gap as misses
      if (checkRequestedAt) stats.divergenceChecksSkippedTotal++;
      checkRequestedAt = 0;
      poll().catch(() => stats.errorsTotal++); // events missed while down
    }
    first = false;
    try {
      for await (const ev of w) onEvent(ev);
      console.error("forest: watcher stream ended");
    } catch (e) {
      console.error("forest: watcher failed:", e);
    }
    watcherUp = false;
    stats.watcherRestartsTotal++;
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

const gauges = () => ({
  clients: sse.size(),
  mode: mode(),
  watchDirty: dirty.size,
  hotWts: [...hot.values()].filter((h) => h.st).length,
  watchEventRate: Math.round(eventRate(Date.now())),
  storm,
});

const LOG_PATH = join(HOME, ".forest", "forest-log.jsonl");
const log = createLog({ path: LOG_PATH, stats });

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

if (SETTINGS.watch) watchLoop();

let lastSafetySweep = Date.now();

(async () => {
  const bootT0 = performance.now();
  await poll().catch((e) => {
    stats.errorsTotal++;
    console.error(e);
  });
  // emitted the moment the UI has something to render, not on the 60s tick,
  // and partitioned so a slow start names its own culprit
  log.line({
    type: "startup",
    bootMs: Math.round(performance.now() - bootT0),
    gitMs: stats.gitMs,
    portsMs: stats.portsMs,
    prsMs: stats.prsMs,
    repos: stats.repos,
    worktrees: stats.worktrees,
    git: stats.gitTotal,
    gh: stats.ghTotal,
    other: stats.otherTotal,
    snapshotBytes: stats.snapshotBytes,
  });
  while (true) {
    await new Promise((r) => setTimeout(r, SETTINGS.pollMs));
    try {
      sweepHot();
      if (storm) {
        const now = Date.now();
        // a laptop suspend during a storm would otherwise charge the whole
        // sleep to the storm; an implausible delta is a stopped clock, not time
        stats.watchStormMsTotal += Math.min(
          now - stormTickAt,
          4 * SETTINGS.pollMs,
        );
        stormTickAt = now;
        // out once the flood has been under a quarter of the threshold for 30 s
        if (eventRate(now) >= SETTINGS.watchStormRate / 4) stormQuietSince = 0;
        else if (!stormQuietSince) stormQuietSince = now;
        else if (now - stormQuietSince >= 30_000) {
          storm = false;
          const top = topOffenders(); // what was still arriving during it
          console.error(
            "forest: storm over, watching again; top paths: " +
              (top.map(([p, n]) => `${p} (${n})`).join(", ") ||
                "none recorded"),
          );
          log.line({
            type: "stormOver",
            ms: now - stormStartedAt,
            top: top.map(([prefix, count]) => ({ prefix, count })),
          });
          markRoot(); // events were dropped: sweep once before trusting them
        }
      }
      // in watch mode the git sweep is the watcher's job; the timed loop only
      // carries the two sources that are not per-repo events. ponytail: ports
      // and PRs share pollMs rather than earning a setting each.
      if (mode() === "watch") {
        // safety net: FSEvents can coalesce or drop, so ground truth is
        // recomputed on watchSweepMs regardless of what events said. Granularity
        // is pollMs, which is this loop's tick.
        if (Date.now() - lastSafetySweep >= SETTINGS.watchSweepMs) {
          lastSafetySweep = Date.now();
          stats.watchSafetySweepsTotal++;
          checkRequestedAt = Date.now();
          await poll();
        } else {
          await ports.refresh();
          await prs.refreshPrs([...repoByPath.values()]);
          store.publish();
        }
      } else await poll();
    } catch (e) {
      stats.errorsTotal++;
      console.error(e);
    }
  }
})();

// ---- server ----

// a mutation can add or remove a worktree, so it needs the full sweep; in
// watch mode it is debounced with everything else instead of firing at once.
const afterMutation = () =>
  mode() === "watch" ? markRoot() : void poll().catch(() => {});

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
      if (!booted) {
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
          afterMutation();
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
      afterMutation();
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
