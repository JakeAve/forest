import { assertEquals } from "@std/assert";
import { DEFAULTS, type Settings } from "./settings.ts";
import { createNotify, type InboxStore, memoryInbox } from "./notify.ts";
import { fakeExec, repo, worktree } from "./fixtures.ts";
import type { Pr, Repo, Worktree } from "./types.ts";

const pr = (over: Partial<Pr> = {}) =>
  ({
    number: 7,
    url: "https://github.com/x/y/pull/7",
    state: "OPEN",
    title: "Add the thing",
    detailAt: null,
    ...over,
  }) as Pr;

const snap = (...wts: Partial<Worktree>[]) =>
  JSON.stringify(
    [
      repo({ prListed: true, worktrees: wts.map((w) => worktree(w)) }),
    ] satisfies Repo[],
  );

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(
  over: Partial<Settings> = {},
  inbox: InboxStore = memoryInbox(),
) {
  const sh = fakeExec({}, { fallback: "" });
  const argv: string[][] = [];
  const exec: typeof sh.exec = (cwd, cmd, stdin) => {
    argv.push(cmd);
    return sh.exec(cwd, cmd, stdin);
  };
  const emitted: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const settings = { ...structuredClone(DEFAULTS), ...over };
  let t = 1_000_000;
  const n = createNotify({
    sh: { ...sh, exec },
    settings,
    sse: { emit: (e, d) => emitted.push(`${e} ${d}`) },
    inbox,
    now: () => t,
    os: true,
    log: (o) => logs.push(o),
  });
  return {
    n,
    logs,
    sh,
    argv,
    emitted,
    settings,
    inbox,
    advance: (ms: number) => t += ms,
  };
}

const interfaceOnly = (i: InboxStore): InboxStore => ({
  load: () => i.load(),
  append: (e) => i.append(e),
  update: (ids, p) => i.update(ids, p),
  snooze: (s) => i.snooze(s),
  unsnooze: (k) => i.unsnooze(k),
  trim: (m) => i.trim(m),
});

type Mk = (over?: Partial<Settings>) => ReturnType<typeof setup>;
const cases: [string, (mk: Mk) => void | Promise<void>][] = [];
const test = (name: string, fn: (mk: Mk) => void | Promise<void>) => {
  cases.push([name, fn]);
  Deno.test(name, () => fn((over) => setup(over)));
};

test("notify: PR title with quotes reaches osascript as argv", (mk) => {
  const title = `-e "do shell script \\"rm -rf ~\\"" 'x'`;
  const { n, argv } = mk({ notify: { "pr-opened": "os" } });
  n.observe(snap({ path: "/r/forest-feat" }));
  n.observe(snap({ path: "/r/forest-feat", pr: pr({ title }) }));
  assertEquals(argv, [[
    "osascript",
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e",
    "end run",
    "--",
    title,
    "PR opened: forest #7",
  ]]);
});

test("notify: several events in one cycle make one osascript call", (mk) => {
  const { n, sh, emitted } = mk({
    notify: { "wt-added": "both", "pushed-to-branch": "app" },
  });
  n.observe(snap({ path: "/r/forest" }));
  n.observe(
    snap({ path: "/r/forest", behind: 2 }, { path: "/r/a" }, {
      path: "/r/b",
    }),
  );
  assertEquals(emitted.length, 3);
  assertEquals(sh.calls, [
    "/ $ osascript -e on run argv -e display notification (item 1 of argv) with title (item 2 of argv) -e end run -- forest Forest: 2 updates",
  ]);
});

test("notify: kinds are off unless enabled in settings", (mk) => {
  const { n, sh, emitted, settings } = mk({
    notify: { "wt-added": "bogus" },
  });
  n.observe(snap({ path: "/r/forest" }));
  n.observe(snap({ path: "/r/forest" }, { path: "/r/a" }));
  assertEquals([emitted, sh.calls, n.list()], [[], [], []]);
  settings.notify = { "wt-added": "app" };
  n.observe(snap({ path: "/r/forest" }, { path: "/r/a" }, { path: "/r/b" }));
  assertEquals(n.list().map((e) => e.wt), ["/r/b"]);
  assertEquals(sh.calls, []);
});

test("notify: muted wt and kind off are dropped", (mk) => {
  const { n } = mk({
    notify: { "wt-added": "app" },
    notifyMuted: ["/r/a"],
  });
  n.observe(snap({ path: "/r/forest" }));
  n.observe(
    snap({ path: "/r/forest", behind: 1 }, { path: "/r/a" }, {
      path: "/r/b",
    }),
  );
  assertEquals(n.list().map((e) => `${e.kind} ${e.wt}`), ["wt-added /r/b"]);
});

test("notify: snooze clears when the condition resets", async (mk) => {
  const { n, inbox } = mk({ notify: { "pushed-to-branch": "app" } });
  const at = (behind: number) => n.observe(snap({ path: "/r/forest", behind }));
  at(0);
  await n.snooze("pushed-to-branch:/r/forest");
  at(1);
  assertEquals(n.list(), []);
  assertEquals((await inbox.load()).snoozes.length, 1);
  at(0);
  await flush();
  assertEquals((await inbox.load()).snoozes, []);
  at(1);
  assertEquals(n.list().map((e) => e.kind), ["pushed-to-branch"]);
});

test("notify: inbox trims to notifyMax", async (mk) => {
  const { n, inbox, advance } = mk({
    notify: { "wt-added": "app" },
    notifyMax: 2,
  });
  const wts: Partial<Worktree>[] = [{ path: "/r/forest" }];
  n.observe(snap(...wts));
  for (const p of ["/r/a", "/r/b", "/r/c"]) {
    advance(1000);
    wts.push({ path: p });
    n.observe(snap(...wts));
  }
  await flush();
  assertEquals(n.list().map((e) => e.wt), ["/r/c", "/r/b"]);
  const stored = (await inbox.load()).events;
  assertEquals(stored.map((e) => e.wt), ["/r/b", "/r/c"]);

  await n.read([n.list()[1].id]);
  assertEquals(
    (await inbox.load()).events.map((e) => e.readAt !== null),
    [true, false],
  );
  await n.read("all");
  const fresh = createNotify({
    sh: fakeExec({}),
    settings: DEFAULTS,
    sse: { emit: () => {} },
    inbox,
    now: () => 0,
    os: false,
    log: () => {},
  });
  await fresh.load();
  assertEquals(fresh.list().map((e) => [e.wt, e.readAt !== null]), [
    ["/r/c", true],
    ["/r/b", true],
  ]);
});

test("notify: a throwing cycle is logged, not thrown", (mk) => {
  const { n, logs, settings } = mk();
  Object.assign(settings, { notify: null, notifyMuted: null });
  n.observe(snap({ path: "/r/forest" }));
  n.observe(snap({ path: "/r/forest" }, { path: "/r/a" }));
  n.observe("{");
  Object.defineProperty(settings, "notifyCiStuckMin", {
    get() {
      throw new Error("boom");
    },
  });
  n.tick();
  assertEquals(logs.map((l) => l.error), [
    logs[0].error,
    "Error: boom",
  ]);
  assertEquals(logs.map((l) => l.type), ["notify-error", "notify-error"]);
});

Deno.test("notify: only the InboxStore interface is used", async (t) => {
  for (const [name, fn] of cases) {
    await t.step(
      name,
      () => fn((over) => setup(over, interfaceOnly(memoryInbox()))),
    );
  }
});
