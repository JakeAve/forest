import { assertEquals } from "@std/assert";
import {
  clampMenu,
  classifyPath,
  discardPrompt,
  ownerWorktree,
  parseDiffHunks,
  parseLsofPidPorts,
  parseStatus,
  parseWorktreeList,
  pool,
  portsByCwd,
  remoteWebUrl,
  removeSummary,
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
    assertEquals(cls(p), { bucket: "ignore", repo: null }, p);
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
    assertEquals(cls(p), { bucket: "refs", repo: "/r/twilight" }, p);
  }
  assertEquals(cls("/r/twilight/.git/index"), {
    bucket: "index",
    repo: "/r/twilight",
  });
  // anything else under .git is still a change: dirty, not dropped
  assertEquals(cls("/r/twilight/.git/logs/HEAD"), {
    bucket: "refs",
    repo: "/r/twilight",
  });
  assertEquals(cls("/r/twilight/.git/config"), {
    bucket: "worktree",
    repo: "/r/twilight",
  });
});

Deno.test("classifyPath: worktree files map to their repo", () => {
  assertEquals(cls("/r/twilight/src/a.py"), {
    bucket: "worktree",
    repo: "/r/twilight",
  });
  // a linked worktree lives outside the repo dir and reports the repo
  assertEquals(cls("/r/twilight-wt/feat/src/a.py"), {
    bucket: "worktree",
    repo: "/r/twilight",
  });
  // nested repo wins over the repo containing it (longest prefix)
  assertEquals(cls("/r/forest/vendor/inner/src/x.ts"), {
    bucket: "worktree",
    repo: "/r/forest/vendor/inner",
  });
  assertEquals(cls("/r/forest/vendor/other/x.ts"), {
    bucket: "worktree",
    repo: "/r/forest",
  });
});

Deno.test("classifyPath: directory events dirty the repo, never 'no match'", () => {
  // FSEvents coalescing reports a parent directory instead of leaf paths
  assertEquals(cls("/r/twilight/src"), {
    bucket: "worktree",
    repo: "/r/twilight",
  });
  assertEquals(cls("/r/twilight"), {
    bucket: "worktree",
    repo: "/r/twilight",
  });
  assertEquals(cls("/r/twilight/.git"), {
    bucket: "worktree",
    repo: "/r/twilight",
  });
});

Deno.test("classifyPath: unknown means rescan the root", () => {
  // ROOT itself: a new directory appeared directly under it
  assertEquals(cls("/r"), { bucket: "unknown", repo: null });
  assertEquals(cls("/r/brand-new/README.md"), {
    bucket: "unknown",
    repo: null,
  });
  // a bare repo is not a repo Forest tracks, so it reads as unknown
  assertEquals(cls("/r/mirror.git/refs/heads/main"), {
    bucket: "unknown",
    repo: null,
  });
});

Deno.test("classifyPath: paths outside ROOT are dropped, not rescanned", () => {
  assertEquals(cls("/elsewhere/x"), { bucket: "ignore", repo: null });
  // a sibling whose name merely starts with ROOT
  assertEquals(cls("/root-ish/x"), { bucket: "ignore", repo: null });
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
    { bucket: "worktree", repo: "/build/twilight" },
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
  });
  assertEquals(classifyPath("/r/book/x", "/r", owners), {
    bucket: "worktree",
    repo: "/r/book",
  });
});

Deno.test("classifyPath: a trailing slash on root still matches", () => {
  assertEquals(classifyPath("/r/twilight/src/a.py", "/r/", OWNERS), {
    bucket: "worktree",
    repo: "/r/twilight",
  });
  assertEquals(classifyPath("/r", "/r//", OWNERS), {
    bucket: "unknown",
    repo: null,
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
  });
  assertEquals(classifyPath("/r/target/.git/HEAD", "/r", owners), {
    bucket: "refs",
    repo: "/r/target",
  });
  // its own build output is still ignored
  assertEquals(classifyPath("/r/build/dist/a.js", "/r", owners), {
    bucket: "ignore",
    repo: null,
  });
});

Deno.test("classifyPath: no owners yet means rescan, never silence", () => {
  // startup: the first publish() has not run, so nothing is known. Every
  // interesting path must fail safe to a root rescan.
  const none = new Map<string, string>();
  assertEquals(classifyPath("/r/twilight/src/a.py", "/r", none), {
    bucket: "unknown",
    repo: null,
  });
  assertEquals(classifyPath("/r/twilight/.git/HEAD", "/r", none), {
    bucket: "unknown",
    repo: null,
  });
});
