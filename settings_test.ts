import { assertEquals } from "@std/assert";
import { coerceSettings, settingsOverrides } from "./parse.ts";

const D = { port: 7420, root: "~/Repos", pollMs: 5000, launchers: { a: "x" } };

Deno.test("drops unknown keys and keeps known ones", () => {
  assertEquals(coerceSettings(D, { port: 8000, nope: 1 }), { port: 8000 });
});

Deno.test("*Ms values are floored at 250, others at 0", () => {
  assertEquals(coerceSettings(D, { pollMs: 0, port: -3 }), {
    pollMs: 250,
    port: 0,
  });
});

Deno.test("junk numbers and blank strings are ignored", () => {
  assertEquals(coerceSettings(D, { pollMs: "abc", root: "  " }), {});
  assertEquals(coerceSettings(D, { pollMs: "900.7", root: " ~/x " }), {
    pollMs: 900,
    root: "~/x",
  });
});

Deno.test("launcher map keeps string entries only", () => {
  assertEquals(
    coerceSettings(D, { launchers: { a: " /s.sh ", b: 3, c: "" } }),
    {
      launchers: { a: "/s.sh" },
    },
  );
});

import { fillCommand } from "./parse.ts";

const V = { slug: "fix-thing", repo: "forest", path: "/r/forest", root: "/r" };

Deno.test("fillCommand substitutes every known placeholder", () => {
  assertEquals(
    fillCommand("wt.sh {slug} --repo {repo} --at {path} in {root}", V),
    "wt.sh fix-thing --repo forest --at /r/forest in /r",
  );
});

Deno.test("fillCommand repeats a placeholder and leaves unknown ones alone", () => {
  assertEquals(
    fillCommand("git worktree add ../{slug} -b {slug} {nope}", V),
    "git worktree add ../fix-thing -b fix-thing {nope}",
  );
});

Deno.test("settingsOverrides keeps only what differs from the defaults", () => {
  assertEquals(settingsOverrides(D, { ...D, pollMs: 900 }), { pollMs: 900 });
  assertEquals(settingsOverrides(D, { ...D }), {});
});

Deno.test("settingsOverrides compares nested maps by value", () => {
  assertEquals(settingsOverrides(D, { ...D, launchers: { a: "x" } }), {});
  assertEquals(settingsOverrides(D, { ...D, launchers: {} }), {
    launchers: {},
  });
});

Deno.test("booleans are coerced, non-booleans ignored", () => {
  const B = { watch: true };
  assertEquals(coerceSettings(B, { watch: false }), { watch: false });
  assertEquals(coerceSettings(B, { watch: "false" }), {});
});
