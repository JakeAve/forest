import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { fakeExec, repo as mkRepo, worktree } from "./fixtures.ts";
import { newStats } from "./stats.ts";
import { createFiles } from "./files.ts";
import { createStore } from "./store.ts";
import { createTools } from "./tools.ts";
import { DEFAULTS } from "./settings.ts";
import type {
  AgentSession,
  Pr,
  Procs,
  Repo,
  SessionInfo,
  Worktree,
} from "./types.ts";

const HOME = "/home/jake";

const pr = (state: Pr["state"]) => ({ number: 1, url: "u", state } as Pr);

const make = (
  repos: Repo[],
  settings = { ...DEFAULTS },
  table: Record<string, string> = {},
  agents = new Map<string, AgentSession[]>(),
  info = new Map<string, SessionInfo>(),
  procs = new Map<string, Procs>(),
) => {
  const store = createStore({
    prFor: (_r, w) => w.pr,
    ticket: (_r, w) => w.ticket,
    procs: () => procs,
    prListed: () => true,
    agents: () => agents,
    onSnapshot: () => {},
    stats: newStats(),
  });
  for (const r of repos) store.byPath.set(r.path, r);
  store.publish();
  const files = createFiles({
    sh: fakeExec(table),
    known: store.known,
    // deno-lint-ignore require-await
    mergeBase: async () => "HEAD",
  });
  const removed: string[][] = [];
  const closes: [string, boolean][] = [];
  const t = createTools({
    store,
    files,
    settings,
    home: HOME,
    sessions: { all: () => info },
    actions: {
      autoMerge: () => Promise.resolve(),
      removeWts: (paths) => {
        removed.push(paths);
        return Promise.resolve(
          paths.filter((p) => p.endsWith("-locked")).map((path) => ({
            path,
            error: "locked",
          })),
        );
      },
    },
    autoRebase: { set: () => Promise.resolve() },
    autoClose: {
      set: (wt, on) => {
        closes.push([wt, on]);
        return Promise.resolve();
      },
    },
    log: () => {},
  });
  return Object.assign(t, { removed, closes });
};

Deno.test("wts filters by pr state and recent", async () => {
  const t = make([
    mkRepo({
      worktrees: [
        worktree({ path: "/r/forest", lastActivity: 3, pr: pr("OPEN") }),
        worktree({
          path: "/r/forest-old",
          branch: "old",
          lastActivity: 2,
          pr: pr("MERGED"),
        }),
        worktree({ path: "/r/forest-new", branch: "new", lastActivity: 1 }),
      ],
    }),
  ]);

  const open = await t.callTool("wts", { pr: "open" }) as Worktree[];
  assertEquals(open.map((w) => w.path), ["/r/forest"]);

  const none = await t.callTool("wts", { pr: "none" }) as Worktree[];
  assertEquals(none.map((w) => w.path), ["/r/forest-new"]);

  const recent = await t.callTool("wts", { recent: "2" }) as Worktree[];
  assertEquals(recent.map((w) => w.path), ["/r/forest", "/r/forest-old"]);
});

Deno.test("link returns candidates for an ambiguous wt selector", async () => {
  const t = make([
    mkRepo({
      worktrees: [
        worktree({ path: "/r/forest-a", branch: "feat-a" }),
        worktree({ path: "/r/forest-b", branch: "feat-b" }),
      ],
    }),
  ]);

  const e = await t.callTool("link", { wt: "feat" }).then(
    () => null,
    (e) => e,
  );
  assertEquals(t.toolError(e), {
    error: "ambiguous worktree",
    candidates: [
      { repo: "forest", branch: "feat-a", path: "/r/forest-a" },
      { repo: "forest", branch: "feat-b", path: "/r/forest-b" },
    ],
  });

  const miss = await t.callTool("link", { wt: "zzz" }).then(
    () => null,
    (e) => e,
  );
  assertEquals(t.toolError(miss).error, "no worktree matches");
});

Deno.test("whoami returns the owning worktree row", async () => {
  const t = make([
    mkRepo({
      worktrees: [
        worktree({ path: "/r/forest" }),
        worktree({ path: "/r/forest/nested", branch: "nested" }),
      ],
    }),
  ]);

  assertEquals(
    (await t.callTool("whoami", { path: "/r/forest/nested/src/a.ts" }) as
      | Worktree
      | null)?.path,
    "/r/forest/nested",
  );
  assertEquals(await t.callTool("whoami", { path: "/elsewhere" }), null);
});

Deno.test("link builds a forest-app.localhost URL for a loopback host", async () => {
  const t = make([mkRepo({ worktrees: [worktree({ path: "/r/forest" })] })]);
  assertEquals(
    await t.callTool("link", { wt: "/r/forest", file: "src/a.ts", line: 12 }),
    {
      url:
        "http://forest-app.localhost:38471/?wt=%2Fr%2Fforest&file=src%2Fa.ts&line=12",
    },
  );

  const lan = make([mkRepo({ worktrees: [worktree({ path: "/r/forest" })] })], {
    ...DEFAULTS,
    host: "10.0.0.5",
    port: 1234,
  });
  assertEquals(await lan.callTool("link", { wt: "/r/forest" }), {
    url: "http://10.0.0.5:1234/?wt=%2Fr%2Fforest",
  });
});

Deno.test("files lists changed files for a resolved worktree", async () => {
  const G = "git --no-optional-locks";
  const t = make(
    [mkRepo({ worktrees: [worktree({ path: "/r/forest" })] })],
    undefined,
    {
      [`${G} diff --no-renames --name-status -z HEAD`]: "M\0src/a.ts\0",
      [`${G} diff --no-renames --numstat -z HEAD`]: "1\t2\tsrc/a.ts\0",
      [`${G} status --porcelain=v2 -z --untracked-files=all`]: "",
    },
  );
  assertEquals(await t.callTool("files", { wt: "/r/forest" }), {
    base: "HEAD",
    files: [{
      path: "src/a.ts",
      status: "M",
      added: 1,
      removed: 2,
      staged: false,
      unstaged: false,
    }],
  });
});

const info = (id: string, title: string): SessionInfo => ({
  agent: "claude",
  label: "Claude",
  id,
  title,
  cwd: "/r/forest",
  startedAt: 1,
  transcript: `/h/.claude/projects/x/${id}.jsonl`,
  url: `claude://resume?session=${id}`,
  command: `cd '/r/forest' && claude --resume ${id}`,
});

const sessionsMake = () => {
  const a = info("aaaa1111", "Make the feat branch");
  const b = info("aaaa2222", "Audit every worktree");
  const slim = (s: SessionInfo, seenAt: number, deep: boolean) => ({
    agent: s.agent,
    id: s.id,
    title: s.title,
    seenAt,
    deep,
  });
  return {
    a,
    b,
    t: make(
      [mkRepo({
        worktrees: [
          worktree({ path: "/r/forest", isPrimary: true }),
          worktree({ path: "/r/forest-feat", branch: "feat" }),
          worktree({ path: "/r/forest-fix", branch: "fix" }),
        ],
      })],
      undefined,
      undefined,
      new Map([
        ["/r/forest-feat", [slim(a, 5, true), slim(b, 9, false)]],
        ["/r/forest-fix", [slim(b, 9, false)]],
      ]),
      new Map([[`claude:${a.id}`, a], [`claude:${b.id}`, b]]),
    ),
  };
};

Deno.test("sessions by wt: full records, most likely creator first, tagged", async () => {
  const { t, a, b } = sessionsMake();
  assertEquals(await t.callTool("sessions", { wt: "feat" }), [
    { ...a, seenAt: 5, tag: "created" },
    { ...b, seenAt: 9, tag: "mentioned" },
  ]);
  assertEquals(await t.callTool("sessions", { wt: "fix" }), [
    { ...b, seenAt: 9, tag: "" },
  ]);
});

Deno.test("sessions by id prefix lists the worktrees it touched; ambiguous ids list candidates", async () => {
  const { t, b } = sessionsMake();
  assertEquals(await t.callTool("sessions", { id: "aaaa2" }), {
    ...b,
    wts: [
      {
        wt: "/r/forest-feat",
        repo: "forest",
        branch: "feat",
        seenAt: 9,
        tag: "mentioned",
      },
      {
        wt: "/r/forest-fix",
        repo: "forest",
        branch: "fix",
        seenAt: 9,
        tag: "",
      },
    ],
  });
  const err = await t.callTool("sessions", { id: "aaaa" }).catch((e) =>
    t.toolError(e)
  );
  assertEquals(err, {
    error: "ambiguous session id",
    candidates: [
      { agent: "claude", id: "aaaa1111", title: "Make the feat branch" },
      { agent: "claude", id: "aaaa2222", title: "Audit every worktree" },
    ],
  });
});

Deno.test("sessions q fuzzy-matches titles; no params is an error", async () => {
  const { t, a } = sessionsMake();
  const got = await t.callTool("sessions", { q: "feat branch" }) as {
    id: string;
  }[];
  assertEquals(got[0].id, a.id);
  assertEquals(
    t.toolError(await t.callTool("sessions", {}).catch((e) => e)),
    { error: "pass wt, id or q" },
  );
});

Deno.test("remove_wts never removes a worktree that would lose work or is in use", async () => {
  const t = make(
    [mkRepo({
      worktrees: [
        worktree({ path: "/r/forest", isPrimary: true }),
        worktree({ path: "/r/forest-done", branch: "done" }),
        worktree({ path: "/r/forest-dirty", branch: "dirty", dirty: 2 }),
        worktree({ path: "/r/forest-mid", branch: "mid", state: "rebase" }),
        worktree({ path: "/r/forest-srv", branch: "srv" }),
        worktree({ path: "/r/forest-locked", branch: "locked" }),
      ],
    })],
    undefined,
    undefined,
    undefined,
    undefined,
    new Map([
      ["/r/forest-srv", [{ port: 5173, pid: 9, command: "vite" }]],
    ]),
  );
  const out = await t.callTool("remove_wts", {
    wts: [
      "/r/forest",
      "done",
      "dirty",
      "mid",
      "srv",
      "/r/forest-locked",
    ],
  });
  assertEquals(t.removed, [["/r/forest-done", "/r/forest-locked"]]);
  assertEquals(out, {
    removed: ["/r/forest-done"],
    refused: [
      { path: "/r/forest", error: "primary checkout" },
      { path: "/r/forest-dirty", error: "uncommitted or untracked changes" },
      { path: "/r/forest-mid", error: "rebase in progress" },
      { path: "/r/forest-srv", error: "listening on 5173" },
      { path: "/r/forest-locked", error: "locked" },
    ],
  });
});

Deno.test("set_auto_merge needs an open PR", async () => {
  const t = make([mkRepo({ worktrees: [worktree({ path: "/r/forest" })] })]);
  assertEquals(
    t.toolError(
      await t.callTool("set_auto_merge", { wt: "/r/forest", enable: true })
        .catch((e) => e),
    ),
    { error: "no open PR" },
  );
});

Deno.test("set_auto_merge off on a merged PR is a no-op", async () => {
  const pr = { number: 7, state: "MERGED" } as Pr;
  const t = make([
    mkRepo({ worktrees: [worktree({ path: "/r/forest", pr })] }),
  ]);
  assertEquals(
    await t.callTool("set_auto_merge", { wt: "/r/forest", enable: false }),
    { pr: 7, autoMerge: false },
  );
});

Deno.test("set_auto_close needs a ticket status to enable, never a PR or to disable", async () => {
  const info = {
    title: "",
    status: "",
    category: null,
    assignee: null,
    actions: [],
  };
  const t = make([
    mkRepo({
      worktrees: [
        worktree({
          path: "/r/forest",
          ticket: { key: "ROM-1", url: "u", info },
        }),
        worktree({
          path: "/r/forest-a",
          branch: "a",
          ticket: { key: "ROM-2", url: "u" },
        }),
      ],
    }),
  ]);
  const err = async (wt: string) =>
    t.toolError(
      await t.callTool("set_auto_close", { wt, enable: true }).catch((e) => e),
    );
  assertEquals(await err("/r/forest-a"), { error: "no ticket status" });
  await t.callTool("set_auto_close", { wt: "/r/forest", enable: true });
  await t.callTool("set_auto_close", { wt: "/r/forest-a", enable: false });
  assertEquals(t.closes, [["/r/forest", true], ["/r/forest-a", false]]);
});

const openPr = (over: Partial<Pr> = {}): Pr => ({
  number: 9,
  url: "u9",
  state: "OPEN",
  stateSince: 0,
  title: "Feat",
  isDraft: false,
  baseRefName: "main",
  reviewDecision: "",
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  autoMerge: true,
  ci: { state: "pending", failing: [] },
  ciSince: null,
  reviewSince: null,
  approvals: 0,
  card: null,
  detailAt: 1,
  ...over,
});

const waitSetup = (pr: Pr) => {
  const w = worktree({ path: "/r/forest-feat", branch: "feat", pr });
  return { w, t: make([mkRepo({ worktrees: [w] })]) };
};

Deno.test("wait returns an already-active kind at once, without its scope", async () => {
  const { t } = waitSetup(
    openPr({ ci: { state: "fail", failing: ["lint"] } }),
  );
  assertEquals(await t.callTool("wait", { wt: "feat", for: "act" }), [{
    kind: "ci-failed",
    key: "ci-failed:/r/forest-feat:lint",
    repo: "/r/forest",
    wt: "/r/forest-feat",
    pr: 9,
    title: "Required check failed: forest #9",
    body: "lint",
    url: "u9",
  }]);
});

Deno.test("wait resolves on the publish that makes a kind active", async () => {
  const { w, t } = waitSetup(openPr());
  const p = t.callTool("wait", { wt: "feat", for: "pr-merged,act" });
  t.wake();
  w.pr = { ...w.pr!, state: "MERGED" };
  t.wake();
  assertEquals(
    ((await p) as { kind: string }[]).map((d) => d.kind),
    ["pr-merged"],
  );
});

Deno.test("wait skips a seen key until it clears, then counts it again", async () => {
  using time = new FakeTime();
  const fail = { state: "fail" as const, failing: ["lint"] };
  const { w, t } = waitSetup(openPr({ ci: fail }));
  const key = "ci-failed:/r/forest-feat:lint";
  let out: unknown = null;
  t.callTool("wait", { wt: "feat", for: "ci-failed", seen: key }).then((
    o,
  ) => out = o);
  t.wake();
  await time.tickAsync(0);
  assertEquals(out, null);
  w.pr = { ...w.pr!, ci: { state: "pending", failing: [] } };
  t.wake();
  w.pr = { ...w.pr!, ci: fail };
  t.wake();
  await time.tickAsync(0);
  assertEquals((out as { key: string }[]).map((d) => d.key), [key]);
});

Deno.test("wait returns [] on timeout; timeout=0 is a single check", async () => {
  using time = new FakeTime();
  const { t } = waitSetup(openPr());
  assertEquals(
    await t.callTool("wait", { wt: "feat", for: "act", timeout: "0" }),
    [],
  );
  const p = t.callTool("wait", { wt: "feat", for: "act", timeout: "5" });
  await time.tickAsync(5000);
  assertEquals(await p, []);
});

Deno.test("wait refuses unknown and always-on kinds", async () => {
  const { t } = waitSetup(openPr());
  for (const k of ["nope", "wt-added", "automerge-changed"]) {
    await assertRejects(
      () => t.callTool("wait", { wt: "feat", for: k }),
      Error,
      `can't wait for ${k}`,
    );
  }
});
