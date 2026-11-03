import { PROVIDERS } from "./agents.ts";
import type { Shell } from "./exec.ts";
import {
  parseLsofPidPorts,
  parsePs,
  type ProcRules,
  procsByCwd,
} from "./parse.ts";
import { type Stats, timed } from "./stats.ts";
import type { Procs } from "./types.ts";

const AGENTS = new Set(PROVIDERS.map((p) => p.agent));
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "login"]);
const RULES: ProcRules = {
  agents: AGENTS,
  shells: SHELLS,
  skip: new Set([
    ...AGENTS,
    ...SHELLS,
    "disclaimer",
    "git",
    "gh",
    "lsof",
    "ps",
  ]),
};

// GLOBAL and timed: one lsof for the whole machine, PID -> cwd -> worktree.
// It cannot be attributed to one repo, so it can never be recomputed per repo;
// it gets its own cadence and is merged into the snapshot by publish().
export function createPorts(sh: Shell, stats: Stats) {
  let procsByCwdCache = new Map<string, Procs>();
  // ps only has whole seconds of uptime; keep the first start time so a row
  // doesn't change every refresh
  const started = new Map<number, number>();

  async function runningProcs(): Promise<Map<string, Procs>> {
    const [net, cwds, ps] = await Promise.all([
      sh.lsof("-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"),
      sh.lsof("-a", "-d", "cwd", "-Fpcn"),
      sh.ps("-axo", "pid=,ppid=,etime=,%cpu=,rss=,args="),
    ]);
    const byCwd = procsByCwd(
      parseLsofPidPorts(net),
      cwds,
      parsePs(ps),
      Date.now(),
      RULES,
    );
    const live = new Set<number>();
    for (const procs of byCwd.values()) {
      for (const p of procs) {
        live.add(p.pid);
        p.since = started.get(p.pid) ?? p.since;
        started.set(p.pid, p.since);
      }
    }
    for (const pid of started.keys()) if (!live.has(pid)) started.delete(pid);
    return byCwd;
  }

  return {
    async refresh() {
      procsByCwdCache = await timed(stats, "portsMs", runningProcs());
    },
    current: () => procsByCwdCache,
  };
}
