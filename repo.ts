import { join, resolve } from "@std/path";
import {
  parseStatus,
  parseUpstreamTrack,
  parseWorktreeList,
  pool,
  remoteWebUrl,
  statusCounts,
} from "./parse.ts";
import type { Shell } from "./exec.ts";
import type { Repo, Worktree } from "./types.ts";

export const REPO_JOBS = 8; // repos swept at once
const WT_JOBS = 4; // worktrees per repo at once

const STATE_BY_GIT_PATH = [
  "rebase",
  "rebase",
  "merge",
  "cherry-pick",
] as const;

export type RepoApi = {
  repoDirs(): Promise<{ name: string; path: string }[]>;
  computeRepo(name: string, path: string): Promise<Repo | null>;
  recomputeWorktrees(repo: Repo, want: Set<string>): Promise<Repo | null>;
  mergeBase(wt: string, repoPath: string | undefined): Promise<string>;
  exists(path: string): Promise<boolean>;
};

export function createRepo(
  { sh, root }: { sh: Shell; root: string },
): RepoApi {
  const { tryGit } = sh;
  const defaultRefByRepo = new Map<string, string>();

  const exists = (path: string) =>
    Deno.stat(join(path, ".git")).then(() => true).catch(() => false);

  async function mergeBase(
    wt: string,
    repoPath: string | undefined,
  ): Promise<string> {
    const ref = defaultRefByRepo.get(repoPath ?? "") ?? "origin/HEAD";
    return (await tryGit(wt, "merge-base", ref, "HEAD"))?.trim() ?? "HEAD";
  }

  async function loadWorktree(
    repoName: string,
    wt: { path: string; head: string; branch: string },
    isPrimary: boolean,
    primaryBranch: string,
    pushed: Set<string>,
    gone: Set<string>,
    defaultRef: string | null,
  ): Promise<Worktree> {
    const [statusZ, ab, headLog, upstream, abMain, statePaths] = await Promise
      .all([
        tryGit(
          wt.path,
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
        ),
        tryGit(
          wt.path,
          "rev-list",
          "--left-right",
          "--count",
          "@{upstream}...HEAD",
        ),
        tryGit(wt.path, "log", "-1", "--format=%ct%n%s%n%an"),
        tryGit(
          wt.path,
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ),
        defaultRef
          ? tryGit(
            wt.path,
            "rev-list",
            "--left-right",
            "--count",
            `${defaultRef}...HEAD`,
          )
          : Promise.resolve(null),
        tryGit(
          wt.path,
          "rev-parse",
          "--git-path",
          "rebase-merge",
          "--git-path",
          "rebase-apply",
          "--git-path",
          "MERGE_HEAD",
          "--git-path",
          "CHERRY_PICK_HEAD",
        ),
      ]);
    // upstream set to the primary branch means "branched off it", not "pushed as it"
    const tracked = upstream?.trim().split("/").slice(1).join("/") || null;
    const remote = tracked && tracked !== primaryBranch
      ? tracked
      : pushed.has(wt.branch)
      ? wt.branch
      : null;
    const st = parseStatus(statusZ ?? "");
    const { dirty, untracked } = st;
    const counts = statusCounts(st.entries);
    const [behind, ahead] = ab
      ? ab.trim().split("\t").map(Number)
      : [null, null];
    const [behindMain, aheadMain] = abMain
      ? abMain.trim().split("\t").map(Number)
      : [null, null];
    const [ct, subject, author] = (headLog ?? "").split("\n");

    let state: Worktree["state"] = wt.branch === "(detached)"
      ? "detached"
      : null;
    const lines = (statePaths ?? "").split("\n");
    const hits = await Promise.all(
      STATE_BY_GIT_PATH.map((_, i) =>
        lines[i]
          ? Deno.stat(resolve(wt.path, lines[i])).then(() => true).catch(() =>
            false
          )
          : false
      ),
    );
    const hit = hits.indexOf(true);
    if (hit >= 0) state = STATE_BY_GIT_PATH[hit];

    let lastActivity = Number(ct ?? 0) * 1000;
    const changed = await tryGit(wt.path, "diff", "--name-only", "-z", "HEAD");
    const paths = [
      ...(changed ?? "").split("\0").filter(Boolean),
      ...untracked,
    ];
    for (const p of paths) {
      const st = await Deno.stat(join(wt.path, p)).catch(() => null);
      if (st?.mtime && st.mtime.getTime() > lastActivity) {
        lastActivity = st.mtime.getTime();
      }
    }
    return {
      repo: repoName,
      path: wt.path,
      branch: wt.branch,
      head: wt.head,
      ahead,
      behind,
      aheadMain,
      behindMain,
      gone: gone.has(wt.branch),
      state,
      dirty,
      staged: counts.staged,
      modified: counts.modified,
      untracked: counts.untracked,
      subject: subject ?? "",
      author: author ?? "",
      lastActivity,
      isPrimary,
      remote,
      ports: [],
      procs: [],
      pr: null,
      autoRebase: null,
    };
  }

  async function repoDirs(): Promise<{ name: string; path: string }[]> {
    const candidates: { name: string; path: string }[] = [];
    for await (const e of Deno.readDir(root)) {
      if (!e.isDirectory) continue;
      const p = join(root, e.name);
      if (await exists(p)) candidates.push({ name: e.name, path: p });
    }
    return candidates;
  }

  // what every worktree of one repo needs, read once: the worktree list, the
  // branches that exist on origin, the upstreams that are gone, the default ref
  async function repoFacts(path: string) {
    const [porcelain, refs, track, headRef] = await Promise.all([
      tryGit(path, "worktree", "list", "--porcelain"),
      tryGit(path, "for-each-ref", "--format=%(refname:short)", "refs/remotes"),
      tryGit(
        path,
        "for-each-ref",
        "--format=%(refname:short) %(upstream:track)",
        "refs/heads",
      ),
      tryGit(path, "symbolic-ref", "refs/remotes/origin/HEAD"),
    ]);
    const defaultRef = headRef?.trim() || null;
    if (defaultRef) defaultRefByRepo.set(path, defaultRef);
    else defaultRefByRepo.delete(path);
    return {
      list: porcelain ? parseWorktreeList(porcelain) : null,
      // ponytail: assumes the remote is "origin"; widen if a second remote ever matters
      pushed: new Set(
        (refs ?? "").split("\n").filter((r) => r.startsWith("origin/")).map((
          r,
        ) => r.slice(7)),
      ),
      gone: parseUpstreamTrack(track ?? ""),
      defaultRef,
    };
  }

  // the unit the watcher invalidates: everything the snapshot knows about one repo
  // Recompute only the named worktrees of one repo, reusing the repo-level data
  // every worktree needs. That is repoFacts' 4 git calls plus loadWorktree's 5
  // each, against computeRepo's 5 + 5 per *every* worktree — on a 29-worktree
  // repo, 9 calls instead of 150.
  //
  // Returns null when the worktree list itself moved, which means a worktree was
  // added or removed and every isPrimary/primaryBranch answer may have changed:
  // only computeRepo can reconcile that, so the caller falls back to it. The
  // cheap path detecting when it is not enough is what keeps this safe.
  async function recomputeWorktrees(
    repo: Repo,
    want: Set<string>,
  ): Promise<Repo | null> {
    const { list, pushed, gone, defaultRef } = await repoFacts(repo.path);
    if (!list) return null;
    if (
      list.length !== repo.worktrees.length ||
      list.some((w, i) => w.path !== repo.worktrees[i].path)
    ) {
      return null;
    }
    const targets = list.map((w, i) => ({ w, i })).filter(({ w }) =>
      want.has(w.path)
    );
    if (!targets.length) return repo;
    const fresh = await pool(
      WT_JOBS,
      targets,
      ({ w, i }) =>
        loadWorktree(
          repo.name,
          w,
          i === 0,
          list[0].branch,
          pushed,
          gone,
          defaultRef,
        ),
    );
    const byPath = new Map(fresh.map((w) => [w.path, w]));
    return {
      ...repo,
      worktrees: repo.worktrees.map((w) => byPath.get(w.path) ?? w),
    };
  }

  async function computeRepo(name: string, path: string): Promise<Repo | null> {
    const [facts, originUrl] = await Promise.all([
      repoFacts(path),
      tryGit(path, "remote", "get-url", "origin"),
    ]);
    const { list, pushed, gone, defaultRef } = facts;
    if (!list) return null;
    // a linked worktree parked at the root is not a repo: its main repo already
    // lists it, and listing it twice gives the client duplicate keys
    if (list[0].path !== path) return null;
    const worktrees = await pool(
      WT_JOBS,
      list,
      (wt, i) =>
        loadWorktree(
          name,
          wt,
          i === 0,
          list[0].branch,
          pushed,
          gone,
          defaultRef,
        ),
    );
    return {
      name,
      path,
      webUrl: originUrl ? remoteWebUrl(originUrl) : null,
      defaultBranch: defaultRef?.replace("refs/remotes/origin/", "") ?? null,
      worktrees,
    };
  }

  return { repoDirs, computeRepo, recomputeWorktrees, mergeBase, exists };
}
