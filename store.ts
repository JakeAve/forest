import { ownerWorktree } from "./parse.ts";
import type { Stats } from "./stats.ts";
import type { Pr, Procs, Repo, Worktree } from "./types.ts";

export type StoreApi = {
  byPath: Map<string, Repo>;
  known: Map<string, string>;
  repoPaths: Map<string, string>;
  snapshot(): string;
  publish(): void;
};

// ---- snapshot assembly ----
// The snapshot has three sources on three cadences: git data
// per repo (event-driven), ports globally (timed), PRs per repo (timed). This
// map is the source of truth; the snapshot is derived from it, so a partial
// recompute only has to replace one entry.
export function createStore(
  { prFor, procs, onSnapshot, stats }: {
    prFor: (repo: string, w: Worktree) => Pr | null;
    procs: () => Map<string, Procs>;
    onSnapshot: (json: string) => void;
    stats: Stats;
  },
): StoreApi {
  const byPath = new Map<string, Repo>();
  const known = new Map<string, string>(); // wt path -> repo main path
  const repoPaths = new Map<string, string>();
  let snapshot = "[]";

  return {
    byPath,
    known,
    repoPaths,
    snapshot: () => snapshot,
    // Rebuilds knownWorktrees/repoPaths from the whole map every time, so a partial
    // recompute can never drop a still-live worktree from the guardWt allowlist.
    // Synchronous throughout: no request can observe the map half-rebuilt.
    publish() {
      const repos = [...byPath.values()].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      known.clear();
      repoPaths.clear();
      const wtByPath = new Map<string, Worktree>();
      for (const r of repos) {
        repoPaths.set(r.name, r.path);
        for (const w of r.worktrees) {
          known.set(w.path, r.path);
          wtByPath.set(w.path, w);
          w.pr = prFor(r.path, w);
          w.ports = []; // recomputed from scratch: publish() runs on live objects
          w.procs = [];
        }
      }
      const wtPaths = [...wtByPath.keys()];
      for (const [cwd, ps] of procs()) {
        const w = wtByPath.get(ownerWorktree(cwd, wtPaths) ?? "");
        if (w) {
          const byKey = new Map(
            [...w.procs, ...ps].map((p) => [`${p.pid}:${p.port}`, p]),
          );
          w.procs = [...byKey.values()].sort((a, b) => a.port - b.port);
        }
      }
      for (const w of wtByPath.values()) {
        w.ports = [...new Set(w.procs.map((p) => p.port))].sort((a, b) =>
          a - b
        );
      }
      const s = JSON.stringify(repos);
      if (s !== snapshot) {
        snapshot = s;
        stats.broadcastsTotal++;
        stats.snapshotBytes = s.length;
        onSnapshot(s);
      }
      stats.repos = repos.length;
      stats.worktrees = known.size;
    },
  };
}
