# forest

Git worktree dashboard: Deno server, `main.ts` (wiring only) plus `exec`,
`repo`, `prs`, `ports`, `store`, `sse`, `watcher`, `files`, `themes`, `log`,
`tools`, `routes`, `stats`, `settings`, `types`, and a Svelte frontend in
`src/`. See README.md for setup and the agent API.

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
- Panes are one flat grid in `App.svelte`; each layout in `AXES`/`LAYOUTS` is a
  `grid-template` on `.panes`. A new pane or layout needs areas in every
  template. Adapt pane contents to width with `@container` on `.band`, never by
  checking `preset`.
- UI text is sentence case; no `text-transform: uppercase`. Header height is
  `--head`, which collapsed panes and drag minimums depend on.
- Ports: server `38471`, vite `38472`. `/mcp` only accepts `Host` of localhost
  or `forest-server.localhost`; keep that allowlist when touching the route.
- Nothing under `/api/t/` or `/mcp` writes; agent tools stay read-only.
