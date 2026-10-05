import { assertEquals } from "@std/assert";
import { PROVIDERS, str } from "./agents.ts";

const [claude, codex] = PROVIDERS;
const ID = "db6d0b23-9126-4e81-8033-5e2517030d0d";

Deno.test("str reads a top-level key and ignores one nested in a JSON string", () => {
  assertEquals(
    str(`{"customTitle":"say \\"hi\\""}`, "customTitle"),
    'say "hi"',
  );
  assertEquals(
    str(`{"content":"{\\"customTitle\\":\\"nope\\"}"}`, "customTitle"),
    undefined,
  );
});

Deno.test("claude sessionOf claims transcripts and subagent transcripts only", () => {
  assertEquals(claude.sessionOf(`-Users-j-Repos-x/${ID}.jsonl`), ID);
  assertEquals(
    claude.sessionOf(`-Users-j-Repos-x/${ID}/subagents/agent-a1.jsonl`),
    ID,
  );
  assertEquals(
    claude.sessionOf(`-Users-j-Repos-x/${ID}/tool-results/a.txt`),
    null,
  );
  assertEquals(claude.sessionOf(`-Users-j-Repos-x/memory/MEMORY.md`), null);
});

Deno.test("codex sessionOf takes the uuid off the rollout name", () => {
  assertEquals(
    codex.sessionOf(`2026/10/02/rollout-2026-10-02T14-11-43-${ID}.jsonl`),
    ID,
  );
  assertEquals(codex.sessionOf(`2026/10/02/notes.jsonl`), null);
});

Deno.test("claude line facts: timestamp, cwd, both titles", () => {
  assertEquals(
    claude.line(
      `{"type":"user","cwd":"/r/x","timestamp":"2026-10-05T16:00:00.000Z"}`,
    ),
    {
      at: Date.parse("2026-10-05T16:00:00.000Z"),
      cwd: "/r/x",
      title: undefined,
      autoTitle: undefined,
    },
  );
  assertEquals(
    claude.line(`{"type":"custom-title","customTitle":"Mine"}`).title,
    "Mine",
  );
});

Deno.test("codex takes a prompt only from user_message events", () => {
  assertEquals(
    codex.line(
      `{"timestamp":"2026-10-05T16:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"fix it"}}`,
    ).prompt,
    "fix it",
  );
  assertEquals(
    codex.line(
      `{"type":"event_msg","payload":{"type":"agent_message","message":"ok"}}`,
    )
      .prompt,
    undefined,
  );
});

Deno.test("resume commands quote the cwd", () => {
  assertEquals(
    claude.command({ id: ID, cwd: "/r/it's" }),
    `cd '/r/it'\\''s' && claude --resume ${ID}`,
  );
  assertEquals(codex.url(ID), `codex://threads/${ID}`);
  assertEquals(claude.url(ID), `claude://resume?session=${ID}`);
});
