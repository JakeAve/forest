import { assertEquals } from "@std/assert";
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
