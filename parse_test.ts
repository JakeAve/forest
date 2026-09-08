import { assertEquals } from "@std/assert";
import {
  clampMenu,
  discardPrompt,
  ownerWorktree,
  parseDiffHunks,
  parseLsofPidPorts,
  parseStatus,
  parseWorktreeList,
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
