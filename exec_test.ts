import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createExec, loginPath, markedPath } from "./exec.ts";
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

Deno.test("exec surfaces the child's stderr when it exits before reading stdin", async () => {
  const sh = createExec(newStats());
  const e = await assertRejects(
    () =>
      sh.exec(".", ["sh", "-c", "echo nope >&2; exit 3"], "x".repeat(1 << 20)),
    Error,
  );
  assertStringIncludes(e.message, "nope");
});

Deno.test("markedPath ignores rc-file chatter around the marked value", () => {
  assertEquals(
    markedPath(
      "Welcome!\n__forest_path__/opt/homebrew/bin:/usr/bin__forest_path__\nbye",
    ),
    "/opt/homebrew/bin:/usr/bin",
  );
  assertEquals(markedPath("no markers"), null);
  assertEquals(markedPath("__forest_path____forest_path__"), null);
});

Deno.test("loginPath reads PATH from a login shell", async () => {
  assertStringIncludes((await loginPath("/bin/sh"))!, "/usr/bin");
  assertEquals(await loginPath("/no/such/shell"), null);
});
