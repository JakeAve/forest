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
      if (Number.isFinite(n)) out[k] = Math.max(k.endsWith("Ms") ? 250 : 0, n);
    } else if (typeof d === "string") {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
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
