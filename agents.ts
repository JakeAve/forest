// One entry per coding agent. sessions.ts is agent-agnostic: it walks `root`,
// tails every file `sessionOf` claims, and asks `line` for facts. Supporting a
// new agent means adding an entry here; nothing else changes.

export type Facts = {
  at?: number; // line timestamp, ms
  cwd?: string;
  branch?: string; // checked out in cwd at this line
  title?: string; // named by the user; wins over autoTitle
  autoTitle?: string;
  prompt?: string; // first one is the fallback title
};

export type Provider = {
  agent: string;
  label: string;
  glyph: string;
  tone: string; // CSS var name, without `--`, for the badge
  root: string; // relative to home
  sessionOf(rel: string): string | null; // file under root -> session id
  line(l: string): Facts;
  titles?: { file: string; line(l: string): [string, string] | null };
  url(id: string): string;
  command(s: { id: string; cwd: string }): string;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// Top-level `"key":"value"` only: a key nested in a JSON string is escaped
// (`\"key\"`) and doesn't match.
export function str(l: string, key: string): string | undefined {
  const m = l.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return undefined;
  }
}

const ts = (l: string) => {
  const t = Date.parse(str(l, "timestamp") ?? "");
  return Number.isNaN(t) ? undefined : t;
};

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export const PROVIDERS: Provider[] = [
  {
    agent: "claude",
    label: "Claude",
    glyph: "✳",
    tone: "agent-a",
    root: ".claude/projects",
    sessionOf: (rel) =>
      rel.match(
        new RegExp(`^[^/]+/(${UUID})(?:\\.jsonl|/subagents/[^/]+\\.jsonl)$`),
      )?.[1] ?? null,
    line: (l) => ({
      at: ts(l),
      cwd: str(l, "cwd"),
      branch: str(l, "gitBranch"),
      title: str(l, "customTitle"),
      autoTitle: str(l, "aiTitle"),
    }),
    // Imports a CLI session into the desktop app, or focuses it if it's there.
    url: (id) => `claude://resume?session=${id}`,
    command: (s) => `cd ${q(s.cwd)} && claude --resume ${s.id}`,
  },
  {
    agent: "codex",
    label: "Codex",
    glyph: "◎",
    tone: "agent-b",
    root: ".codex/sessions",
    sessionOf: (rel) =>
      rel.match(
        new RegExp(`^\\d{4}/\\d{2}/\\d{2}/rollout-.*-(${UUID})\\.jsonl$`),
      )
        ?.[1] ?? null,
    line: (l) => ({
      at: ts(l),
      cwd: str(l, "cwd"),
      branch: str(l, "branch"), // session_meta's git.branch
      prompt: l.includes('"type":"user_message"')
        ? str(l, "message")
        : undefined,
    }),
    titles: {
      file: ".codex/session_index.jsonl",
      line: (l) => {
        const id = str(l, "id");
        const name = str(l, "thread_name");
        return id && name ? [id, name] : null;
      },
    },
    url: (id) => `codex://threads/${id}`,
    command: (s) => `cd ${q(s.cwd)} && codex resume ${s.id}`,
  },
];
