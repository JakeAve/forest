import { assertEquals } from "@std/assert";
import { fakeExec, repo as mkRepo, worktree } from "./fixtures.ts";
import { newStats } from "./stats.ts";
import { createFiles } from "./files.ts";
import { createStore } from "./store.ts";
import { createTools } from "./tools.ts";
import { DEFAULTS } from "./settings.ts";
import type { Pr, Repo, Worktree } from "./types.ts";

const HOME = "/home/jake";

const pr = (state: Pr["state"]) => ({ number: 1, url: "u", state } as Pr);

const make = (
  repos: Repo[],
  settings = { ...DEFAULTS },
  table: Record<string, string> = {},
) => {
  const store = createStore({
    prFor: (_r, w) => w.pr,
    procs: () => new Map(),
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
  return createTools({ store, files, settings, home: HOME });
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
  const out = t.toolError(e) as { error: string; candidates: Worktree[] };
  assertEquals(out.error, "ambiguous worktree");
  assertEquals(out.candidates.map((w) => w.path), [
    "/r/forest-a",
    "/r/forest-b",
  ]);

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
