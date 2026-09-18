import { bumpMax, type Stats } from "./stats.ts";

export type Exec = (
  cwd: string,
  cmd: string[],
  stdin?: string,
) => Promise<string>;

export type Shell = {
  exec: Exec;
  git(cwd: string, ...args: string[]): Promise<string>;
  tryGit(cwd: string, ...args: string[]): Promise<string | null>;
  gitIn(cwd: string, stdin: string, ...args: string[]): Promise<void>;
  lsof(...args: string[]): Promise<string>;
};

const dec = new TextDecoder();

export function createExec(stats: Stats): Shell {
  const spawned = (bin: string) => {
    stats.subprocessesTotal++;
    if (bin === "git") stats.gitTotal++;
    else if (bin === "gh") stats.ghTotal++;
    else stats.otherTotal++;
    const t0 = performance.now();
    bumpMax(stats, "subprocessPeak", ++stats.subprocessInflight);
    return () => {
      stats.subprocessInflight--;
      stats.subprocessMsTotal += performance.now() - t0;
    };
  };

  const exec: Exec = async (cwd, cmd, stdin) => {
    const done = spawned(cmd[0]);
    try {
      const p = new Deno.Command(cmd[0], {
        args: cmd.slice(1),
        cwd,
        stdin: stdin === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      if (stdin !== undefined) {
        const w = p.stdin.getWriter();
        await w.write(new TextEncoder().encode(stdin));
        await w.close();
      }
      const out = await p.output();
      if (!out.success) {
        throw new Error(
          dec.decode(out.stderr).trim() || dec.decode(out.stdout).trim(),
        );
      }
      return dec.decode(out.stdout);
    } finally {
      done();
    }
  };

  const git = (cwd: string, ...args: string[]) => exec(cwd, ["git", ...args]);

  return {
    exec,
    git,
    // read-only calls only: the flag keeps polling from rewriting .git/index
    tryGit: (cwd, ...args) =>
      git(cwd, "--no-optional-locks", ...args).catch(() => {
        stats.gitFailTotal++;
        return null;
      }),
    gitIn: async (cwd, stdin, ...args) => {
      await exec(cwd, ["git", ...args], stdin);
    },
    lsof: async (...args) => {
      const done = spawned("lsof");
      const out = await new Deno.Command("lsof", {
        args,
        stdout: "piped",
        stderr: "null",
      })
        .output().catch(() => null).finally(done);
      return out ? dec.decode(out.stdout) : "";
    },
  };
}
