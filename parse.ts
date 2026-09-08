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
) {
  for (const line of s.split("\n")) {
    if (line[0] === "p") onPid(line.slice(1));
    else if (line[0] === "n") onName(line.slice(1));
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

export function portsByCwd(
  byPid: Map<string, number[]>,
  cwds: string,
): Map<string, number[]> {
  const byCwd = new Map<string, number[]>();
  let pid = "";
  fieldLines(cwds, (p) => (pid = p), (cwd) => {
    const ports = byPid.get(pid);
    if (ports) {
      byCwd.set(
        cwd,
        [...new Set([...(byCwd.get(cwd) ?? []), ...ports])].sort((a, b) =>
          a - b
        ),
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
): { bucket: WatchBucket; repo: string | null } {
  // a trailing slash on the `root` setting would otherwise make every
  // startsWith below fail, silently classifying every event as ignore
  const root = rootArg.replace(/(?!^)\/+$/, "");
  const ignore = { bucket: "ignore", repo: null } as const;
  // a new dir directly under ROOT may be a new repo; ROOT itself means rescan
  if (path === root) return { bucket: "unknown", repo: null };
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
  if (!owner) return { bucket: "unknown", repo: null }; // new repo appeared
  const repo = owners.get(owner)!;
  if (inGit) {
    // linked worktrees keep refs/index under .git/worktrees/<name>/, so match
    // on position within .git rather than on an exact path
    if (
      inGit.includes("refs") || /^(HEAD|packed-refs|MERGE_HEAD)$/.test(last)
    ) {
      return { bucket: "refs", repo };
    }
    if (last === "index") return { bucket: "index", repo };
  }
  return { bucket: "worktree", repo };
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
