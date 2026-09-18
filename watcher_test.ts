import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { pushable, repo as mkRepo, worktree } from "./fixtures.ts";
import type { RepoApi } from "./repo.ts";
import { DEFAULTS } from "./settings.ts";
import { newStats } from "./stats.ts";
import { createStore } from "./store.ts";
import type { Repo } from "./types.ts";
import { createWatcher } from "./watcher.ts";

const fixtures = (): Map<string, Repo> =>
  new Map([
    [
      "/r/forest",
      mkRepo({
        worktrees: [
          worktree({ path: "/r/forest", isPrimary: true }),
          worktree({ path: "/r/forest-feat" }),
        ],
      }),
    ],
    [
      "/r/other",
      mkRepo({
        name: "other",
        path: "/r/other",
        worktrees: [
          worktree({ repo: "other", path: "/r/other", isPrimary: true }),
        ],
      }),
    ],
  ]);

type Stream = ReturnType<typeof pushable<{ paths: string[] }>>;

function make(opts: { openFails?: (call: number) => boolean } = {}) {
  const settings = { ...DEFAULTS, root: "/r" };
  const stats = newStats();
  const store = createStore({
    prFor: () => null,
    procs: () => new Map(),
    onSnapshot: () => {},
    stats,
  });
  const truth = fixtures();
  const h = {
    settings,
    stats,
    store,
    truth,
    exists: true,
    computeNull: false,
    recomputeNull: false,
    gate: null as Promise<void> | null,
    computes: [] as string[],
    recomputes: [] as string[][],
    repoDirs: 0,
    pushes: [] as string[],
    logs: [] as Record<string, unknown>[],
    streams: [] as Stream[],
    opens: 0,
  };
  const repo: RepoApi = {
    repoDirs: () => {
      h.repoDirs++;
      return Promise.resolve(
        [...truth.values()].map((r) => ({ name: r.name, path: r.path })),
      );
    },
    computeRepo: async (_name, path) => {
      h.computes.push(path);
      if (h.gate) await h.gate;
      return h.computeNull ? null : structuredClone(truth.get(path) ?? null);
    },
    recomputeWorktrees: async (r, want) => {
      h.recomputes.push([...want].sort());
      if (h.gate) await h.gate;
      return h.recomputeNull ? null : r;
    },
    mergeBase: () => Promise.resolve("HEAD"),
    exists: () => Promise.resolve(h.exists),
  };
  const w = createWatcher({
    repo,
    prs: {
      refreshPrs: () => Promise.resolve(),
      pushSoon: (r) => void h.pushes.push(r),
    },
    ports: { refresh: () => Promise.resolve() },
    store,
    sse: { setStatus: () => {} },
    stats,
    settings,
    root: "/r",
    log: (o) => void h.logs.push(o),
    watchFs: () => {
      h.opens++;
      if (opts.openFails?.(h.opens)) throw new Error("no watch");
      const s = pushable<{ paths: string[] }>();
      h.streams.push(s);
      return s;
    },
  });
  return Object.assign(h, { w });
}

const quiet = () => {
  const orig = console.error;
  const errs: unknown[] = [];
  console.error = (...a: unknown[]) => errs.push(a[0]);
  return { errs, [Symbol.dispose]: () => (console.error = orig) };
};

// FakeTime fires every timer due in one tick synchronously, so a drain's
// trailing schedule() would never see its own timer fire: step through in
// slices with the microtasks run between them.
const tick = async (time: FakeTime, ms: number) => {
  for (let left = ms; left > 0; left -= 100) {
    await time.tickAsync(Math.min(100, left));
  }
  await time.tickAsync(0);
};

async function boot(opts?: Parameters<typeof make>[0]) {
  const h = make(opts);
  await h.w.poll();
  h.w.watch();
  return h;
}

const ev = (...paths: string[]) => ({ paths });

Deno.test("a worktree event marks only that worktree and recomputes after watchDebounceMs", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  assertEquals(h.w.mode(), "watch");
  h.streams[0].push(ev("/r/forest-feat/src/a.ts"));
  await tick(time, 0);
  assertEquals(h.stats.watchWorktreeTotal, 1);
  assertEquals(h.w.gauges().watchDirty, 1);
  await tick(time, 299);
  assertEquals(h.recomputes, []);
  await tick(time, 1);
  assertEquals(h.recomputes, [["/r/forest-feat"]]);
  assertEquals(h.stats.watchRecomputesTotal, 1);
  assertEquals(h.w.gauges().watchDirty, 0);
});

Deno.test("a .git refs event marks every worktree of the repo once", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  h.streams[0].push(ev("/r/forest/.git/refs/heads/main"));
  await tick(time, 0);
  assertEquals(h.stats.watchRefsTotal, 1);
  assertEquals(h.w.gauges().watchDirty, 2);
  await tick(time, 300);
  assertEquals(h.recomputes, [["/r/forest", "/r/forest-feat"]]);
  assertEquals(h.stats.watchRecomputesTotal, 1);
});

Deno.test("an unknown path marks root and the drain runs a full poll", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  h.streams[0].push(ev("/r/newrepo"));
  await tick(time, 300);
  assertEquals(h.stats.watchUnknownTotal, 1);
  assertEquals(h.stats.watchRootRescansTotal, 1);
  assertEquals(h.stats.pollsTotal, 2);
  assertEquals(h.recomputes, []);
});

Deno.test("a steady event stream still drains at watchMaxWaitMs", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  for (let t = 0; t < 2100; t += 100) {
    h.streams[0].push(ev("/r/forest-feat/src/a.ts"));
    await tick(time, 100);
    assertEquals(h.recomputes.length, 0, `drained early at ${t + 100}`);
  }
  await tick(time, 100); // 2200: debounce + max wait
  assertEquals(h.recomputes.length, 1);
  assertEquals(h.stats.watchDebounceCollapsedTotal, 20);
  await tick(time, 300);
});

Deno.test("a mark during an in-flight drain is picked up by the trailing schedule", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  let release!: () => void;
  h.gate = new Promise<void>((r) => release = r);
  h.streams[0].push(ev("/r/forest-feat/src/a.ts"));
  await tick(time, 300);
  assertEquals(h.recomputes.length, 1);
  h.streams[0].push(ev("/r/other/x.ts"));
  await tick(time, 0);
  h.gate = null;
  release();
  await tick(time, 0);
  assertEquals(h.stats.drainsTotal, 1);
  await tick(time, 300);
  assertEquals(h.recomputes, [["/r/forest-feat"], ["/r/other"]]);
  assertEquals(h.w.gauges().watchDirty, 0);
});

async function goHot(time: FakeTime, h: Awaited<ReturnType<typeof boot>>) {
  for (let i = 0; i < DEFAULTS.watchHotThreshold + 1; i++) {
    h.streams[0].push(ev("/r/forest-feat/src/a.ts"));
    await tick(time, 300);
  }
}

Deno.test("watchHotThreshold+1 recomputes in 60 s enter backoff; the worktree stays dirty and is deferred", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  await goHot(time, h);
  assertEquals(h.recomputes.length, 11);
  assertEquals(h.stats.watchBackoffEntriesTotal, 1);
  assertEquals(h.w.gauges().hotWts, 1);
  h.streams[0].push(ev("/r/forest-feat/src/a.ts"));
  await tick(time, 300);
  assertEquals(h.recomputes.length, 11);
  assertEquals(h.w.gauges().watchDirty, 1);
  await tick(time, 1000);
  assertEquals(h.recomputes.length, 12);
  assertEquals(h.w.gauges().watchDirty, 0);
});

Deno.test("sweepHot on tick exits backoff after its interval and forgets cold entries", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  await goHot(time, h);
  await tick(time, 1999);
  await h.w.tick();
  assertEquals(h.w.gauges().hotWts, 1);
  await tick(time, 1);
  await h.w.tick();
  assertEquals(h.w.gauges().hotWts, 0);
  assertEquals(h.stats.watchBackoffExitsTotal, 1);
  await time.tickAsync(60_000);
  await h.w.tick();
  await goHot(time, h);
  assertEquals(h.stats.watchBackoffEntriesTotal, 2);
});

const flood = (n: number) =>
  ev(...Array.from({ length: n }, (_, i) => `/r/forest-feat/src/f${i}.ts`));

Deno.test("more than watchStormRate paths per second enter storm once, mark root and count offenders", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  h.streams[0].push(flood(DEFAULTS.watchStormRate * 5 + 1));
  await tick(time, 0);
  assertEquals(h.stats.watchStormEntriesTotal, 1);
  assertEquals(h.w.gauges().storm, true);
  assertEquals(h.w.mode(), "poll");
  const storm = h.logs.filter((l) => l.type === "storm");
  assertEquals(storm.length, 1);
  const top = storm[0].top as { prefix: string; count: number }[];
  assertEquals(top[0].prefix, "/r/forest-feat/src");
  assert(top[0].count > 0);
  h.streams[0].push(flood(100));
  await tick(time, 300);
  assertEquals(h.stats.watchStormEntriesTotal, 1);
  assertEquals(h.stats.watchRootRescansTotal, 1);
  assertEquals(h.recomputes, []);
});

Deno.test("30 s under a quarter of the threshold exits storm and marks root again", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  h.streams[0].push(flood(DEFAULTS.watchStormRate * 5 + 1));
  await tick(time, 300);
  await tick(time, 5000);
  await h.w.tick();
  assertEquals(h.w.gauges().storm, true);
  await tick(time, 29_999);
  await h.w.tick();
  assertEquals(h.w.gauges().storm, true);
  await tick(time, 1);
  await h.w.tick();
  assertEquals(h.w.gauges().storm, false);
  assertEquals(h.w.mode(), "watch");
  assertEquals(h.logs.filter((l) => l.type === "stormOver").length, 1);
  assert(h.stats.watchStormMsTotal > 0);
  await tick(time, 300);
  assertEquals(h.stats.watchRootRescansTotal, 2);
});

Deno.test("sweepAll while sweeping queues exactly one follow-up sweep", async () => {
  using _q = quiet();
  const h = make();
  await h.w.poll();
  let release!: () => void;
  h.gate = new Promise<void>((r) => release = r);
  const p1 = h.w.sweepAll();
  const p2 = h.w.sweepAll();
  const p3 = h.w.sweepAll();
  assertStrictEquals(p2, p3);
  assert(p1 !== p2);
  h.gate = null;
  release();
  await Promise.all([p1, p2, p3]);
  assertEquals(h.repoDirs, 3);
  assertEquals(h.computes.length, 6);
});

Deno.test("a safety sweep judges quiet repos and excludes those touched during the window", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  for (const r of h.truth.values()) r.worktrees[0].head = "bbbbbbb2";
  await time.tickAsync(DEFAULTS.watchSweepMs);
  let release!: () => void;
  h.gate = new Promise<void>((r) => release = r);
  const t = h.w.tick();
  await tick(time, 0);
  assertEquals(h.stats.watchSafetySweepsTotal, 1);
  h.streams[0].push(ev("/r/other/x.ts"));
  await tick(time, 300);
  h.gate = null;
  release();
  await t;
  await tick(time, 0);
  assertEquals(h.stats.divergenceReposCheckedTotal, 1);
  assertEquals(h.stats.divergenceReposExcludedTotal, 1);
  assertEquals(h.stats.divergencesTotal, 1);
  assertEquals(h.stats.divergenceHeadTotal, 1);
  const d = h.logs.filter((l) => l.type === "divergence");
  assertEquals(d.map((l) => l.repo), ["/r/forest"]);
});

Deno.test("computeRepo null keeps the old repo when .git exists and deletes it when it is gone", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  h.recomputeNull = true;
  h.computeNull = true;
  h.streams[0].push(ev("/r/forest-feat/src/a.ts"));
  await tick(time, 300);
  assertEquals(h.computes.at(-1), "/r/forest");
  assert(h.store.byPath.has("/r/forest"));
  h.exists = false;
  h.streams[0].push(ev("/r/forest-feat/src/a.ts"));
  await tick(time, 300);
  assertEquals([...h.store.byPath.keys()], ["/r/other"]);
  assertEquals(h.store.known.has("/r/forest-feat"), false);
});

Deno.test("a refs/remotes event calls prs.pushSoon", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot();
  h.streams[0].push(ev("/r/forest/.git/refs/heads/main"));
  h.streams[0].push(ev("/r/forest/.git/refs/remotes/origin/feat"));
  await tick(time, 0);
  assertEquals(h.pushes, ["/r/forest"]);
});

Deno.test("watchFs throwing on first open leaves mode at poll", async () => {
  using _q = quiet();
  const h = make({ openFails: () => true });
  await h.w.poll();
  await h.w.watch();
  assertEquals(h.w.mode(), "poll");
  h.w.onEvent(ev("/r/forest-feat/src/a.ts"));
  assertEquals(h.stats.watchEventsTotal, 0);
  assertEquals(h.w.gauges().mode, "poll");
});

Deno.test("a stream that ends restarts with backoff and polls once", async () => {
  using time = new FakeTime();
  using _q = quiet();
  const h = await boot({ openFails: (n) => n === 2 });
  h.streams[0].end();
  await tick(time, 0);
  assertEquals(h.stats.watcherRestartsTotal, 1);
  assertEquals(h.w.mode(), "poll");
  await tick(time, 999);
  assertEquals(h.opens, 1);
  await tick(time, 1); // 1 s: re-open fails
  assertEquals(h.opens, 2);
  await tick(time, 1999);
  assertEquals(h.opens, 2);
  await tick(time, 1); // 2 s more: re-open succeeds
  assertEquals(h.opens, 3);
  assertEquals(h.w.mode(), "watch");
  assertEquals(h.stats.pollsTotal, 2);
  h.streams[1].push(ev("/r/forest-feat/src/a.ts"));
  await tick(time, 300);
  assertEquals(h.recomputes, [["/r/forest-feat"]]);
});
