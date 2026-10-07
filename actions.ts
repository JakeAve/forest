import type { Shell } from "./exec.ts";
import type { PrsApi } from "./prs.ts";
import type { StoreApi } from "./store.ts";

export type ActionsApi = ReturnType<typeof createActions>;

// Writes both the UI routes and the agent tools make, so both refresh alike.
export function createActions(
  { sh, store, prs, afterMutation }: {
    sh: Pick<Shell, "exec" | "git">;
    store: Pick<StoreApi, "known">;
    prs: Pick<PrsApi, "refreshOnePr" | "refreshPrSoon">;
    afterMutation: () => void;
  },
) {
  const { exec, git } = sh;
  return {
    async autoMerge(wt: string, n: number, enable: boolean) {
      const repo = store.known.get(wt)!;
      await exec(
        wt,
        enable
          ? ["gh", "pr", "merge", String(n), "--auto", "--squash"]
          : ["gh", "pr", "merge", String(n), "--disable-auto"],
      );
      await prs.refreshOnePr(repo, n).catch(() => {});
      prs.refreshPrSoon(repo, n);
      // the merge lands on the remote, not locally: fetch so ahead/behind
      // vs base isn't read from last sweep's stale refs
      await git(wt, "fetch", "origin").catch(() => {});
      afterMutation();
    },
    async removeWts(paths: string[], force = false) {
      const failed: { path: string; error: string }[] = [];
      for (const p of paths) {
        await git(
          store.known.get(p)!,
          "worktree",
          "remove",
          ...(force ? ["--force"] : []),
          p,
        ).catch((e) => failed.push({ path: p, error: e.message }));
      }
      afterMutation();
      return failed;
    },
  };
}
