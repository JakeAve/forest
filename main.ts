import process from "node:process"; // cpuUsage(): self CPU, see stats above
import { serveDir } from "@std/http/file-server";
import { basename, dirname, join } from "@std/path";
import { mergeInclude, parseThemeText, resolveTheme } from "./src/theme.js";
import {
  coerceSettings,
  fillCommand,
  ownerWorktree,
  parseDiffHunks,
  parseLsofPidPorts,
  parseStatus,
  parseWorktreeList,
  portsByCwd,
  remoteWebUrl,
  settingsOverrides,
} from "./parse.ts";

const HOME = Deno.env.get("HOME")!;
const DEFAULTS = {
  port: 7420,
  root: "~/Repos",
  pollMs: 5000,
  prPollMs: 60000,
  recentCount: 10,
  agoRefreshMs: 30000,
  toastMs: 7000,
  collapseMargin: 3,
  collapseMinSize: 5,
  launchers: {} as Record<string, string>,
};
const SETTINGS_PATH = join(HOME, ".forest", "settings.json");
const SETTINGS: typeof DEFAULTS = {
  ...DEFAULTS,
  ...(await Deno.readTextFile(SETTINGS_PATH).then(JSON.parse).catch(
    () => ({}),
  )),
};
const ROOT = SETTINGS.root.replace(/^~/, HOME);
const LAYOUT_PATH = join(HOME, ".forest", "layout.json");
const THEMES_DIR = join(HOME, ".forest", "themes");
const VSCODE_EXT_DIRS = [
  ...[".vscode", ".vscode-insiders", ".vscode-oss", ".cursor"].map((d) =>
    join(HOME, d, "extensions")
  ),
  ...[
    "Visual Studio Code",
    "Visual Studio Code - Insiders",
    "VSCodium",
    "Cursor",
  ]
    .map((a) => `/Applications/${a}.app/Contents/Resources/app/extensions`),
];

const readJson = (p: string) =>
  Deno.readTextFile(p).then(parseThemeText).catch(() => null);

async function scanVsCodeThemes(): Promise<{ name: string; path: string }[]> {
  const found = new Map<string, string>();
  for (const root of VSCODE_EXT_DIRS) {
    const dirs = await Array.fromAsync(Deno.readDir(root)).catch(() => []);
    for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(root, d.name);
      const pkg = await readJson(join(dir, "package.json"));
      const themes = pkg?.contributes?.themes;
      if (!Array.isArray(themes)) continue;
      const nls = await readJson(join(dir, "package.nls.json")) ?? {};
      for (const t of themes) {
        const label = String(t.label ?? t.id ?? basename(t.path, ".json"))
          .replace(/^%(.+)%$/, (_, k) => nls[k] ?? k)
          .replace(/[^\w .()+-]/g, " ").trim();
        found.set(label, join(dir, t.path));
      }
    }
  }
  return [...found].map(([name, path]) => ({ name, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadVsCodeTheme(path: string): Promise<unknown> {
  const t = parseThemeText(await Deno.readTextFile(path));
  if (typeof t.include !== "string") return t;
  return mergeInclude(await loadVsCodeTheme(join(dirname(path), t.include)), t);
}
const dec = new TextDecoder();

// ---- observability ----
// Forest's cost is subprocesses, not compute: a poll fans out to hundreds of
// `git` calls, so the numbers that matter are spawn rate, how long children
// live, and whether the loop stays responsive while they do.
//
// *Total fields are cumulative since startedAt — diff any two log lines for a
// rate over that window. *Max fields are per-line: reset after each line is
// written, so each describes only that minute rather than repeating one old
// spike forever. Everything else is a gauge, true only at the instant of the
// line. The schema is append-only: add fields, never redefine one.
const stats = {
  startedAt: Date.now(),
  pollsTotal: 0,
  pollMsTotal: 0, // divide by pollsTotal for a mean over any window
  pollMs: 0,
  // ponytail: cpu*MsTotal is RUSAGE_SELF — this process only. The git and gh
  // children are the bulk of the machine cost and land in subprocessMsTotal as
  // wall time instead. Read the two together; neither alone is "CPU used".
  cpuUserMsTotal: 0,
  cpuSystemMsTotal: 0,
  subprocessesTotal: 0,
  gitTotal: 0,
  ghTotal: 0,
  otherTotal: 0,
  subprocessMsTotal: 0, // summed wall time across the three spawn chokepoints
  subprocessInflight: 0,
  // the three phases of a poll, so a slow one names its own culprit
  gitMs: 0,
  gitMsTotal: 0,
  portsMs: 0,
  portsMsTotal: 0,
  prsMs: 0, // 0 on polls where prPollMs rate-limits the call away
  prsMsTotal: 0,
  // swallowed per-repo failures: a repo can vanish from the snapshot without
  // errorsTotal moving. Never zero — a repo with no upstream fails every poll.
  // Watch the rate, not the value.
  gitFailTotal: 0,
  ghFailTotal: 0,
  errorsTotal: 0,
  broadcastsTotal: 0,
  // event-loop lag: the honest "is it struggling" number. A 250ms timer that
  // fires late means the loop was blocked, whatever the cause.
  lagSamplesTotal: 0,
  lagMsTotal: 0,
  logWritesTotal: 0,
  logFailTotal: 0,
  logRotationsTotal: 0,
  pollMsMax: 0,
  gitMsMax: 0,
  lagMsMax: 0,
  subprocessPeak: 0, // high-water concurrent children
  snapshotBytes: 0, // last snapshot that changed
  repos: 0,
  worktrees: 0,
  heapBytes: 0,
  load1: 0, // machine-wide: separates "the box was busy" from "we were busy"
};
const MAX_FIELDS = [
  "pollMsMax",
  "gitMsMax",
  "lagMsMax",
  "subprocessPeak",
] as const;
const bumpMax = (k: typeof MAX_FIELDS[number], v: number) => {
  if (v > stats[k]) stats[k] = v;
};

// returns a done() that must run on every path, success or throw
const spawned = (bin: string) => {
  stats.subprocessesTotal++;
  if (bin === "git") stats.gitTotal++;
  else if (bin === "gh") stats.ghTotal++;
  else stats.otherTotal++;
  const t0 = performance.now();
  bumpMax("subprocessPeak", ++stats.subprocessInflight);
  return () => {
    stats.subprocessInflight--;
    stats.subprocessMsTotal += performance.now() - t0;
  };
};

async function exec(cwd: string, cmd: string[]): Promise<string> {
  const done = spawned(cmd[0]);
  const out = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output().finally(done);
  if (!out.success) {
    throw new Error(
      dec.decode(out.stderr).trim() || dec.decode(out.stdout).trim(),
    );
  }
  return dec.decode(out.stdout);
}
const git = (cwd: string, ...args: string[]) => exec(cwd, ["git", ...args]);
const tryGit = (cwd: string, ...args: string[]) =>
  git(cwd, ...args).catch(() => {
    stats.gitFailTotal++;
    return null;
  });

async function gitIn(cwd: string, stdin: string, ...args: string[]) {
  const done = spawned("git");
  try {
    const p = new Deno.Command("git", {
      args,
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
    const out = await p.output();
    if (!out.success) throw new Error(dec.decode(out.stderr).trim());
  } finally {
    done();
  }
}

type Worktree = {
  repo: string;
  path: string;
  branch: string;
  head: string;
  ahead: number | null;
  behind: number | null;
  dirty: number;
  lastActivity: number;
  isPrimary: boolean;
  remote: string | null;
  ports: number[];
  pr: Pr | null;
};
type Repo = {
  name: string;
  path: string;
  webUrl: string | null;
  worktrees: Worktree[];
};

async function mergeBase(wt: string): Promise<string> {
  return (await tryGit(wt, "merge-base", "origin/HEAD", "HEAD"))?.trim() ??
    "HEAD";
}

async function loadWorktree(
  repoName: string,
  wt: { path: string; head: string; branch: string },
  isPrimary: boolean,
  primaryBranch: string,
  pushed: Set<string>,
): Promise<Worktree> {
  const [statusZ, ab, headTime, upstream] = await Promise.all([
    tryGit(wt.path, "status", "--porcelain=v2", "-z", "--untracked-files=all"),
    tryGit(
      wt.path,
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ),
    tryGit(wt.path, "log", "-1", "--format=%ct"),
    tryGit(
      wt.path,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ),
  ]);
  // upstream set to the primary branch means "branched off it", not "pushed as it"
  const tracked = upstream?.trim().split("/").slice(1).join("/") || null;
  const remote = tracked && tracked !== primaryBranch
    ? tracked
    : pushed.has(wt.branch)
    ? wt.branch
    : null;
  const { dirty, untracked } = parseStatus(statusZ ?? "");
  const [behind, ahead] = ab ? ab.trim().split("\t").map(Number) : [null, null];

  let lastActivity = Number(headTime?.trim() ?? 0) * 1000;
  const changed = await tryGit(wt.path, "diff", "--name-only", "-z", "HEAD");
  const paths = [...(changed ?? "").split("\0").filter(Boolean), ...untracked];
  for (const p of paths) {
    const st = await Deno.stat(join(wt.path, p)).catch(() => null);
    if (st?.mtime && st.mtime.getTime() > lastActivity) {
      lastActivity = st.mtime.getTime();
    }
  }
  return {
    repo: repoName,
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
    ahead,
    behind,
    dirty,
    lastActivity,
    isPrimary,
    remote,
    ports: [],
    pr: null,
  };
}

async function computeRepos(): Promise<Repo[]> {
  const candidates: { name: string; path: string }[] = [];
  for await (const e of Deno.readDir(ROOT)) {
    if (!e.isDirectory) continue;
    const p = join(ROOT, e.name);
    const hasGit = await Deno.stat(join(p, ".git")).then(() => true).catch(() =>
      false
    );
    if (hasGit) candidates.push({ name: e.name, path: p });
  }
  const repos = await Promise.all(candidates.map(async ({ name, path }) => {
    const [porcelain, originUrl, refs] = await Promise.all([
      tryGit(path, "worktree", "list", "--porcelain"),
      tryGit(path, "remote", "get-url", "origin"),
      tryGit(path, "for-each-ref", "--format=%(refname:short)", "refs/remotes"),
    ]);
    if (!porcelain) return null;
    const list = parseWorktreeList(porcelain);
    // ponytail: assumes the remote is "origin"; widen if a second remote ever matters
    const pushed = new Set(
      (refs ?? "").split("\n").filter((r) => r.startsWith("origin/")).map((r) =>
        r.slice(7)
      ),
    );
    const worktrees = await Promise.all(
      list.map((wt, i) =>
        loadWorktree(name, wt, i === 0, list[0].branch, pushed)
      ),
    );
    return {
      name,
      path,
      webUrl: originUrl ? remoteWebUrl(originUrl) : null,
      worktrees,
    };
  }));
  return repos.filter((r): r is Repo => r !== null).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

// ---- listening dev servers ----

async function lsof(...args: string[]): Promise<string> {
  const done = spawned("lsof");
  const out = await new Deno.Command("lsof", {
    args,
    stdout: "piped",
    stderr: "null",
  })
    .output().catch(() => null).finally(done);
  return out ? dec.decode(out.stdout) : "";
}

async function listeningPorts(): Promise<Map<string, number[]>> {
  const byPid = parseLsofPidPorts(
    await lsof("-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"),
  );
  if (!byPid.size) return new Map();
  return portsByCwd(
    byPid,
    await lsof("-a", "-d", "cwd", "-Fpn", "-p", [...byPid.keys()].join(",")),
  );
}

// ---- open pull requests ----

type Pr = { number: number; url: string; state: string };
const prsByRepo = new Map<string, Map<string, Pr>>();
let prsAt = 0;

async function refreshPrs(repos: Repo[]) {
  if (prsAt && Date.now() - prsAt < SETTINGS.prPollMs) return (stats.prsMs = 0);
  prsAt = Date.now();
  const t0 = performance.now();
  try {
    await Promise.all(repos.map(async (r) => {
      const out = await exec(r.path, [
        "gh",
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        "200",
        "--json",
        "number,url,headRefName,state",
      ]).catch(() => {
        stats.ghFailTotal++;
        return null;
      });
      if (out === null) return;
      const byBranch = new Map<string, Pr>();
      for (const p of JSON.parse(out) as (Pr & { headRefName: string })[]) {
        const cur = byBranch.get(p.headRefName);
        if (!cur || (cur.state !== "OPEN" && p.number > cur.number)) {
          byBranch.set(p.headRefName, {
            number: p.number,
            url: p.url,
            state: p.state,
          });
        }
      }
      prsByRepo.set(r.path, byBranch);
    }));
  } finally {
    stats.prsMs = Math.round(performance.now() - t0);
    stats.prsMsTotal += stats.prsMs;
  }
}

// ---- files & diff ----

const knownWorktrees = new Map<string, string>(); // wt path -> repo main path
const repoPaths = new Map<string, string>();

function guardWt(wt: string | null): string {
  if (!wt || !knownWorktrees.has(wt)) {
    throw new Error(`unknown worktree: ${wt ?? "(none given)"}`);
  }
  return wt;
}

function guardThemeName(n: unknown): string {
  const s = String(n ?? "");
  if (!/^[\w .()+-]+$/.test(s) || s.includes("..")) {
    throw new Error("bad theme name");
  }
  return s;
}
function guardPath(p: string | null): string {
  if (!p || p.includes("..") || p.startsWith("/")) throw new Error("bad path");
  return p;
}

const resolveBase = (wt: string, mode: string) =>
  mode === "head" ? Promise.resolve("HEAD") : mergeBase(wt);

async function listFiles(wt: string, mode: string) {
  const base = await resolveBase(wt, mode);
  const [nameStatus, numstat, statusZ] = await Promise.all([
    tryGit(wt, "diff", "--no-renames", "--name-status", "-z", base),
    tryGit(wt, "diff", "--no-renames", "--numstat", "-z", base),
    tryGit(wt, "status", "--porcelain=v2", "-z", "--untracked-files=all"),
  ]);
  const status = new Map<string, string>();
  const nsToks = (nameStatus ?? "").split("\0").filter(Boolean);
  for (let i = 0; i + 1 < nsToks.length; i += 2) {
    status.set(nsToks[i + 1], nsToks[i][0]);
  }

  const st = parseStatus(statusZ ?? "");
  const xy = new Map(st.entries.map((e) => [e.path, e.xy]));

  const files: {
    path: string;
    status: string;
    added: number;
    removed: number;
    staged: boolean;
    unstaged: boolean;
  }[] = [];
  const flags = (path: string) => {
    const s = xy.get(path) ?? "..";
    return {
      staged: s !== "??" && s[0] !== ".",
      unstaged: s === "??" || s[1] !== ".",
    };
  };
  const numToks = (numstat ?? "").split("\0").filter(Boolean);
  for (const t of numToks) {
    const [added, removed, path] = t.split("\t");
    files.push({
      path,
      status: status.get(path) ?? "M",
      added: Number(added) || 0,
      removed: Number(removed) || 0,
      ...flags(path),
    });
  }
  for (const p of st.untracked) {
    const text = await Deno.readTextFile(join(wt, p)).catch(() => "");
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    files.push({ path: p, status: "U", added: lines, removed: 0, ...flags(p) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { base, files };
}

async function fileContents(wt: string, path: string, mode: string) {
  const base = await resolveBase(wt, mode);
  const [baseText, workText] = await Promise.all([
    tryGit(wt, "show", `${base}:${path}`),
    Deno.readTextFile(join(wt, path)).catch(() => null),
  ]);
  return { base: baseText, work: workText };
}

// ---- SSE ----
// ponytail: polls every worktree every pollMs; scope to expanded repo groups if it ever feels slow

const enc = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController>();
let snapshot = "[]";

function broadcast(s: string) {
  stats.broadcastsTotal++;
  const chunk = enc.encode(`data: ${s}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

// `timed` records one phase of a poll. The three partition it, so a slow poll
// says which stage was slow instead of needing to be reproduced.
async function timed<T>(
  key: "gitMs" | "portsMs",
  p: Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  try {
    return await p;
  } finally {
    stats[key] = Math.round(performance.now() - t0);
    stats[`${key}Total`] += stats[key];
  }
}

async function poll() {
  const t0 = performance.now();
  const [repos, byCwd] = await Promise.all([
    timed("gitMs", computeRepos()),
    timed("portsMs", listeningPorts()),
  ]);
  bumpMax("gitMsMax", stats.gitMs);
  await refreshPrs(repos);
  knownWorktrees.clear();
  repoPaths.clear();
  const wtByPath = new Map<string, Worktree>();
  for (const r of repos) {
    repoPaths.set(r.name, r.path);
    for (const w of r.worktrees) {
      knownWorktrees.set(w.path, r.path);
      wtByPath.set(w.path, w);
      const prs = prsByRepo.get(r.path);
      w.pr = prs?.get(w.branch) ?? (w.remote ? prs?.get(w.remote) : null) ??
        null;
    }
  }
  for (const [cwd, ports] of byCwd) {
    const w = wtByPath.get(ownerWorktree(cwd, [...wtByPath.keys()]) ?? "");
    if (w) w.ports = [...new Set([...w.ports, ...ports])].sort((a, b) => a - b);
  }
  const s = JSON.stringify(repos);
  if (s !== snapshot) {
    snapshot = s;
    stats.snapshotBytes = s.length;
    broadcast(s);
  }
  stats.repos = repos.length;
  stats.worktrees = knownWorktrees.size;
  stats.pollsTotal++;
  stats.pollMs = Math.round(performance.now() - t0);
  stats.pollMsTotal += stats.pollMs;
  bumpMax("pollMsMax", stats.pollMs);
}

const statsLine = () => {
  const cpu = process.cpuUsage(); // cumulative µs since start, self only
  const mem = Deno.memoryUsage();
  stats.cpuUserMsTotal = Math.round(cpu.user / 1000);
  stats.cpuSystemMsTotal = Math.round(cpu.system / 1000);
  stats.heapBytes = mem.heapUsed;
  stats.load1 = Math.round(Deno.loadavg()[0] * 100) / 100;
  return {
    t: new Date().toISOString(),
    uptimeMs: Date.now() - stats.startedAt,
    ...stats,
    // accumulated as a float for precision, emitted rounded: sub-ms children
    // still sum correctly and the log stays readable through jq
    subprocessMsTotal: Math.round(stats.subprocessMsTotal),
    lagMsTotal: Math.round(stats.lagMsTotal),
    lagMsMax: Math.round(stats.lagMsMax),
    rss: mem.rss,
    clients: clients.size,
    pollMsSetting: SETTINGS.pollMs,
  };
};

// One flat line a minute, plus one per notable event; `type` tells them apart.
// Rotation keeps at most one previous generation, so history stays between
// LOG_MAX_LINES and twice it and never grows without bound. A rename is O(1) —
// a true one-in-one-out ring would rewrite the whole file on every append.
const LOG_PATH = join(HOME, ".forest", "forest-log.jsonl");
const LOG_MAX_LINES = 10_000;
let logLines = -1; // unknown until the first write counts what is already there
let logFailed = false;
let logQueue: Promise<void> = Promise.resolve();

function logLine(o: Record<string, unknown>) {
  logQueue = logQueue.then(async () => {
    try {
      await Deno.mkdir(join(HOME, ".forest"), { recursive: true });
      if (logLines < 0) {
        logLines = await Deno.readTextFile(LOG_PATH)
          .then((t) => t.split("\n").length - 1)
          .catch(() => 0);
      }
      if (logLines >= LOG_MAX_LINES) {
        // replaces any previous .1: exactly one generation is kept
        await Deno.rename(LOG_PATH, LOG_PATH + ".1");
        logLines = 0;
        stats.logRotationsTotal++;
      }
      await Deno.writeTextFile(
        LOG_PATH,
        JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n",
        { append: true },
      );
      logLines++;
      stats.logWritesTotal++;
      logFailed = false;
    } catch (e) {
      stats.logFailTotal++;
      // a failure is reported once per streak, not every minute
      if (!logFailed) console.error("forest-log write failed:", e);
      logFailed = true;
    }
  });
}

// A 250ms timer that fires late means the loop was blocked. Machine-independent
// stress signal: it moves when we are starved, whatever else the box is doing.
const LAG_MS = 250;
let lagLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const lag = Math.max(0, now - lagLast - LAG_MS);
  lagLast = now;
  stats.lagSamplesTotal++;
  stats.lagMsTotal += lag;
  bumpMax("lagMsMax", lag);
}, LAG_MS);

setInterval(() => {
  logLine({ type: "stats", ...statsLine() });
  // statsLine() is synchronous and already spread above, so the window closes
  // here: every *Max on the next line describes only the coming minute.
  for (const k of MAX_FIELDS) stats[k] = 0;
  stats.subprocessPeak = stats.subprocessInflight; // children still running
}, 60_000);

(async () => {
  const bootT0 = performance.now();
  while (true) {
    try {
      await poll();
    } catch (e) {
      stats.errorsTotal++;
      console.error(e);
    }
    if (stats.pollsTotal === 1) {
      // emitted the moment the UI has something to render, not on the 60s
      // tick, and partitioned so a slow start names its own culprit
      logLine({
        type: "startup",
        bootMs: Math.round(performance.now() - bootT0),
        gitMs: stats.gitMs,
        portsMs: stats.portsMs,
        prsMs: stats.prsMs,
        repos: stats.repos,
        worktrees: stats.worktrees,
        git: stats.gitTotal,
        gh: stats.ghTotal,
        other: stats.otherTotal,
        snapshotBytes: stats.snapshotBytes,
      });
    }
    await new Promise((r) => setTimeout(r, SETTINGS.pollMs));
  }
})();

// ---- server ----

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const BW = (Deno as unknown as {
  BrowserWindow?: new (opts: Record<string, unknown>) => unknown;
}).BrowserWindow;

const server = Deno.serve({ port: SETTINGS.port }, async (req) => {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/api/stats") return json(statsLine());
    if (url.pathname === "/api/events") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          clients.add(c);
          c.enqueue(enc.encode(`data: ${snapshot}\n\n`));
        },
        cancel() {
          clients.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
    if (url.pathname === "/api/settings") {
      if (req.method === "PUT") {
        Object.assign(SETTINGS, coerceSettings(DEFAULTS, await req.json()));
        await Deno.mkdir(join(HOME, ".forest"), { recursive: true });
        await Deno.writeTextFile(
          SETTINGS_PATH,
          JSON.stringify(settingsOverrides(DEFAULTS, SETTINGS), null, 2) + "\n",
        );
        return json({ ...SETTINGS, desktop: !!BW });
      }
      return json({ ...SETTINGS, desktop: !!BW });
    }
    if (url.pathname === "/api/layout") {
      if (req.method === "PUT") {
        await Deno.mkdir(join(HOME, ".forest"), { recursive: true });
        await Deno.writeTextFile(LAYOUT_PATH, JSON.stringify(await req.json()));
        return json({ ok: true });
      }
      return json(
        await Deno.readTextFile(LAYOUT_PATH).then(JSON.parse).catch(() => ({})),
      );
    }
    if (url.pathname === "/api/themes") {
      const names: string[] = [];
      try {
        for await (const e of Deno.readDir(THEMES_DIR)) {
          if (e.name.endsWith(".json")) names.push(e.name.slice(0, -5));
        }
      } catch {
        // dir not created until first import
      }
      return json(names.sort());
    }
    if (url.pathname === "/api/vscode-themes") {
      return json(await scanVsCodeThemes());
    }
    if (url.pathname === "/api/theme") {
      const name = guardThemeName(url.searchParams.get("name"));
      return new Response(
        await Deno.readTextFile(join(THEMES_DIR, name + ".json")),
      );
    }
    const mode = url.searchParams.get("base") === "head" ? "head" : "branch";
    if (url.pathname === "/api/files") {
      return json(await listFiles(guardWt(url.searchParams.get("wt")), mode));
    }
    if (url.pathname === "/api/file") {
      return json(
        await fileContents(
          guardWt(url.searchParams.get("wt")),
          guardPath(url.searchParams.get("path")),
          mode,
        ),
      );
    }
    if (url.pathname === "/api/hunks") {
      const wt = guardWt(url.searchParams.get("wt"));
      const d = await tryGit(
        wt,
        "diff",
        "--no-renames",
        "--",
        guardPath(url.searchParams.get("path")),
      );
      return json(parseDiffHunks(d ?? ""));
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const b = await req.json();
      const noWt = url.pathname === "/api/wt-create" ||
        url.pathname === "/api/theme-import" ||
        url.pathname === "/api/wt-remove";
      const wt = noWt ? "" : guardWt(b.wt ?? null);
      switch (url.pathname) {
        case "/api/rebase":
          await git(wt, "fetch", "origin");
          try {
            await git(wt, "rebase", "origin/HEAD");
          } catch (e) {
            await tryGit(wt, "rebase", "--abort");
            throw new Error(
              `rebase failed — aborted, use a terminal. ${
                (e as Error).message
              }`,
            );
          }
          break;
        case "/api/wt-remove": {
          const force = b.force ? ["--force"] : [];
          const failed: { path: string; error: string }[] = [];
          for (const p of (b.wts ?? [b.wt]).map(guardWt)) {
            await git(knownWorktrees.get(p)!, "worktree", "remove", ...force, p)
              .catch((e) => failed.push({ path: p, error: e.message }));
          }
          poll().catch(() => {});
          return json({ ok: !failed.length, failed });
        }
        case "/api/wt-create": {
          const repoPath = repoPaths.get(String(b.repo));
          if (!repoPath) throw new Error("unknown repo");
          const slug = String(b.slug ?? "").trim();
          if (!/^[\w][\w/.-]*$/.test(slug) || slug.includes("..")) {
            throw new Error("bad branch name");
          }
          const repo = String(b.repo);
          const tpl = SETTINGS.launchers[repo] ?? SETTINGS.launchers["*"];
          if (tpl) {
            const cmd = fillCommand(tpl.includes("{") ? tpl : tpl + " {slug}", {
              slug,
              repo,
              path: repoPath,
              root: ROOT,
            });
            await exec(repoPath, ["sh", "-c", cmd]);
          } else {
            await git(
              repoPath,
              "worktree",
              "add",
              `${repoPath}-wt/${slug.replace(/\//g, "-")}`,
              "-b",
              slug,
            );
          }
          break;
        }
        case "/api/theme-import": {
          let name = b.name, text = String(b.json);
          if (b.path) {
            const hit = (await scanVsCodeThemes()).find((t) =>
              t.path === b.path
            );
            if (!hit) throw new Error("not an installed VS Code theme");
            const theme = await loadVsCodeTheme(hit.path);
            resolveTheme(theme);
            name = hit.name;
            text = JSON.stringify(theme);
          }
          await Deno.mkdir(THEMES_DIR, { recursive: true });
          await Deno.writeTextFile(
            join(THEMES_DIR, guardThemeName(name) + ".json"),
            text,
          );
          break;
        }
        case "/api/stage":
          await git(wt, "add", "--", guardPath(b.path));
          break;
        case "/api/unstage":
          await git(wt, "restore", "--staged", "--", guardPath(b.path));
          break;
        case "/api/discard":
          if (b.untracked) await Deno.remove(join(wt, guardPath(b.path)));
          else await git(wt, "checkout", "--", guardPath(b.path));
          break;
        case "/api/stage-hunk":
          await gitIn(wt, String(b.patch), "apply", "--cached");
          break;
        case "/api/discard-hunk":
          await gitIn(wt, String(b.patch), "apply", "--reverse");
          break;
        case "/api/save": {
          const p = join(wt, guardPath(b.path));
          const cur = await Deno.readTextFile(p).catch(() => null);
          if (cur !== b.expect) {
            return new Response(JSON.stringify({ current: cur }), {
              status: 409,
              headers: { "content-type": "application/json" },
            });
          }
          await Deno.writeTextFile(p, String(b.content));
          break;
        }
        default:
          return new Response("not found", { status: 404 });
      }
      poll().catch(() => {});
      return json({ ok: true });
    }
    return serveDir(req, {
      fsRoot: join(import.meta.dirname!, "dist"),
      quiet: true,
    });
  } catch (e) {
    return new Response(String(e), { status: 400 });
  }
});

if (BW) {
  new BW({
    url: `http://localhost:${(server.addr as Deno.NetAddr).port}/`,
    title: "forest",
    width: 1440,
    height: 900,
    transparentTitlebar: true,
  });
}

console.log(`forest on http://localhost:${SETTINGS.port}  root=${ROOT}`);
