import { assertEquals } from "@std/assert";
import { matchWt } from "./src/filter.js";

const wt = (o = {}) => ({ branch: "jake/rom-1", dirty: 0, ports: [], ...o });

Deno.test("no filters: everything matches", () => {
  assertEquals(matchWt({}, "edward", wt()), true);
});

Deno.test("runningOnly keeps only worktrees with ports", () => {
  assertEquals(matchWt({ runningOnly: true }, "edward", wt()), false);
  assertEquals(
    matchWt({ runningOnly: true }, "edward", wt({ ports: [1901] })),
    true,
  );
});

Deno.test("runningOnly tolerates a worktree with no ports field", () => {
  const { ports: _drop, ...noPorts } = wt();
  assertEquals(matchWt({ runningOnly: true }, "edward", noPorts), false);
});

Deno.test("dirtyOnly and runningOnly stack as AND", () => {
  const f = { dirtyOnly: true, runningOnly: true };
  assertEquals(matchWt(f, "edward", wt({ dirty: 2 })), false);
  assertEquals(matchWt(f, "edward", wt({ ports: [1901] })), false);
  assertEquals(matchWt(f, "edward", wt({ dirty: 2, ports: [1901] })), true);
});

Deno.test("query matches branch or repo name, and stacks with runningOnly", () => {
  assertEquals(matchWt({ q: "rom-1" }, "edward", wt()), true);
  assertEquals(matchWt({ q: "edw" }, "edward", wt()), true);
  assertEquals(matchWt({ q: "nope" }, "edward", wt()), false);
  assertEquals(matchWt({ q: "edw", runningOnly: true }, "edward", wt()), false);
});
