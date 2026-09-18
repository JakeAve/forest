import type { Shell } from "./exec.ts";
import { parseLsofCommands, parseLsofPidPorts, procsByCwd } from "./parse.ts";
import { type Stats, timed } from "./stats.ts";
import type { Procs } from "./types.ts";

// ---- listening dev servers ----

// GLOBAL and timed: one lsof for the whole machine, PID -> cwd -> worktree.
// It cannot be attributed to one repo, so it can never be recomputed per repo;
// it gets its own cadence and is merged into the snapshot by publish().
export function createPorts(sh: Shell, stats: Stats) {
  let procsByCwdCache = new Map<string, Procs>();

  async function listeningPorts(): Promise<Map<string, Procs>> {
    const net = await sh.lsof("-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn");
    const byPid = parseLsofPidPorts(net);
    if (!byPid.size) return new Map();
    const cmds = parseLsofCommands(net);
    const cwds = await sh.lsof(
      "-a",
      "-d",
      "cwd",
      "-Fpn",
      "-p",
      [...byPid.keys()].join(","),
    );
    return procsByCwd(byPid, cmds, cwds);
  }

  return {
    async refresh() {
      procsByCwdCache = await timed(stats, "portsMs", listeningPorts());
    },
    current: () => procsByCwdCache,
  };
}
