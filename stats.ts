import process from "node:process"; // cpuUsage(): self CPU, see stats above
import type { Settings } from "./settings.ts";

// ---- baseline metrics ----
// Cumulative since start. Diff two log lines to get a rate.
// *Total fields are cumulative since startedAt — diff two lines for a rate.
// Everything else is a gauge, true only at the instant the line was written.
export const newStats = () => ({
  startedAt: Date.now(),
  pollsTotal: 0,
  pollMsTotal: 0, // divide by pollsTotal for a mean over any window
  pollMs: 0,
  // ponytail: cpu*MsTotal is RUSAGE_SELF — this process only. The git and gh
  // children are the bulk of the machine cost and land in subprocessMsTotal as
  // wall time instead. Read the two together; neither alone is "CPU used".
  cpuUserMsTotal: 0,
  cpuSystemMsTotal: 0,
  subprocessesTotal: 0,
  gitTotal: 0,
  ghTotal: 0,
  otherTotal: 0,
  subprocessMsTotal: 0, // summed wall time across the three spawn chokepoints
  subprocessInflight: 0,
  // the three phases of a poll, so a slow one names its own culprit
  gitMs: 0,
  gitMsTotal: 0,
  portsMs: 0,
  portsMsTotal: 0,
  prsMs: 0, // 0 on polls where prPollMs rate-limits the call away
  prsMsTotal: 0,
  // swallowed per-repo failures: a repo can vanish from the snapshot without
  // errorsTotal moving. Never zero — a repo with no upstream fails every poll.
  // Watch the rate, not the value.
  gitFailTotal: 0,
  ghFailTotal: 0,
  errorsTotal: 0,
  broadcastsTotal: 0,
  // event-loop lag: the honest "is it struggling" number. A 250ms timer that
  // fires late means the loop was blocked, whatever the cause.
  lagSamplesTotal: 0,
  lagMsTotal: 0,
  logWritesTotal: 0,
  logFailTotal: 0,
  logRotationsTotal: 0,
  pollMsMax: 0,
  gitMsMax: 0,
  recomputeMsMax: 0,
  drainMsMax: 0,
  lagMsMax: 0,
  subprocessPeak: 0, // high-water concurrent children
  // ---- watcher ----
  watchEventsTotal: 0, // one per event *path*, not per FsEvent
  watchIgnoredTotal: 0,
  watchRefsTotal: 0,
  watchIndexTotal: 0,
  watchWorktreeTotal: 0,
  watchUnknownTotal: 0,
  watchRecomputesTotal: 0, // single repos recomputed from an event
  watchRootRescansTotal: 0, // full sweeps forced by an unknown path
  watchDebounceCollapsedTotal: 0, // marks that landed on an already-dirty repo
  watchRootCollapsedTotal: 0, // root rescans that landed on an already-dirty root
  watcherRestartsTotal: 0,
  // the watch path's own cost, so the per-worktree recompute can be measured
  // rather than just counted: pairs with watchRecomputesTotal, and drains are
  // the watch-path analogue of a poll
  recomputeMsTotal: 0,
  drainsTotal: 0,
  drainMsTotal: 0,
  // ---- backoff + storm: the safety valve ----
  watchBackoffEntriesTotal: 0, // repos that went hot
  watchBackoffExitsTotal: 0, // ...and later went quiet again
  watchStormEntriesTotal: 0,
  watchStormMsTotal: 0, // time spent degraded to plain polling
  // ---- safety net + divergence ----
  // sweepsTotal counts every full sweep, whatever fired it (timer, mutating
  // POST, root rescan). This counts only the timed safety-net ones, so
  // divergences-per-sweep has a denominator that means something.
  watchSafetySweepsTotal: 0,
  divergencesTotal: 0,
  // a divergence check skipped WHOLESALE, which now only happens for a root
  // rescan: a repo may have appeared or vanished, which is not per-repo
  divergenceChecksSkippedTotal: 0,
  // per-repo exclusion instead. A sweep spans seconds, so a repo touched
  // anywhere in that window cannot be judged; the other 120 still are.
  divergenceReposCheckedTotal: 0,
  divergenceReposExcludedTotal: 0,
  divergenceBranchTotal: 0,
  divergenceHeadTotal: 0,
  divergenceAheadTotal: 0,
  divergenceBehindTotal: 0,
  divergenceDirtyTotal: 0,
  divergenceLastActivityTotal: 0,
  divergenceRemoteTotal: 0,
  divergenceWorktreeAddedTotal: 0,
  divergenceWorktreeRemovedTotal: 0,
  divergenceRepoAddedTotal: 0,
  divergenceRepoRemovedTotal: 0,
  snapshotBytes: 0, // last snapshot that changed
  repos: 0,
  worktrees: 0,
  heapBytes: 0,
  load1: 0, // machine-wide: separates "the box was busy" from "we were busy"
});

export type Stats = ReturnType<typeof newStats>;

export const MAX_FIELDS = [
  "pollMsMax",
  "gitMsMax",
  "recomputeMsMax",
  "drainMsMax",
  "lagMsMax",
  "subprocessPeak",
] as const;

export const bumpMax = (
  s: Stats,
  k: typeof MAX_FIELDS[number],
  v: number,
) => {
  if (v > s[k]) s[k] = v;
};

// `timed` records one phase of a poll. The three partition it, so a slow poll
// says which stage was slow instead of needing to be reproduced.
export async function timed<T>(
  s: Stats,
  key: "gitMs" | "portsMs",
  p: Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  try {
    return await p;
  } finally {
    s[key] = Math.round(performance.now() - t0);
    s[`${key}Total`] += s[key];
  }
}

export const statsLine = (
  stats: Stats,
  settings: Settings,
  gauges: {
    clients: number;
    mode: "watch" | "poll";
    watchDirty: number;
    hotWts: number;
    watchEventRate: number;
    storm: boolean;
  },
): Record<string, unknown> => {
  const cpu = process.cpuUsage(); // cumulative µs since start, self only
  const mem = Deno.memoryUsage();
  stats.cpuUserMsTotal = Math.round(cpu.user / 1000);
  stats.cpuSystemMsTotal = Math.round(cpu.system / 1000);
  stats.heapBytes = mem.heapUsed;
  stats.load1 = Math.round(Deno.loadavg()[0] * 100) / 100;
  return {
    t: new Date().toISOString(),
    uptimeMs: Date.now() - stats.startedAt,
    ...stats,
    // accumulated as a float for precision, emitted rounded: sub-ms children
    // still sum correctly and the log stays readable through jq
    subprocessMsTotal: Math.round(stats.subprocessMsTotal),
    lagMsTotal: Math.round(stats.lagMsTotal),
    lagMsMax: Math.round(stats.lagMsMax),
    recomputeMsTotal: Math.round(stats.recomputeMsTotal),
    drainMsTotal: Math.round(stats.drainMsTotal),
    recomputeMsMax: Math.round(stats.recomputeMsMax),
    drainMsMax: Math.round(stats.drainMsMax),
    rss: mem.rss,
    clients: gauges.clients,
    pollMsSetting: settings.pollMs,
    mode: gauges.mode,
    watchDebounceMs: settings.watchDebounceMs,
    watchMaxWaitMs: settings.watchMaxWaitMs,
    watchSweepMs: settings.watchSweepMs,
    watchHotThreshold: settings.watchHotThreshold,
    watchBackoffMaxMs: settings.watchBackoffMaxMs,
    watchStormRate: settings.watchStormRate,
    watchDirty: gauges.watchDirty,
    // renamed from hotRepos: backoff is keyed per worktree now, so the old name
    hotWts: gauges.hotWts, // in backoff now
    watchEventRate: gauges.watchEventRate,
    storm: gauges.storm,
  };
};
