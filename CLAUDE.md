# forest

Git worktree dashboard: Deno server (`main.ts`) + Svelte frontend (`src/`). See
README.md for setup and the agent API.

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
- Put logic with edge cases in `parse.ts`, `src/theme.js` or `src/filter.js` so
  it's testable without spawning git; `main.ts` stays glue.
- Colors and CSS vars: follow the `theming` skill in `.claude/skills/`.
- Ports: server `38471`, vite `38472`. `/mcp` only accepts `Host` of localhost
  or `forest-server.localhost`; keep that allowlist when touching the route.
- Nothing under `/api/t/` or `/mcp` writes; agent tools stay read-only.
