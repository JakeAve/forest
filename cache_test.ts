import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { join } from "@std/path";
import { createCache } from "./cache.ts";
import { fakeExec, repo, worktree } from "./fixtures.ts";
import { createPrs } from "./prs.ts";
import { DEFAULTS } from "./settings.ts";
import { newStats } from "./stats.ts";
import { createStore } from "./store.ts";
import type { Pr } from "./types.ts";

function graph(path: string) {
  const stats = newStats();
  const prs = createPrs({
    sh: fakeExec({}),
    settings: { ...DEFAULTS },
    stats,
    onChange: () => {},
  });
  const store = createStore({
    prFor: prs.prFor,
    prListed: prs.listed,
    procs: () => new Map(),
    onSnapshot: (j) => cache.save(j),
    stats,
  });
  const logs: Record<string, unknown>[] = [];
  const cache = createCache({ path, store, prs, log: (o) => logs.push(o) });
  return { store, prs, cache, logs };
}

const PR = {
  number: 7,
  url: "https://github.com/x/y/pull/7",
  state: "OPEN",
  stateSince: 5,
  title: "Add the thing",
  ci: { state: "pass", failing: [] },
  detailAt: 9,
} as unknown as Pr;

async function tmp(fn: (path: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(join(dir, "roots", "x", "cache.json"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("cache: a second boot serves the last snapshot, PRs included", () =>
  tmp(async (path) => {
    const a = graph(path);
    const r = repo({
      prListed: true,
      worktrees: [worktree({ branch: "feat", pr: PR, ports: [3000] })],
    });
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify({ v: 1, repos: [r] }));
    await a.cache.load();
    const [got] = JSON.parse(a.store.snapshot());
    assertEquals(got.worktrees[0].pr, PR);
    assertEquals(got.prListed, true);
    assertEquals(got.cached, true);
    assertEquals(got.worktrees[0].ports, []); // live data is never served stale

    await a.cache.flush();
    const b = graph(path);
    await b.cache.load();
    assertEquals(b.store.snapshot(), a.store.snapshot());
    await b.cache.flush();
  }));

Deno.test("cache: a missing, corrupt or foreign file is ignored", () =>
  tmp(async (path) => {
    await Deno.mkdir(join(path, ".."), { recursive: true });
    for (
      const body of [
        null,
        "{nope",
        '{"v":0,"repos":[]}',
        '{"v":1,"repos":[{"path":"/r/x","name":"x"}]}',
      ]
    ) {
      if (body !== null) await Deno.writeTextFile(path, body);
      const g = graph(path);
      await g.cache.load();
      assertEquals(g.store.snapshot(), "[]");
      assertEquals(g.store.byPath.size, 0);
    }
  }));

Deno.test("cache: writes the latest snapshot once per delay", () =>
  tmp(async (path) => {
    using time = new FakeTime();
    const g = graph(path);
    g.cache.save("[1]");
    await time.tickAsync(1000);
    g.cache.save("[2]");
    assertEquals(await Deno.readTextFile(path).catch(() => null), null);
    await time.tickAsync(1000);
    await g.cache.flush();
    assertEquals(await Deno.readTextFile(path), '{"v":1,"repos":[2]}');
  }));
