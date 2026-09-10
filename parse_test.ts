import { assertEquals, assertThrows } from "@std/assert";
import type { DiffWorktree } from "./parse.ts";
import {
  backoffOver,
  ciSummary,
  clampMenu,
  classifyPath,
  diffSnapshots,
  discardPrompt,
  hotBackoff,
  ownerWorktree,
  parseDiffHunks,
  parseLsofCommands,
  parseLsofPidPorts,
  parseStatus,
  parseUpstreamTrack,
  parseWorktreeList,
  pool,
  portsByCwd,
  procsByCwd,
  qbool,
  qnum,
  rateWindow,
  remoteWebUrl,
  removeSummary,
  selectWt,
  statusCounts,
  trimSeps,
} from "./parse.ts";

Deno.test("parseWorktreeList", () => {
  const out = parseWorktreeList(
    "worktree /r/twilight\nHEAD abc123\nbranch refs/heads/master\n\n" +
      "worktree /r/twilight/.worktrees/x\nHEAD def456\ndetached\n",
  );
  assertEquals(out, [
    { path: "/r/twilight", head: "abc123", branch: "master" },
    { path: "/r/twilight/.worktrees/x", head: "def456", branch: "(detached)" },
  ]);
});

Deno.test("parseStatus counts entries and skips rename extra field", () => {
  const z = [
    "1 .M N... 100644 100644 100644 aaa bbb src/a.py",
    "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.py",
    "src/old.py",
    "? scratch/notes.md",
  ].join("\0") + "\0";
  const { dirty, untracked, entries } = parseStatus(z);
  assertEquals(dirty, 3);
  assertEquals(untracked, ["scratch/notes.md"]);
  assertEquals(entries, [
    { xy: ".M", path: "src/a.py" },
    { xy: "R.", path: "src/new.py" },
    { xy: "??", path: "scratch/notes.md" },
  ]);
});

Deno.test("parseStatus empty", () => {
  assertEquals(parseStatus(""), { dirty: 0, untracked: [], entries: [] });
});

Deno.test("parseDiffHunks splits per hunk, keeps file header", () => {
  const diff = [
    "diff --git a/x.py b/x.py",
    "index aaa..bbb 100644",
    "--- a/x.py",
    "+++ b/x.py",
    "@@ -1,3 +1,4 @@",
    " one",
    "+added",
    " two",
    " three",
    "@@ -10,2 +11,2 @@ def f():",
    "-old",
    "+new",
    " tail",
    "",
  ].join("\n");
  const hunks = parseDiffHunks(diff);
  assertEquals(hunks.length, 2);
  assertEquals(hunks[0].startB, 1);
  assertEquals(hunks[1].startB, 11);
  assertEquals(hunks[1].header, "@@ -10,2 +11,2 @@ def f():");
  assertEquals(
    hunks[0].patch,
    "diff --git a/x.py b/x.py\nindex aaa..bbb 100644\n--- a/x.py\n+++ b/x.py\n" +
      "@@ -1,3 +1,4 @@\n one\n+added\n two\n three\n",
  );
});

Deno.test("parseDiffHunks empty diff", () => {
  assertEquals(parseDiffHunks(""), []);
});

Deno.test("lsof: pid ports, cwd join, dedupes v4+v6 and sorts", () => {
  const byPid = parseLsofPidPorts(
    "p100\nn*:7420\nn[::1]:5173\np200\nn127.0.0.1:7420\np300\nn/tmp/sock\n",
  );
  assertEquals(byPid.get("100"), [7420, 5173]);
  assertEquals(byPid.get("200"), [7420]);
  assertEquals(byPid.has("300"), false);

  const byCwd = portsByCwd(
    byPid,
    "p100\nn/Repos/forest\np200\nn/Repos/forest\np300\nn/Repos/other\n",
  );
  assertEquals(byCwd.get("/Repos/forest"), [5173, 7420]);
  assertEquals(byCwd.has("/Repos/other"), false);
});

Deno.test("ownerWorktree: deepest match wins, no partial-segment match", () => {
  const paths = ["/Repos/edward", "/Repos/edward-wt/rom-1", "/Repos/twilight"];
  assertEquals(
    ownerWorktree("/Repos/edward-wt/rom-1/src", paths),
    "/Repos/edward-wt/rom-1",
  );
  assertEquals(ownerWorktree("/Repos/edward", paths), "/Repos/edward");
  assertEquals(ownerWorktree("/Repos/edward-other", paths), undefined);
  assertEquals(ownerWorktree("/elsewhere", paths), undefined);
});

Deno.test("removeSummary: all removed, singular and plural", () => {
  assertEquals(removeSummary(1, []), "removed 1 worktree");
  assertEquals(removeSummary(3, []), "removed 3 worktrees");
});

Deno.test("removeSummary: partial failure names the leftovers", () => {
  assertEquals(
    removeSummary(3, ["jake/a"]),
    "removed 2 worktrees · couldn't remove 1 worktree: jake/a",
  );
});

Deno.test("removeSummary: total failure drops the removed clause", () => {
  assertEquals(
    removeSummary(2, ["a", "b"]),
    "couldn't remove 2 worktrees: a, b",
  );
});

Deno.test("clampMenu: leaves a menu that fits where it was opened", () => {
  assertEquals(clampMenu(100, 100, 160, 200, 1440, 900), { x: 100, y: 100 });
});

Deno.test("clampMenu: flips up and left instead of overflowing", () => {
  assertEquals(clampMenu(1400, 850, 160, 200, 1440, 900), {
    x: 1240,
    y: 650,
  });
});

Deno.test("clampMenu: clamps when it fits on neither side", () => {
  assertEquals(clampMenu(10, 10, 160, 200, 100, 150), { x: 4, y: 4 });
});

Deno.test("discardPrompt: tracked files talk about changes", () => {
  assertEquals(
    discardPrompt("src/app.ts", false),
    "discard changes to src/app.ts?",
  );
});

Deno.test("discardPrompt: untracked files warn that it is a deletion", () => {
  assertEquals(
    discardPrompt("notes.md", true),
    "delete notes.md? it is untracked, so git cannot bring it back",
  );
});

Deno.test("remoteWebUrl: scp, ssh and https remotes become web urls", () => {
  const cases: [string, string | null][] = [
    [
      "git@github.com:podium-internal/twilight.git",
      "https://github.com/podium-internal/twilight",
    ],
    [
      "ssh://git@github.com/podium-internal/twilight.git",
      "https://github.com/podium-internal/twilight",
    ],
    [
      "https://github.com/podium-internal/twilight",
      "https://github.com/podium-internal/twilight",
    ],
    ["/Users/me/Repos/origin.git", null],
  ];
  for (const [input, want] of cases) {
    assertEquals(remoteWebUrl(input), want);
  }
});

Deno.test("trimSeps drops leading, trailing and doubled separators", () => {
  assertEquals(trimSeps(["-", "a", "-", "-", "b", "-"]), ["a", "-", "b"]);
  assertEquals(trimSeps(["-", "-"]), []);
  assertEquals(trimSeps(["a", "b"]), ["a", "b"]);
});

Deno.test("pool keeps input order, bounds concurrency, runs each item once", async () => {
  let live = 0, peak = 0;
  const runs: number[] = [];
  const out = await pool(3, [10, 20, 30, 40, 50, 60, 70], async (n, i) => {
    peak = Math.max(peak, ++live);
    runs.push(i);
    await new Promise((r) => setTimeout(r, n % 30));
    live--;
    return n * 2;
  });
  assertEquals(out, [20, 40, 60, 80, 100, 120, 140]);
  assertEquals(peak, 3);
  assertEquals(runs.toSorted((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

Deno.test("pool handles empty, oversized limit, and never returns holes", async () => {
  assertEquals(await pool(4, [], (n) => Promise.resolve(n)), []);
  assertEquals(await pool(99, [1, 2], (n) => Promise.resolve(n * 3)), [3, 6]);
  // a limit of 0 must still process every item, not silently return holes
  assertEquals(await pool(0, [1, 2], (n) => Promise.resolve(n * 3)), [3, 6]);
});

// ---- fs-watch classifier ----

const ROOT = "/r";
// repo /r/twilight, one linked worktree under /r/twilight-wt, and a repo
// nested inside another repo
const OWNERS = new Map([
  ["/r/twilight", "/r/twilight"],
  ["/r/twilight-wt/feat", "/r/twilight"],
  ["/r/forest", "/r/forest"],
  ["/r/forest/vendor/inner", "/r/forest/vendor/inner"],
]);
const cls = (p: string) => classifyPath(p, ROOT, OWNERS);

Deno.test("classifyPath: ignored paths never reach a repo", () => {
  for (
    const p of [
      "/r/twilight/node_modules/x.js",
      "/r/twilight/a/b/node_modules/deep/c/node_modules/d.js",
      "/r/twilight/dist/app.js",
      "/r/twilight/target/debug/x",
      "/r/twilight/__pycache__/x.pyc",
      "/r/twilight/.git/objects/ab/cdef",
      "/r/twilight/.git/lfs/objects/aa",
      "/r/twilight/.git/index.lock",
      "/r/twilight/.git/refs/heads/main.lock",
      "/r/twilight/.DS_Store",
      "/r/twilight/src/a.py.swp",
      "/r/twilight/src/a.py~",
      "/r/twilight/src/.#a.py",
    ]
  ) {
    assertEquals(cls(p), { bucket: "ignore", repo: null, wt: null }, p);
  }
});

Deno.test("classifyPath: .git internals bucket as refs or index", () => {
  const refs = [
    "/r/twilight/.git/HEAD",
    "/r/twilight/.git/packed-refs",
    "/r/twilight/.git/MERGE_HEAD",
    "/r/twilight/.git/refs/heads/feat/x",
    // a linked worktree keeps its refs under .git/worktrees/<name>/
    "/r/twilight/.git/worktrees/feat/HEAD",
  ];
  for (const p of refs) {
    assertEquals(cls(p), { bucket: "refs", repo: "/r/twilight", wt: null }, p);
  }
  assertEquals(cls("/r/twilight/.git/index"), {
    bucket: "index",
    repo: "/r/twilight",
    wt: null,
  });
  // anything else under .git is still a change: dirty, not dropped
  assertEquals(cls("/r/twilight/.git/logs/HEAD"), {
    bucket: "refs",
    repo: "/r/twilight",
    wt: null,
  });
  assertEquals(cls("/r/twilight/.git/config"), {
    bucket: "worktree",
    repo: "/r/twilight",
    wt: null,
  });
});

Deno.test("classifyPath: worktree files map to their repo", () => {
  assertEquals(cls("/r/twilight/src/a.py"), {
    bucket: "worktree",
    repo: "/r/twilight",
    wt: "/r/twilight",
  });
  // a linked worktree lives outside the repo dir and reports the repo
  assertEquals(cls("/r/twilight-wt/feat/src/a.py"), {
    bucket: "worktree",
    repo: "/r/twilight",
    wt: "/r/twilight-wt/feat",
  });
  // nested repo wins over the repo containing it (longest prefix)
  assertEquals(cls("/r/forest/vendor/inner/src/x.ts"), {
    bucket: "worktree",
    repo: "/r/forest/vendor/inner",
    wt: "/r/forest/vendor/inner",
  });
  assertEquals(cls("/r/forest/vendor/other/x.ts"), {
    bucket: "worktree",
    repo: "/r/forest",
    wt: "/r/forest",
  });
});

Deno.test("classifyPath: directory events dirty the repo, never 'no match'", () => {
  // FSEvents coalescing reports a parent directory instead of leaf paths
  assertEquals(cls("/r/twilight/src"), {
    bucket: "worktree",
    repo: "/r/twilight",
    wt: "/r/twilight",
  });
  assertEquals(cls("/r/twilight"), {
    bucket: "worktree",
    repo: "/r/twilight",
    wt: "/r/twilight",
  });
  assertEquals(cls("/r/twilight/.git"), {
    bucket: "worktree",
    repo: "/r/twilight",
    wt: null,
  });
});

Deno.test("classifyPath: only working-tree files name a single worktree", () => {
  // the point of `wt`: a file in a linked worktree invalidates that worktree
  // alone, not the 29 others sharing the repo
  assertEquals(cls("/r/twilight-wt/feat/src/a.py").wt, "/r/twilight-wt/feat");
  assertEquals(cls("/r/twilight/src/a.py").wt, "/r/twilight");
  // but everything under .git is repo-wide and must stay that way: refs/heads
  // is shared, so one branch update moves ahead/behind for any worktree, and
  // .git/worktrees/<name>/ names a worktree without giving its path
  for (
    const p of [
      "/r/twilight/.git/HEAD",
      "/r/twilight/.git/refs/heads/feat/x",
      "/r/twilight/.git/worktrees/feat/HEAD",
      "/r/twilight/.git/index",
      "/r/twilight/.git/config",
    ]
  ) {
    assertEquals(cls(p).wt, null, p);
    assertEquals(cls(p).repo, "/r/twilight", p);
  }
});

Deno.test("classifyPath: unknown means rescan the root", () => {
  // ROOT itself: a new directory appeared directly under it
  assertEquals(cls("/r"), { bucket: "unknown", repo: null, wt: null });
  assertEquals(cls("/r/brand-new/README.md"), {
    bucket: "unknown",
    repo: null,
    wt: null,
  });
  // a bare repo is not a repo Forest tracks, so it reads as unknown
  assertEquals(cls("/r/mirror.git/refs/heads/main"), {
    bucket: "unknown",
    repo: null,
    wt: null,
  });
});

Deno.test("classifyPath: paths outside ROOT are dropped, not rescanned", () => {
  assertEquals(cls("/elsewhere/x"), { bucket: "ignore", repo: null, wt: null });
  // a sibling whose name merely starts with ROOT
  assertEquals(cls("/root-ish/x"), { bucket: "ignore", repo: null, wt: null });
  // ROOT's own path is never scanned for ignore segments
  assertEquals(
    classifyPath(
      "/build/twilight/src/a.py",
      "/build",
      new Map([[
        "/build/twilight",
        "/build/twilight",
      ]]),
    ),
    { bucket: "worktree", repo: "/build/twilight", wt: "/build/twilight" },
  );
});

Deno.test("classifyPath: sibling repo names are not confused", () => {
  const owners = new Map([["/r/book", "/r/book"], [
    "/r/bookish",
    "/r/bookish",
  ]]);
  assertEquals(classifyPath("/r/bookish/x", "/r", owners), {
    bucket: "worktree",
    repo: "/r/bookish",
    wt: "/r/bookish",
  });
  assertEquals(classifyPath("/r/book/x", "/r", owners), {
    bucket: "worktree",
    repo: "/r/book",
    wt: "/r/book",
  });
});

Deno.test("classifyPath: a trailing slash on root still matches", () => {
  assertEquals(classifyPath("/r/twilight/src/a.py", "/r/", OWNERS), {
    bucket: "worktree",
    repo: "/r/twilight",
    wt: "/r/twilight",
  });
  assertEquals(classifyPath("/r", "/r//", OWNERS), {
    bucket: "unknown",
    repo: null,
    wt: null,
  });
});

Deno.test("classifyPath: a repo named after an ignore dir is still watched", () => {
  const owners = new Map([["/r/build", "/r/build"], [
    "/r/target",
    "/r/target",
  ]]);
  assertEquals(classifyPath("/r/build/src/a.ts", "/r", owners), {
    bucket: "worktree",
    repo: "/r/build",
    wt: "/r/build",
  });
  assertEquals(classifyPath("/r/target/.git/HEAD", "/r", owners), {
    bucket: "refs",
    repo: "/r/target",
    wt: null,
  });
  // its own build output is still ignored
  assertEquals(classifyPath("/r/build/dist/a.js", "/r", owners), {
    bucket: "ignore",
    repo: null,
    wt: null,
  });
});

Deno.test("classifyPath: no owners yet means rescan, never silence", () => {
  // startup: the first publish() has not run, so nothing is known. Every
  // interesting path must fail safe to a root rescan.
  const none = new Map<string, string>();
  assertEquals(classifyPath("/r/twilight/src/a.py", "/r", none), {
    bucket: "unknown",
    repo: null,
    wt: null,
  });
  assertEquals(classifyPath("/r/twilight/.git/HEAD", "/r", none), {
    bucket: "unknown",
    repo: null,
    wt: null,
  });
});

// ---- diffSnapshots ----

const wt = (path: string, over: Partial<DiffWorktree> = {}): DiffWorktree => ({
  path,
  branch: "main",
  head: "abc",
  ahead: 0,
  behind: 0,
  dirty: 0,
  lastActivity: 100,
  remote: null,
  ...over,
});
const snap = (...repos: [string, DiffWorktree[]][]) =>
  new Map(repos.map(([path, worktrees]) => [path, { path, worktrees }]));

Deno.test("diffSnapshots: identical snapshots diverge nowhere", () => {
  const a = snap(["/r/one", [wt("/r/one"), wt("/r/one-wt")]], ["/r/two", [
    wt("/r/two"),
  ]]);
  const b = snap(["/r/one", [wt("/r/one"), wt("/r/one-wt")]], ["/r/two", [
    wt("/r/two"),
  ]]);
  assertEquals(diffSnapshots(a, b), []);
});

Deno.test("diffSnapshots: names the repo, the worktree and the field", () => {
  const live = snap(["/r/one", [wt("/r/one", { dirty: 0 })]]);
  const truth = snap(["/r/one", [wt("/r/one", { dirty: 3 })]]);
  assertEquals(diffSnapshots(live, truth), [{
    repo: "/r/one",
    worktree: "/r/one",
    field: "dirty",
    watch: 0,
    sweep: 3,
  }]);
});

Deno.test("diffSnapshots: every watched field is compared", () => {
  const live = snap(["/r/one", [wt("/r/one")]]);
  const truth = snap(["/r/one", [
    wt("/r/one", {
      branch: "feat",
      head: "def",
      ahead: 1,
      behind: 2,
      dirty: 3,
      lastActivity: 200,
      remote: "feat",
    }),
  ]]);
  assertEquals(diffSnapshots(live, truth).map((d) => d.field), [
    "branch",
    "head",
    "ahead",
    "behind",
    "dirty",
    "lastActivity",
    "remote",
  ]);
});

Deno.test("diffSnapshots: ports and pr never count as divergence", () => {
  // they come from the lsof and gh timers, not from fs events
  const live = snap(["/r/one", [
    { ...wt("/r/one"), ports: [3000], pr: { number: 7 } } as DiffWorktree,
  ]]);
  const truth = snap(["/r/one", [
    { ...wt("/r/one"), ports: [], pr: null } as DiffWorktree,
  ]]);
  assertEquals(diffSnapshots(live, truth), []);
});

Deno.test("diffSnapshots: worktree added and removed", () => {
  const one = snap(["/r/one", [wt("/r/one")]]);
  const two = snap(["/r/one", [wt("/r/one"), wt("/r/one-feat")]]);
  assertEquals(diffSnapshots(one, two), [{
    repo: "/r/one",
    worktree: "/r/one-feat",
    field: "worktreeAdded",
    watch: null,
    sweep: "/r/one-feat",
  }]);
  assertEquals(diffSnapshots(two, one), [{
    repo: "/r/one",
    worktree: "/r/one-feat",
    field: "worktreeRemoved",
    watch: "/r/one-feat",
    sweep: null,
  }]);
});

Deno.test("diffSnapshots: repo added and removed", () => {
  const one = snap(["/r/one", [wt("/r/one")]]);
  const two = snap(["/r/one", [wt("/r/one")]], ["/r/two", [wt("/r/two")]]);
  assertEquals(diffSnapshots(one, two), [{
    repo: "/r/two",
    worktree: null,
    field: "repoAdded",
    watch: null,
    sweep: "/r/two",
  }]);
  assertEquals(diffSnapshots(two, one), [{
    repo: "/r/two",
    worktree: null,
    field: "repoRemoved",
    watch: "/r/two",
    sweep: null,
  }]);
});

Deno.test("diffSnapshots: excluded repos are not judged", () => {
  // a repo touched during the sweep window disagrees for timing reasons; the
  // other repos in the same snapshot must still be checked
  const live = snap(["/r/hot", [wt("/r/hot", { lastActivity: 200 })]], [
    "/r/cold",
    [wt("/r/cold", { dirty: 0 })],
  ]);
  const truth = snap(["/r/hot", [wt("/r/hot", { lastActivity: 100 })]], [
    "/r/cold",
    [wt("/r/cold", { dirty: 3 })],
  ]);
  assertEquals(
    diffSnapshots(live, truth, new Set(["/r/hot"])).map((d) => [
      d.repo,
      d.field,
    ]),
    [["/r/cold", "dirty"]],
  );
  assertEquals(diffSnapshots(live, truth, new Set(["/r/hot", "/r/cold"])), []);
});

Deno.test("diffSnapshots: NaN does not diverge against itself", () => {
  // ahead/behind are .map(Number), lastActivity is Number(...): both can be
  // NaN, and `!==` would re-fire every sweep and never heal
  const live = snap(["/r/one", [wt("/r/one", { ahead: NaN, behind: 1 })]]);
  const truth = snap(["/r/one", [wt("/r/one", { ahead: NaN, behind: NaN })]]);
  assertEquals(diffSnapshots(live, truth).map((d) => d.field), ["behind"]);
});

// ---- rateWindow ----

Deno.test("rateWindow: counts the window and forgets what falls out", () => {
  const w = rateWindow(1000, 10); // 100 ms slots
  for (let t = 0; t < 500; t += 100) w.add(10_000 + t);
  assertEquals(w.count(10_400), 5);
  // a second past the first add, only the later four slots are still inside
  assertEquals(w.count(11_000), 4);
  // and with no further adds it decays to zero on time alone
  assertEquals(w.count(11_500), 0);
});

Deno.test("rateWindow: add returns the live count, slots are reused", () => {
  const w = rateWindow(1000, 10);
  assertEquals(w.add(0), 1);
  assertEquals(w.add(0), 2);
  // same ring slot one full window later: the stale count must not be added to
  assertEquals(w.add(1000), 1);
  assertEquals(w.add(1900), 2);
});

// ---- hotBackoff ----

const HOT = (st: Parameters<typeof hotBackoff>[0], hits: number, now: number) =>
  hotBackoff(st, hits, now, 10, 30_000);

Deno.test("hotBackoff: a quiet repo runs immediately and stays stateless", () => {
  assertEquals(HOT(undefined, 0, 0), { run: true, state: undefined });
  assertEquals(HOT(undefined, 9, 0), { run: true, state: undefined });
});

Deno.test("hotBackoff: past the threshold the interval doubles to the cap", () => {
  let now = 0;
  let st = HOT(undefined, 10, now).state;
  assertEquals(st, { intervalMs: 1000, nextAt: 1000 });
  for (const want of [2000, 4000, 8000, 16_000, 30_000, 30_000]) {
    now = st!.nextAt;
    const d = HOT(st, 20, now);
    assertEquals(d.run, true); // delayed, never dropped
    st = d.state;
    assertEquals(st!.intervalMs, want);
  }
});

Deno.test("hotBackoff: before its slot a hot repo is deferred, not dropped", () => {
  const st = { intervalMs: 4000, nextAt: 5000 };
  assertEquals(HOT(st, 20, 4999), { run: false, state: st });
  assertEquals(HOT(st, 20, 5000).run, true);
});

Deno.test("hotBackoff: a late look is not a quiet one", () => {
  // owed at 5000, asked at 9000: the repo was still dirty the whole time, so
  // this is deferral catching up, not calm. It must keep doubling.
  const st = { intervalMs: 4000, nextAt: 5000 };
  assertEquals(HOT(st, 20, 9000).state, { intervalMs: 8000, nextAt: 17_000 });
});

Deno.test("backoffOver: one quiet interval past the owed slot", () => {
  const st = { intervalMs: 4000, nextAt: 5000 };
  assertEquals(backoffOver(st, 8999), false);
  assertEquals(backoffOver(st, 9000), true);
});

Deno.test("rateWindow: a clock jump forward empties the window, backward is not in it", () => {
  const w = rateWindow(1000, 10);
  for (let t = 0; t < 500; t += 100) w.add(10_000 + t);
  // laptop sleep: hours later nothing is in the trailing second
  assertEquals(w.count(10_000 + 8 * 3600_000), 0);
  // and a clock stepped backwards must not count those slots as "in window"
  assertEquals(w.count(10_000 - 8 * 3600_000), 0);
  // an add after the backward step starts a fresh count
  assertEquals(w.add(1000), 1);
});

// ---- agent interface ----

Deno.test("statusCounts: staged/modified from xy, untracked separate", () => {
  const entries = [
    { xy: ".M" },
    { xy: "R." },
    { xy: "??" },
  ];
  assertEquals(statusCounts(entries), { staged: 1, modified: 1, untracked: 1 });
});

Deno.test("statusCounts: untracked only", () => {
  assertEquals(statusCounts([{ xy: "??" }, { xy: "??" }]), {
    staged: 0,
    modified: 0,
    untracked: 2,
  });
});

Deno.test("parseUpstreamTrack: gone branches, ahead and bare lines ignored", () => {
  const out = "feat/x [gone]\nmain\nfeat/y [ahead 2]\n";
  assertEquals(parseUpstreamTrack(out), new Set(["feat/x"]));
});

Deno.test("ciSummary: empty input", () => {
  assertEquals(ciSummary([]), { state: null, failing: [] });
});

Deno.test("ciSummary: all success is pass", () => {
  assertEquals(
    ciSummary([
      { name: "build", conclusion: "SUCCESS" },
      { context: "ci/test", state: "SUCCESS" },
    ]),
    { state: "pass", failing: [] },
  );
});

Deno.test("ciSummary: one failure fails and names it", () => {
  assertEquals(
    ciSummary([
      { name: "build", conclusion: "SUCCESS" },
      { name: "lint", conclusion: "FAILURE" },
    ]),
    { state: "fail", failing: ["lint"] },
  );
});

Deno.test("ciSummary: one queued is pending", () => {
  assertEquals(
    ciSummary([
      { name: "build", conclusion: "SUCCESS" },
      { name: "deploy", status: "QUEUED" },
    ]),
    { state: "pending", failing: [] },
  );
});

Deno.test("parseLsofCommands and procsByCwd: c lines join to pid->command", () => {
  const net = [
    "p1175",
    "cnode",
    "f23",
    "n*:5173",
    "p1200",
    "cvite",
    "n127.0.0.1:5173",
    "p1300",
    "n/tmp/sock",
    "p1500",
    "n*:4000",
    "",
  ].join("\n");
  const cmds = parseLsofCommands(net);
  assertEquals(cmds.get("1175"), "node");
  assertEquals(cmds.get("1200"), "vite");
  assertEquals(cmds.has("1500"), false);

  const byPid = parseLsofPidPorts(net);
  const cwds = [
    "p1175",
    "n/Repos/forest",
    "p1200",
    "n/Repos/forest",
    "p1500",
    "n/Repos/other",
    "",
  ].join("\n");
  const byCwd = procsByCwd(byPid, cmds, cwds);
  assertEquals(byCwd.get("/Repos/forest"), [
    { port: 5173, pid: 1175, command: "node" },
    { port: 5173, pid: 1200, command: "vite" },
  ]);
  assertEquals(byCwd.get("/Repos/other"), [
    { port: 4000, pid: 1500, command: "" },
  ]);
});

const WT_ROWS = [
  { path: "/r/a", branch: "feat/x", repo: "appA" },
  { path: "/r/b", branch: "feat/xy", repo: "appB" },
  { path: "/r/c", branch: "main", repo: "appC" },
];

Deno.test("selectWt: exact path wins over any text match", () => {
  assertEquals(selectWt("/r/c", WT_ROWS), { wt: WT_ROWS[2] });
});

Deno.test("selectWt: zero matches", () => {
  assertEquals(selectWt("nomatch", WT_ROWS), { candidates: [] });
});

Deno.test("selectWt: two matches", () => {
  assertEquals(selectWt("feat", WT_ROWS), {
    candidates: [WT_ROWS[0], WT_ROWS[1]],
  });
});

Deno.test("selectWt: one match", () => {
  assertEquals(selectWt("main", WT_ROWS), { wt: WT_ROWS[2] });
});

Deno.test("qbool: parses string and boolean forms, rejects garbage", () => {
  assertEquals(qbool.parse("false"), false);
  assertEquals(qbool.parse("true"), true);
  assertEquals(qbool.parse(true), true);
  assertThrows(() => qbool.parse("x"));
});

Deno.test("qnum: coerces to a non-negative int", () => {
  assertEquals(qnum.parse("3"), 3);
});
