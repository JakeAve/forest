import type { Exec, Shell } from "./exec.ts";

export function fakeExec(
  table: Record<string, string | ((cwd: string) => string)>,
  opts?: { fallback?: string },
): Shell & { calls: string[]; missing: string[] } {
  const calls: string[] = [];
  const missing: string[] = [];

  const exec: Exec = (cwd, cmd) => {
    const key = cmd.join(" ");
    calls.push(`${cwd} $ ${key}`);
    const hit = table[key];
    if (hit === undefined) {
      missing.push(key);
      if (opts?.fallback === undefined) {
        throw new Error(`fakeExec: no entry for ${key}`);
      }
      return Promise.resolve(opts.fallback);
    }
    return Promise.resolve(typeof hit === "function" ? hit(cwd) : hit);
  };

  const git = (cwd: string, ...args: string[]) => exec(cwd, ["git", ...args]);

  return {
    calls,
    missing,
    exec,
    git,
    tryGit: (cwd, ...args) =>
      Promise.resolve()
        .then(() => git(cwd, "--no-optional-locks", ...args))
        .catch(() => null),
    gitIn: async (cwd, _stdin, ...args) => {
      await git(cwd, ...args);
    },
    lsof: (...args) =>
      Promise.resolve().then(() => exec("", ["lsof", ...args])).catch(() => ""),
  };
}

export const PORCELAIN_2WT = `worktree /r/forest
HEAD aaaaaaa1
branch refs/heads/main

worktree /r/forest-feat
HEAD bbbbbbb2
branch refs/heads/feat
`;

export const STATUS_V2 = [
  "1 M. N... 100644 100644 100644 aaa bbb src/a.ts",
  "1 .M N... 100644 100644 100644 ccc ddd src/b.ts",
  "? notes.md",
].join("\0") + "\0";

export const HEAD_LOG = "1700000000\nAdd the thing\nJake\n";

export const FOR_EACH_REF_TRACK = "main [behind 1]\nfeat [gone]\n";

export const GH_PR_LIST = JSON.stringify([
  {
    number: 7,
    url: "https://github.com/JakeAve/forest/pull/7",
    headRefName: "feat",
    state: "OPEN",
    createdAt: "2026-09-01T00:00:00Z",
    closedAt: null,
    mergedAt: null,
  },
  {
    number: 3,
    url: "https://github.com/JakeAve/forest/pull/3",
    headRefName: "old",
    state: "MERGED",
    createdAt: "2026-08-01T00:00:00Z",
    closedAt: "2026-08-02T00:00:00Z",
    mergedAt: "2026-08-02T00:00:00Z",
  },
]);

export const GH_PR_VIEW = JSON.stringify({
  title: "Add the thing",
  isDraft: false,
  baseRefName: "main",
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  statusCheckRollup: [{
    name: "test",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    startedAt: "2026-09-02T00:00:00Z",
    completedAt: "2026-09-02T00:05:00Z",
  }],
  reviews: [{
    author: { login: "octo" },
    state: "APPROVED",
    submittedAt: "2026-09-03T00:00:00Z",
    url: "https://github.com/JakeAve/forest/pull/7#r1",
    body: "lgtm",
  }],
});

export const GH_CARD = JSON.stringify({
  author: { login: "jake" },
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-03T00:00:00Z",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  headRefName: "feat",
  mergeStateStatus: "CLEAN",
  baseRef: { compare: { aheadBy: 4, behindBy: 1 } },
  reviewRequests: { nodes: [{ requestedReviewer: { login: "bot" } }] },
  reviews: {
    nodes: [{
      author: { login: "octo" },
      state: "APPROVED",
      submittedAt: "2026-09-03T00:00:00Z",
      url: "https://github.com/JakeAve/forest/pull/7#r1",
      body: "lgtm",
    }],
  },
  reviewThreads: { nodes: [] },
  comments: { nodes: [] },
  commits: {
    nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }],
  },
});

export function pushable<T>(): AsyncIterable<T> & {
  push(v: T): void;
  end(): void;
  fail(e: unknown): void;
} {
  const queue: T[] = [];
  let done = false;
  let err: { e: unknown } | null = null;
  let wake: (() => void) | null = null;
  const bump = () => {
    wake?.();
    wake = null;
  };
  return {
    push: (v) => {
      queue.push(v);
      bump();
    },
    end: () => {
      done = true;
      bump();
    },
    fail: (e) => {
      err = { e };
      bump();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (err) throw err.e;
        if (done) return;
        await new Promise<void>((r) => wake = r);
      }
    },
  };
}
