# forest

Git worktree dashboard: Deno server, `boot.ts` (wires the module graph, starts
nothing) and `main.ts` (starts it) plus `exec`, `repo`, `prs`, `ports`, `store`,
`cache`, `sse`, `watcher`, `files`, `themes`, `log`, `actions`, `tools`,
`notify`, `routes`, `stats`, `settings`, `agents`, `sessions`, `types`, and a
Svelte frontend in `src/`. See README.md for setup and the agent API.

Forest does the deterministic work so agents don't spend tokens and turns on it.
If an agent would otherwise poll, retry or sequence something itself (watching
CI, rebasing, merging when green, closing the ticket on merge), forest owns it
as a toggle on the row (`set_auto_*`) or a blocking read (`wait`). The agent
gets back a short answer, not raw state to sift through.

## Commands

```sh
npm install && npm run build   # dist/, served by the deno server
deno task serve                # http://forest-app.localhost:38471
npm run dev                    # vite on :38472, proxies /api to :38471
deno task check                # fmt + lint + typecheck; must pass before commit
deno task test                 # unit tests
deno task setup                # git hooks run check + test on commit/push
```

## Rules

- `parse.ts` is imported by both Deno and the Vite bundle. Any package it
  imports must be in both `deno.json` imports and `package.json`, pinned to the
  same version; no `@std/*` or `jsr:` imports there.
- Logic with edge cases goes in `parse.ts`, `src/theme.js` or `src/filter.js` so
  it's testable without spawning git. IO-driven logic goes in its system module
  and takes its IO as deps (`Shell` from `exec.ts`, the store, the clock) so
  it's testable with `fakeExec` from `fixtures.ts` and `FakeTime`. `main.ts` is
  wiring only.
- Filters (UI, palette, agent `q`) match through `fuzzy`/`rank` in
  `src/filter.js`. `selectWt` stays substring so a `wt` selector is precise.
- Colors and CSS vars: follow the `theming` skill in `.claude/skills/`.
- Ticket status comes from a user-owned command (`ticketCmds`); writing one or
  touching `tickets.ts` follows the `ticket-command` skill in `.claude/skills/`.
- Panes are one flat grid in `App.svelte`; each layout in `AXES`/`LAYOUTS` is a
  `grid-template` on `.panes`. A new pane or layout needs areas in every
  template. Adapt pane contents to width with `@container` on `.band`, never by
  checking `preset`.
- UI text is sentence case; no `text-transform: uppercase`. Header height is
  `--head`, which collapsed panes and drag minimums depend on.
- Coding agents (Claude, Codex, …) are entries in `PROVIDERS` in `agents.ts`;
  `sessions.ts` and the UI never name a specific agent.
- Ports: server `38471`, vite `38472`. `/mcp` only accepts `Host` of localhost
  or `forest-server.localhost`; keep that allowlist when touching the route.
- Agent tools come in tiers (`kind` in `tools.ts`): read (no `kind`, GET),
  `write` (undone by calling it again with the opposite value), and
  `destructive` (refuses in code anything that would lose work). Writes take
  POST, never GET. A tool's description is not a guard. Merge-now, close, push,
  discard, kill and `--force` stay UI-only. A write tool calls the same function
  as its UI route (`actions.ts`) and has a test for each refusal. README "Write
  tools" is the contract.
- API first: a fact about a worktree or repo (a PR, a ticket, a port) is a field
  on the row, resolved in `store.publish()` from its deps, so the SSE snapshot,
  the boot cache and the agent tools carry one value. The UI and `tools.ts` read
  rows; a fact computed only in one of them is invisible to the others. The boot
  cache is stale rows the server built, not a place to compute new ones.
