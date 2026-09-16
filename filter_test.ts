import { assertEquals } from "@std/assert";
import { fuzzy, matchWt, rank } from "./src/filter.js";

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

Deno.test("fuzzy: subsequence required", () => {
  assertEquals(fuzzy("xyz", "abc"), null);
  assertEquals(fuzzy("", "anything"), 0);
  assertEquals(fuzzy("ac", "abc") !== null, true);
});

Deno.test("fuzzy: contiguous beats scattered", () => {
  const contiguous = fuzzy("abc", "abcxyz")!;
  const scattered = fuzzy("abc", "axbxcx")!;
  assertEquals(contiguous > scattered, true);
});

Deno.test("fuzzy: word start beats mid-word", () => {
  const wordStart = fuzzy("fb", "foo_bar")!;
  const midWord = fuzzy("fb", "foobar")!;
  assertEquals(wordStart > midWord, true);
});

Deno.test("rank: ties keep input order", () => {
  const items = [{ label: "aaa" }, { label: "aaa" }, { label: "aaa" }];
  assertEquals(rank("a", items), items);
});

Deno.test("rank: respects limit", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ label: `item${i}` }));
  assertEquals(rank("item", items, 3).length, 3);
});

Deno.test('rank: "#12" finds a PR number in detail', () => {
  const items = [
    { label: "Add filter ranking", detail: "#12" },
    { label: "Unrelated", detail: "#99" },
  ];
  const ranked = rank("#12", items);
  assertEquals(ranked.length, 1);
  assertEquals(ranked[0].label, "Add filter ranking");
});
