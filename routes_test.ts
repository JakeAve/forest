import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fakeExec, repo as mkRepo, worktree } from "./fixtures.ts";
import { createFiles } from "./files.ts";
import { createSse } from "./sse.ts";
import { createStore } from "./store.ts";
import { createTools } from "./tools.ts";
import { createAutoRebase } from "./autorebase.ts";
import { createRoutes } from "./routes.ts";
import { createNotify, memoryInbox } from "./notify.ts";
import { DEFAULTS } from "./settings.ts";
import { newStats } from "./stats.ts";
import type { PrsApi } from "./prs.ts";
import type { SessionsApi } from "./sessions.ts";
import type { WatcherApi } from "./watcher.ts";
import type { Worktree } from "./types.ts";

const HOME = "/home/jake";

const info = (hostname: string) =>
  ({
    remoteAddr: { transport: "tcp", hostname, port: 1 },
  }) as Deno.ServeHandlerInfo;
const LOCAL = info("127.0.0.1");
const FOREIGN = info("10.0.0.5");

const get = (path: string, host = "localhost:38471") =>
  new Request(`http://${host}${path}`, { headers: { host } });

const post = (path: string, body: unknown, host = "localhost:38471") =>
  new Request(`http://${host}${path}`, {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const make = (opts?: {
  table?: Record<string, string | ((cwd: string) => string)>;
  worktrees?: Worktree[];
}) => {
  const sh = fakeExec(opts?.table ?? {});
  const stats = newStats();
  const sse = createSse();
  const store = createStore({
    prFor: () => null,
    procs: () => new Map(),
    onSnapshot: () => {},
    stats,
  });
  const wts = opts?.worktrees ?? [worktree({ path: "/r/forest" })];
  store.byPath.set("/r/forest", mkRepo({ worktrees: wts }));
  store.publish();

  const files = createFiles({
    sh,
    known: store.known,
    // deno-lint-ignore require-await
    mergeBase: async () => "HEAD",
  });
  const notify = createNotify({
    sh,
    settings: { ...DEFAULTS },
    sse,
    inbox: memoryInbox(),
    now: Date.now,
    os: false,
    log: () => {},
  });

  const mutations: number[] = [];
  const watcher = {
    booted: () => true,
    afterMutation: () => mutations.push(1),
    gauges: () => ({
      mode: "poll" as const,
      watchDirty: 0,
      hotWts: 0,
      watchEventRate: 0,
      storm: false,
    }),
  } as unknown as WatcherApi;

  const prCalls: string[] = [];
  const prs = {
    // deno-lint-ignore require-await
    refreshOnePr: async () => void prCalls.push("refreshOnePr"),
    refreshPrSoon: () => void prCalls.push("refreshPrSoon"),
    expire: () => void prCalls.push("expire"),
    // deno-lint-ignore require-await
    refreshPrs: async () => void prCalls.push("refreshPrs"),
  } as unknown as PrsApi;

  const settings = { ...DEFAULTS };
  const tools = createTools({
    store,
    files,
    settings,
    home: HOME,
    sessions: { all: () => new Map() },
  });
  const routes = createRoutes({
    settings,
    settingsPath: "/tmp/forest-test/settings.json",
    layoutPath: "/tmp/forest-test/layout.json",
    themesDir: "/tmp/forest-test/themes",
    distDir: "/tmp/forest-test/dist",
    home: HOME,
    root: "/r",
    sh,
    store,
    prs,
    ports: { current: () => new Map() },
    files,
    watcher,
    autoRebase: createAutoRebase({
      sh,
      store,
      prs,
      path: "/tmp/forest-test/autorebase.json",
      afterMutation: () => {},
      log: () => {},
    }),
    notify,
    sse,
    stats,
    tools,
    sessions: {
      find: (agent: string, id: string) =>
        agent === "claude" && id === "known"
          ? {
            url: "claude://resume?session=known",
            command: "cd '/r' && claude --resume known",
          }
          : null,
    } as unknown as SessionsApi,
    desktop: false,
  });
  return { routes, notify, sh, store, files, mutations, prCalls, settings };
};

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("GET /api/files with an unknown wt is 400", async () => {
  const { routes } = make();
  const res = await routes(get("/api/files?wt=/r/other"), LOCAL);
  assertEquals(res.status, 400);
  assertStringIncludes(await res.text(), "unknown worktree");
});

Deno.test("POST /api/stage runs git add -- path and returns ok", async () => {
  const { routes, sh, mutations } = make({
    table: { "git add -- src/a.ts": "" },
  });
  const res = await routes(
    post("/api/stage", { wt: "/r/forest", path: "src/a.ts" }),
    LOCAL,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(sh.calls, ["/r/forest $ git add -- src/a.ts"]);
  assertEquals(mutations.length, 1);
});

Deno.test("POST /api/stage-hunk pipes the patch to git apply --cached", async () => {
  const { routes, sh } = make({ table: { "git apply --cached": "" } });
  const res = await routes(
    post("/api/stage-hunk", {
      wt: "/r/forest",
      patch: "@@ -1 +1 @@\n-a\n+b\n",
    }),
    LOCAL,
  );
  assertEquals(res.status, 200);
  assertEquals(sh.calls, [
    "/r/forest $ git apply --cached <<< @@ -1 +1 @@\n-a\n+b\n",
  ]);
});

Deno.test("POST /api/save returns 409 with current when expect mismatches", async () => {
  await withTmp(async (dir) => {
    await Deno.writeTextFile(join(dir, "a.ts"), "on disk");
    const { routes, mutations } = make({
      worktrees: [worktree({ path: dir })],
    });

    const bad = await routes(
      post("/api/save", {
        wt: dir,
        path: "a.ts",
        expect: "stale",
        content: "new",
      }),
      LOCAL,
    );
    assertEquals(bad.status, 409);
    assertEquals(await bad.json(), { current: "on disk" });
    assertEquals(mutations.length, 0);

    const ok = await routes(
      post("/api/save", {
        wt: dir,
        path: "a.ts",
        expect: "on disk",
        content: "new",
      }),
      LOCAL,
    );
    assertEquals(ok.status, 200);
    assertEquals(await Deno.readTextFile(join(dir, "a.ts")), "new");
    assertEquals(mutations.length, 1);
  });
});

Deno.test("POST /api/wt-create rejects a bad slug and an unknown repo", async () => {
  const { routes, sh } = make();
  const unknown = await routes(
    post("/api/wt-create", { repo: "nope", slug: "ok" }),
    LOCAL,
  );
  assertEquals(unknown.status, 400);
  assertStringIncludes(await unknown.text(), "unknown repo");

  for (const slug of ["../evil", "a/../b", "-lead", ""]) {
    const res = await routes(
      post("/api/wt-create", { repo: "forest", slug }),
      LOCAL,
    );
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), "bad branch name");
  }
  assertEquals(sh.calls, []);
});

Deno.test("GET /api/open resolves a path inside a known worktree", async () => {
  await withTmp(async (dir) => {
    await Deno.writeTextFile(join(dir, "a.ts"), "x");
    const { routes } = make({ worktrees: [worktree({ path: dir })] });
    const res = await routes(
      get(`/api/open?path=${encodeURIComponent(join(dir, "a.ts"))}:12`),
      LOCAL,
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      wt: dir,
      rel: "a.ts",
      kind: "file",
      loose: false,
      line: 12,
    });
  });
});

Deno.test("GET /api/open from a foreign Host is 403", async () => {
  const { routes } = make();
  const res = await routes(
    get("/api/open?path=/r/forest", "10.0.0.5:38471"),
    FOREIGN,
  );
  assertEquals(res.status, 403);
  assertStringIncludes(await res.text(), "only opens paths for this machine");
});

Deno.test("GET /api/t/files with an ambiguous wt is 400 with candidates", async () => {
  const { routes } = make({
    worktrees: [
      worktree({ path: "/r/forest-a", branch: "feat-a" }),
      worktree({ path: "/r/forest-b", branch: "feat-b" }),
    ],
  });
  const res = await routes(get("/api/t/files?wt=feat"), LOCAL);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "ambiguous worktree");
  assertEquals(body.candidates.map((w: Worktree) => w.path), [
    "/r/forest-a",
    "/r/forest-b",
  ]);
});

Deno.test("POST /api/new, /api/rename and /api/delete on a loose root from a local request succeed and call afterMutation", async () => {
  await withTmp(async (dir) => {
    const { routes, mutations } = make();
    // the UI registers a loose root by opening it first
    const opened = await routes(
      get(`/api/open?path=${encodeURIComponent(dir)}`),
      LOCAL,
    );
    assertEquals((await opened.json()).loose, true);

    assertEquals(
      (await routes(post("/api/new", { wt: dir, path: "a.ts" }), LOCAL)).status,
      200,
    );
    assertEquals(
      (await routes(
        post("/api/rename", { wt: dir, from: "a.ts", to: "b.ts" }),
        LOCAL,
      )).status,
      200,
    );
    assertEquals(await Deno.readTextFile(join(dir, "b.ts")), "");

    assertEquals(
      (await routes(post("/api/delete", { wt: dir, path: "b.ts" }), LOCAL))
        .status,
      200,
    );
    assert(!await Deno.lstat(join(dir, "b.ts")).catch(() => null));
    assertEquals(mutations.length, 3);
  });
});

Deno.test("POST /api/rename onto an existing path is 400 already exists", async () => {
  await withTmp(async (dir) => {
    await Deno.writeTextFile(join(dir, "a.ts"), "a");
    await Deno.writeTextFile(join(dir, "b.ts"), "b");
    const { routes, mutations } = make({
      worktrees: [worktree({ path: dir })],
    });
    const res = await routes(
      post("/api/rename", { wt: dir, from: "a.ts", to: "b.ts" }),
      LOCAL,
    );
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), "b.ts already exists");
    assertEquals(mutations.length, 0);
  });
});

Deno.test("POST /api/new on a loose root from a LAN address is 400", async () => {
  await withTmp(async (dir) => {
    const { routes, mutations } = make();
    await routes(get(`/api/open?path=${encodeURIComponent(dir)}`), LOCAL);

    const res = await routes(
      post("/api/new", { wt: dir, path: "a.ts" }),
      FOREIGN,
    );
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), "only opens paths for this machine");
    assert(!await Deno.lstat(join(dir, "a.ts")).catch(() => null));
    assertEquals(mutations.length, 0);
  });
});

Deno.test("POST /api/delete on an unknown wt is 400", async () => {
  const { routes, mutations } = make();
  const res = await routes(
    post("/api/delete", { wt: "/r/other", path: "a.ts" }),
    LOCAL,
  );
  assertEquals(res.status, 400);
  assertStringIncludes(await res.text(), "unknown worktree");
  assertEquals(mutations.length, 0);
});

Deno.test("POST /api/agent-resume opens only an indexed session's link, only for this machine", async () => {
  const { routes, sh } = make({
    table: { "open claude://resume?session=known": "" },
  });
  const ok = await routes(
    post("/api/agent-resume", { agent: "claude", id: "known" }),
    LOCAL,
  );
  assertEquals(ok.status, 200);
  assertEquals(sh.calls, [`${HOME} $ open claude://resume?session=known`]);
  const unknown = await routes(
    post("/api/agent-resume", { agent: "claude", id: "x; rm -rf ~" }),
    LOCAL,
  );
  assertEquals(unknown.status, 400);
  const foreign = await routes(
    post("/api/agent-resume", { agent: "claude", id: "known" }),
    FOREIGN,
  );
  assertEquals(foreign.status, 400);
  assertEquals(sh.calls.length, 1);
});

Deno.test("POST /api/agent-terminal runs an indexed session's command in Terminal as an argument", async () => {
  const run =
    `osascript -e on run argv -e tell application "Terminal" to do script (item 1 of argv) -e tell application "Terminal" to activate -e end run cd '/r' && claude --resume known`;
  const { routes, sh } = make({ table: { [run]: "" } });
  const ok = await routes(
    post("/api/agent-terminal", { agent: "claude", id: "known" }),
    LOCAL,
  );
  assertEquals(ok.status, 200);
  assertEquals(sh.calls, [`${HOME} $ ${run}`]);
  const unknown = await routes(
    post("/api/agent-terminal", { agent: "codex", id: "known" }),
    LOCAL,
  );
  assertEquals(unknown.status, 400);
});

Deno.test("an unknown POST is 404", async () => {
  const { routes, mutations } = make();
  const res = await routes(post("/api/bogus", { wt: "/r/forest" }), LOCAL);
  assertEquals(res.status, 404);
  assertEquals(await res.text(), "not found");
  assertEquals(mutations.length, 0);
});

Deno.test("routes: notify POST without wt is not rejected by guardWt", async () => {
  const { routes } = make();
  const read = await routes(post("/api/notify/read", { all: true }), LOCAL);
  assertEquals([read.status, await read.json()], [200, { ok: true }]);
  const snooze = await routes(post("/api/notify/snooze", { key: "k" }), LOCAL);
  assertEquals([snooze.status, await snooze.json()], [200, { ok: true }]);
  const bad = await routes(post("/api/notify/snooze", {}), LOCAL);
  assertEquals(bad.status, 400);
  const badRead = await routes(post("/api/notify/read", {}), LOCAL);
  assertEquals(badRead.status, 400);
});

Deno.test("routes: GET /api/notify returns events newest first as a copy", async () => {
  const { routes, notify } = make();
  const res = await routes(get("/api/notify"), LOCAL);
  assertEquals(await res.json(), []);
  assertEquals(notify.list(), []);
});

Deno.test("GET /mcp with a foreign Host is rejected", async () => {
  const { routes } = make();
  const res = await routes(get("/mcp", "evil.example.com"), FOREIGN);
  assert(res.status >= 400, `expected a rejection, got ${res.status}`);
  await res.body?.cancel();
});

Deno.test("a cross-site POST is 403 and the app's own origin passes", async () => {
  const { routes, sh } = make({ table: { "git add -- a.ts": "" } });
  const from = (origin: string) => {
    const req = post("/api/stage", { wt: "/r/forest", path: "a.ts" });
    req.headers.set("origin", origin);
    return routes(req, LOCAL);
  };
  const evil = await from("https://evil.example");
  assertEquals(evil.status, 403);
  await evil.body?.cancel();
  assertEquals(sh.calls, []);
  const ok = await from("http://forest-app.localhost:38471");
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
});

Deno.test("PUT /api/settings from a rebound Host is 403", async () => {
  const { routes } = make();
  const res = await routes(
    new Request("http://evil.example:38471/api/settings", {
      method: "PUT",
      headers: { host: "evil.example:38471" },
      body: "{}",
    }),
    LOCAL,
  );
  assertEquals(res.status, 403);
  await res.body?.cancel();
});
