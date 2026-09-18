import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createExec } from "./exec.ts";
import { newStats } from "./stats.ts";

Deno.test("exec returns stdout and counts otherTotal", async () => {
  const stats = newStats();
  const sh = createExec(stats);
  assertEquals(await sh.exec(".", ["sh", "-c", "echo hi"]), "hi\n");
  assertEquals(stats.otherTotal, 1);
  assertEquals(stats.subprocessesTotal, 1);
  assertEquals(stats.subprocessInflight, 0);
});

Deno.test("exec pipes stdin", async () => {
  const sh = createExec(newStats());
  assertEquals(await sh.exec(".", ["cat"], "x"), "x");
});

Deno.test("failed command throws stderr text", async () => {
  const sh = createExec(newStats());
  const e = await assertRejects(
    () => sh.exec(".", ["sh", "-c", "echo boom >&2; exit 1"]),
    Error,
  );
  assertStringIncludes(e.message, "boom");
});

Deno.test("tryGit returns null and bumps gitFailTotal in a non-repo temp dir", async () => {
  const stats = newStats();
  const sh = createExec(stats);
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await sh.tryGit(dir, "rev-parse", "HEAD"), null);
    assertEquals(stats.gitFailTotal, 1);
  } finally {
    await Deno.remove(dir);
  }
});

Deno.test("lsof never throws", async () => {
  const sh = createExec(newStats());
  assertEquals(await sh.lsof("--definitely-not-a-flag"), "");
});
