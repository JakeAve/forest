import { serveDir } from "@std/http/file-server";
import { basename, dirname, join } from "@std/path";
import { mergeInclude, parseThemeText, resolveTheme } from "./src/theme.js";
import {
  classifyPath,
  coerceSettings,
  fillCommand,
  ownerWorktree,
  parseDiffHunks,
  parseLsofPidPorts,
  parseStatus,
  parseWorktreeList,
  pool,
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
  watch: true,
  watchDebounceMs: 300,
  watchMaxWaitMs: 2000,
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

// ---- baseline metrics (experiment; see docs/fs-watch.md) ----
// Cumulative since start. Diff two log lines to get a rate.
// *Total fields are cumulative since startedAt — diff two lines for a rate.
// Everything else is a gauge, true only at the instant the line was written.
const stats = {
  startedAt: Date.now(),
  sweepsTotal: 0,
  sweepMsTotal: 0, // divide by sweepsTotal for mean duration over any window
  subprocessesTotal: 0,
  gitTotal: 0,
  ghTotal: 0,
  otherTotal: 0,
  broadcastsTotal: 0,
  errorsTotal: 0,
  // swallowed per-repo failures; a repo can vanish from the snapshot without
  // errorsTotal moving. Never zero: repos with no origin/HEAD or no upstream
  // fail two calls every sweep. Watch the rate, not the value.
  gitFailTotal: 0,
  ghFailTotal: 0,
  logWritesTotal: 0,
  logFailTotal: 0,
  // ---- watcher (step 4) ----
  watchEventsTotal: 0, // one per event *path*, not per FsEvent
  watchIgnoredTotal: 0,
  watchRefsTotal: 0,
  watchIndexTotal: 0,
  watchWorktreeTotal: 0,
  watchUnknownTotal: 0,
  watchRecomputesTotal: 0, // single repos recomputed from an event
  watchRootRescansTotal: 0, // full sweeps forced by an unknown path
  watchDebounceCollapsedTotal: 0, // marks that landed on an already-dirty repo
  watchRootCollapsedTotal: 0, // root rescans that landed on an already-dirty root
  watcherRestartsTotal: 0,
  gitSweepMs: 0, // last git-only sweep; sweepMs also covers ports/PRs/publish
  gitSweepMsTotal: 0,
  sweepMs: 0, // last sweep
  snapshotBytes: 0, // last snapshot that changed
  repos: 0,
  worktrees: 0,
};
const spawned = (bin: string) => {
  stats.subprocessesTotal++;
  if (bin === "git") stats.gitTotal++;
  else if (bin === "gh") stats.ghTotal++;
  else stats.otherTotal++;
};

async function exec(cwd: string, cmd: string[]): Promise<string> {
  spawned(cmd[0]);
  const out = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      dec.decode(out.stderr).trim() || dec.decode(out.stdout).trim(),
    );
  }
  return dec.decode(out.stdout);
}
const git = (cwd: string, ...args: string[]) => exec(cwd, ["git", ...args]);
// read-only calls only: the flag keeps polling from rewriting .git/index
const tryGit = (cwd: string, ...args: string[]) =>
  git(cwd, "--no-optional-locks", ...args).catch(() => {
    stats.gitFailTotal++;
    return null;
  });

// ponytail: fixed ceilings, not adaptive — ~128 `git` and 8 `gh` per sweep;
// concurrent polls stack on top, so this is a per-sweep bound, not a system one.
const REPO_JOBS = 8; // repos swept at once
const WT_JOBS = 4; // worktrees per repo at once
const PR_JOBS = 8; // `gh`: own knob, 7x `git`'s RSS per process

async function gitIn(cwd: string, stdin: string, ...args: string[]) {
  spawned("git");
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

async function repoDirs(): Promise<{ name: string; path: string }[]> {
  const candidates: { name: string; path: string }[] = [];
  for await (const e of Deno.readDir(ROOT)) {
    if (!e.isDirectory) continue;
    const p = join(ROOT, e.name);
    const hasGit = await Deno.stat(join(p, ".git")).then(() => true).catch(() =>
      false
    );
    if (hasGit) candidates.push({ name: e.name, path: p });
  }
  return candidates;
}

// the unit the watcher invalidates: everything the snapshot knows about one repo
async function computeRepo(name: string, path: string): Promise<Repo | null> {
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
  const worktrees = await pool(
    WT_JOBS,
    list,
    (wt, i) => loadWorktree(name, wt, i === 0, list[0].branch, pushed),
  );
  return {
    name,
    path,
    webUrl: originUrl ? remoteWebUrl(originUrl) : null,
    worktrees,
  };
}

// ---- listening dev servers ----

async function lsof(...args: string[]): Promise<string> {
  spawned("lsof");
  const out = await new Deno.Command("lsof", {
    args,
    stdout: "piped",
    stderr: "null",
  })
    .output().catch(() => null);
  return out ? dec.decode(out.stdout) : "";
}

// GLOBAL and timed: one lsof for the whole machine, PID -> cwd -> worktree.
// It cannot be attributed to one repo, so it can never be recomputed per repo;
// it gets its own cadence and is merged into the snapshot by publish().
let portsByCwdCache = new Map<string, number[]>();

async function refreshPorts() {
  portsByCwdCache = await listeningPorts();
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
  if (prsAt && Date.now() - prsAt < SETTINGS.prPollMs) return;
  prsAt = Date.now();
  await pool(PR_JOBS, repos, async (r) => {
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
  });
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
  const chunk = enc.encode(`data: ${s}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

// ---- snapshot assembly ----
// The snapshot has three sources on three cadences (docs/fs-watch.md): git data
// per repo (event-driven), ports globally (timed), PRs per repo (timed). This
// map is the source of truth; the snapshot is derived from it, so a partial
// recompute only has to replace one entry.
const repoByPath = new Map<string, Repo>();

// Rebuilds knownWorktrees/repoPaths from the whole map every time, so a partial
// recompute can never drop a still-live worktree from the guardWt allowlist.
// Synchronous throughout: no request can observe the map half-rebuilt.
function publish() {
  const repos = [...repoByPath.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
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
      w.ports = []; // recomputed from scratch: publish() runs on live objects
    }
  }
  const wtPaths = [...wtByPath.keys()];
  for (const [cwd, ports] of portsByCwdCache) {
    const w = wtByPath.get(ownerWorktree(cwd, wtPaths) ?? "");
    if (w) w.ports = [...new Set([...w.ports, ...ports])].sort((a, b) => a - b);
  }
  const s = JSON.stringify(repos);
  if (s !== snapshot) {
    snapshot = s;
    stats.broadcastsTotal++;
    stats.snapshotBytes = s.length;
    broadcast(s);
  }
  stats.repos = repos.length;
  stats.worktrees = knownWorktrees.size;
}

// Re-entrancy guard #1: global, because a sweep touches every repo — two at
// once are pure duplicate work. But a caller arriving mid-sweep may have just
// mutated a worktree this sweep already read, so it must NOT join: it gets a
// sweep that starts after the current one ends. At most one is queued.
let sweeping: Promise<void> | null = null;
let queuedSweep: Promise<void> | null = null;

function sweepAll(): Promise<void> {
  if (sweeping) {
    return queuedSweep ??= sweeping.catch(() => {}).then(() => {
      queuedSweep = null;
      return sweepAll();
    });
  }
  sweeping = (async () => {
    const t0 = performance.now();
    const dirs = await repoDirs();
    const repos = await pool(
      REPO_JOBS,
      dirs,
      (d) => computeRepo(d.name, d.path),
    );
    repoByPath.clear();
    for (const r of repos) if (r) repoByPath.set(r.path, r);
    stats.gitSweepMs = Math.round(performance.now() - t0);
    stats.gitSweepMsTotal += stats.gitSweepMs;
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

// everything, the old way. The timed loop when watch is off, and the startup
// sweep either way. sweepMs spans the whole cycle — same meaning it had in
// step 3, so the poll-vs-watch baseline stays comparable.
async function poll() {
  const t0 = performance.now();
  await sweepAll();
  const repos = [...repoByPath.values()];
  await Promise.all([refreshPorts(), refreshPrs(repos)]);
  publish();
  stats.sweepsTotal++;
  stats.sweepMs = Math.round(performance.now() - t0);
  stats.sweepMsTotal += stats.sweepMs;
}

// ---- watcher: invalidate, never compute (docs/fs-watch.md) ----

const mode = () => SETTINGS.watch && watcherUp ? "watch" : "poll";
let watcherUp = false;
const dirty = new Set<string>(); // repo paths
let rootDirty = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let firstMarkAt = 0; // when the current dirty batch was first marked
let pending = false; // a drain timer is armed and has not fired yet

// ponytail: one global debounce timer, not one per repo — a repo that never
// goes quiet delays every other dirty repo with it. Per-repo timers if that
// shows up; step 6's backoff is the real answer.
function schedule() {
  if (!firstMarkAt) firstMarkAt = Date.now();
  // max wait: past the ceiling, stop deferring and let the armed timer fire.
  // A pure trailing debounce never drains at all under a steady event stream.
  if (pending && Date.now() - firstMarkAt >= SETTINGS.watchMaxWaitMs) return;
  clearTimeout(debounceTimer);
  pending = true;
  debounceTimer = setTimeout(() => {
    pending = false;
    drain().catch((e) => {
      stats.errorsTotal++;
      console.error(e);
    });
  }, SETTINGS.watchDebounceMs);
}

function markRepo(repo: string) {
  if (dirty.has(repo)) stats.watchDebounceCollapsedTotal++;
  dirty.add(repo);
  schedule();
}

function markRoot() {
  if (rootDirty) stats.watchRootCollapsedTotal++;
  rootDirty = true;
  schedule();
}

// Re-entrancy guard #2: global, because drain is the single consumer of the
// single dirty set. It already fans out across repos through `pool`, so a
// per-repo lock would only add bookkeeping — and a repo re-dirtied during its
// own recompute is not lost, it stays in the set and the trailing schedule()
// picks it up.
let draining = false;

async function drain() {
  if (draining) return schedule();
  draining = true;
  firstMarkAt = 0; // this batch is being consumed; the next mark starts a new one
  try {
    if (rootDirty) {
      // a new directory under ROOT may be a new repo: only a full sweep knows
      rootDirty = false;
      dirty.clear();
      stats.watchRootRescansTotal++;
      // poll() can throw (readDir, gh JSON). Losing the flag here would hide a
      // newly cloned repo until an unrelated event: put it back and retry.
      await poll().catch((e) => {
        rootDirty = true;
        stats.errorsTotal++;
        console.error(e);
      });
    } else {
      const todo = [...dirty];
      dirty.clear();
      await pool(REPO_JOBS, todo, async (path) => {
        const known = repoByPath.get(path);
        if (!known) return;
        const fresh = await computeRepo(known.name, path).catch((e) => {
          stats.errorsTotal++;
          console.error(e);
          return known;
        });
        // computeRepo returns null for a transient git failure too, so only a
        // vanished .git is proof the repo is gone; otherwise keep what we had
        if (fresh) repoByPath.set(path, fresh);
        else if (!await Deno.stat(join(path, ".git")).catch(() => null)) {
          repoByPath.delete(path);
        }
        stats.watchRecomputesTotal++;
      });
      if (todo.length) publish();
    }
  } finally {
    draining = false;
  }
  if (dirty.size || rootDirty) schedule();
}

const BUCKET_STAT = {
  ignore: "watchIgnoredTotal",
  refs: "watchRefsTotal",
  index: "watchIndexTotal",
  worktree: "watchWorktreeTotal",
  unknown: "watchUnknownTotal",
} as const;

function onEvent(ev: Deno.FsEvent) {
  if (mode() !== "watch") return; // watch flipped off at runtime: act like poll
  for (const path of ev.paths) {
    stats.watchEventsTotal++;
    // knownWorktrees is already "every repo and worktree path -> repo path":
    // a repo's primary worktree path is the repo path.
    const { bucket, repo } = classifyPath(path, ROOT, knownWorktrees);
    stats[BUCKET_STAT[bucket]]++;
    if (bucket === "ignore") continue;
    if (repo) markRepo(repo);
    else markRoot();
  }
}

async function watchLoop() {
  let backoff = 1000;
  let first = true;
  while (true) {
    let w: Deno.FsWatcher;
    try {
      w = Deno.watchFs(ROOT, { recursive: true });
    } catch (e) {
      // non-local filesystem, permissions: log once, keep today's polling
      if (first) {
        console.error("forest: watchFs unavailable, polling instead:", e);
        return;
      }
      // a failed re-open retries the OPEN; looping onto the dead stream would
      // spin restarts forever
      console.error("forest: watcher re-open failed:", e);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    watcherUp = true;
    if (!first) {
      backoff = 1000;
      poll().catch(() => stats.errorsTotal++); // events missed while down
    }
    first = false;
    try {
      for await (const ev of w) onEvent(ev);
      console.error("forest: watcher stream ended");
    } catch (e) {
      console.error("forest: watcher failed:", e);
    }
    watcherUp = false;
    stats.watcherRestartsTotal++;
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

const statsLine = () => ({
  t: new Date().toISOString(),
  uptimeMs: Date.now() - stats.startedAt,
  ...stats,
  rss: Deno.memoryUsage().rss,
  clients: clients.size,
  pollMs: SETTINGS.pollMs,
  mode: mode(),
  watchDebounceMs: SETTINGS.watchDebounceMs,
  watchMaxWaitMs: SETTINGS.watchMaxWaitMs,
  watchDirty: dirty.size,
});

// one flat line a minute; failures are logged once and never reach the poll loop
const LOG_PATH = join(HOME, ".forest", "watch-log.jsonl");
let logFailed = false;
setInterval(async () => {
  try {
    await Deno.mkdir(join(HOME, ".forest"), { recursive: true });
    await Deno.writeTextFile(LOG_PATH, JSON.stringify(statsLine()) + "\n", {
      append: true,
    });
    stats.logWritesTotal++;
    logFailed = false;
  } catch (e) {
    stats.logFailTotal++;
    if (!logFailed) console.error("watch-log write failed:", e);
    logFailed = true;
  }
}, 60_000);

if (SETTINGS.watch) watchLoop();

(async () => {
  await poll().catch((e) => {
    stats.errorsTotal++;
    console.error(e);
  });
  while (true) {
    await new Promise((r) => setTimeout(r, SETTINGS.pollMs));
    try {
      // in watch mode the git sweep is the watcher's job; the timed loop only
      // carries the two sources that are not per-repo events. ponytail: ports
      // and PRs share pollMs rather than earning a setting each.
      if (mode() === "watch") {
        await refreshPorts();
        await refreshPrs([...repoByPath.values()]);
        publish();
      } else await poll();
    } catch (e) {
      stats.errorsTotal++;
      console.error(e);
    }
  }
})();

// ---- server ----

// a mutation can add or remove a worktree, so it needs the full sweep; in
// watch mode it is debounced with everything else instead of firing at once.
const afterMutation = () =>
  mode() === "watch" ? markRoot() : void poll().catch(() => {});

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
    if (url.pathname === "/api/stats") return json(statsLine());
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
            await git(wt, "rebase", "--abort").catch(() => {});
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
          afterMutation();
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
      afterMutation();
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
