import { join, relative } from "@std/path";
import type { Provider } from "./agents.ts";
import type { AgentSession } from "./types.ts";

// ---- agent sessions ----

// GLOBAL and timed, like ports: transcripts aren't per repo. Each file is
// tailed from where the last refresh stopped, so a refresh after boot reads
// only what agents appended since.

export type SessionFs = {
  list(dir: string): Promise<string[]>; // files under dir, recursively
  stat(path: string): Promise<{ size: number; mtime: number }>;
  read(path: string, from: number): AsyncIterable<Uint8Array>;
};

type Scan = {
  p: Provider;
  id: string;
  size: number;
  mtime: number;
  offset: number; // bytes consumed, always just past a newline
  at: number; // last timestamp seen; stamps lines that carry none
  startedAt: number;
  cwd: string;
  title: string;
  autoTitle: string;
  prompt: string;
  seen: Map<string, number>; // path under home -> first mention
};

export const MAX_SHOWN = 5;

// Earliest first, capped. The earliest always stays (likely the creator), then
// sessions that worked inside the worktree beat ones that only named it.
export function shown<T extends [string, number]>(
  sorted: T[],
  deep: Set<string>,
): T[] {
  const [head, ...rest] = sorted;
  const keep = new Set(
    [head, ...rest.filter((e) => deep.has(e[0])), ...rest].slice(0, MAX_SHOWN),
  );
  return sorted.filter((e) => keep.has(e));
}

// A prompt as a fallback title: tagged blocks (pasted content, attachments)
// dropped, whitespace collapsed.
export const promptTitle = (p: string) =>
  p.replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 80);

const dec = new TextDecoder();

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

export function createSessions(
  { home, providers, fs, onChange }: {
    home: string;
    providers: Provider[];
    fs: SessionFs;
    onChange: () => void;
  },
) {
  const scans = new Map<string, Scan>(); // file -> scan
  const titles = new Map<string, string>(); // agent:id -> title
  const titlesAt = new Map<string, number>(); // titles file -> mtime
  const pathRx = new RegExp(
    home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "/[^\\s\"'`<>|:;,(){}\\[\\]\\\\]+",
    "g",
  );
  let version = 0;
  let memo = { key: "", value: new Map<string, AgentSession[]>() };
  let running: Promise<void> | null = null;

  function scanLine(s: Scan, l: string) {
    if (!l) return;
    const f = s.p.line(l);
    if (f.at) s.at = f.at;
    const at = s.at || s.mtime;
    s.startedAt ||= at;
    if (f.cwd && !s.cwd) s.cwd = f.cwd;
    if (f.title) s.title = f.title;
    if (f.autoTitle) s.autoTitle = f.autoTitle;
    if (f.prompt && !s.prompt) s.prompt = promptTitle(f.prompt);
    for (const m of l.matchAll(pathRx)) {
      const path = m[0].replace(/\.+$/, "");
      if (!s.seen.has(path)) s.seen.set(path, at);
    }
  }

  async function scanFile(p: Provider, path: string, id: string) {
    const st = await fs.stat(path);
    let s = scans.get(path);
    if (s && s.size === st.size && s.mtime === st.mtime) return false;
    if (!s || st.size < s.offset) {
      s = {
        p,
        id,
        size: 0,
        mtime: 0,
        offset: 0,
        at: 0,
        startedAt: 0,
        cwd: "",
        title: "",
        autoTitle: "",
        prompt: "",
        seen: new Map(),
      };
      scans.set(path, s);
    }
    s.size = st.size;
    s.mtime = st.mtime;
    // streamed: a transcript can be hundreds of MB
    let carry = new Uint8Array(0);
    for await (const chunk of fs.read(path, s.offset)) {
      const buf = carry.length ? concat(carry, chunk) : chunk;
      const end = buf.lastIndexOf(10) + 1;
      for (const l of dec.decode(buf.subarray(0, end)).split("\n")) {
        scanLine(s, l);
      }
      s.offset += end;
      carry = buf.slice(end);
    }
    return true;
  }

  async function scanTitles(p: Provider) {
    if (!p.titles) return false;
    const path = join(home, p.titles.file);
    const st = await fs.stat(path).catch(() => null);
    if (!st || titlesAt.get(path) === st.mtime) return false;
    titlesAt.set(path, st.mtime);
    const parts = [];
    for await (const chunk of fs.read(path, 0)) parts.push(chunk);
    for (const l of dec.decode(concat(...parts)).split("\n")) {
      const t = l && p.titles.line(l);
      if (t) titles.set(`${p.agent}:${t[0]}`, t[1]);
    }
    return true;
  }

  async function sweep() {
    let changed = false;
    for (const p of providers) {
      const root = join(home, p.root);
      const live = new Set<string>();
      for (const path of await fs.list(root)) {
        const id = p.sessionOf(relative(root, path));
        if (!id) continue;
        live.add(path);
        changed = await scanFile(p, path, id).catch(() => false) || changed;
      }
      for (const [path, s] of scans) {
        if (s.p === p && !live.has(path)) {
          scans.delete(path);
          changed = true;
        }
      }
      changed = await scanTitles(p) || changed;
    }
    if (changed) {
      version++;
      onChange();
    }
  }

  return {
    refresh(): Promise<void> {
      running ??= sweep().finally(() => (running = null));
      return running;
    },

    // wt path -> sessions that mention it, earliest mention first. A session
    // is all its files: the transcript plus any subagent transcripts.
    forWts(wts: string[]): Map<string, AgentSession[]> {
      const key = `${version}\n${wts.join("\n")}`;
      if (memo.key === key) return memo.value;
      const main = new Map<string, Scan>(); // agent:id -> earliest file
      for (const s of scans.values()) {
        const k = `${s.p.agent}:${s.id}`;
        const m = main.get(k);
        if (!m || s.startedAt < m.startedAt) main.set(k, s);
      }
      const out = new Map<string, AgentSession[]>();
      for (const wt of wts) {
        const first = new Map<string, number>();
        const deep = new Set<string>();
        for (const s of scans.values()) {
          const k = `${s.p.agent}:${s.id}`;
          if (s.cwd === wt || s.cwd.startsWith(wt + "/")) deep.add(k);
          for (const [path, at] of s.seen) {
            const inside = path.startsWith(wt + "/");
            if (!inside && path !== wt) continue;
            if (inside) deep.add(k);
            if (at < (first.get(k) ?? Infinity)) first.set(k, at);
          }
        }
        if (!first.size) continue;
        out.set(
          wt,
          shown([...first].sort((a, b) => a[1] - b[1]), deep).map(
            ([k, seenAt]) => {
              const s = main.get(k)!;
              const { agent, label, glyph, tone } = s.p;
              return {
                agent,
                label,
                glyph,
                tone,
                id: s.id,
                title: titles.get(k) || s.title || s.autoTitle || s.prompt,
                cwd: s.cwd,
                startedAt: s.startedAt,
                seenAt,
                deep: deep.has(k),
                command: s.p.command(s),
              };
            },
          ),
        );
      }
      memo = { key, value: out };
      return out;
    },

    // The deep link for a session Forest has indexed, so the resume route
    // never opens a URL it built from request input alone.
    url(agent: string, id: string): string | null {
      for (const s of scans.values()) {
        if (s.p.agent === agent && s.id === id) return s.p.url(id);
      }
      return null;
    },
  };
}

export type SessionsApi = ReturnType<typeof createSessions>;

export const denoFs: SessionFs = {
  async list(dir) {
    const out: string[] = [];
    const walk = async (d: string) => {
      try {
        for await (const e of Deno.readDir(d)) {
          const p = join(d, e.name);
          if (e.isDirectory) await walk(p);
          else if (e.isFile) out.push(p);
        }
      } catch { /* missing or unreadable: an agent that isn't installed */ }
    };
    await walk(dir);
    return out;
  },
  async stat(path) {
    const st = await Deno.stat(path);
    return { size: st.size, mtime: st.mtime?.getTime() ?? 0 };
  },
  async *read(path, from) {
    const f = await Deno.open(path);
    try {
      await f.seek(from, Deno.SeekMode.Start);
    } catch (e) {
      f.close();
      throw e;
    }
    yield* f.readable;
  },
};
