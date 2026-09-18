import { assertEquals } from "@std/assert";
import { newStats } from "./stats.ts";
import { createStore } from "./store.ts";
import type { Pr, Procs, Repo, Worktree } from "./types.ts";

const wt = (repo: string, path: string): Worktree => ({
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
});

const mkRepo = (name: string, wts: string[]): Repo => ({
  name,
  path: `/r/${name}`,
  webUrl: null,
  defaultBranch: "main",
  worktrees: wts.map((p) => wt(name, p)),
});

const make = (opts?: {
  prFor?: (repo: string, w: Worktree) => Pr | null;
  procs?: Map<string, Procs>;
}) => {
  const sent: string[] = [];
  const stats = newStats();
  const store = createStore({
    prFor: opts?.prFor ?? (() => null),
    procs: () => opts?.procs ?? new Map(),
    onSnapshot: (j) => sent.push(j),
    stats,
  });
  return { store, sent, stats };
};

Deno.test("publish rebuilds known and repoPaths from byPath and sorts repos by name", () => {
  const { store, stats } = make();
  store.byPath.set("/r/zulu", mkRepo("zulu", ["/r/zulu"]));
  store.byPath.set("/r/alpha", mkRepo("alpha", ["/r/alpha", "/r/alpha-feat"]));
  store.publish();

  assertEquals(
    JSON.parse(store.snapshot()).map((r: Repo) => r.name),
    ["alpha", "zulu"],
  );
  assertEquals([...store.known], [
    ["/r/alpha", "/r/alpha"],
    ["/r/alpha-feat", "/r/alpha"],
    ["/r/zulu", "/r/zulu"],
  ]);
  assertEquals([...store.repoPaths], [
    ["alpha", "/r/alpha"],
    ["zulu", "/r/zulu"],
  ]);
  assertEquals(stats.repos, 2);
  assertEquals(stats.worktrees, 3);

  store.byPath.delete("/r/alpha");
  store.publish();
  assertEquals([...store.known.keys()], ["/r/zulu"]);
  assertEquals([...store.repoPaths.keys()], ["zulu"]);
});

Deno.test("publish attaches pr, procs sorted by port and unique ports per worktree", () => {
  const pr = { number: 7, url: "u" } as Pr;
  const { store } = make({
    prFor: (repo, w) => repo === "/r/forest" && w.branch === "main" ? pr : null,
    procs: new Map<string, Procs>([
      ["/r/forest", [{ port: 3000, pid: 9, command: "node" }]],
      ["/r/forest/src", [
        { port: 1901, pid: 5, command: "vite" },
        { port: 3000, pid: 9, command: "node" },
      ]],
    ]),
  });
  store.byPath.set("/r/forest", mkRepo("forest", ["/r/forest"]));
  store.publish();

  const w = store.byPath.get("/r/forest")!.worktrees[0];
  assertEquals(w.pr, pr);
  assertEquals(w.procs.map((p) => p.port), [1901, 3000]);
  assertEquals(w.ports, [1901, 3000]);
});

Deno.test("a proc whose cwd is inside a nested worktree goes to the deepest owner", () => {
  const { store } = make({
    procs: new Map<string, Procs>([
      ["/r/forest/nested/app", [{ port: 8080, pid: 1, command: "deno" }]],
    ]),
  });
  store.byPath.set(
    "/r/forest",
    mkRepo("forest", ["/r/forest", "/r/forest/nested"]),
  );
  store.publish();

  const [outer, inner] = store.byPath.get("/r/forest")!.worktrees;
  assertEquals(outer.ports, []);
  assertEquals(inner.ports, [8080]);
});

Deno.test("publish does not call onSnapshot when the JSON is unchanged", () => {
  const { store, sent, stats } = make();
  store.byPath.set("/r/forest", mkRepo("forest", ["/r/forest"]));
  store.publish();
  store.publish();
  assertEquals(sent.length, 1);
  assertEquals(stats.broadcastsTotal, 1);
  assertEquals(stats.snapshotBytes, sent[0].length);

  store.byPath.set("/r/other", mkRepo("other", ["/r/other"]));
  store.publish();
  assertEquals(sent.length, 2);
  assertEquals(store.repos().length, 2);
});
