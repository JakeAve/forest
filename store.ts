import { ownerWorktree, type Ticket } from "./parse.ts";
import type { Stats } from "./stats.ts";
import type { WtKey } from "./sessions.ts";
import type {
  AgentSession,
  AutoRebase,
  Pr,
  Procs,
  Repo,
  Worktree,
} from "./types.ts";

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
  {
    prFor,
    ticket = () => null,
    autoRebase,
    prError = () => null,
    prListed,
    procs,
    agents = () => new Map(),
    onSnapshot,
    stats,
  }: {
    prFor: (repo: string, w: Worktree) => Pr | null;
    ticket?: (repo: Repo, w: Worktree) => Ticket | null;
    autoRebase?: (wt: string) => AutoRebase | null;
    prError?: (repo: string) => string | null;
    prListed?: (repo: string) => boolean;
    procs: () => Map<string, Procs>;
    // null until sessions have loaded: rows keep the agents they last had
    agents?: (wts: WtKey[]) => Map<string, AgentSession[]> | null;
    onSnapshot: (json: string) => void;
    stats: Stats;
  },
): StoreApi {
  const byPath = new Map<string, Repo>();
  const known = new Map<string, string>(); // wt path -> repo main path
  const repoPaths = new Map<string, string>();
  let snapshot = "[]";
  // wt path -> agents last published; a recomputed row arrives without any
  let held = new Map<string, AgentSession[]>();

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
        r.prError = prError(r.path);
        r.prListed = prListed?.(r.path) ?? false;
        for (const w of r.worktrees) {
          known.set(w.path, r.path);
          wtByPath.set(w.path, w);
          w.pr = prFor(r.path, w);
          w.ticket = ticket(r, w);
          w.autoRebase = autoRebase?.(w.path) ?? null;
          w.ports = []; // recomputed from scratch: publish() runs on live objects
          w.procs = [];
        }
      }
      const wtPaths = [...wtByPath.keys()];
      const byWt = agents(
        repos.flatMap((r) =>
          r.worktrees.flatMap((w) =>
            !w.isPrimary
              ? [{ path: w.path }]
              : w.branch && w.branch !== r.defaultBranch &&
                  w.state !== "detached"
              ? [{
                path: w.path,
                branch: w.branch,
                ...(w.ticket && !w.ticket.key.startsWith("#") &&
                  { ticket: w.ticket.key }),
              }]
              : []
          )
        ),
      );
      for (const w of wtByPath.values()) {
        w.agents = byWt ? byWt.get(w.path) ?? [] : held.get(w.path) ?? w.agents;
      }
      held = new Map([...wtByPath].map(([p, w]) => [p, w.agents]));
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
