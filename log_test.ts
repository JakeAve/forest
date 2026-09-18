import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createLog } from "./log.ts";
import { newStats } from "./stats.ts";

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const lines = (t: string) => t.split("\n").length - 1;

Deno.test("rotates at maxLines keeping exactly one previous generation", async () => {
  await withTmp(async (dir) => {
    const stats = newStats();
    const path = join(dir, "logs", "forest-log.jsonl");
    const log = createLog({ path, stats, maxLines: 3 });
    for (let i = 0; i < 8; i++) log.line({ type: "stats", i });
    await log.flush();

    assertEquals(stats.logWritesTotal, 8);
    assertEquals(stats.logRotationsTotal, 2);
    assertEquals(lines(await Deno.readTextFile(path)), 2);
    assertEquals(lines(await Deno.readTextFile(path + ".1")), 3);
    assertEquals(await Deno.stat(path + ".2").catch(() => null), null);

    const last = JSON.parse((await Deno.readTextFile(path)).split("\n")[1]);
    assertEquals(last.type, "stats");
    assertEquals(last.i, 7);
    assertEquals(typeof last.t, "string");
  });
});

Deno.test("a write failure is reported once per streak", async () => {
  await withTmp(async (dir) => {
    const blocker = join(dir, "blocker");
    await Deno.writeTextFile(blocker, "");
    const stats = newStats();
    const log = createLog({ path: join(blocker, "forest-log.jsonl"), stats });

    const errs: unknown[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => errs.push(a[0]);
    try {
      log.line({ type: "stats" });
      log.line({ type: "stats" });
      log.line({ type: "stats" });
      await log.flush();
    } finally {
      console.error = real;
    }

    assertEquals(stats.logFailTotal, 3);
    assertEquals(stats.logWritesTotal, 0);
    assertEquals(errs, ["forest-log write failed:"]);
  });
});
