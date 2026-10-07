import { assertEquals } from "@std/assert";
import {
  findAll,
  fuzzy,
  matcher,
  matchPath,
  matchWt,
  parseQuery,
  pathText,
  rank,
} from "./src/filter.js";

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

Deno.test("matchWt: fuzzy across branch and repo", () => {
  assertEquals(matchWt({ q: "jr1" }, "edward", wt()), true);
  assertEquals(matchWt({ q: "rom1 edw" }, "edward", wt()), true);
});

Deno.test("matchPath: abbreviations and typed paths both match", () => {
  assertEquals(matchPath("appsv", "src/App.svelte"), true);
  assertEquals(matchPath("src/app", "src/App.svelte"), true);
  assertEquals(matchPath("", "anything"), true);
  assertEquals(matchPath("xyz", "src/App.svelte"), false);
});

Deno.test("rank with pathText: basename hit beats a deep directory hit", () => {
  const paths = ["filters/deep/x.ts", "src/filter.js"];
  assertEquals(rank("filter", paths, 50, pathText)[0], "src/filter.js");
});

Deno.test("findAll: every case-insensitive hit, query taken literally", () => {
  assertEquals(findAll("", "abc"), []);
  assertEquals(findAll("Ab", "ab xAB ab"), [[0, 2], [4, 6], [7, 9]]);
  assertEquals(findAll("a.(", "a.( axx"), [[0, 3]]);
});

Deno.test("parseQuery: slashes make a regex, closing slash optional", () => {
  assertEquals(parseQuery("foo"), { text: "foo" });
  assertEquals(parseQuery("/").text, "");
  assertEquals(parseQuery("/ab+/").re?.source, "ab+");
  assertEquals(parseQuery("/ab+").re?.source, "ab+");
  assertEquals(parseQuery("/a\\/").re?.source, "a\\/");
  assertEquals(typeof parseQuery("/a(/").error, "string");
});

Deno.test("matcher: regex hits score 0, bad regex matches nothing", () => {
  assertEquals(matcher("/^rom-\\d+$/")("ROM-12"), 0);
  assertEquals(matcher("/^rom-\\d+$/")("rom-x"), null);
  assertEquals(matcher("/a(/")("a("), null);
});

Deno.test("regex anchors apply per field, not to the joined text", () => {
  assertEquals(matchPath("/^src\\//", "src/App.svelte"), true);
  assertEquals(matchPath("/\\.ts$/", "src/App.svelte"), false);
  assertEquals(matchWt({ q: "/^edward$/" }, "edward", wt()), true);
  assertEquals(matchWt({ q: "/^jake\\//" }, "edward", wt()), true);
});

Deno.test("rank: regex keeps input order", () => {
  const items = [{ label: "b1" }, { label: "a1" }, { label: "c" }];
  assertEquals(rank("/\\d/", items), items.slice(0, 2));
});

Deno.test("findAll: regex per line, zero-width hits dropped", () => {
  assertEquals(findAll("/^a/", "ab\nxa\nab"), [[0, 1], [6, 7]]);
  assertEquals(findAll("/^/", "ab\ncd"), []);
  assertEquals(findAll("/a(/", "a("), []);
});
