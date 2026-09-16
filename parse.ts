import { z } from "zod";
import { matchWt } from "./src/filter.js";

export function parseWorktreeList(porcelain: string) {
  const wts: { path: string; head: string; branch: string }[] = [];
  for (const block of porcelain.trim().split("\n\n")) {
    let path = "", head = "", branch = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) head = line.slice(5);
      else if (line.startsWith("branch ")) {
        branch = line.slice(7).replace("refs/heads/", "");
      } else if (line === "detached") branch = "(detached)";
    }
    if (path) wts.push({ path, head, branch });
  }
  return wts;
}

// status --porcelain=v2 -z: entries are NUL-separated; a "2 " (rename) entry
// consumes one extra NUL field (the original path)
export function parseStatus(z: string) {
  const toks = z.split("\0").filter(Boolean);
  const raw: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    raw.push(toks[i]);
    if (toks[i].startsWith("2 ")) i++;
  }
  const entries = raw.map((e) => {
    if (e.startsWith("? ")) return { xy: "??", path: e.slice(2) };
    const t = e.split(" ");
    return { xy: t[1], path: t.slice(e.startsWith("2 ") ? 9 : 8).join(" ") };
  });
  const untracked = entries.filter((e) => e.xy === "??").map((e) => e.path);
  return { dirty: entries.length, untracked, entries };
}

// split `git diff` output into per-hunk patches that `git apply` accepts
export function parseDiffHunks(diff: string) {
  const lines = diff.split("\n");
  const at = lines.findIndex((l) => l.startsWith("@@"));
  if (at < 0) return [];
  const fileHeader = lines.slice(0, at).join("\n");
  const hunks: { header: string; startB: number; patch: string }[] = [];
  let cur: string[] | null = null;
  const flush = () => {
    if (!cur) return;
    const header = cur[0];
    const startB = Number(header.match(/\+(\d+)/)?.[1] ?? 1);
    hunks.push({
      header,
      startB,
      patch: fileHeader + "\n" + cur.join("\n") + "\n",
    });
  };
  for (const l of lines.slice(at)) {
    if (l.startsWith("@@")) {
      flush();
      cur = [l];
    } else if (cur && l !== "") cur.push(l);
  }
  flush();
  return hunks;
}

function fieldLines(
  s: string,
  onPid: (pid: string) => void,
  onName: (n: string) => void,
  onCmd?: (c: string) => void,
) {
  for (const line of s.split("\n")) {
    if (line[0] === "p") onPid(line.slice(1));
    else if (line[0] === "n") onName(line.slice(1));
    else if (line[0] === "c") onCmd?.(line.slice(1));
  }
}

export function parseLsofPidPorts(net: string): Map<string, number[]> {
  const byPid = new Map<string, number[]>();
  let pid = "";
  fieldLines(net, (p) => (pid = p), (n) => {
    const port = Number(n.slice(n.lastIndexOf(":") + 1));
    if (port) byPid.set(pid, [...(byPid.get(pid) ?? []), port]);
  });
  return byPid;
}

export function parseLsofCommands(net: string): Map<string, string> {
  const cmds = new Map<string, string>();
  let pid = "";
  fieldLines(net, (p) => (pid = p), () => {}, (c) => cmds.set(pid, c));
  return cmds;
}

export function procsByCwd(
  byPid: Map<string, number[]>,
  cmds: Map<string, string>,
  cwds: string,
): Map<string, { port: number; pid: number; command: string }[]> {
  const byCwd = new Map<
    string,
    { port: number; pid: number; command: string }[]
  >();
  let pid = "";
  fieldLines(cwds, (p) => (pid = p), (cwd) => {
    const ports = byPid.get(pid);
    if (ports) {
      const entries = [...new Set(ports)].map((port) => ({
        port,
        pid: Number(pid),
        command: cmds.get(pid) ?? "",
      }));
      byCwd.set(
        cwd,
        [...(byCwd.get(cwd) ?? []), ...entries].sort((a, b) => a.port - b.port),
      );
    }
  });
  return byCwd;
}

export function ownerWorktree(
  cwd: string,
  paths: string[],
): string | undefined {
  return paths
    .filter((p) => cwd === p || cwd.startsWith(p + "/"))
    .sort((a, b) => b.length - a.length)[0];
}

// A zero threshold is worse than the default: watchStormRate 0 makes the first
// event a storm and the exit condition unreachable (the watcher never comes
// back), watchHotThreshold 0 puts every repo in permanent backoff. *Ms keys
// have their own floor below.
const MIN_SETTING: Record<string, number> = {
  watchStormRate: 1,
  watchHotThreshold: 1,
};

export function coerceSettings(
  defaults: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(defaults)) {
    if (!(k in body)) continue;
    const v = body[k];
    if (typeof d === "number") {
      const n = Math.floor(Number(v));
      if (Number.isFinite(n)) {
        out[k] = Math.max(k.endsWith("Ms") ? 250 : MIN_SETTING[k] ?? 0, n);
      }
    } else if (typeof d === "string") {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    } else if (typeof d === "boolean") {
      if (typeof v === "boolean") out[k] = v;
    } else if (v && typeof v === "object") {
      out[k] = Object.fromEntries(
        Object.entries(v).filter(([, s]) => typeof s === "string" && s.trim())
          .map(([n, s]) => [n, (s as string).trim()]),
      );
    }
  }
  return out;
}

export function fillCommand(
  tpl: string,
  vars: Record<string, string>,
): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
}

export function settingsOverrides(
  defaults: Record<string, unknown>,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings).filter(([k, v]) =>
      JSON.stringify(v) !== JSON.stringify(defaults[k])
    ),
  );
}

export function removeSummary(total: number, failed: string[]): string {
  const ok = total - failed.length;
  const n = (c: number) => `${c} worktree${c === 1 ? "" : "s"}`;
  if (!failed.length) return `removed ${n(ok)}`;
  return `${ok ? `removed ${n(ok)} · ` : ""}couldn't remove ${
    n(failed.length)
  }: ${failed.join(", ")}`;
}

export function clampMenu(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  pad = 4,
) {
  const fit = (p: number, size: number, limit: number) =>
    Math.max(
      pad,
      p + size + pad <= limit ? p : Math.min(p - size, limit - size - pad),
    );
  return { x: fit(x, w, vw), y: fit(y, h, vh) };
}

export function discardPrompt(path: string, untracked: boolean): string {
  return untracked
    ? `delete ${path}? it is untracked, so git cannot bring it back`
    : `discard changes to ${path}?`;
}

export function remoteWebUrl(url: string): string | null {
  const u = url.trim().replace(/\.git$/, "");
  const m = u.match(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+)$/);
  return m && m[2].includes("/") ? `https://${m[1]}/${m[2]}` : null;
}

export function trimSeps<T>(items: (T | "-")[]): (T | "-")[] {
  const out = items.filter((it, i, a) =>
    it !== "-" || (i > 0 && a[i - 1] !== "-")
  );
  if (out[0] === "-") out.shift();
  if (out.at(-1) === "-") out.pop();
  return out;
}

/** Promise.all with at most `limit` in flight. Same order, same rejection. */
export async function pool<T, R>(
  limit: number,
  items: T[],
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

// ---- fs-watch classifier (see docs/fs-watch.md) ----

// gitignored everywhere here, so they can never change a value Forest shows.
// This list is the primary flood defense; it is a string scan, no syscall.
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "__pycache__",
  ".direnv",
  ".cache",
]);
const IGNORE_FILE = /^(\.DS_Store|\.#.*|.*~|.*\.swp)$/;

export type WatchBucket = "ignore" | "refs" | "index" | "worktree" | "unknown";

/**
 * Bucket one fs event path. Pure string work, no syscalls — every event pays
 * for this, so nothing here may touch the disk.
 *
 * `owners` maps every known repo *and* worktree path to its repo path (a
 * repo's primary worktree path is the repo path, so `knownWorktrees` is
 * exactly this map). Longest matching prefix wins, so a nested repo beats the
 * repo it sits inside.
 *
 * Returns the owning worktree as well as its repo: one changed file only
 * invalidates that worktree, and a repo with 29 of them costs 148 git calls to
 * recompute whole against 7 for one worktree.
 *
 * A directory event — FSEvents coalesces bursts into the parent dir — is just
 * a path under a repo, so it dirties that repo like anything else. There is no
 * "no file matched" outcome.
 *
 * ponytail: re-sorts `owners` per event (O(n log n), n≈250). Hoist a sorted
 * array if the event rate ever makes that show up.
 */
export function classifyPath(
  path: string,
  rootArg: string,
  owners: Map<string, string>,
): { bucket: WatchBucket; repo: string | null; wt: string | null } {
  // a trailing slash on the `root` setting would otherwise make every
  // startsWith below fail, silently classifying every event as ignore
  const root = rootArg.replace(/(?!^)\/+$/, "");
  const ignore = { bucket: "ignore", repo: null, wt: null } as const;
  // a new dir directly under ROOT may be a new repo; ROOT itself means rescan
  if (path === root) return { bucket: "unknown", repo: null, wt: null };
  if (!path.startsWith(root + "/")) return ignore; // we only watch ROOT
  const segs = path.slice(root.length + 1).split("/");
  const last = segs[segs.length - 1];
  // segs[0] is the repo's own directory name: a repo legitimately named
  // `build` or `target` must not ignore itself.
  // ponytail: a *nested* repo named after an ignore dir is still invisible.
  if (segs.slice(1).some((s) => IGNORE_DIRS.has(s))) return ignore;
  if (IGNORE_FILE.test(last)) return ignore;
  const g = segs.indexOf(".git");
  const inGit = g < 0 ? null : segs.slice(g + 1);
  if (inGit) {
    if (inGit[0] === "objects" || inGit[0] === "lfs") return ignore;
    if (last.endsWith(".lock")) return ignore;
  }
  const owner = ownerWorktree(path, [...owners.keys()]);
  // new repo appeared
  if (!owner) return { bucket: "unknown", repo: null, wt: null };
  const repo = owners.get(owner)!;
  // Everything under .git is repo-wide, so wt stays null: refs/heads is shared
  // by every worktree, so one branch update moves ahead/behind for any of them,
  // and a linked worktree's own HEAD and index live under .git/worktrees/<name>/,
  // which names the worktree but not its path. Only a working-tree file belongs
  // to exactly one worktree.
  if (inGit) {
    // linked worktrees keep refs/index under .git/worktrees/<name>/, so match
    // on position within .git rather than on an exact path
    if (
      inGit.includes("refs") || /^(HEAD|packed-refs|MERGE_HEAD)$/.test(last)
    ) {
      return { bucket: "refs", repo, wt: null };
    }
    if (last === "index") return { bucket: "index", repo, wt: null };
    return { bucket: "worktree", repo, wt: null };
  }
  return { bucket: "worktree", repo, wt: owner };
}

// ---- divergence: did the watcher miss a change? (docs/fs-watch.md) ----

export type DiffWorktree = {
  path: string;
  branch: string;
  head: string;
  ahead: number | null;
  behind: number | null;
  dirty: number;
  lastActivity: number;
  remote: string | null;
};
export type DiffRepo = { path: string; worktrees: DiffWorktree[] };
export type Divergence = {
  repo: string;
  worktree: string | null;
  field: string;
  watch: unknown;
  sweep: unknown;
};

// ports and pr are deliberately absent: they come from the global lsof timer
// and the gh timer, never from fs events, so a difference there says nothing
// about the watcher. isPrimary/webUrl follow the worktree list, not events.
const WT_FIELDS = [
  "branch",
  "head",
  "ahead",
  "behind",
  "dirty",
  "lastActivity",
  "remote",
] as const;

/**
 * Field-by-field diff of what events believe (`watch`) against a fresh full
 * sweep (`sweep`). Every entry is one change the watcher failed to deliver.
 * Naming the repo and the field is the whole point — a JSON string diff would
 * say "different" and nothing else.
 *
 * `exclude` drops repos that were touched while the sweep was running. A sweep
 * spans seconds: a repo read early, written mid-sweep and recomputed by the
 * watcher before the sweep ended disagrees for timing reasons alone. Excluding
 * that one repo keeps the other 120 measured.
 */
export function diffSnapshots(
  watch: Map<string, DiffRepo>,
  sweep: Map<string, DiffRepo>,
  exclude?: Set<string>,
): Divergence[] {
  const out: Divergence[] = [];
  const add = (
    repo: string,
    worktree: string | null,
    field: string,
    w: unknown,
    s: unknown,
  ) => {
    if (!exclude?.has(repo)) {
      out.push({ repo, worktree, field, watch: w, sweep: s });
    }
  };
  for (const [path, truth] of sweep) {
    const live = watch.get(path);
    if (!live) {
      add(path, null, "repoAdded", null, path);
      continue;
    }
    const stale = new Map(live.worktrees.map((w) => [w.path, w]));
    for (const tw of truth.worktrees) {
      const lw = stale.get(tw.path);
      if (!lw) {
        add(path, tw.path, "worktreeAdded", null, tw.path);
        continue;
      }
      stale.delete(tw.path);
      for (const f of WT_FIELDS) {
        // Object.is, not !==: ahead/behind come from .map(Number) and
        // lastActivity from Number(...), so both sides can be NaN. `!==` would
        // report NaN vs NaN forever — logged as null vs null, and never
        // healing, because the NaN is written into the map.
        if (!Object.is(lw[f], tw[f])) add(path, tw.path, f, lw[f], tw[f]);
      }
    }
    for (const p of stale.keys()) add(path, p, "worktreeRemoved", p, null);
  }
  for (const p of watch.keys()) {
    if (!sweep.has(p)) add(p, null, "repoRemoved", p, null);
  }
  return out;
}

// ---- backoff + storm: the safety valve (step 6, docs/fs-watch.md) ----

/**
 * Rolling count over the trailing `windowMs`, in `buckets` time slots.
 * Bounded memory and no pruning walk — a slot older than the window is simply
 * not counted, so the count decays with time even if nothing is ever added.
 * `now` is a parameter, so the caller (and the tests) own the clock.
 *
 * ponytail: slot-granular, so the count is accurate to windowMs/buckets. Both
 * users (a 60 s recompute window, a 5 s event window) are thresholds, not
 * billing.
 */
export function rateWindow(windowMs: number, buckets = 12) {
  const width = windowMs / buckets;
  const counts = new Array<number>(buckets).fill(0);
  const slots = new Array<number>(buckets).fill(-Infinity);
  const slotOf = (now: number) => Math.floor(now / width);
  const count = (now: number) => {
    const cur = slotOf(now);
    const oldest = cur - buckets + 1;
    let n = 0;
    // `<= cur` as well as `>= oldest`: a clock stepped backwards leaves slots
    // in the future, which are not in the trailing window either.
    for (let i = 0; i < buckets; i++) {
      if (slots[i] >= oldest && slots[i] <= cur) n += counts[i];
    }
    return n;
  };
  return {
    count,
    add(now: number) {
      const s = slotOf(now);
      const i = ((s % buckets) + buckets) % buckets;
      if (slots[i] !== s) {
        slots[i] = s;
        counts[i] = 0;
      }
      counts[i]++;
      return count(now);
    },
  };
}

/** Backoff state for one hot repo. Absent = not in backoff. */
export type HotState = { intervalMs: number; nextAt: number };

/**
 * One quiet interval: the repo was owed a recompute at `nextAt` and a whole
 * further interval passed. Only meaningful for a repo with nothing pending —
 * a *deferred* repo is late because we are holding it, not because it is
 * quiet, so the caller ANDs this with "not dirty".
 */
export const backoffOver = (st: HotState, now: number) =>
  now >= st.nextAt + st.intervalMs;

/**
 * May this dirty repo be recomputed now, and what is its backoff afterwards?
 * Pure: the caller keeps the state and the window.
 *
 * `hits` is that repo's recomputes in the trailing 60 s. Past `threshold` the
 * repo enters backoff and its interval doubles from 1 s to `maxMs`. `run:
 * false` means *later*, never *never*: the caller leaves the repo dirty.
 */
export function hotBackoff(
  st: HotState | undefined,
  hits: number,
  now: number,
  threshold: number,
  maxMs: number,
): { run: boolean; state: HotState | undefined } {
  if (st && now < st.nextAt) return { run: false, state: st }; // defer, keep dirty
  if (!st && hits < threshold) return { run: true, state: undefined };
  const intervalMs = Math.min(st ? st.intervalMs * 2 : 1000, maxMs);
  return { run: true, state: { intervalMs, nextAt: now + intervalMs } };
}

// ---- agent interface ----

export type FileRow = {
  path: string;
  status: string;
  added: number;
  removed: number;
  staged: boolean;
  unstaged: boolean;
};
export type Files = { base: string; files: FileRow[] };

const CONFLICT_XY = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);

export function statusCounts(
  entries: { xy: string }[],
): { staged: number; modified: number; untracked: number } {
  const untracked = entries.filter((e) => e.xy === "??").length;
  const rest = entries.filter((e) => e.xy !== "??");
  return {
    staged:
      rest.filter((e) => !CONFLICT_XY.has(e.xy) && e.xy[0] !== ".").length,
    modified: rest.filter((e) => e.xy[1] !== ".").length,
    untracked,
  };
}

export function parseUpstreamTrack(out: string): Set<string> {
  const gone = new Set<string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(\S+)\s*(.*)$/);
    if (m && m[2].trim() === "[gone]") gone.add(m[1]);
  }
  return gone;
}

const FAIL_CONCLUSION = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
]);
const FAIL_STATE = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUS = new Set(["QUEUED", "IN_PROGRESS"]);
const PENDING_STATE = new Set(["PENDING", "EXPECTED"]);

export function ciSummary(
  rollup: {
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }[],
): { state: "pass" | "fail" | "pending" | null; failing: string[] } {
  if (!rollup.length) return { state: null, failing: [] };
  const failing = rollup.filter((e) =>
    (e.conclusion && FAIL_CONCLUSION.has(e.conclusion)) ||
    (e.state && FAIL_STATE.has(e.state))
  );
  if (failing.length) {
    return {
      state: "fail",
      failing: failing.map((e) => e.name ?? e.context ?? ""),
    };
  }
  const pending = rollup.some((e) =>
    (e.status && PENDING_STATUS.has(e.status)) ||
    (e.state && PENDING_STATE.has(e.state))
  );
  return { state: pending ? "pending" : "pass", failing: [] };
}

// GitHub's GraphQL API reports an unfinished CheckRun's completedAt as this Go
// zero-time sentinel rather than null — reject anything that old as bogus.
const MIN_SANE_TIME = Date.parse("2000-01-01T00:00:00Z");
const validTime = (t?: string): number | undefined => {
  if (!t) return undefined;
  const ms = new Date(t).getTime();
  return ms > MIN_SANE_TIME ? ms : undefined;
};

/** When the current ci state actually started, per GitHub's own timestamps. */
export function ciSince(
  rollup: {
    name?: string;
    context?: string;
    conclusion?: string;
    state?: string;
    status?: string;
    startedAt?: string;
    completedAt?: string;
    createdAt?: string;
  }[],
  ciState: "pass" | "fail" | "pending" | null,
): number | null {
  if (!ciState) return null;
  const relevant = ciState === "fail"
    ? rollup.filter((e) =>
      (e.conclusion && FAIL_CONCLUSION.has(e.conclusion)) ||
      (e.state && FAIL_STATE.has(e.state))
    )
    : ciState === "pending"
    ? rollup.filter((e) =>
      (e.status && PENDING_STATUS.has(e.status)) ||
      (e.state && PENDING_STATE.has(e.state))
    )
    : rollup;
  const times = relevant
    .map((e) =>
      validTime(e.completedAt) ?? validTime(e.startedAt) ??
        validTime(e.createdAt)
    )
    .filter((t) => t !== undefined);
  return times.length ? Math.max(...times) : null;
}

/** When the current review decision was actually reached, per GitHub's reviews. */
export function reviewSince(
  reviews: { state?: string; submittedAt?: string }[],
  decision: string,
): number | null {
  if (!decision) return null;
  const times = reviews
    .filter((r) => r.state === decision)
    .map((r) => r.submittedAt)
    .filter((t) => !!t)
    .map((t) => new Date(t!).getTime());
  return times.length ? Math.max(...times) : null;
}

/** Path-shaped input only: anything else is a fuzzy selector, left alone. */
export const normPath = (p: string, home = "") =>
  p.replace(/^~(?=$|\/)/, home).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");

/** Pasted path text (quoted, a stack frame, a file:// URL, trailing :line:col) into a bare path + line. */
export function parseOpenInput(s: string): { path: string; line: number } {
  let t = s.trim();
  const quoted = t.match(/^(['"`])([\s\S]*)\1$/);
  if (quoted) t = quoted[2].trim();
  const frame = t.match(/^at\s+.+?\s+\(([^)]+)\)$/) ?? t.match(/^\(([^)]+)\)$/);
  if (frame) t = frame[1].trim();
  if (t.startsWith("file://")) {
    const rest = t.slice("file://".length);
    try {
      t = decodeURIComponent(rest);
    } catch {
      t = rest;
    }
  }
  let line = 0;
  const loc = t.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (loc) {
    t = loc[1];
    line = Number(loc[2]);
  }
  return { path: t, line };
}

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "forest-app.localhost",
]);

/** Loopback remote address AND a Host header naming this server, not a proxied/foreign one. */
export function isLocalRequest(
  remoteHost: string,
  hostHeader: string | null,
): boolean {
  const loopback = remoteHost === "::1" ||
    /^127\./.test(remoteHost) ||
    /^::ffff:127\./.test(remoteHost);
  if (!loopback || !hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL("http://" + hostHeader).hostname;
  } catch {
    return false;
  }
  return LOCAL_HOSTNAMES.has(hostname);
}

export function selectWt<
  T extends { path: string; branch: string; repo: string },
>(sel: string, rows: T[], home = ""): { wt: T } | { candidates: T[] } {
  const owner = ownerWorktree(normPath(sel, home), rows.map((r) => r.path));
  if (owner) return { wt: rows.find((r) => r.path === owner)! };
  const candidates = rows.filter((r) => matchWt({ q: sel }, r.repo, r));
  return candidates.length === 1 ? { wt: candidates[0] } : { candidates };
}

export const qbool = z.union([
  z.boolean(),
  z.literal("true"),
  z.literal("1"),
  z.literal("false"),
  z.literal("0"),
]).transform((v) => v === true || v === "true" || v === "1");

export const qnum = z.union([
  z.number(),
  z.string().regex(/^\d+$/).transform(Number),
]).pipe(z.number().int().min(0));

// ---- file explorer ----

/** Max entries a directory walk collects before giving up. */
export const TREE_CAP = 5000;

export type TreeRow = {
  path: string;
  name: string;
  depth: number;
  dir: boolean;
};
type TreeNode = Map<string, TreeNode>;

/** Visible rows of a path tree: folders first, children only under `open` folders; `dirs` are folders even before their contents load. */
export function treeRows(
  paths: string[],
  open: Record<string, boolean>,
  dirs: string[] = [],
): TreeRow[] {
  const root: TreeNode = new Map();
  const dirSet = new Set(dirs);
  for (const p of [...dirs, ...paths]) {
    let n = root;
    for (const s of p.split("/")) {
      if (!n.has(s)) n.set(s, new Map());
      n = n.get(s)!;
    }
  }
  const rows: TreeRow[] = [];
  const walk = (n: TreeNode, pre: string, depth: number) => {
    const isDir = (name: string, k: TreeNode) =>
      k.size > 0 || dirSet.has(pre + name);
    const kids = [...n].sort(([a, x], [b, y]) =>
      Number(isDir(b, y)) - Number(isDir(a, x)) || a.localeCompare(b)
    );
    for (const [name, k] of kids) {
      const path = pre + name;
      const dir = k.size > 0 || dirSet.has(path);
      rows.push({ path, name, depth, dir });
      if (k.size && open[path]) walk(k, path + "/", depth + 1);
    }
  };
  walk(root, "", 0);
  return rows;
}

/** `git ls-files --ignored --directory` entries as ignored files and folders; a folder git lists only because everything under it is ignored is dropped, since its own entries cover it. */
export function parseIgnored(
  entries: string[],
): { files: string[]; dirs: string[] } {
  const own = entries.filter((e) =>
    !(e.endsWith("/") && entries.some((o) => o !== e && o.startsWith(e)))
  );
  return {
    files: own.filter((e) => !e.endsWith("/")),
    dirs: own.filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1)),
  };
}

/** Whether a tree path is git-ignored, given ignored files and folders. */
export const isIgnoredPath = (path: string, ignored: string[]) =>
  ignored.some((i) => path === i || path.startsWith(i + "/"));

/** Every ancestor folder of the given paths, for marking folders that hold changes. */
export function ancestorDirs(paths: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) {
      dirs.add(p.slice(0, i));
    }
  }
  return dirs;
}

export const MAX_PREVIEW = 1 << 20;

export const fmtSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1 << 20
    ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / (1 << 20)).toFixed(1)} MB`;

/** Why a file can't be shown as text, or null if it can. */
export function previewSkip(size: number, head: Uint8Array): string | null {
  if (size > MAX_PREVIEW) return `too large to show · ${fmtSize(size)}`;
  if (head.subarray(0, 8000).includes(0)) return `binary · ${fmtSize(size)}`;
  return null;
}
