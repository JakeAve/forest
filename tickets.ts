import { limiter, type TicketInfo, ticketInfo } from "./parse.ts";
import type { Shell } from "./exec.ts";
import type { Settings } from "./settings.ts";

const TICKET_JOBS = 4;
const RETRY_MS = 600_000;

export type TicketsApi = {
  info(repo: string, name: string, key: string): TicketInfo | null;
  act(
    repo: string,
    name: string,
    key: string,
    to: string,
    pr?: string,
  ): Promise<void>;
};

// Status from the user's own ticket command (settings.ticketCmds, `$1` is the
// key), so a tracker's auth stays in its CLI or token and Forest names none.
// Read-through: asking for a missing or stale key fetches it, and the answer
// arrives through onChange like a PR's.
export function createTickets(
  { sh, settings, onChange, now = Date.now }: {
    sh: Shell;
    settings: Settings;
    onChange: () => void;
    now?: () => number;
  },
): TicketsApi {
  const run = limiter(TICKET_JOBS);
  const cache = new Map<string, { info: TicketInfo | null; at: number }>();
  const nextAt = new Map<string, number>();
  const failed = new Set<string>(); // repo names already logged

  async function fetch(repo: string, name: string, key: string, cmd: string) {
    const out = await run(() =>
      sh.exec(repo, [
        "sh",
        "-c",
        cmd.includes("$1") ? cmd : `${cmd} "$1"`,
        "forest-ticket",
        key,
      ])
    ).catch((e) => {
      if (!failed.has(name)) {
        failed.add(name);
        // stderr is the user's script's: one capped line, not a traceback
        const last = e.message.trim().split("\n").at(-1) ?? "";
        console.error(`ticket command failed in ${name}:`, last.slice(0, 200));
      }
      return null;
    });
    const info = out === null ? null : ticketInfo(out);
    const prev = cache.get(key);
    if (info) failed.delete(name);
    else if (prev?.info) {
      nextAt.set(key, now() + RETRY_MS);
      return;
    }
    cache.set(key, { info, at: now() });
    nextAt.set(key, now() + (info ? settings.ticketPollMs : RETRY_MS));
    if (JSON.stringify(prev?.info) !== JSON.stringify(info)) onChange();
  }

  const cmdFor = (name: string) =>
    settings.ticketCmds[name] ?? settings.ticketCmds["*"];

  return {
    info(repo, name, key) {
      const cmd = cmdFor(name);
      if (!cmd) return null;
      if (now() >= (nextAt.get(key) ?? 0)) {
        nextAt.set(key, Infinity); // in flight
        void fetch(repo, name, key, cmd);
      }
      return cache.get(key)?.info ?? null;
    },
    // Moves the ticket with the same command, the target status as $2 and
    // the worktree's PR URL (or "") as $3; only to a status the command
    // itself last offered.
    async act(repo, name, key, to, pr = "") {
      const cmd = cmdFor(name);
      if (!cmd || !cache.get(key)?.info?.actions.includes(to)) {
        throw new Error(`not an action for ${key}: ${to}`);
      }
      await sh.exec(repo, [
        "sh",
        "-c",
        cmd.includes("$1") ? cmd : `${cmd} "$1" "$2" "$3"`,
        "forest-ticket",
        key,
        to,
        pr,
      ]);
      await fetch(repo, name, key, cmd);
    },
  };
}
