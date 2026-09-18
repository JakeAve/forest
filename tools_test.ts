import { assertEquals } from "@std/assert";
import { newStats } from "./stats.ts";
import { createStore } from "./store.ts";
import { createTools } from "./tools.ts";
import { DEFAULTS } from "./settings.ts";
import type { FilesApi } from "./files.ts";
import type { Pr, Repo, Worktree } from "./types.ts";

const HOME = "/home/jake";

const wt = (
  repo: string,
  path: string,
  o: Partial<Worktree> = {},
): Worktree => ({
  repo,
  path,
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
  subject: "",
  author: "",
  lastActivity: 0,
  isPrimary: false,
  remote: null,
  ports: [],
  procs: [],
  pr: null,
  ...o,
});

const pr = (state: Pr["state"]) => ({ number: 1, url: "u", state } as Pr);

const mkRepo = (name: string, wts: Worktree[]): Repo => ({
  name,
  path: `/r/${name}`,
  webUrl: "https://github.com/JakeAve/forest",
  defaultBranch: "main",
  worktrees: wts,
});

const make = (repos: Repo[], settings = { ...DEFAULTS }) => {
  const store = createStore({
    prFor: (_r, w) => w.pr,
    procs: () => new Map(),
    onSnapshot: () => {},
    stats: newStats(),
  });
  for (const r of repos) store.byPath.set(r.path, r);
  store.publish();
  return createTools({
    store,
    files: {} as FilesApi,
    settings,
    home: HOME,
  });
};

Deno.test("wts filters by pr state and recent", async () => {
  const t = make([
    mkRepo("forest", [
      wt("forest", "/r/forest", { lastActivity: 3, pr: pr("OPEN") }),
      wt("forest", "/r/forest-old", {
        branch: "old",
        lastActivity: 2,
        pr: pr("MERGED"),
      }),
      wt("forest", "/r/forest-new", { branch: "new", lastActivity: 1 }),
    ]),
  ]);

  const open = await t.callTool("wts", { pr: "open" }) as Worktree[];
  assertEquals(open.map((w) => w.path), ["/r/forest"]);

  const none = await t.callTool("wts", { pr: "none" }) as Worktree[];
  assertEquals(none.map((w) => w.path), ["/r/forest-new"]);

  const recent = await t.callTool("wts", { recent: "2" }) as Worktree[];
  assertEquals(recent.map((w) => w.path), ["/r/forest", "/r/forest-old"]);
});

// `wts` itself takes no selector; the ambiguous path is resolveWt, reached by
// every tool that takes a `wt`.
Deno.test("wts returns candidates for an ambiguous selector", async () => {
  const t = make([
    mkRepo("forest", [
      wt("forest", "/r/forest-a", { branch: "feat-a" }),
      wt("forest", "/r/forest-b", { branch: "feat-b" }),
    ]),
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
    mkRepo("forest", [
      wt("forest", "/r/forest"),
      wt("forest", "/r/forest/nested", { branch: "nested" }),
    ]),
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
  const t = make([mkRepo("forest", [wt("forest", "/r/forest")])]);
  assertEquals(
    await t.callTool("link", { wt: "/r/forest", file: "src/a.ts", line: 12 }),
    {
      url:
        "http://forest-app.localhost:38471/?wt=%2Fr%2Fforest&file=src%2Fa.ts&line=12",
    },
  );

  const lan = make([mkRepo("forest", [wt("forest", "/r/forest")])], {
    ...DEFAULTS,
    host: "10.0.0.5",
    port: 1234,
  });
  assertEquals(await lan.callTool("link", { wt: "/r/forest" }), {
    url: "http://10.0.0.5:1234/?wt=%2Fr%2Fforest",
  });
});
