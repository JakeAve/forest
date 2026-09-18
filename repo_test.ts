import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  fakeExec,
  FOR_EACH_REF_TRACK,
  HEAD_LOG,
  PORCELAIN_2WT,
  STATUS_V2,
} from "./fixtures.ts";
import { createRepo } from "./repo.ts";

const REPO = "/r/forest";
const FEAT = "/r/forest-feat";
const G = "git --no-optional-locks";
const GIT_PATHS =
  `${G} rev-parse --git-path rebase-merge --git-path rebase-apply --git-path MERGE_HEAD --git-path CHERRY_PICK_HEAD`;

type Entry = string | ((cwd: string) => string);

const table = (over: Record<string, Entry> = {}): Record<string, Entry> => ({
  [`${G} worktree list --porcelain`]: PORCELAIN_2WT,
  [`${G} for-each-ref --format=%(refname:short) refs/remotes`]:
    "origin/HEAD\norigin/main\n",
  [`${G} for-each-ref --format=%(refname:short) %(upstream:track) refs/heads`]:
    FOR_EACH_REF_TRACK,
  [`${G} symbolic-ref refs/remotes/origin/HEAD`]: "refs/remotes/origin/main\n",
  [`${G} remote get-url origin`]: "git@github.com:JakeAve/forest.git\n",
  [`${G} status --porcelain=v2 -z --untracked-files=all`]: (cwd) =>
    cwd === REPO ? "" : STATUS_V2,
  [`${G} rev-list --left-right --count @{upstream}...HEAD`]: (cwd) =>
    cwd === REPO ? "0\t0\n" : "2\t3\n",
  [`${G} rev-list --left-right --count refs/remotes/origin/main...HEAD`]: (
    cwd,
  ) => cwd === REPO ? "0\t0\n" : "1\t4\n",
  [`${G} log -1 --format=%ct%n%s%n%an`]: HEAD_LOG,
  [`${G} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]:
    "origin/main\n",
  [GIT_PATHS]:
    ".git/rebase-merge\n.git/rebase-apply\n.git/MERGE_HEAD\n.git/CHERRY_PICK_HEAD\n",
  [`${G} diff --name-only -z HEAD`]: "",
  ...over,
});

const make = (over?: Record<string, Entry>) => {
  const sh = fakeExec(table(over));
  return { sh, repo: createRepo({ sh, root: "/r" }) };
};

Deno.test("computeRepo returns null when the first listed worktree is not the repo path", async () => {
  const { sh, repo } = make();
  assertEquals(await repo.computeRepo("other", "/r/other"), null);
  assertEquals(sh.missing, []);
});

Deno.test("computeRepo builds one Worktree per porcelain entry with ahead/behind and counts", async () => {
  const { sh, repo } = make();
  const r = await repo.computeRepo("forest", REPO);
  assertEquals(r?.webUrl, "https://github.com/JakeAve/forest");
  assertEquals(r?.defaultBranch, "main");
  assertEquals(r?.worktrees.length, 2);
  assertEquals(r?.worktrees[0], {
    repo: "forest",
    path: REPO,
    branch: "main",
    head: "aaaaaaa1",
    ahead: 0,
    behind: 0,
    aheadMain: 0,
    behindMain: 0,
    gone: false,
    state: null,
    dirty: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    subject: "Add the thing",
    author: "Jake",
    lastActivity: 1700000000000,
    isPrimary: true,
    remote: "main",
    ports: [],
    procs: [],
    pr: null,
  });
  const w = r!.worktrees[1];
  assertEquals(
    [w.path, w.branch, w.isPrimary],
    [FEAT, "feat", false],
  );
  assertEquals([w.ahead, w.behind, w.aheadMain, w.behindMain], [3, 2, 4, 1]);
  assertEquals([w.dirty, w.staged, w.modified, w.untracked], [3, 1, 1, 1]);
  assertEquals(sh.missing, []);
});

Deno.test("recomputeWorktrees returns null when the worktree list changed", async () => {
  const { sh, repo } = make();
  const r = await repo.computeRepo("forest", REPO);
  const shrunk = fakeExec(table({
    [`${G} worktree list --porcelain`]: PORCELAIN_2WT.split("\n\n")[0],
  }));
  const after = createRepo({ sh: shrunk, root: "/r" });
  assertEquals(await after.recomputeWorktrees(r!, new Set([FEAT])), null);
  assertEquals(shrunk.missing, []);
  assertEquals(sh.missing, []);
});

Deno.test("recomputeWorktrees replaces only wanted worktrees", async () => {
  let subject = "Add the thing";
  const { sh, repo } = make({
    [`${G} log -1 --format=%ct%n%s%n%an`]: () =>
      `1700000000\n${subject}\nJake\n`,
  });
  const r = await repo.computeRepo("forest", REPO);
  subject = "Fix the thing";
  const next = await repo.recomputeWorktrees(r!, new Set([FEAT]));
  assertEquals(next!.worktrees[0], r!.worktrees[0]);
  assertEquals(next!.worktrees[1].subject, "Fix the thing");
  assertEquals(sh.missing, []);
});

Deno.test("remote is null when upstream is the primary branch and the branch is not pushed", async () => {
  const { sh, repo } = make();
  const r = await repo.computeRepo("forest", REPO);
  assertEquals(r?.worktrees[1].remote, null);
  assertEquals(sh.missing, []);
});

Deno.test("remote is the branch when it is in origin refs", async () => {
  const { sh, repo } = make({
    [`${G} for-each-ref --format=%(refname:short) refs/remotes`]:
      "origin/HEAD\norigin/main\norigin/feat\n",
  });
  const r = await repo.computeRepo("forest", REPO);
  assertEquals(r?.worktrees[1].remote, "feat");
  assertEquals(sh.missing, []);
});

Deno.test("state is merge when MERGE_HEAD exists", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, ".git"));
    await Deno.writeTextFile(join(dir, ".git", "MERGE_HEAD"), "abc\n");
    const { sh, repo } = make({
      [`${G} worktree list --porcelain`]: PORCELAIN_2WT.replace(FEAT, dir),
    });
    const r = await repo.computeRepo("forest", REPO);
    assertEquals(r?.worktrees[0].state, null);
    assertEquals(r?.worktrees[1].state, "merge");
    assertEquals(sh.missing, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gone upstream sets gone", async () => {
  const { sh, repo } = make();
  const r = await repo.computeRepo("forest", REPO);
  assertEquals(r?.worktrees.map((w) => w.gone), [false, true]);
  assertEquals(sh.missing, []);
});

Deno.test("lastActivity is the newest mtime among changed and untracked files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "changed.txt"), "x");
    await Deno.writeTextFile(join(dir, "notes.md"), "y");
    await Deno.utime(join(dir, "changed.txt"), 1800000000, 1800000000);
    await Deno.utime(join(dir, "notes.md"), 1800000060, 1800000060);
    const { sh, repo } = make({
      [`${G} worktree list --porcelain`]: PORCELAIN_2WT.replace(FEAT, dir),
      [`${G} diff --name-only -z HEAD`]: (cwd) =>
        cwd === REPO ? "" : "changed.txt\0",
    });
    const r = await repo.computeRepo("forest", REPO);
    assertEquals(r?.worktrees[0].lastActivity, 1700000000000);
    assertEquals(r?.worktrees[1].lastActivity, 1800000060000);
    assertEquals(sh.missing, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mergeBase falls back to HEAD when merge-base fails", async () => {
  const { sh, repo } = make({
    [`${G} merge-base refs/remotes/origin/main HEAD`]: () => {
      throw new Error("no merge base");
    },
    [`${G} merge-base origin/HEAD HEAD`]: "cafe123\n",
  });
  await repo.computeRepo("forest", REPO);
  assertEquals(await repo.mergeBase(FEAT, REPO), "HEAD");
  assertEquals(await repo.mergeBase(FEAT, undefined), "cafe123");
  assertEquals(sh.missing, []);
});
