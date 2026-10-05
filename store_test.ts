import { assertEquals } from "@std/assert";
import { newStats } from "./stats.ts";
import { createStore } from "./store.ts";
import type { WtKey } from "./sessions.ts";
import { repo, worktree } from "./fixtures.ts";
import type { AgentSession, Pr, Procs, Repo, Worktree } from "./types.ts";

const mkRepo = (name: string, wts: string[]): Repo =>
  repo({
    name,
    path: `/r/${name}`,
    worktrees: wts.map((p) => worktree({ repo: name, path: p })),
  });

const make = (opts?: {
  prFor?: (repo: string, w: Worktree) => Pr | null;
  procs?: Map<string, Procs>;
  prListed?: (repo: string) => boolean;
  agents?: (wts: WtKey[]) => Map<string, AgentSession[]>;
}) => {
  const sent: string[] = [];
  const stats = newStats();
  const store = createStore({
    prFor: opts?.prFor ?? (() => null),
    prListed: opts?.prListed,
    procs: () => opts?.procs ?? new Map(),
    agents: opts?.agents,
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

Deno.test("store: publish sets prListed from prs", () => {
  const { store } = make({ prListed: (r) => r === "/r/a" });
  store.byPath.set("/r/a", mkRepo("a", ["/r/a"]));
  store.byPath.set("/r/b", mkRepo("b", ["/r/b"]));
  store.publish();
  assertEquals(
    [store.byPath.get("/r/a")!.prListed, store.byPath.get("/r/b")!.prListed],
    [true, false],
  );
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
  assertEquals(store.byPath.size, 2);
});

Deno.test("publish asks for agent sessions of linked worktrees, and of a main checkout only on a feature branch", () => {
  const asked: WtKey[][] = [];
  const a = { id: "s1" } as AgentSession;
  const { store } = make({
    agents: (wts) => {
      asked.push(wts);
      return new Map([["/r/alpha-feat", [a]]]);
    },
  });
  const r = mkRepo("alpha", ["/r/alpha", "/r/alpha-feat"]);
  r.worktrees[0].isPrimary = true;
  store.byPath.set("/r/alpha", r);
  store.publish();
  assertEquals(asked, [[{ path: "/r/alpha-feat" }]]);

  r.worktrees[0].branch = "feat/x";
  store.publish();
  assertEquals(asked.at(-1), [
    { path: "/r/alpha", branch: "feat/x" },
    { path: "/r/alpha-feat" },
  ]);
  assertEquals(
    JSON.parse(store.snapshot())[0].worktrees.map((w: Worktree) => w.agents),
    [[], [a]],
  );
});
