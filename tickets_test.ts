import { assertEquals, assertRejects } from "@std/assert";
import { fakeExec } from "./fixtures.ts";
import { DEFAULTS } from "./settings.ts";
import { createTickets } from "./tickets.ts";

const CMD = 'sh -c tk "$1" forest-ticket ROM-1';

Deno.test("tickets: fetches on first read, publishes, then serves the cache until stale", async () => {
  let t = 0;
  let changes = 0;
  const sh = fakeExec({ [CMD]: '{"title":"T","status":"done"}' });
  const tickets = createTickets({
    sh,
    settings: { ...DEFAULTS, ticketCmds: { "*": "tk" }, ticketPollMs: 100 },
    onChange: () => changes++,
    now: () => t,
  });
  assertEquals(tickets.info("/r", "r", "ROM-1"), null);
  await new Promise((r) => setTimeout(r));
  assertEquals(changes, 1);
  assertEquals(tickets.info("/r", "r", "ROM-1")?.category, "done");
  assertEquals(sh.calls.length, 1);
  t = 100;
  tickets.info("/r", "r", "ROM-1");
  await new Promise((r) => setTimeout(r));
  assertEquals([sh.calls.length, changes], [2, 1]);
});

Deno.test("tickets: a failed refresh keeps the last status; no command, no fetch", async () => {
  let t = 0;
  let fail = false;
  const sh = fakeExec({
    [CMD]: () => {
      if (fail) throw new Error("401");
      return '{"title":"T","status":"todo"}';
    },
  });
  const tickets = createTickets({
    sh,
    settings: { ...DEFAULTS, ticketCmds: { r: "tk" }, ticketPollMs: 1 },
    onChange: () => {},
    now: () => t,
  });
  assertEquals(tickets.info("/o", "other", "ROM-1"), null);
  tickets.info("/r", "r", "ROM-1");
  await new Promise((r) => setTimeout(r));
  fail = true;
  t = 5;
  tickets.info("/r", "r", "ROM-1");
  await new Promise((r) => setTimeout(r));
  assertEquals(tickets.info("/r", "r", "ROM-1")?.status, "todo");
  assertEquals(sh.calls.length, 2);
});

Deno.test("tickets: act runs the command with $2 and $3, then re-reads; refuses an unoffered status", async () => {
  let status = "todo";
  const sh = fakeExec({
    [CMD]: () => JSON.stringify({ status, actions: ["done"] }),
    ['sh -c tk "$1" "$2" "$3" forest-ticket ROM-1 done https://gh/pull/7']:
      () => {
        status = "done";
        return "";
      },
  });
  const tickets = createTickets({
    sh,
    settings: { ...DEFAULTS, ticketCmds: { "*": "tk" } },
    onChange: () => {},
  });
  tickets.info("/r", "r", "ROM-1");
  await new Promise((r) => setTimeout(r));
  await assertRejects(() => tickets.act("/r", "r", "ROM-1", "cancelled"));
  await tickets.act("/r", "r", "ROM-1", "done", "https://gh/pull/7");
  assertEquals(tickets.info("/r", "r", "ROM-1")?.status, "done");
});
