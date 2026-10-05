import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { boot } from "./boot.ts";
import { DEFAULTS } from "./settings.ts";

const info = {
  remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1 },
} as Deno.ServeHandlerInfo;

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

Deno.test("boot wires the real module graph end to end", async () => {
  const home = await Deno.realPath(await Deno.makeTempDir());
  try {
    const root = join(home, "Repos");
    const demo = join(root, "demo");
    await Deno.mkdir(demo, { recursive: true });
    await git(demo, "init", "-q", "-b", "main");
    await git(demo, "commit", "-q", "--allow-empty", "-m", "init");
    await Deno.writeTextFile(join(demo, "a.txt"), "x\n");
    const app = boot({
      settings: { ...DEFAULTS, root, watch: false },
      home,
      distDir: home,
      notifyOs: false,
    });
    await app.watcher.poll();
    const get = (path: string) =>
      app.routes(new Request(`http://localhost${path}`), info).then((r) =>
        r.json()
      );
    const snap = await get("/api/t/snapshot");
    assertEquals(snap.map((r: { name: string }) => r.name), ["demo"]);
    assertEquals(snap[0].worktrees[0].branch, "main");
    assertEquals(snap[0].worktrees[0].untracked, 1);
    assertEquals(await get("/api/notify"), []);
    const stats = await get("/api/stats");
    assertEquals([stats.repos, stats.worktrees, stats.mode], [1, 1, "poll"]);
    const files = await get(`/api/files?wt=${demo}`);
    assertEquals(files.files.map((f: { path: string }) => f.path), ["a.txt"]);

    await app.cache.flush();
    const again = boot({
      settings: { ...DEFAULTS, root, watch: false },
      home,
      distDir: home,
      notifyOs: false,
    });
    await again.cache.load();
    const cached = await again.routes(
      new Request("http://localhost/api/t/snapshot"),
      info,
    ).then((r) => r.json());
    assertEquals(cached[0].worktrees[0].untracked, 1);
    await again.cache.flush();
    const other = boot({
      settings: { ...DEFAULTS, root: join(home, "Elsewhere"), watch: false },
      home,
      distDir: home,
      notifyOs: false,
    });
    await other.cache.load();
    assertEquals(
      await other.routes(
        new Request("http://localhost/api/t/snapshot"),
        info,
      ).then((r) => r.json()),
      [],
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
