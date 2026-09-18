import { dirname, join } from "@std/path";
import { matchPath } from "./src/filter.js";
import {
  type FileRow,
  type Files,
  isLocalRequest,
  MAX_PREVIEW,
  parseIgnored,
  parseStatus,
  previewSkip,
  TREE_CAP,
} from "./parse.ts";
import type { Shell } from "./exec.ts";
import type { RepoApi } from "./repo.ts";
import type { Tree } from "./types.ts";

export type FilesApi = {
  looseRoots: Set<string>;
  isLoose(wt: string): boolean;
  guardWt(wt: string | null): string;
  guardRoot(
    wt: string | null,
    req: Request,
    info: Deno.ServeHandlerInfo,
  ): string;
  guardPath(p: string | null): string;
  listFiles(wt: string, mode: string, q?: string): Promise<Files>;
  fileContents(
    wt: string,
    path: string,
    mode: string,
  ): Promise<{ base: string | null; work: string | null; skip?: string }>;
  listTree(wt: string): Promise<Tree>;
  listDir(root: string, dir: string): Promise<Tree>;
  walkTree(root: string): Promise<Tree>;
  newEntry(root: string, rel: string): Promise<void>;
  rename(root: string, from: string, to: string): Promise<void>;
  remove(root: string, rel: string): Promise<void>;
  save(
    root: string,
    rel: string,
    expect: unknown,
    content: string,
  ): Promise<"ok" | { current: string | null }>;
};

// ponytail: fixed name list, not per-ecosystem detection; add names as they turn up
const DEP_DIRS = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".yarn",
  ".pnpm-store",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".venv",
  "venv",
  "__pycache__",
  "site-packages",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  "target",
  "vendor",
  "Pods",
  ".terraform",
]);
const depExcludes = [...DEP_DIRS].flatMap((d) => ["-x", d]);

export function createFiles(deps: {
  sh: Shell;
  known: Map<string, string>;
  mergeBase: RepoApi["mergeBase"];
  home: string;
}): FilesApi {
  const { tryGit } = deps.sh;
  const { known } = deps;

  function guardWt(wt: string | null): string {
    if (!wt || !known.has(wt)) {
      throw new Error(`unknown worktree: ${wt ?? "(none given)"}`);
    }
    return wt;
  }

  const looseRoots = new Set<string>();
  const isLoose = (wt: string) => !known.has(wt) && looseRoots.has(wt);

  function guardRoot(
    wt: string | null,
    req: Request,
    info: Deno.ServeHandlerInfo,
  ): string {
    if (wt && isLoose(wt)) {
      const host = (info.remoteAddr as Deno.NetAddr).hostname;
      if (!isLocalRequest(host, req.headers.get("host"))) {
        throw new Error("Forest only opens paths for this machine");
      }
      return wt;
    }
    return guardWt(wt);
  }

  function guardPath(p: string | null): string {
    if (!p || p.includes("..") || p.startsWith("/")) {
      throw new Error("bad path");
    }
    return p;
  }

  const resolveBase = (wt: string, mode: string) =>
    mode === "head"
      ? Promise.resolve("HEAD")
      : deps.mergeBase(wt, known.get(wt));

  async function listFiles(
    wt: string,
    mode: string,
    q?: string,
  ): Promise<Files> {
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

    const files: FileRow[] = [];
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
      files.push({
        path: p,
        status: "U",
        added: lines,
        removed: 0,
        ...flags(p),
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      base,
      files: q ? files.filter((f) => matchPath(q, f.path)) : files,
    };
  }

  async function fileContents(wt: string, path: string, mode: string) {
    const p = join(wt, path);
    const size = (await Deno.stat(p).catch(() => null))?.size ?? 0;
    const bytes = size > MAX_PREVIEW
      ? new Uint8Array()
      : await Deno.readFile(p).catch(() => null);
    const skip = bytes && previewSkip(size, bytes);
    if (skip) return { base: null, work: null, skip };
    const work = bytes && new TextDecoder().decode(bytes);
    if (isLoose(wt)) return { base: null, work };
    const base = await resolveBase(wt, mode);
    return { base: await tryGit(wt, "show", `${base}:${path}`), work };
  }

  async function listTree(wt: string): Promise<Tree> {
    const ls = (...args: string[]) =>
      tryGit(wt, "ls-files", "-z", ...args).then((o) =>
        (o ?? "").split("\0").filter(Boolean)
      );
    const [listed, ignoredRaw] = await Promise.all([
      ls("--cached", "--others", "--exclude-standard", ...depExcludes),
      ls(
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        ...depExcludes,
      ),
    ]);
    const ignored = parseIgnored(ignoredRaw);
    return {
      files: [
        ...new Set([
          ...listed.filter((p) => !p.endsWith("/")),
          ...ignored.files,
        ]),
      ],
      dirs: [
        ...listed.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1)),
        ...ignored.dirs,
      ],
      ignored: [...ignored.files, ...ignored.dirs],
    };
  }

  async function listDir(root: string, dir: string): Promise<Tree> {
    const files: string[] = [];
    const dirs: string[] = [];
    for await (const e of Deno.readDir(join(root, dir))) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory && e.name !== ".git") dirs.push(p);
      else if (e.isFile) files.push(p);
    }
    return { files, dirs, ignored: [] };
  }

  async function walkTree(root: string): Promise<Tree> {
    const files: string[] = [];
    const dirs: string[] = [];
    const queue = [""];
    for (let i = 0; i < queue.length && files.length < TREE_CAP; i++) {
      try {
        for await (const e of Deno.readDir(join(root, queue[i]))) {
          const rel = queue[i] ? `${queue[i]}/${e.name}` : e.name;
          if (e.isDirectory && DEP_DIRS.has(e.name)) dirs.push(rel);
          else if (e.isDirectory && e.name !== ".git") queue.push(rel);
          else if (e.isFile) files.push(rel);
          if (files.length >= TREE_CAP) break;
        }
      } catch {
        continue;
      }
    }
    return { files, dirs, ignored: dirs };
  }

  async function newEntry(root: string, rel: string) {
    const safe = guardPath(rel);
    const p = join(root, safe);
    if (safe.endsWith("/")) await Deno.mkdir(p, { recursive: true });
    else {
      await Deno.mkdir(dirname(p), { recursive: true });
      await Deno.writeTextFile(p, "", { createNew: true });
    }
  }

  async function rename(root: string, from: string, to: string) {
    const dest = join(root, guardPath(to));
    if (await Deno.lstat(dest).catch(() => null)) {
      throw new Error(`${to} already exists`);
    }
    await Deno.mkdir(dirname(dest), { recursive: true });
    await Deno.rename(join(root, guardPath(from)), dest);
  }

  async function remove(root: string, rel: string) {
    await Deno.remove(join(root, guardPath(rel)), { recursive: true });
  }

  async function save(
    root: string,
    rel: string,
    expect: unknown,
    content: string,
  ): Promise<"ok" | { current: string | null }> {
    const p = join(root, guardPath(rel));
    const cur = await Deno.readTextFile(p).catch(() => null);
    if (cur !== expect) return { current: cur };
    await Deno.writeTextFile(p, content);
    return "ok";
  }

  return {
    looseRoots,
    isLoose,
    guardWt,
    guardRoot,
    guardPath,
    listFiles,
    fileContents,
    listTree,
    listDir,
    walkTree,
    newEntry,
    rename,
    remove,
    save,
  };
}
