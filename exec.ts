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
        stdin: stdin === undefined ? "inherit" : "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const wrote = stdin === undefined ? null : (async () => {
        const w = p.stdin.getWriter();
        await w.write(new TextEncoder().encode(stdin));
        await w.close();
      })().catch(() => {});
      const out = await p.output();
      await wrote;
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
      try {
        // try, not .catch(): a missing binary throws before output() returns
        const out = await new Deno.Command("lsof", {
          args,
          stdout: "piped",
          stderr: "null",
        }).output();
        return dec.decode(out.stdout);
      } catch {
        return "";
      } finally {
        done();
      }
    },
  };
}

// A .app opened from Finder or the Dock inherits launchd's PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), not the shell's, so gh, launchers and repo
// git hooks can't find Homebrew/nvm/deno tools. Ask the login shell instead,
// the way editors do. Markers fence the value from rc-file chatter; a hung rc
// file is cut off rather than holding up startup.
const MARK = "__forest_path__";

export function markedPath(out: string): string | null {
  return out.match(new RegExp(`${MARK}(.*?)${MARK}`, "s"))?.[1] || null;
}

export async function loginPath(
  shell = Deno.env.get("SHELL") || "/bin/zsh",
): Promise<string | null> {
  try {
    // try, not .catch(): a missing binary throws before output() returns
    const out = await new Deno.Command(shell, {
      args: ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(5_000),
    }).output();
    return markedPath(dec.decode(out.stdout));
  } catch {
    return null;
  }
}
