import { dirname } from "@std/path";
import type { Stats } from "./stats.ts";

// One flat line a minute, plus one per notable event; `type` tells them apart.
// Rotation keeps at most one previous generation, so history stays between
// maxLines and twice it and never grows without bound. A rename is O(1) —
// a true one-in-one-out ring would rewrite the whole file on every append.
export function createLog(
  { path, stats, maxLines = 10_000 }: {
    path: string;
    stats: Stats;
    maxLines?: number;
  },
): { line(o: Record<string, unknown>): void; flush(): Promise<void> } {
  let lines = -1; // unknown until the first write counts what is already there
  let failed = false;
  let queue: Promise<void> = Promise.resolve();

  return {
    line(o: Record<string, unknown>) {
      queue = queue.then(async () => {
        try {
          await Deno.mkdir(dirname(path), { recursive: true });
          if (lines < 0) {
            lines = await Deno.readTextFile(path)
              .then((t) => t.split("\n").length - 1)
              .catch(() => 0);
          }
          if (lines >= maxLines) {
            // replaces any previous .1: exactly one generation is kept
            await Deno.rename(path, path + ".1");
            lines = 0;
            stats.logRotationsTotal++;
          }
          await Deno.writeTextFile(
            path,
            JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n",
            { append: true },
          );
          lines++;
          stats.logWritesTotal++;
          failed = false;
        } catch (e) {
          stats.logFailTotal++;
          // a failure is reported once per streak, not every minute
          if (!failed) console.error("forest-log write failed:", e);
          failed = true;
        }
      });
    },
    flush: () => queue,
  };
}
