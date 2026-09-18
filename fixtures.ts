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
