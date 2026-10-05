import { assertEquals } from "@std/assert";
import { PROVIDERS } from "./agents.ts";
import {
  createSessions,
  MAX_SHOWN,
  promptTitle,
  type SessionFs,
  shown,
} from "./sessions.ts";

const HOME = "/h";
const WT = "/h/Repos/app/.worktrees/feat";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const claudeFile = (id: string) =>
  `/h/.claude/projects/-h-Repos-app/${id}.jsonl`;
const codexFile =
  `/h/.codex/sessions/2026/10/05/rollout-2026-10-05T10-00-00-${C}.jsonl`;

const at = (min: number) =>
  `2026-10-05T10:${String(min).padStart(2, "0")}:00.000Z`;
const ms = (min: number) => Date.parse(at(min));
const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";

// Files are served in two chunks so a line can straddle a chunk boundary.
function fakeFs(files: Map<string, string>): SessionFs & { reads: number[] } {
  const enc = new TextEncoder();
  const mtime = new Map<string, number>();
  const reads: number[] = [];
  return {
    reads,
    list: (dir) =>
      Promise.resolve([...files.keys()].filter((p) => p.startsWith(dir + "/"))),
    stat: (p) => {
      const s = files.get(p);
      if (s === undefined) return Promise.reject(new Deno.errors.NotFound());
      const size = enc.encode(s).length;
      if (!mtime.has(p + size)) mtime.set(p + size, mtime.size + 1);
      return Promise.resolve({ size, mtime: mtime.get(p + size)! });
    },
    async *read(p, from) {
      const b = enc.encode(files.get(p)!).subarray(from);
      reads.push(b.length);
      const mid = Math.floor(b.length / 2);
      yield b.subarray(0, mid);
      yield b.subarray(mid);
    },
  };
}

function make(files: Map<string, string>) {
  const fs = fakeFs(files);
  let changes = 0;
  const s = createSessions({
    home: HOME,
    providers: PROVIDERS,
    fs,
    onChange: () => changes++,
  });
  return { s, fs, changes: () => changes };
}

Deno.test("sessions rank by first mention and mark ones that worked inside", async () => {
  const files = new Map([
    // A lists every worktree at 10:05: named it, never worked in it
    [
      claudeFile(A),
      line({ type: "user", cwd: "/h/Repos/app", timestamp: at(1) }) +
      line({ type: "user", timestamp: at(5), content: `worktrees:\n${WT}\n` }) +
      line({ type: "custom-title", customTitle: "Lister" }),
    ],
    // B created it at 10:02 and edited a file inside at 10:03
    [
      claudeFile(B),
      line({ type: "user", cwd: "/h/Repos/app", timestamp: at(0) }) +
      line({ type: "ai-title", aiTitle: "Make feat" }) +
      line({ timestamp: at(2), content: `Created ${WT}.` }) +
      line({ timestamp: at(3), content: `Edited ${WT}/src/a.ts` }),
    ],
    // Codex started inside it at 10:09; its title comes from the index
    [
      codexFile,
      line({
        timestamp: at(9),
        type: "session_meta",
        payload: { id: C, cwd: WT },
      }),
    ],
    [
      "/h/.codex/session_index.jsonl",
      line({ id: C, thread_name: "first" }) +
      line({ id: C, thread_name: "Codex feat" }),
    ],
  ]);
  const { s } = make(files);
  await s.refresh();
  const got = s.forWts([{ path: WT }, {
    path: "/h/Repos/app/.worktrees/other",
  }]);
  assertEquals(got.has("/h/Repos/app/.worktrees/other"), false);
  assertEquals(
    got.get(WT)!.map((a) => [a.agent, a.id, a.title, a.seenAt, a.deep]),
    [
      ["claude", B, "Make feat", ms(2), true],
      ["claude", A, "Lister", ms(5), false],
      ["codex", C, "Codex feat", ms(9), true],
    ],
  );
  assertEquals(got.get(WT)![0].cwd, "/h/Repos/app");
  assertEquals(
    got.get(WT)![0].command,
    `cd '/h/Repos/app' && claude --resume ${B}`,
  );
  assertEquals(got.get(WT)![2].url, `codex://threads/${C}`);
  assertEquals(s.find("codex", C), {
    url: `codex://threads/${C}`,
    command: `cd '${WT}' && codex resume ${C}`,
  });
  assertEquals(s.find("codex", A), null);
});

Deno.test("refresh tails appended lines and waits for a partial line to finish", async () => {
  const files = new Map([
    [
      claudeFile(A),
      line({ type: "user", cwd: "/h/Repos/app", timestamp: at(0) }),
    ],
  ]);
  const { s, fs, changes } = make(files);
  await s.refresh();
  assertEquals(s.forWts([{ path: WT }]).size, 0);
  assertEquals(changes(), 1);

  await s.refresh(); // nothing changed: no read, no publish
  assertEquals(fs.reads.length, 1);
  assertEquals(changes(), 1);

  const before = files.get(claudeFile(A))!;
  const tail = line({ timestamp: at(4), content: `cd ${WT}` });
  files.set(claudeFile(A), before + tail.slice(0, 20));
  await s.refresh();
  assertEquals(s.forWts([{ path: WT }]).size, 0);

  files.set(claudeFile(A), before + tail);
  await s.refresh();
  assertEquals(fs.reads.at(-1), tail.length); // only the unconsumed bytes
  assertEquals(s.forWts([{ path: WT }]).get(WT)![0].seenAt, ms(4));
});

Deno.test("a subagent transcript counts for its parent session; a removed file drops out", async () => {
  const sub = `/h/.claude/projects/-h-Repos-app/${A}/subagents/agent-x.jsonl`;
  const files = new Map([
    [
      claudeFile(A),
      line({ type: "user", cwd: "/h/Repos/app", timestamp: at(0) }) +
      line({ type: "custom-title", customTitle: "Parent" }),
    ],
    [sub, line({ cwd: "/h/Repos/app", timestamp: at(7), content: `${WT}/x` })],
  ]);
  const { s } = make(files);
  await s.refresh();
  const [a] = s.forWts([{ path: WT }]).get(WT)!;
  assertEquals([a.id, a.title, a.startedAt, a.seenAt], [
    A,
    "Parent",
    ms(0),
    ms(7),
  ]);

  files.delete(sub);
  await s.refresh();
  assertEquals(s.forWts([{ path: WT }]).size, 0);
});

Deno.test("a rewritten (shorter) transcript is rescanned from the start", async () => {
  const files = new Map([
    [
      claudeFile(A),
      line({ timestamp: at(1), content: `${WT} and a long tail of text here` }),
    ],
  ]);
  const { s } = make(files);
  await s.refresh();
  files.set(claudeFile(A), line({ timestamp: at(2), content: "gone" }));
  await s.refresh();
  assertEquals(s.forWts([{ path: WT }]).size, 0);
});

Deno.test("shown keeps the earliest, then prefers sessions that worked inside", () => {
  const sorted = Array.from(
    { length: MAX_SHOWN + 2 },
    (_, i) => [`s${i}`, i] as [string, number],
  );
  const deep = new Set([`s${MAX_SHOWN + 1}`]);
  const out = shown(sorted, deep).map((e) => e[0]);
  assertEquals(out.length, MAX_SHOWN);
  assertEquals(out[0], "s0");
  assertEquals(out.at(-1), `s${MAX_SHOWN + 1}`);
});

Deno.test("promptTitle drops tagged blocks and collapses whitespace", () => {
  assertEquals(
    promptTitle(
      'For the cards:\n<pasted_content id="5">\nlong <b>paste</b>\n</pasted_content> fix them <br/>',
    ),
    "For the cards: fix them",
  );
});

Deno.test("a main checkout on a branch matches sessions that ran in it on that branch", async () => {
  const MAIN = "/h/Repos/app";
  const files = new Map([
    // ran in the checkout on feat/x from 10:03: a match
    [
      claudeFile(A),
      line({ cwd: MAIN, gitBranch: "main", timestamp: at(1) }) +
      line({ cwd: MAIN, gitBranch: "feat/x", timestamp: at(3) }),
    ],
    // names the checkout but ran elsewhere, and feat/x only in another repo
    [
      claudeFile(B),
      line({ cwd: "/h/Repos/other", gitBranch: "feat/x", timestamp: at(0) }) +
      line({ timestamp: at(2), content: `cd ${MAIN}` }),
    ],
    [
      codexFile,
      line({
        timestamp: at(5),
        type: "session_meta",
        payload: { id: C, cwd: `${MAIN}/src`, git: { branch: "feat/x" } },
      }),
    ],
  ]);
  const { s } = make(files);
  await s.refresh();
  const got = s.forWts([{ path: MAIN, branch: "feat/x" }]).get(MAIN)!;
  assertEquals(got.map((a) => [a.id, a.seenAt, a.deep]), [
    [A, ms(3), true],
    [C, ms(5), true],
  ]);
});
