import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { FakeTime } from "@std/testing/time";
import { fakeExec, pushable, STATUS_V2 } from "./fixtures.ts";
import { createFiles } from "./files.ts";
import { guardThemeName } from "./themes.ts";
import { MAX_PREVIEW, TREE_CAP } from "./parse.ts";

const G = "git --no-optional-locks";
const BASE = "base123";
const WT = "/r/forest";

type Entry = string | ((cwd: string) => string);

const mk = (
  sh: ReturnType<typeof fakeExec>,
  known: [string, string][] = [[WT, WT]],
) =>
  createFiles({
    sh,
    known: new Map(known),
    // deno-lint-ignore require-await
    mergeBase: async () => BASE,
  });

const make = (
  table: Record<string, Entry> = {},
  known?: [string, string][],
) => {
  const sh = fakeExec(table);
  return { sh, files: mk(sh, known) };
};

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const req = new Request("http://localhost/x", {
  headers: { host: "localhost:38471" },
});
const infoFrom = (hostname: string) =>
  ({
    remoteAddr: { transport: "tcp", hostname, port: 1 },
  }) as Deno.ServeHandlerInfo;

Deno.test("guardPath rejects .., absolute and empty", () => {
  const { files } = make();
  for (const p of ["../x", "a/../b", "/etc/passwd", "", null]) {
    assertThrows(() => files.guardPath(p), Error, "bad path");
  }
  assertEquals(files.guardPath("src/a.ts"), "src/a.ts");
});

Deno.test("guardWt rejects an unknown worktree", () => {
  const { files } = make();
  assertEquals(files.guardWt(WT), WT);
  assertThrows(() => files.guardWt("/r/other"), Error, "unknown worktree");
  assertThrows(() => files.guardWt(null), Error, "(none given)");
});

Deno.test("guardRoot allows a loose root only for a local request", () => {
  const { files } = make();
  files.looseRoots.add("/tmp/loose");
  assert(files.isLoose("/tmp/loose"));
  assert(!files.isLoose(WT));

  assertEquals(
    files.guardRoot("/tmp/loose", req, infoFrom("127.0.0.1")),
    "/tmp/loose",
  );
  assertThrows(
    () => files.guardRoot("/tmp/loose", req, infoFrom("10.0.0.4")),
    Error,
    "Forest only opens paths for this machine",
  );
  // a known worktree never needs the loose check
  assertEquals(files.guardRoot(WT, req, infoFrom("10.0.0.4")), WT);
  assertThrows(
    () => files.guardRoot("/r/other", req, infoFrom("127.0.0.1")),
    Error,
    "unknown worktree",
  );
});

Deno.test("guardThemeName rejects .. and slashes", () => {
  assertEquals(guardThemeName("Solarized Dark (v2)"), "Solarized Dark (v2)");
  for (const n of ["../x", "a/b", "", null, "a..b"]) {
    assertThrows(() => guardThemeName(n), Error, "bad theme name");
  }
});

Deno.test("listFiles merges name-status, numstat, status flags and untracked line counts", async () => {
  await withTmp(async (dir) => {
    await Deno.writeTextFile(join(dir, "notes.md"), "one\ntwo\n");
    const { files } = make({
      [`${G} diff --no-renames --name-status -z ${BASE}`]:
        "M\0src/a.ts\0A\0src/b.ts\0",
      [`${G} diff --no-renames --numstat -z ${BASE}`]:
        "1\t2\tsrc/a.ts\x003\t0\tsrc/b.ts\0",
      [`${G} status --porcelain=v2 -z --untracked-files=all`]: STATUS_V2,
    }, [[dir, dir]]);

    const out = await files.listFiles(dir, "branch");
    assertEquals(out.base, BASE);
    assertEquals(out.files, [
      {
        path: "notes.md",
        status: "U",
        added: 2,
        removed: 0,
        staged: false,
        unstaged: true,
      },
      {
        path: "src/a.ts",
        status: "M",
        added: 1,
        removed: 2,
        staged: true,
        unstaged: false,
      },
      {
        path: "src/b.ts",
        status: "A",
        added: 3,
        removed: 0,
        staged: false,
        unstaged: true,
      },
    ]);

    const q = await files.listFiles(dir, "branch", "b.ts");
    assertEquals(q.files.map((f) => f.path), ["src/b.ts"]);
  });
});

Deno.test("fileContents: binary, large text, UTF-16, and base from git show", async () => {
  await withTmp(async (dir) => {
    await Deno.writeFile(join(dir, "big.bin"), new Uint8Array(MAX_PREVIEW + 1));
    await Deno.writeTextFile(join(dir, "small.txt"), "hi\n");
    const { files } = make({
      [`${G} show ${BASE}:small.txt`]: "old\n",
    }, [[dir, dir]]);

    const big = await files.fileContents(dir, "big.bin", "branch");
    assertEquals(big, { base: null, work: null, skip: "binary · 1.0 MB" });

    await Deno.writeTextFile(join(dir, "big.log"), "x\n".repeat(MAX_PREVIEW));
    const log = await files.fileContents(dir, "big.log", "branch");
    assertEquals(log, {
      base: null,
      work: null,
      large: 2 * MAX_PREVIEW,
      encoding: undefined,
    });

    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0, 0x69, 0]);
    await Deno.writeFile(join(dir, "u16.txt"), utf16);
    assertEquals(await files.fileContents(dir, "u16.txt", "branch"), {
      base: null,
      work: "hi",
      encoding: "utf-16le",
    });

    const small = await files.fileContents(dir, "small.txt", "branch");
    assertEquals(small, { base: "old\n", work: "hi\n" });
  });
});

Deno.test("fileContents on a loose root has no base", async () => {
  await withTmp(async (dir) => {
    await Deno.writeTextFile(join(dir, "a.txt"), "hi\n");
    const { sh, files } = make({}, []);
    files.looseRoots.add(dir);
    assertEquals(await files.fileContents(dir, "a.txt", "branch"), {
      base: null,
      work: "hi\n",
    });
    assertEquals(sh.calls, []);
  });
});

Deno.test("listTree merges ignored files and dirs and excludes dependency dirs", async () => {
  const probe = fakeExec({}, { fallback: "" });
  await mk(probe).listTree(WT);
  const [cached, ignoredArgs] = probe.calls.map((c) => c.split(" $ ")[1]);
  for (const k of [cached, ignoredArgs]) {
    assert(k.includes("-x node_modules"), k);
    assert(k.includes("-x .venv"), k);
  }

  const { files } = make({
    [cached]: "src/a.ts\0src/b.ts\0empty/\0",
    [ignoredArgs]: "dist/\0dist/app.js\0.env\0coverage/\0",
  });
  const t = await files.listTree(WT);
  // dist/ is dropped: its own listed entries cover it
  assertEquals(t.files, ["src/a.ts", "src/b.ts", "dist/app.js", ".env"]);
  assertEquals(t.dirs, ["empty", "coverage"]);
  assertEquals(t.ignored, ["dist/app.js", ".env", "coverage"]);
});

Deno.test("walkTree stops at TREE_CAP and lists dep dirs as ignored", async () => {
  await withTmp(async (dir) => {
    await Deno.mkdir(join(dir, "node_modules"));
    await Deno.mkdir(join(dir, ".git"));
    const deep = join(dir, "deep");
    await Deno.mkdir(deep);
    const empty = new Uint8Array();
    for (let i = 0; i < TREE_CAP + 1; i += 500) {
      await Promise.all(
        Array.from(
          { length: Math.min(500, TREE_CAP + 1 - i) },
          (_, j) => Deno.writeFile(join(deep, `f${i + j}.txt`), empty),
        ),
      );
    }
    const { files } = make({}, []);
    const t = await files.walkTree(dir);
    assertEquals(t.files.length, TREE_CAP);
    assert(t.files.every((f) => f.startsWith("deep/")));
    assertEquals(t.dirs, ["node_modules"]);
    assertEquals(t.ignored, ["node_modules"]);
  });
});

Deno.test("listDir lists one level and hides .git", async () => {
  await withTmp(async (dir) => {
    await Deno.mkdir(join(dir, "src", "sub"), { recursive: true });
    await Deno.mkdir(join(dir, "src", ".git"));
    await Deno.writeTextFile(join(dir, "src", "a.ts"), "");
    const { files } = make({}, []);
    const t = await files.listDir(dir, "src");
    assertEquals(t, { files: ["src/a.ts"], dirs: ["src/sub"], ignored: [] });
  });
});

Deno.test("newEntry creates a file with missing parents and refuses to overwrite", async () => {
  await withTmp(async (dir) => {
    const { files } = make({}, []);
    await files.newEntry(dir, "a/b/c.ts");
    assertEquals(await Deno.readTextFile(join(dir, "a/b/c.ts")), "");
    await Deno.writeTextFile(join(dir, "a/b/c.ts"), "keep");
    await assertRejects(() => files.newEntry(dir, "a/b/c.ts"));
    assertEquals(await Deno.readTextFile(join(dir, "a/b/c.ts")), "keep");
  });
});

Deno.test("newEntry with a trailing slash creates a folder", async () => {
  await withTmp(async (dir) => {
    const { files } = make({}, []);
    await files.newEntry(dir, "a/b/");
    assert((await Deno.stat(join(dir, "a/b"))).isDirectory);
  });
});

Deno.test("rename moves a file into a new folder and refuses an existing target", async () => {
  await withTmp(async (dir) => {
    const { files } = make({}, []);
    await Deno.writeTextFile(join(dir, "a.txt"), "hi");
    await files.rename(dir, "a.txt", "sub/b.txt");
    assertEquals(await Deno.readTextFile(join(dir, "sub/b.txt")), "hi");
    assertEquals(await Deno.stat(join(dir, "a.txt")).catch(() => null), null);

    await Deno.writeTextFile(join(dir, "c.txt"), "c");
    await assertRejects(
      () => files.rename(dir, "c.txt", "sub/b.txt"),
      Error,
      "sub/b.txt already exists",
    );
    // a dangling symlink counts as existing
    await Deno.symlink(join(dir, "nope"), join(dir, "dangling"));
    await assertRejects(
      () => files.rename(dir, "c.txt", "dangling"),
      Error,
      "dangling already exists",
    );
  });
});

Deno.test("remove deletes a folder recursively", async () => {
  await withTmp(async (dir) => {
    const { files } = make({}, []);
    await Deno.mkdir(join(dir, "a/b"), { recursive: true });
    await Deno.writeTextFile(join(dir, "a/b/c.ts"), "x");
    await files.remove(dir, "a");
    assertEquals(await Deno.stat(join(dir, "a")).catch(() => null), null);
  });
});

Deno.test("save returns current on a mismatch and writes on a match", async () => {
  await withTmp(async (dir) => {
    const { files } = make({}, []);
    await Deno.writeTextFile(join(dir, "a.txt"), "disk");
    assertEquals(await files.save(dir, "a.txt", "stale", "new"), {
      current: "disk",
    });
    assertEquals(await Deno.readTextFile(join(dir, "a.txt")), "disk");
    assertEquals(await files.save(dir, "a.txt", "disk", "new"), "ok");
    assertEquals(await Deno.readTextFile(join(dir, "a.txt")), "new");
    // a file that is not there reads as null
    assertEquals(await files.save(dir, "gone.txt", "x", "new"), {
      current: null,
    });
    assertEquals(await files.save(dir, "gone.txt", null, "new"), "ok");
  });
});

Deno.test("save with no expect returns current even for a missing file", async () => {
  await withTmp(async (dir) => {
    const { files } = make({}, []);
    assertEquals(await files.save(dir, "gone.txt", undefined, "new"), {
      current: null,
    });
    assertEquals(
      await Deno.stat(join(dir, "gone.txt")).catch(() => null),
      null,
    );
  });
});

Deno.test("every mutation rejects a path with ..", async () => {
  await withTmp(async (dir) => {
    const { files } = make({}, []);
    const bad = "../escape.txt";
    await assertRejects(() => files.newEntry(dir, bad), Error, "bad path");
    await assertRejects(
      () => files.rename(dir, "a.txt", bad),
      Error,
      "bad path",
    );
    await assertRejects(
      () => files.rename(dir, bad, "b.txt"),
      Error,
      "bad path",
    );
    await assertRejects(() => files.remove(dir, bad), Error, "bad path");
    await assertRejects(
      () => files.save(dir, bad, null, "x"),
      Error,
      "bad path",
    );
  });
});

Deno.test("a temporary root gets its own watcher, debounced and filtered", async () => {
  using time = new FakeTime();
  const stream = pushable<{ paths: string[] }>();
  const emits: [string, string[]][] = [];
  const files = createFiles({
    sh: fakeExec({}),
    known: new Map(),
    // deno-lint-ignore require-await
    mergeBase: async () => BASE,
    watchFs: () => stream,
    onChange: (r, p) => void emits.push([r, p]),
  });
  files.addLoose("/tmp/dl");
  files.addLoose("/tmp/dl");
  assert(files.isLoose("/tmp/dl"));
  stream.push({ paths: ["/tmp/dl/a.txt", "/tmp/dl/node_modules/x.js"] });
  await time.tickAsync(0);
  stream.push({ paths: ["/tmp/dl/sub/b.txt", "/tmp/dl", "/tmp/dlx/c"] });
  await time.tickAsync(0);
  assertEquals(emits, []);
  await time.tickAsync(300);
  assertEquals(emits, [["/tmp/dl", ["a.txt", "sub/b.txt"]]]);
  stream.end();
});

Deno.test("a capped temporary root stops watching", async () => {
  await withTmp(async (dir) => {
    using time = new FakeTime();
    let closed = 0;
    const stream = Object.assign(pushable<{ paths: string[] }>(), {
      close: () => void closed++,
    });
    const emits: string[] = [];
    const files = createFiles({
      sh: fakeExec({}),
      known: new Map(),
      // deno-lint-ignore require-await
      mergeBase: async () => BASE,
      watchFs: () => stream,
      onChange: (r) => void emits.push(r),
    });
    for (let i = 0; i < TREE_CAP; i++) {
      await Deno.writeTextFile(join(dir, `f${i}`), "");
    }
    files.addLoose(dir);
    const t = await files.walkTree(dir);
    assertEquals(t.files.length, TREE_CAP);
    assertEquals(closed, 1);
    stream.push({ paths: [join(dir, "f0")] });
    await time.tickAsync(500);
    assertEquals(emits, []);
    stream.end();
  });
});
