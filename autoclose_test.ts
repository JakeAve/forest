import { assertEquals } from "@std/assert";
import { createAutoClose } from "./autoclose.ts";
import { repo, worktree } from "./fixtures.ts";
import type { TicketInfo } from "./parse.ts";
import type { Pr, Worktree } from "./types.ts";

const WT = "/r/forest-feat";
const info = (over: Partial<TicketInfo> = {}): TicketInfo => ({
  title: "t",
  status: "in review",
  category: "doing",
  assignee: null,
  actions: ["todo", "done"],
  ...over,
});
const merged = { number: 7, url: "pr7", state: "MERGED" } as Pr;

function make(over: Partial<Worktree>, fail = false) {
  const w = worktree({
    path: WT,
    branch: "feat",
    pr: { number: 7, state: "OPEN" } as Pr,
    ticket: { key: "ROM-1", url: "u", info: info() },
    ...over,
  });
  const store = {
    byPath: new Map([["/r/forest", repo({ worktrees: [w] })]]),
    known: new Map([[WT, "/r/forest"]]),
    publish() {},
  };
  const acted: string[] = [];
  const path = `${Deno.makeTempDirSync()}/autoclose.json`;
  const api = createAutoClose({
    store,
    tickets: {
      act: (_r, _n, key, to, pr) => {
        acted.push(`${key} ${to} ${pr}`);
        return fail ? Promise.reject(new Error("boom")) : Promise.resolve();
      },
    },
    path,
    log: () => {},
  });
  return { api, w, acted, path };
}

Deno.test("open PR: waits; merged: closes the ticket once and turns off", async () => {
  const t = make({});
  await t.api.set(WT, true);
  await t.api.tick();
  assertEquals(t.acted, []);
  t.w.pr = merged;
  await Promise.all([t.api.tick(), t.api.tick()]);
  assertEquals(t.acted, ["ROM-1 done pr7"]);
  assertEquals(t.api.status(WT), null);
  assertEquals(JSON.parse(Deno.readTextFileSync(t.path)), []);
});

Deno.test("already done: turns off without acting", async () => {
  const t = make({
    pr: merged,
    ticket: {
      key: "ROM-1",
      url: "u",
      info: info({ status: "done", category: "done" }),
    },
  });
  await t.api.set(WT, true);
  await t.api.tick();
  assertEquals(t.acted, []);
  assertEquals(t.api.status(WT), null);
});

Deno.test("merged with no ticket key: turns off", async () => {
  const t = make({ pr: merged, ticket: null });
  await t.api.set(WT, true);
  await t.api.tick();
  assertEquals([t.acted, t.api.status(WT)], [[], null]);
});

Deno.test("ticket not read yet: waits", async () => {
  const t = make({
    pr: merged,
    ticket: { key: "ROM-1", url: "u", info: null },
  });
  await t.api.set(WT, true);
  await t.api.tick();
  assertEquals(t.api.status(WT), { on: true, error: null });
});

Deno.test("no done action or a failing command: error stays until re-enabled", async () => {
  const none = make({
    pr: merged,
    ticket: { key: "ROM-1", url: "u", info: info({ actions: ["todo"] }) },
  });
  await none.api.set(WT, true);
  await none.api.tick();
  assertEquals(none.api.status(WT), {
    on: true,
    error: "no done status offered for ROM-1",
  });

  const t = make({ pr: merged }, true);
  await t.api.set(WT, true);
  await t.api.tick();
  await t.api.tick();
  assertEquals(t.acted, ["ROM-1 done pr7"]);
  assertEquals(t.api.status(WT), { on: true, error: "boom" });
  await t.api.set(WT, true);
  assertEquals(t.api.status(WT), { on: true, error: null });
});

Deno.test("load restores the set", async () => {
  const t = make({});
  await t.api.set(WT, true);
  const again = make({});
  Deno.writeTextFileSync(again.path, Deno.readTextFileSync(t.path));
  await again.api.load();
  assertEquals(again.api.status(WT), { on: true, error: null });
});
