import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  fakeExec,
  GH_CARD,
  GH_PR_LIST,
  GH_PR_VIEW,
  repo,
  worktree,
} from "./fixtures.ts";
import { createPrs } from "./prs.ts";
import { DEFAULTS } from "./settings.ts";
import { newStats } from "./stats.ts";
import type { Repo, Worktree } from "./types.ts";

const REPO = "/r/forest";
const LIST =
  "gh pr list --state all --limit 200 --json number,url,headRefName,state,createdAt,closedAt,mergedAt";
const FIELDS =
  "title,isDraft,baseRefName,reviewDecision,mergeable,mergeStateStatus,autoMergeRequest,statusCheckRollup,reviews";
const VIEW = (n: number) => `gh pr view ${n} --json ${FIELDS}`;
const VIEW_ONE = (n: number) =>
  `gh pr view ${n} --json state,createdAt,closedAt,mergedAt,${FIELDS}`;

type Entry = string | ((cwd: string) => string);

const make = (table: Record<string, Entry>) => {
  // the card query is one huge multi-line key; match it by prefix instead
  const proxied = new Proxy(table, {
    get: (t, k) =>
      typeof k === "string" && k.startsWith("gh api graphql")
        ? GH_CARD
        : t[k as string],
  });
  const sh = fakeExec(proxied);
  const stats = newStats();
  let changes = 0;
  const prs = createPrs({
    sh,
    settings: { ...DEFAULTS },
    stats,
    onChange: () => changes++,
  });
  return {
    prs,
    stats,
    calls: sh.calls,
    lists: () => sh.calls.filter((c) => c.includes("gh pr list")).length,
    changed: () => changes,
  };
};

const wt = (branch: string, remote: string | null = null): Worktree =>
  worktree({ path: `/r/forest-${branch}`, branch, remote });

const mkRepo = (over: Partial<Repo> = {}): Repo =>
  repo({ path: REPO, worktrees: [wt("feat")], ...over });

const boom = () => {
  throw new Error("gh: no auth");
};

Deno.test("a repo GitHub can't find backs off but reports no error", async () => {
  using _time = new FakeTime();
  const orig = console.error;
  console.error = () => {};
  try {
    const { prs, stats } = make({
      [LIST]: () => {
        throw new Error(
          "GraphQL: Could not resolve to a Repository with the name 'a/b'. (repository)",
        );
      },
    });
    const r = mkRepo();
    await prs.refreshPrs([r]);
    await prs.refreshPrs([r]);
    assertEquals([stats.ghFailTotal, prs.prError(REPO)], [1, null]);
  } finally {
    console.error = orig;
  }
});

Deno.test("a repo without webUrl is never queried", async () => {
  const { prs, calls } = make({});
  await prs.refreshPrs([mkRepo({ webUrl: null })]);
  assertEquals(calls, []);
});

Deno.test("gh failure schedules retry at 10 min, then 1 h, and logs once", async () => {
  using time = new FakeTime();
  const errs: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a[0]);
  try {
    const { prs, stats } = make({ [LIST]: boom });
    const r = mkRepo();
    await prs.refreshPrs([r]);
    assertEquals([stats.ghFailTotal, errs.length, prs.prError(REPO)], [
      1,
      1,
      "gh: no auth",
    ]);

    await time.tickAsync(599_000);
    await prs.refreshPrs([r]);
    assertEquals(stats.ghFailTotal, 1);
    await time.tickAsync(2_000);
    await prs.refreshPrs([r]);
    assertEquals([stats.ghFailTotal, errs.length], [2, 1]);

    await time.tickAsync(3_599_000);
    await prs.refreshPrs([r]);
    assertEquals(stats.ghFailTotal, 2);
    await time.tickAsync(2_000);
    await prs.refreshPrs([r]);
    assertEquals([stats.ghFailTotal, errs.length], [3, 1]);
  } finally {
    console.error = orig;
  }
});

Deno.test("a later success clears the failed flag and returns to prPollMs", async () => {
  using time = new FakeTime();
  const orig = console.error;
  console.error = () => {};
  try {
    let fail = true;
    const { prs, lists } = make({
      [LIST]: () => fail ? boom() : GH_PR_LIST,
      [VIEW(7)]: GH_PR_VIEW,
    });
    const r = mkRepo();
    await prs.refreshPrs([r]);
    assertEquals(prs.prError(REPO), "gh: no auth");

    await time.tickAsync(600_001);
    fail = false;
    await prs.refreshPrs([r]);
    assertEquals(prs.prError(REPO), null);

    const n = lists();
    await time.tickAsync(DEFAULTS.prPollMs - 1_000);
    await prs.refreshPrs([r]);
    assertEquals(lists(), n);
    await time.tickAsync(2_000);
    await prs.refreshPrs([r]);
    assertEquals(lists(), n + 1);
  } finally {
    console.error = orig;
  }
});

Deno.test("an open PR on a worktree branch gets detail; a closed one's detail is evicted", async () => {
  using time = new FakeTime();
  let list = GH_PR_LIST;
  const { prs } = make({ [LIST]: () => list, [VIEW(7)]: GH_PR_VIEW });
  const r = mkRepo();
  await prs.refreshPrs([r]);
  const pr = prs.prFor(REPO, r.worktrees[0])!;
  assertEquals([pr.number, pr.state, pr.title], [7, "OPEN", "Add the thing"]);
  assertEquals([pr.approvals, pr.ci.state, pr.mergeState], [
    1,
    "pass",
    "CLEAN",
  ]);
  assertEquals(pr.card?.additions, 10);
  assert(pr.detailAt !== null);

  list = JSON.stringify([{
    ...JSON.parse(GH_PR_LIST)[0],
    state: "CLOSED",
    closedAt: "2026-09-05T00:00:00Z",
  }]);
  await time.tickAsync(DEFAULTS.prPollMs + 1);
  await prs.refreshPrs([r]);
  const after = prs.prFor(REPO, r.worktrees[0])!;
  assertEquals(after.state, "CLOSED");
  assertEquals(after.stateSince, Date.parse("2026-09-05T00:00:00Z"));
  assertEquals([after.title, after.card, after.detailAt], ["", null, null]);
});

Deno.test("unchanged detail keeps prev ciSince and reviewSince and does not touch detailAt", async () => {
  using time = new FakeTime();
  const view = JSON.stringify({
    ...JSON.parse(GH_PR_VIEW),
    statusCheckRollup: [{
      name: "test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    }],
    reviews: [{ author: { login: "octo" }, state: "APPROVED" }],
  });
  const { prs } = make({ [LIST]: GH_PR_LIST, [VIEW(7)]: view });
  const r = mkRepo();
  await prs.refreshPrs([r]);
  const first = prs.prFor(REPO, r.worktrees[0])!;
  assertEquals([first.ciSince, first.reviewSince], [Date.now(), Date.now()]);

  await time.tickAsync(DEFAULTS.prPollMs + 1);
  await prs.refreshPrs([r]);
  const second = prs.prFor(REPO, r.worktrees[0])!;
  assertEquals(second.ciSince, first.ciSince);
  assertEquals(second.reviewSince, first.reviewSince);
  assertEquals(second.detailAt, first.detailAt);
});

Deno.test("prFor matches the branch first and the remote second", async () => {
  const list = JSON.stringify([...JSON.parse(GH_PR_LIST), {
    number: 9,
    url: "https://github.com/JakeAve/forest/pull/9",
    headRefName: "jake/feat",
    state: "OPEN",
    createdAt: "2026-09-04T00:00:00Z",
    closedAt: null,
    mergedAt: null,
  }]);
  const { prs } = make({
    [LIST]: list,
    [VIEW(7)]: GH_PR_VIEW,
    [VIEW(9)]: GH_PR_VIEW,
  });
  const r = mkRepo({
    worktrees: [wt("feat", "jake/feat"), wt("wip", "jake/feat")],
  });
  await prs.refreshPrs([r]);
  assertEquals(prs.prFor(REPO, r.worktrees[0])?.number, 7);
  assertEquals(prs.prFor(REPO, r.worktrees[1])?.number, 9);
  assertEquals(prs.prFor(REPO, wt("nope")), null);
});

Deno.test("refreshOnePr rewrites slim state and calls onChange", async () => {
  const merged = JSON.stringify({
    state: "MERGED",
    createdAt: "2026-09-01T00:00:00Z",
    closedAt: "2026-09-06T00:00:00Z",
    mergedAt: "2026-09-06T00:00:00Z",
    ...JSON.parse(GH_PR_VIEW),
  });
  const { prs, changed } = make({
    [LIST]: GH_PR_LIST,
    [VIEW(7)]: GH_PR_VIEW,
    [VIEW_ONE(7)]: merged,
  });
  const r = mkRepo();
  await prs.refreshPrs([r]);
  assertEquals(changed(), 0);

  await prs.refreshOnePr(REPO, 7);
  assertEquals(changed(), 1);
  const pr = prs.prFor(REPO, r.worktrees[0])!;
  assertEquals([pr.number, pr.state, pr.title], [7, "MERGED", "Add the thing"]);
  assertEquals(pr.stateSince, Date.parse("2026-09-06T00:00:00Z"));
});

Deno.test("refreshPrSoon fires after PR_PUSH_MS under FakeTime", async () => {
  using time = new FakeTime();
  const { prs, changed } = make({ [VIEW_ONE(7)]: GH_PR_VIEW });
  prs.refreshPrSoon(REPO, 7);
  await time.tickAsync(9_999);
  assertEquals(changed(), 0);
  await time.tickAsync(2);
  await time.runMicrotasks();
  assertEquals(changed(), 1);
});

Deno.test("pushSoon is ignored for a failed repo", async () => {
  using time = new FakeTime();
  const orig = console.error;
  console.error = () => {};
  try {
    let fail = true;
    const { prs, lists } = make({
      [LIST]: () => fail ? boom() : GH_PR_LIST,
      [VIEW(7)]: GH_PR_VIEW,
    });
    const r = mkRepo();
    await prs.refreshPrs([r]);
    fail = false;
    prs.pushSoon(REPO, Date.now());
    await time.tickAsync(10_001);
    const n = lists();
    await prs.refreshPrs([r]);
    assertEquals(lists(), n); // still in the 10-minute backoff

    await time.tickAsync(600_001);
    await prs.refreshPrs([r]);
    assertEquals(prs.prError(REPO), null);
    const m = lists();
    prs.pushSoon(REPO, Date.now());
    await time.tickAsync(10_001);
    await prs.refreshPrs([r]);
    assertEquals(lists(), m + 1);
  } finally {
    console.error = orig;
  }
});
