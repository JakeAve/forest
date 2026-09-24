import { dirname } from "@std/path";
import type { Shell } from "./exec.ts";
import type { PrsApi } from "./prs.ts";
import type { StoreApi } from "./store.ts";
import type { AutoRebase, Worktree } from "./types.ts";

export type AutoRebaseApi = {
  load(): Promise<void>;
  set(wt: string, on: boolean): Promise<void>;
  status(wt: string): AutoRebase | null;
  tick(): Promise<void>;
  rebase(wt: string): Promise<void>;
  updateBranch(wt: string, repo: string, n: number): Promise<void>;
};

// Opted-in worktrees follow origin/HEAD on a timer. A branch with an open PR
// is updated on GitHub (update-branch merges base into it) and fast-forwarded
// locally once that lands; any other branch is rebased locally and never
// pushed. A failure is remembered against the base sha it failed on, so a
// conflict is retried only once base moves again.
export function createAutoRebase(
  { sh, store, prs, path, afterMutation, log }: {
    sh: Pick<Shell, "git" | "exec">;
    store: Pick<StoreApi, "byPath" | "known" | "publish">;
    prs: Pick<PrsApi, "refreshOnePr" | "refreshPrSoon">;
    path: string;
    afterMutation: () => void;
    log: (o: Record<string, unknown>) => void;
  },
): AutoRebaseApi {
  const { git, exec } = sh;
  const on = new Set<string>();
  const failed = new Map<string, { sha: string; error: string }>();

  const save = async () => {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify([...on], null, 2) + "\n");
  };

  const row = (wt: string): Worktree | undefined =>
    store.byPath.get(store.known.get(wt) ?? "")?.worktrees.find((w) =>
      w.path === wt
    );

  const counts = async (wt: string, range: string) =>
    (await git(wt, "rev-list", "--left-right", "--count", range)).trim()
      .split("\t").map(Number);

  async function rebase(wt: string) {
    try {
      await git(wt, "rebase", "origin/HEAD");
    } catch (e) {
      await git(wt, "rebase", "--abort").catch(() => {});
      throw new Error(
        `rebase failed — aborted, use a terminal. ${(e as Error).message}`,
      );
    }
  }

  async function updateBranch(wt: string, repo: string, n: number) {
    await exec(wt, [
      "gh",
      "api",
      "-X",
      "PUT",
      `repos/{owner}/{repo}/pulls/${n}/update-branch`,
    ]);
    await prs.refreshOnePr(repo, n).catch(() => {});
    prs.refreshPrSoon(repo, n);
  }

  // one worktree; returns what it did, or null when there was nothing to do
  async function step(wt: string, w: Worktree, repo: string) {
    const [behindBase] = await counts(wt, "origin/HEAD...HEAD");
    if (w.pr?.state === "OPEN") {
      if (!w.remote) return null;
      const [behindRemote, aheadRemote] = await counts(
        wt,
        `origin/${w.remote}...HEAD`,
      );
      if (aheadRemote) return null; // unpushed local work: not ours to reconcile
      if (behindRemote) {
        // update-branch is asynchronous on GitHub's side, so its merge commit
        // usually arrives here a tick later, as "behind the remote"
        await git(wt, "merge", "--ff-only", `origin/${w.remote}`);
        return "ff";
      }
      if (!behindBase) return null;
      await updateBranch(wt, repo, w.pr.number);
      return "update-branch";
    }
    if (!behindBase) return null;
    await rebase(wt);
    return "rebase";
  }

  async function tick() {
    let changed = false, moved = false;
    const fetched = new Set<string>();
    for (const wt of on) {
      const repo = store.known.get(wt);
      const w = row(wt);
      if (!repo || !w || w.isPrimary || w.state || w.dirty) continue;
      let sha = "";
      try {
        if (!fetched.has(repo)) {
          await git(wt, "fetch", "origin");
          fetched.add(repo);
        }
        sha = (await git(wt, "rev-parse", "origin/HEAD")).trim();
        if (failed.get(wt)?.sha === sha) continue;
        const action = await step(wt, w, repo);
        if (failed.delete(wt)) changed = true;
        if (!action) continue;
        moved = true;
        log({ type: "autoRebase", wt, action });
      } catch (e) {
        const error = (e as Error).message;
        failed.set(wt, { sha, error });
        changed = true;
        log({ type: "autoRebase", wt, error });
      }
    }
    if (moved) afterMutation();
    else if (changed) store.publish();
  }

  return {
    load: async () => {
      const saved = await Deno.readTextFile(path).then(JSON.parse).catch(
        () => [],
      );
      for (const p of saved) if (typeof p === "string") on.add(p);
    },
    set: async (wt, enable) => {
      if (enable) on.add(wt);
      else {
        on.delete(wt);
        failed.delete(wt);
      }
      for (const p of on) if (!store.known.has(p)) on.delete(p);
      await save();
      store.publish();
    },
    status: (wt) =>
      on.has(wt) ? { on: true, error: failed.get(wt)?.error ?? null } : null,
    tick,
    rebase,
    updateBranch,
  };
}
