import { dirname } from "@std/path";
import {
  backoffOver,
  classifyPath,
  diffSnapshots,
  hotBackoff,
  type HotState,
  pool,
  rateWindow,
} from "./parse.ts";
import { REPO_JOBS, type RepoApi } from "./repo.ts";
import type { PrsApi } from "./prs.ts";
import type { StoreApi } from "./store.ts";
import type { SseApi } from "./sse.ts";
import type { Settings } from "./settings.ts";
import { bumpMax, type Stats } from "./stats.ts";
import type { Repo } from "./types.ts";

export type WatcherApi = {
  onEvent(ev: { paths: string[] }): void;
  tick(): Promise<void>;
  poll(): Promise<void>;
  sweepAll(): Promise<void>;
  markRoot(): void;
  afterMutation(): void;
  mode(): "watch" | "poll";
  booted(): boolean;
  gauges(): {
    mode: "watch" | "poll";
    watchDirty: number;
    hotWts: number;
    watchEventRate: number;
    storm: boolean;
  };
  watch(): Promise<void>;
  start(): void;
};

export function createWatcher(
  { repo, prs, ports, store, sse, stats, settings, root, log, watchFs }: {
    repo: RepoApi;
    prs: Pick<PrsApi, "refreshPrs" | "pushSoon">;
    ports: { refresh(): Promise<void> };
    store: StoreApi;
    sse: Pick<SseApi, "setStatus">;
    stats: Stats;
    settings: Settings;
    root: string;
    log: (o: Record<string, unknown>) => void;
    watchFs: (root: string) => AsyncIterable<{ paths: string[] }>;
  },
): WatcherApi {
  const { byPath: repoByPath, known: knownWorktrees } = store;

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
        log({ type: "divergence", ...d });
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
      if (!booted) {
        sse.setStatus({ phase: "repos", done: 0, total: dirs.length });
      }
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
    settings.watch && watcherUp && !storm ? "watch" : "poll";
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
    log({
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
    if (pending && Date.now() - firstMarkAt >= settings.watchMaxWaitMs) return;
    clearTimeout(debounceTimer);
    pending = true;
    debounceTimer = setTimeout(() => {
      pending = false;
      drain().catch((e) => {
        stats.errorsTotal++;
        console.error(e);
      });
    }, settings.watchDebounceMs);
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
            settings.watchHotThreshold,
            settings.watchBackoffMaxMs,
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

  function onEvent(ev: { paths: string[] }) {
    if (!settings.watch || !watcherUp) return; // act like poll
    const now = Date.now();
    for (const path of ev.paths) {
      stats.watchEventsTotal++;
      // knownWorktrees is already "every repo and worktree path -> repo path":
      // a repo's primary worktree path is the repo path.
      const { bucket, repo, wt } = classifyPath(path, root, knownWorktrees);
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
      if (storm || rate > settings.watchStormRate / 4) {
        const dir = dirname(path);
        if (offenders.size < 1000 || offenders.has(dir)) {
          offenders.set(dir, (offenders.get(dir) ?? 0) + 1);
        }
      } else if (offenders.size) offenders.clear();
      if (storm) continue; // counted, never marked: that is what bounds the work
      if (rate > settings.watchStormRate) return enterStorm(rate);
      // a push writes refs/remotes/<remote>/<branch>, and `gh pr create` opens the
      // PR a beat after it: look shortly after the ref, not on it.
      if (repo && bucket === "refs" && path.includes("/refs/remotes/")) {
        prs.pushSoon(repo, now);
      }
      if (wt) markWt(wt);
      else if (repo) markRepo(repo);
      else markRoot();
    }
  }

  async function watch() {
    let backoff = 1000;
    let first = true;
    while (true) {
      let w: AsyncIterable<{ paths: string[] }>;
      try {
        w = watchFs(root);
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
    mode: mode(),
    watchDirty: dirty.size,
    hotWts: [...hot.values()].filter((h) => h.st).length,
    watchEventRate: Math.round(eventRate(Date.now())),
    storm,
  });

  let lastSafetySweep = Date.now();

  async function tick() {
    try {
      sweepHot();
      if (storm) {
        const now = Date.now();
        // a laptop suspend during a storm would otherwise charge the whole
        // sleep to the storm; an implausible delta is a stopped clock, not time
        stats.watchStormMsTotal += Math.min(
          now - stormTickAt,
          4 * settings.pollMs,
        );
        stormTickAt = now;
        // out once the flood has been under a quarter of the threshold for 30 s
        if (eventRate(now) >= settings.watchStormRate / 4) stormQuietSince = 0;
        else if (!stormQuietSince) stormQuietSince = now;
        else if (now - stormQuietSince >= 30_000) {
          storm = false;
          const top = topOffenders(); // what was still arriving during it
          console.error(
            "forest: storm over, watching again; top paths: " +
              (top.map(([p, n]) => `${p} (${n})`).join(", ") ||
                "none recorded"),
          );
          log({
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
        if (Date.now() - lastSafetySweep >= settings.watchSweepMs) {
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

  function start() {
    if (settings.watch) watch();
    (async () => {
      const bootT0 = performance.now();
      await poll().catch((e) => {
        stats.errorsTotal++;
        console.error(e);
      });
      // emitted the moment the UI has something to render, not on the 60s tick,
      // and partitioned so a slow start names its own culprit
      log({
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
        await new Promise((r) => setTimeout(r, settings.pollMs));
        await tick();
      }
    })();
  }

  return {
    onEvent,
    tick,
    poll,
    sweepAll,
    markRoot,
    // a mutation can add or remove a worktree, so it needs the full sweep; in
    // watch mode it is debounced with everything else instead of firing at once.
    afterMutation: () =>
      mode() === "watch" ? markRoot() : void poll().catch(() => {}),
    mode,
    booted: () => booted,
    gauges,
    watch,
    start,
  };
}
