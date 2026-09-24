import { assert, assertEquals } from "@std/assert";
import { createAutoRebase } from "./autorebase.ts";
import { fakeExec, repo, worktree } from "./fixtures.ts";
import type { Pr, Worktree } from "./types.ts";

const WT = "/r/forest-feat";
const OPEN_PR = { number: 7, state: "OPEN" } as Pr;
const BASE = {
  "git fetch origin": "",
  "git rev-parse origin/HEAD": "base1\n",
  "git rev-list --left-right --count origin/HEAD...HEAD": "2\t1\n",
};

// `use` swaps the command table between ticks; `calls` is only what acted
// (fetch and rev-* reads are dropped)
function make(over: Partial<Worktree>, table: Record<string, string> = {}) {
  let fake = fakeExec({ ...BASE, ...table });
  const w = worktree({ path: WT, branch: "feat", ...over });
  const store = {
    byPath: new Map([["/r/forest", repo({ worktrees: [w] })]]),
    known: new Map([[WT, "/r/forest"]]),
    published: 0,
    publish() {
      this.published++;
    },
  };
  const refreshed: number[] = [];
  const logs: Record<string, unknown>[] = [];
  let mutations = 0;
  const path = `${Deno.makeTempDirSync()}/autorebase.json`;
  const deps = {
    sh: {
      exec: (cwd: string, cmd: string[]) => fake.exec(cwd, cmd),
      git: (cwd: string, ...args: string[]) => fake.exec(cwd, ["git", ...args]),
    },
    store,
    prs: {
      refreshOnePr: (_r: string, n: number) => {
        refreshed.push(n);
        return Promise.resolve();
      },
      refreshPrSoon: () => {},
    },
    path,
    afterMutation: () => mutations++,
    log: (o: Record<string, unknown>) => logs.push(o),
  };
  return {
    api: createAutoRebase(deps),
    deps,
    store,
    refreshed,
    logs,
    mutations: () => mutations,
    use: (t: Record<string, string>) => {
      fake = fakeExec({ ...BASE, ...t });
    },
    all: () => fake.calls.map((c) => c.split(" $ ")[1]),
    calls: () =>
      fake.calls.map((c) => c.split(" $ ")[1]).filter((c) =>
        !c.startsWith("git fetch") && !c.startsWith("git rev-")
      ),
  };
}

Deno.test("no-PR branch behind base is rebased and fetched once per repo", async () => {
  const t = make({}, { "git rebase origin/HEAD": "" });
  await t.api.set(WT, true);
  await t.api.tick();
  assertEquals(t.calls(), ["git rebase origin/HEAD"]);
  assertEquals(t.all().filter((c) => c.startsWith("git fetch")).length, 1);
  assertEquals(t.mutations(), 1);
  assertEquals(t.logs, [{ type: "autoRebase", wt: WT, action: "rebase" }]);

  t.use({ "git rev-list --left-right --count origin/HEAD...HEAD": "0\t1\n" });
  await t.api.tick();
  assertEquals(t.calls(), []);
  assertEquals(t.mutations(), 1);
});

Deno.test("skips primary, dirty, mid-op and opted-out worktrees", async () => {
  for (
    const over of [{ isPrimary: true }, { dirty: 1 }, {
      state: "merge" as const,
    }]
  ) {
    const t = make(over);
    await t.api.set(WT, true);
    await t.api.tick();
    assertEquals(t.all(), []);
  }
  const t = make({});
  await t.api.tick();
  assertEquals(t.all(), []);
});

Deno.test("a conflict aborts, is remembered against the base sha, and retries once base moves", async () => {
  const t = make({}, { "git rebase --abort": "" });
  await t.api.set(WT, true);
  await t.api.tick();
  assert(t.api.status(WT)?.error?.includes("rebase failed"));
  assertEquals(t.calls(), ["git rebase origin/HEAD", "git rebase --abort"]);
  assertEquals(t.mutations(), 0);
  assertEquals(t.store.published, 2); // set + the new error

  t.use({ "git rebase origin/HEAD": "" });
  await t.api.tick(); // same base: not retried, even though it would succeed
  assertEquals(t.calls(), []);

  t.use({
    "git rev-parse origin/HEAD": "base2\n",
    "git rebase origin/HEAD": "",
  });
  await t.api.tick();
  assertEquals(t.calls(), ["git rebase origin/HEAD"]);
  assertEquals(t.api.status(WT), { on: true, error: null });
});

Deno.test("PR branch: update-branch when behind base, ff once the remote moves, never over unpushed work", async () => {
  const cmp = "git rev-list --left-right --count origin/feat...HEAD";
  const put = "gh api -X PUT repos/{owner}/{repo}/pulls/7/update-branch";
  const t = make({ pr: OPEN_PR, remote: "feat" }, {
    [cmp]: "0\t0\n",
    [put]: "",
  });
  await t.api.set(WT, true);
  await t.api.tick();
  assertEquals(t.calls(), [put]);
  assertEquals(t.refreshed, [7]);

  t.use({
    "git rev-list --left-right --count origin/HEAD...HEAD": "0\t1\n",
    [cmp]: "1\t0\n",
    "git merge --ff-only origin/feat": "",
  });
  await t.api.tick();
  assertEquals(t.calls(), ["git merge --ff-only origin/feat"]);

  t.use({ [cmp]: "1\t1\n" });
  await t.api.tick();
  assertEquals(t.calls(), []);

  const unpushed = make({ pr: OPEN_PR, remote: null });
  await unpushed.api.set(WT, true);
  await unpushed.api.tick();
  assertEquals(unpushed.calls(), []);
});

Deno.test("set persists, prunes unknown paths and publishes; load restores", async () => {
  const t = make({});
  await t.api.set(WT, true);
  assertEquals(t.store.published, 1);
  assertEquals(JSON.parse(await Deno.readTextFile(t.deps.path)), [WT]);
  assertEquals(t.api.status(WT), { on: true, error: null });

  const again = createAutoRebase(t.deps);
  assertEquals(again.status(WT), null);
  await again.load();
  assertEquals(again.status(WT), { on: true, error: null });

  t.store.known.clear();
  await again.set("/r/other", false);
  assertEquals(JSON.parse(await Deno.readTextFile(t.deps.path)), []);
  assertEquals(again.status(WT), null);
});
