import process from "node:process"; // cpuUsage(): self CPU, see stats above
import { serveDir } from "@std/http/file-server";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { basename, dirname, join, resolve } from "@std/path";
import { mergeInclude, parseThemeText, resolveTheme } from "./src/theme.js";
import {
  backoffOver,
  classifyPath,
  coerceSettings,
  diffSnapshots,
  fillCommand,
  hotBackoff,
  type HotState,
  ownerWorktree,
  parseDiffHunks,
  parseLsofPidPorts,
  parseStatus,
  parseUpstreamTrack,
  parseWorktreeList,
  pool,
  portsByCwd,
  rateWindow,
  remoteWebUrl,
  settingsOverrides,
  statusCounts,
} from "./parse.ts";

const HOME = Deno.env.get("HOME")!;
const DEFAULTS = {
  host: "127.0.0.1",
  port: 7420,
  root: "~/Repos",
  pollMs: 5000,
  prPollMs: 60000, // a repo with an open PR: only that state can still change
  prIdleMs: 300000, // a repo without one: catches PRs opened outside this machine
  watch: true,
  watchDebounceMs: 300,
  watchMaxWaitMs: 2000,
  watchSweepMs: 300000,
  watchHotThreshold: 10,
  watchBackoffMaxMs: 30000,
  watchStormRate: 2000,
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
  recomputeMsMax: 0,
  drainMsMax: 0,
  lagMsMax: 0,
  subprocessPeak: 0, // high-water concurrent children
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
  // the watch path's own cost, so the per-worktree recompute can be measured
  // rather than just counted: pairs with watchRecomputesTotal, and drains are
  // the watch-path analogue of a poll
  recomputeMsTotal: 0,
  drainsTotal: 0,
  drainMsTotal: 0,
  // ---- backoff + storm: the safety valve (step 6) ----
  watchBackoffEntriesTotal: 0, // repos that went hot
  watchBackoffExitsTotal: 0, // ...and later went quiet again
  watchStormEntriesTotal: 0,
  watchStormMsTotal: 0, // time spent degraded to plain polling
  // ---- safety net + divergence (step 5) ----
  // sweepsTotal counts every full sweep, whatever fired it (timer, mutating
  // POST, root rescan). This counts only the timed safety-net ones, so
  // divergences-per-sweep has a denominator that means something.
  watchSafetySweepsTotal: 0,
  divergencesTotal: 0,
  // a divergence check skipped WHOLESALE, which now only happens for a root
  // rescan: a repo may have appeared or vanished, which is not per-repo
  divergenceChecksSkippedTotal: 0,
  // per-repo exclusion instead. A sweep spans seconds, so a repo touched
  // anywhere in that window cannot be judged; the other 120 still are.
  divergenceReposCheckedTotal: 0,
  divergenceReposExcludedTotal: 0,
  divergenceBranchTotal: 0,
  divergenceHeadTotal: 0,
  divergenceAheadTotal: 0,
  divergenceBehindTotal: 0,
  divergenceDirtyTotal: 0,
  divergenceLastActivityTotal: 0,
  divergenceRemoteTotal: 0,
  divergenceWorktreeAddedTotal: 0,
  divergenceWorktreeRemovedTotal: 0,
  divergenceRepoAddedTotal: 0,
  divergenceRepoRemovedTotal: 0,
  snapshotBytes: 0, // last snapshot that changed
  repos: 0,
  worktrees: 0,
  heapBytes: 0,
  load1: 0, // machine-wide: separates "the box was busy" from "we were busy"
};
const MAX_FIELDS = [
  "pollMsMax",
  "gitMsMax",
  "recomputeMsMax",
  "drainMsMax",
  "lagMsMax",
  "subprocessPeak",
] as const;
const bumpMax = (k: typeof MAX_FIELDS[number], v: number) => {
  if (v > stats[k]) stats[k] = v;
};

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
  aheadMain: number | null;
  behindMain: number | null;
  gone: boolean;
  state: "rebase" | "merge" | "cherry-pick" | "detached" | null;
  dirty: number;
  staged: number;
  modified: number;
  untracked: number;
  subject: string;
  author: string;
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
  defaultBranch: string | null;
  worktrees: Worktree[];
};

// repo main path -> refs/remotes/origin/<default>; not serialized
const defaultRefByRepo = new Map<string, string>();

async function mergeBase(wt: string): Promise<string> {
  const ref = defaultRefByRepo.get(knownWorktrees.get(wt) ?? "") ??
    "origin/HEAD";
  return (await tryGit(wt, "merge-base", ref, "HEAD"))?.trim() ?? "HEAD";
}

const STATE_BY_GIT_PATH = [
  "rebase",
  "rebase",
  "merge",
  "cherry-pick",
] as const;

async function loadWorktree(
  repoName: string,
  wt: { path: string; head: string; branch: string },
  isPrimary: boolean,
  primaryBranch: string,
  pushed: Set<string>,
  gone: Set<string>,
  defaultRef: string | null,
): Promise<Worktree> {
  const [statusZ, ab, headLog, upstream, abMain, statePaths] = await Promise
    .all([
      tryGit(
        wt.path,
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
      ),
      tryGit(
        wt.path,
        "rev-list",
        "--left-right",
        "--count",
        "@{upstream}...HEAD",
      ),
      tryGit(wt.path, "log", "-1", "--format=%ct%n%s%n%an"),
      tryGit(
        wt.path,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ),
      defaultRef
        ? tryGit(
          wt.path,
          "rev-list",
          "--left-right",
          "--count",
          `${defaultRef}...HEAD`,
        )
        : Promise.resolve(null),
      tryGit(
        wt.path,
        "rev-parse",
        "--git-path",
        "rebase-merge",
        "--git-path",
        "rebase-apply",
        "--git-path",
        "MERGE_HEAD",
        "--git-path",
        "CHERRY_PICK_HEAD",
      ),
    ]);
  // upstream set to the primary branch means "branched off it", not "pushed as it"
  const tracked = upstream?.trim().split("/").slice(1).join("/") || null;
  const remote = tracked && tracked !== primaryBranch
    ? tracked
    : pushed.has(wt.branch)
    ? wt.branch
    : null;
  const st = parseStatus(statusZ ?? "");
  const { dirty, untracked } = st;
  const counts = statusCounts(st.entries);
  const [behind, ahead] = ab ? ab.trim().split("\t").map(Number) : [null, null];
  const [behindMain, aheadMain] = abMain
    ? abMain.trim().split("\t").map(Number)
    : [null, null];
  const [ct, subject, author] = (headLog ?? "").split("\n");

  let state: Worktree["state"] = wt.branch === "(detached)" ? "detached" : null;
  const lines = (statePaths ?? "").split("\n");
  for (let i = 0; i < STATE_BY_GIT_PATH.length; i++) {
    if (!lines[i]) continue;
    if (await Deno.stat(resolve(wt.path, lines[i])).catch(() => null)) {
      state = STATE_BY_GIT_PATH[i];
      break;
    }
  }

  let lastActivity = Number(ct ?? 0) * 1000;
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
    aheadMain,
    behindMain,
    gone: gone.has(wt.branch),
    state,
    dirty,
    staged: counts.staged,
    modified: counts.modified,
    untracked: counts.untracked,
    subject: subject ?? "",
    author: author ?? "",
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
// Recompute only the named worktrees of one repo, reusing the repo-level data
// every worktree needs: the list (for a fresh head/branch and who is primary)
// and refs/remotes (for `pushed`). That is 2 git calls plus loadWorktree's 5
// each, against computeRepo's 3 + 5 per *every* worktree — on a 29-worktree
// repo, 7 calls instead of 148.
//
// Returns null when the worktree list itself moved, which means a worktree was
// added or removed and every isPrimary/primaryBranch answer may have changed:
// only computeRepo can reconcile that, so the caller falls back to it. The
// cheap path detecting when it is not enough is what keeps this safe.
async function recomputeWorktrees(
  repo: Repo,
  want: Set<string>,
): Promise<Repo | null> {
  const [porcelain, refs, track] = await Promise.all([
    tryGit(repo.path, "worktree", "list", "--porcelain"),
    tryGit(
      repo.path,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/remotes",
    ),
    tryGit(
      repo.path,
      "for-each-ref",
      "--format=%(refname:short) %(upstream:track)",
      "refs/heads",
    ),
  ]);
  if (!porcelain) return null;
  const list = parseWorktreeList(porcelain);
  if (
    list.length !== repo.worktrees.length ||
    list.some((w, i) => w.path !== repo.worktrees[i].path)
  ) {
    return null;
  }
  const pushed = new Set(
    (refs ?? "").split("\n").filter((r) => r.startsWith("origin/")).map((r) =>
      r.slice(7)
    ),
  );
  const gone = parseUpstreamTrack(track ?? "");
  const targets = list.map((w, i) => ({ w, i })).filter(({ w }) =>
    want.has(w.path)
  );
  if (!targets.length) return repo;
  const fresh = await pool(
    WT_JOBS,
    targets,
    ({ w, i }) =>
      loadWorktree(
        repo.name,
        w,
        i === 0,
        list[0].branch,
        pushed,
        gone,
        defaultRefByRepo.get(repo.path) ?? null,
      ),
  );
  const byPath = new Map(fresh.map((w) => [w.path, w]));
  return {
    ...repo,
    worktrees: repo.worktrees.map((w) => byPath.get(w.path) ?? w),
  };
}

async function computeRepo(name: string, path: string): Promise<Repo | null> {
  const [porcelain, originUrl, refs, headRef, track] = await Promise.all([
    tryGit(path, "worktree", "list", "--porcelain"),
    tryGit(path, "remote", "get-url", "origin"),
    tryGit(path, "for-each-ref", "--format=%(refname:short)", "refs/remotes"),
    tryGit(path, "symbolic-ref", "refs/remotes/origin/HEAD"),
    tryGit(
      path,
      "for-each-ref",
      "--format=%(refname:short) %(upstream:track)",
      "refs/heads",
    ),
  ]);
  if (!porcelain) return null;
  const list = parseWorktreeList(porcelain);
  // a linked worktree parked at the root is not a repo: its main repo already
  // lists it, and listing it twice gives the client duplicate keys
  if (list[0].path !== path) return null;
  // ponytail: assumes the remote is "origin"; widen if a second remote ever matters
  const pushed = new Set(
    (refs ?? "").split("\n").filter((r) => r.startsWith("origin/")).map((r) =>
      r.slice(7)
    ),
  );
  const defaultRef = headRef?.trim() || null;
  if (defaultRef) defaultRefByRepo.set(path, defaultRef);
  else defaultRefByRepo.delete(path);
  const gone = parseUpstreamTrack(track ?? "");
  const worktrees = await pool(
    WT_JOBS,
    list,
    (wt, i) =>
      loadWorktree(name, wt, i === 0, list[0].branch, pushed, gone, defaultRef),
  );
  return {
    name,
    path,
    webUrl: originUrl ? remoteWebUrl(originUrl) : null,
    defaultBranch: defaultRef?.replace("refs/remotes/origin/", "") ?? null,
    worktrees,
  };
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

// GLOBAL and timed: one lsof for the whole machine, PID -> cwd -> worktree.
// It cannot be attributed to one repo, so it can never be recomputed per repo;
// it gets its own cadence and is merged into the snapshot by publish().
let portsByCwdCache = new Map<string, number[]>();

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

async function refreshPorts() {
  portsByCwdCache = await timed("portsMs", listeningPorts());
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
const prFor = (prs: Map<string, Pr> | undefined, w: Worktree) =>
  prs?.get(w.branch) ?? (w.remote ? prs?.get(w.remote) : null) ?? null;

// repo path -> earliest next gh call. Only an OPEN pr can change under us, so a
// repo without one is checked on the idle floor: enough to notice a PR opened in
// a browser, cheap enough to leave running all day.
const ghNextAt = new Map<string, number>();
const ghFailed = new Set<string>(); // reported once per repo, not once per call
const PR_PUSH_MS = 10_000;
const GH_RETRY_MS = [600_000, 3_600_000];

async function refreshPrs(repos: Repo[]) {
  const now = Date.now();
  // no origin remote, no PRs -- ever. The rest run on their own clock.
  const due = repos.filter((r) =>
    r.webUrl && now >= (ghNextAt.get(r.path) ?? 0)
  );
  await pool(PR_JOBS, due, async (r) => {
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
    ]).catch((e) => {
      stats.ghFailTotal++;
      const first = !ghFailed.has(r.path);
      if (first) {
        ghFailed.add(r.path);
        console.error(`gh pr list failed in ${r.name}:`, e.message);
      }
      ghNextAt.set(r.path, Date.now() + GH_RETRY_MS[first ? 0 : 1]);
      return null;
    });
    if (out === null) return;
    ghFailed.delete(r.path);
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
    // read off this repo's own worktrees, not the PR list: a teammate's open PR
    // cannot change anything Forest draws.
    const open = r.worktrees.some((w) => prFor(byBranch, w)?.state === "OPEN");
    ghNextAt.set(
      r.path,
      Date.now() + (open ? SETTINGS.prPollMs : SETTINGS.prIdleMs),
    );
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

function send(chunk: Uint8Array) {
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

function broadcast(s: string) {
  send(enc.encode(`data: ${s}\n\n`));
}

// A silent stream is indistinguishable from a dead one: enqueue on a dead
// socket buffers rather than throwing, so the server keeps a zombie client and
// the browser fires no error, never reconnects, and shows stale data until a
// manual refresh. EventSource ignores comment lines.
setInterval(() => send(enc.encode(": ping\n\n")), 20_000);

// Boot progress rides a named event so the snapshot stays a bare array. The
// first sweep publishes each repo as it lands, so the list fills in instead of
// appearing all at once; this says how much is still coming.
let booted = false;
let bootStatus = { phase: "repos", done: 0, total: 0 };
const statusChunk = () =>
  enc.encode(`event: status\ndata: ${JSON.stringify(bootStatus)}\n\n`);

function setStatus(o: Partial<typeof bootStatus>) {
  bootStatus = { ...bootStatus, ...o };
  send(statusChunk());
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
      w.pr = prFor(prsByRepo.get(r.path), w);
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

// ---- divergence: the actual experiment (docs/fs-watch.md) ----
// When the safety-net sweep asked for a check. A timestamp, not a flag,
// because the tick can land while a sweep is already in flight: that sweep
// read its repos before the request existed, so it must not answer it. Only a
// sweep that STARTED at or after the request may.
let checkRequestedAt = 0;
// Repos marked dirty or recomputed since the current sweep started. The whole
// sweep is the window: a repo read early, written mid-sweep and recomputed by
// the watcher before the sweep ends looks quiescent at the final instant yet
// legitimately disagrees. Excluding that repo is what keeps the rest measured.
let touched = new Set<string>();

const DIVERGENCE_STAT = {
  branch: "divergenceBranchTotal",
  head: "divergenceHeadTotal",
  ahead: "divergenceAheadTotal",
  behind: "divergenceBehindTotal",
  dirty: "divergenceDirtyTotal",
  lastActivity: "divergenceLastActivityTotal",
  remote: "divergenceRemoteTotal",
  worktreeAdded: "divergenceWorktreeAddedTotal",
  worktreeRemoved: "divergenceWorktreeRemovedTotal",
  repoAdded: "divergenceRepoAddedTotal",
  repoRemoved: "divergenceRepoRemovedTotal",
} as const;

// A divergence is a measurement, never an error path: this must not be able to
// fail the sweep that called it.
function recordDivergences(truth: Map<string, Repo>) {
  try {
    // The one genuinely global case: an unknown path means a repo may have
    // appeared or vanished, which no per-repo exclusion can describe.
    if (rootDirty || rootRescanning) {
      stats.divergenceChecksSkippedTotal++;
      return;
    }
    // A repo still dirty at check time has not caught up yet, and a repo in
    // backoff is dirty for as long as its interval — deliberately stale, by
    // our own decision. Judging it would report our backoff as a missed event
    // and make the metric cry wolf, so the exclusion is "touched during the
    // window OR still owed a recompute". The cost is that a repo which is
    // never both quiet and clean is never judged; what says how much that
    // costs is divergenceReposExcludedTotal vs divergenceReposCheckedTotal
    // (and watchDirty per line). NOT hotWts: backoff is a subset of dirty,
    // so hotWts can read 0 while repos are being excluded every check.
    // `dirty` holds worktree paths but the comparison is per repo, so map them
    // back before the union: a repo with any worktree still owed a recompute is
    // not judgeable, exactly as when the whole repo was the unit.
    const excluded = touched.union(
      new Set([...dirty].map((wt) => knownWorktrees.get(wt) ?? wt)),
    );
    let checked = 0;
    for (const p of truth.keys()) if (!excluded.has(p)) checked++;
    stats.divergenceReposCheckedTotal += checked;
    stats.divergenceReposExcludedTotal += truth.size - checked;
    for (const d of diffSnapshots(repoByPath, truth, excluded)) {
      stats.divergencesTotal++;
      const k = DIVERGENCE_STAT[d.field as keyof typeof DIVERGENCE_STAT];
      if (k) stats[k]++;
      logLine({ type: "divergence", ...d });
    }
  } catch (e) {
    stats.errorsTotal++;
    console.error(e);
  }
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
    const startedAt = Date.now();
    // repos already dirty at sweep start belong to the window too: the watcher
    // knows about them and simply has not caught up yet
    touched = new Set([...dirty].map((wt) => knownWorktrees.get(wt) ?? wt));
    const t0 = performance.now();
    const dirs = await repoDirs();
    if (!booted) setStatus({ phase: "repos", done: 0, total: dirs.length });
    let done = 0;
    const repos = await pool(
      REPO_JOBS,
      dirs,
      async (d) => {
        const r = await computeRepo(d.name, d.path);
        // Boot only: land each repo as it resolves so the list fills in rather
        // than appearing all at once. knownWorktrees is rebuilt from a partial
        // map here, so an early event may classify as unknown and force one
        // extra root rescan — it self-corrects on the next publish.
        if (!booted) {
          if (r) repoByPath.set(r.path, r);
          setStatus({ done: ++done });
          publish();
        }
        return r;
      },
    );
    const next = new Map<string, Repo>();
    for (const r of repos) if (r) next.set(r.path, r);
    if (checkRequestedAt && startedAt >= checkRequestedAt) {
      checkRequestedAt = 0;
      recordDivergences(next);
    }
    repoByPath.clear();
    for (const [k, v] of next) repoByPath.set(k, v);
    stats.gitMs = Math.round(performance.now() - t0);
    stats.gitMsTotal += stats.gitMs;
    bumpMax("gitMsMax", stats.gitMs);
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
  // PRs are decoration; the repo list is the content. Start the gh fan-out but
  // paint without it — at boot that is ~half the wait, and it is the only stage
  // that depends on the network. The PR tags land on the second publish.
  const prs = refreshPrs(repos);
  await refreshPorts();
  publish();
  if (!booted) setStatus({ phase: "prs" });
  await prs;
  publish();
  if (!booted) {
    booted = true;
    setStatus({ phase: "ready" });
  }
  stats.pollsTotal++;
  stats.pollMs = Math.round(performance.now() - t0);
  stats.pollMsTotal += stats.pollMs;
  bumpMax("pollMsMax", stats.pollMs);
}

// ---- watcher: invalidate, never compute (docs/fs-watch.md) ----

// storm mode is exactly "stop being a watcher": events are dropped and the
// timed loop polls everything on pollMs, which is what Forest did before this
// branch. Degrading to the old behaviour is the whole point of the valve.
const mode = () => SETTINGS.watch && watcherUp && !storm ? "watch" : "poll";
let watcherUp = false;
const dirty = new Set<string>(); // repo paths

// ---- storm mode: defence of last resort (docs/fs-watch.md) ----
// A flood the ignore list did not anticipate. Above watchStormRate we stop
// acting on events, force one full sweep so no repo is left behind, and let
// the timed loop poll everything until the flood is over. Events are still
// classified and counted throughout — entry and exit have to measure the same
// population, or ignorable traffic would pin the watcher off.
let storm = false;
let stormTickAt = 0; // last time watchStormMsTotal was topped up
let stormStartedAt = 0;
let stormQuietSince = 0; // when the rate first dropped under threshold/4
const STORM_WINDOW_MS = 5000;
const stormWindow = rateWindow(STORM_WINDOW_MS, 10);
const eventRate = (now: number) =>
  stormWindow.count(now) / (STORM_WINDOW_MS / 1000);
// counted only while the rate is already elevated (the run-up) and then
// throughout the storm itself, so it always names the live offender rather
// than a lifetime histogram. ponytail: capped at 1000 keys and keyed by parent
// dir — enough to write an ignore rule from.
const offenders = new Map<string, number>();
// the top prefixes are the deliverable: they name the missing ignore rule
function topOffenders() {
  const top = [...offenders].sort((a, b) => b[1] - a[1]).slice(0, 3);
  offenders.clear();
  return top;
}

function enterStorm(rate: number) {
  storm = true;
  stormStartedAt = stormTickAt = Date.now();
  stormQuietSince = 0;
  stats.watchStormEntriesTotal++;
  const top = topOffenders();
  console.error(
    `forest: storm mode, ${Math.round(rate)} events/s; top paths: ` +
      (top.map(([p, n]) => `${p} (${n})`).join(", ") || "none recorded"),
  );
  logLine({
    type: "storm",
    rate: Math.round(rate),
    top: top.map(([prefix, count]) => ({ prefix, count })),
  });
  // every repo is suspect while events are being dropped
  markRoot();
}
let rootDirty = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let firstMarkAt = 0; // when the current dirty batch was first marked
let pending = false; // a drain timer is armed and has not fired yet

// ---- per-repo backoff (docs/fs-watch.md) ----
// One entry per repo that has recomputed recently; `st` is set only while the
// repo is in backoff. Dropped again as soon as both are empty, so the map is
// the hot set, not a registry of every repo.
const hot = new Map<
  string,
  { win: ReturnType<typeof rateWindow>; st?: HotState }
>();

function hotEntry(path: string) {
  let h = hot.get(path);
  if (!h) hot.set(path, h = { win: rateWindow(60_000) });
  return h;
}

// Leaving backoff has to be checked when nothing is happening — that is what
// quiet means — so it rides the timed loop rather than the drain.
function sweepHot() {
  const now = Date.now();
  for (const [path, h] of hot) {
    if (h.st && !dirty.has(path) && backoffOver(h.st, now)) {
      h.st = undefined;
      stats.watchBackoffExitsTotal++;
    }
    if (!h.st && !h.win.count(now)) hot.delete(path); // cold: forget it
  }
}

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

// `dirty` holds worktree paths, not repo paths: one changed file only
// invalidates the worktree it is in.
function markWt(wt: string) {
  if (dirty.has(wt)) stats.watchDebounceCollapsedTotal++;
  dirty.add(wt);
  schedule();
}

// A .git path is repo-wide (shared refs, or a linked worktree's metadata that
// names it but not its path), so every worktree of the repo is marked. That
// costs what the old per-repo invalidation always cost; it is just no longer
// what the common case pays.
function markRepo(repo: string) {
  for (const [wt, r] of knownWorktrees) if (r === repo) markWt(wt);
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
// a root rescan's own sweep can't be checked: it exists because a path
// resolved to no repo, so repoByPath is stale by definition, not by miss
let rootRescanning = false;

async function drain() {
  if (draining) return schedule();
  draining = true;
  const dt0 = performance.now();
  firstMarkAt = 0; // this batch is being consumed; the next mark starts a new one
  try {
    if (rootDirty) {
      // a new directory under ROOT may be a new repo: only a full sweep knows
      rootDirty = false;
      dirty.clear();
      stats.watchRootRescansTotal++;
      // poll() can throw (readDir, gh JSON). Losing the flag here would hide a
      // newly cloned repo until an unrelated event: put it back and retry.
      rootRescanning = true;
      await poll().catch((e) => {
        rootDirty = true;
        stats.errorsTotal++;
        console.error(e);
      }).finally(() => {
        rootRescanning = false;
      });
    } else {
      const now = Date.now();
      const todo = [...dirty];
      dirty.clear();
      // backoff gate: a hot repo is put back in the dirty set instead of being
      // recomputed. It is never dropped — it stays dirty, the trailing
      // schedule() below keeps firing, and it runs when its interval is up.
      const run: string[] = [];
      for (const path of todo) {
        const h = hotEntry(path);
        const d = hotBackoff(
          h.st,
          h.win.count(now),
          now,
          SETTINGS.watchHotThreshold,
          SETTINGS.watchBackoffMaxMs,
        );
        if (!h.st && d.state) stats.watchBackoffEntriesTotal++;
        h.st = d.state; // only sweepHot clears it: exiting needs quiet, not a drain
        if (d.run) run.push(path);
        else dirty.add(path); // deferred, not dropped
      }
      // Group by repo so the two repo-level calls are paid once even when
      // several worktrees of the same repo changed in one batch.
      const byRepo = new Map<string, Set<string>>();
      for (const wt of run) {
        const repo = knownWorktrees.get(wt);
        if (!repo) continue; // vanished between mark and drain
        const set = byRepo.get(repo) ?? new Set<string>();
        set.add(wt);
        byRepo.set(repo, set);
      }
      await pool(REPO_JOBS, [...byRepo], async ([path, wts]) => {
        touched.add(path); // recomputed inside a sweep window: not judgeable
        const known = repoByPath.get(path);
        if (!known) return;
        const rt0 = performance.now();
        const fresh = await (async () => {
          const partial = await recomputeWorktrees(known, wts);
          // null means the worktree list moved: only a full recompute can say
          // what the repo looks like now
          return partial ?? await computeRepo(known.name, path);
        })().catch((e) => {
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
        const rms = performance.now() - rt0;
        stats.recomputeMsTotal += rms;
        bumpMax("recomputeMsMax", rms);
        for (const wt of wts) hotEntry(wt).win.add(Date.now());
      });
      if (run.length) publish();
    }
  } finally {
    draining = false;
    const dms = performance.now() - dt0;
    stats.drainsTotal++;
    stats.drainMsTotal += dms;
    bumpMax("drainMsMax", dms);
    // inside the finally: a throw that skipped this would leave deferred repos
    // dirty with no timer — never recomputed, and never judged either.
    if (dirty.size || rootDirty) schedule();
  }
}

const BUCKET_STAT = {
  ignore: "watchIgnoredTotal",
  refs: "watchRefsTotal",
  index: "watchIndexTotal",
  worktree: "watchWorktreeTotal",
  unknown: "watchUnknownTotal",
} as const;

function onEvent(ev: Deno.FsEvent) {
  if (!SETTINGS.watch || !watcherUp) return; // act like poll
  const now = Date.now();
  for (const path of ev.paths) {
    stats.watchEventsTotal++;
    // knownWorktrees is already "every repo and worktree path -> repo path":
    // a repo's primary worktree path is the repo path.
    const { bucket, repo, wt } = classifyPath(path, ROOT, knownWorktrees);
    stats[BUCKET_STAT[bucket]]++;
    // Classification runs in a storm too, so entry and exit measure the same
    // population: an ignored flood (`npm ci` in node_modules) must not hold us
    // off the watcher. Measured, it is not the expensive part either — the
    // rate window costs about what the string scan does. What bounds the work
    // is dropping the event below, not skipping the classify.
    if (bucket === "ignore") continue;
    const rate = stormWindow.add(now) / (STORM_WINDOW_MS / 1000);
    // during a storm this keeps naming what is holding it open, which is the
    // input to the next ignore rule
    if (storm || rate > SETTINGS.watchStormRate / 4) {
      const dir = dirname(path);
      if (offenders.size < 1000 || offenders.has(dir)) {
        offenders.set(dir, (offenders.get(dir) ?? 0) + 1);
      }
    } else if (offenders.size) offenders.clear();
    if (storm) continue; // counted, never marked: that is what bounds the work
    if (rate > SETTINGS.watchStormRate) return enterStorm(rate);
    // a push writes refs/remotes/<remote>/<branch>, and `gh pr create` opens the
    // PR a beat after it: look shortly after the ref, not on it. A repo gh cannot
    // read is left in its backoff -- pushing to it does not fix the auth.
    if (
      repo && bucket === "refs" && !ghFailed.has(repo) &&
      path.includes("/refs/remotes/")
    ) {
      ghNextAt.set(repo, now + PR_PUSH_MS);
    }
    if (wt) markWt(wt);
    else if (repo) markRepo(repo);
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
      // whatever this sweep finds is the downtime, not a missed event, so it
      // declines any pending check rather than logging the gap as misses
      if (checkRequestedAt) stats.divergenceChecksSkippedTotal++;
      checkRequestedAt = 0;
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
    recomputeMsTotal: Math.round(stats.recomputeMsTotal),
    drainMsTotal: Math.round(stats.drainMsTotal),
    recomputeMsMax: Math.round(stats.recomputeMsMax),
    drainMsMax: Math.round(stats.drainMsMax),
    rss: mem.rss,
    clients: clients.size,
    pollMsSetting: SETTINGS.pollMs,
    mode: mode(),
    watchDebounceMs: SETTINGS.watchDebounceMs,
    watchMaxWaitMs: SETTINGS.watchMaxWaitMs,
    watchSweepMs: SETTINGS.watchSweepMs,
    watchHotThreshold: SETTINGS.watchHotThreshold,
    watchBackoffMaxMs: SETTINGS.watchBackoffMaxMs,
    watchStormRate: SETTINGS.watchStormRate,
    watchDirty: dirty.size,
    // renamed from hotRepos: backoff is keyed per worktree now, so the old name
    hotWts: [...hot.values()].filter((h) => h.st).length, // in backoff now
    watchEventRate: Math.round(eventRate(Date.now())),
    storm,
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

if (SETTINGS.watch) watchLoop();

let lastSafetySweep = Date.now();

(async () => {
  const bootT0 = performance.now();
  await poll().catch((e) => {
    stats.errorsTotal++;
    console.error(e);
  });
  // emitted the moment the UI has something to render, not on the 60s tick,
  // and partitioned so a slow start names its own culprit
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
  while (true) {
    await new Promise((r) => setTimeout(r, SETTINGS.pollMs));
    try {
      sweepHot();
      if (storm) {
        const now = Date.now();
        // a laptop suspend during a storm would otherwise charge the whole
        // sleep to the storm; an implausible delta is a stopped clock, not time
        stats.watchStormMsTotal += Math.min(
          now - stormTickAt,
          4 * SETTINGS.pollMs,
        );
        stormTickAt = now;
        // out once the flood has been under a quarter of the threshold for 30 s
        if (eventRate(now) >= SETTINGS.watchStormRate / 4) stormQuietSince = 0;
        else if (!stormQuietSince) stormQuietSince = now;
        else if (now - stormQuietSince >= 30_000) {
          storm = false;
          const top = topOffenders(); // what was still arriving during it
          console.error(
            "forest: storm over, watching again; top paths: " +
              (top.map(([p, n]) => `${p} (${n})`).join(", ") ||
                "none recorded"),
          );
          logLine({
            type: "stormOver",
            ms: now - stormStartedAt,
            top: top.map(([prefix, count]) => ({ prefix, count })),
          });
          markRoot(); // events were dropped: sweep once before trusting them
        }
      }
      // in watch mode the git sweep is the watcher's job; the timed loop only
      // carries the two sources that are not per-repo events. ponytail: ports
      // and PRs share pollMs rather than earning a setting each.
      if (mode() === "watch") {
        // safety net: FSEvents can coalesce or drop, so ground truth is
        // recomputed on watchSweepMs regardless of what events said. Granularity
        // is pollMs, which is this loop's tick.
        if (Date.now() - lastSafetySweep >= SETTINGS.watchSweepMs) {
          lastSafetySweep = Date.now();
          stats.watchSafetySweepsTotal++;
          checkRequestedAt = Date.now();
          await poll();
        } else {
          await refreshPorts();
          await refreshPrs([...repoByPath.values()]);
          publish();
        }
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

// ---- tools ----

type Tool = {
  desc: string;
  input: Record<string, z.ZodType>;
  run: (a: Record<string, unknown>) => unknown | Promise<unknown>;
};

class ToolError extends Error {
  candidates?: unknown[];
}

const tools: Record<string, Tool> = {
  snapshot: {
    desc: "Every repo forest watches, with its worktrees, status and PRs.",
    input: {},
    run: () =>
      [...repoByPath.values()].sort((a, b) => a.name.localeCompare(b.name)),
  },
  link: {
    desc: "A forest URL that opens a worktree, optionally at a file and line.",
    input: {
      wt: z.string(),
      file: z.string().optional(),
      line: z.coerce.number().int().min(0).optional(),
      base: z.enum(["branch", "head"]).optional(),
    },
    run: (a) => {
      const p = new URLSearchParams({ wt: guardWt(String(a.wt)) });
      for (const k of ["file", "line", "base"]) {
        if (a[k] !== undefined) p.set(k, String(a[k]));
      }
      return { url: `http://localhost:${SETTINGS.port}/?${p}` };
    },
  },
};

const callTool = (name: string, raw: Record<string, unknown>) =>
  tools[name].run(z.object(tools[name].input).parse(raw));

const toolError = (e: unknown) => ({
  error: e instanceof Error ? e.message : String(e),
  ...(e instanceof ToolError && e.candidates
    ? { candidates: e.candidates }
    : {}),
});

const mcp = new McpServer({ name: "forest", version: "0" });
for (const [name, tool] of Object.entries(tools)) {
  mcp.registerTool(
    name,
    { description: tool.desc, inputSchema: tool.input },
    async (args: Record<string, unknown>) => {
      try {
        const out = await callTool(name, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out) }],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: JSON.stringify(toolError(e)),
          }],
        };
      }
    },
  );
}
const mcpTransport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});
await mcp.connect(mcpTransport);

const server = Deno.serve({
  hostname: SETTINGS.host,
  port: SETTINGS.port,
}, async (req) => {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/api/events") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          clients.add(c);
          c.enqueue(enc.encode(`data: ${snapshot}\n\n`));
          // a client that connects after boot must not be left on a spinner
          c.enqueue(statusChunk());
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
    if (url.pathname === "/mcp") return mcpTransport.handleRequest(req);
    if (url.pathname.startsWith("/api/t/")) {
      const name = url.pathname.slice("/api/t/".length);
      if (!(name in tools)) return new Response("not found", { status: 404 });
      try {
        return json(await callTool(name, Object.fromEntries(url.searchParams)));
      } catch (e) {
        return new Response(JSON.stringify(toolError(e)), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
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
