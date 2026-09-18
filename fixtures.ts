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
