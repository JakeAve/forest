# forest

A dashboard for git worktrees across every repo in one directory. Scans a root
folder, finds each repo and its worktrees, and shows what's dirty, what's ahead
or behind, which has an open PR, and which is running a dev server right now —
with a built-in diff viewer you can stage, discard, and edit from.

Deno server + Svelte frontend. No database, no config to write by hand.

## Quick start

```sh
npm install       # frontend deps
npm run build     # builds dist/, which the server serves
deno task serve   # http://localhost:7420
```

Set `root` to the directory your repos live in — whatever that is on your
machine — via the ⚙ settings panel, or write it directly:

```sh
mkdir -p ~/.forest && echo '{"root":"~/your-repos-dir"}' > ~/.forest/settings.json
```

A leading `~` is expanded. The path is scanned one level deep: every immediate
subdirectory containing a `.git` counts as a repo.

`root` and `port` need a restart; everything else applies live.

## What it shows

Each worktree row carries its branch, dirty-file count, ahead/behind arrows,
listening ports (linked, click to open), open PR number, and last activity —
where activity means the newest of the HEAD commit and the mtime of any changed
or untracked file, so a worktree you're editing sorts to the top before you
commit anything.

Filter by branch name, or narrow to dirty-only / running-only. Right-click a
repo or worktree for open, copy path, copy remote branch, open remote branch,
and new worktree.

Selecting a worktree lists its changed files, either since the branch point
(merge-base with `origin/HEAD`) or just uncommitted. Selecting a file opens a
CodeMirror diff you can stage or discard by hunk, edit in place, and save —
saves are guarded by a compare-and-swap against what was on disk, so a
concurrent write returns 409 instead of clobbering.

Port detection reads `lsof` and maps listening PIDs to their cwd, then to the
owning worktree. PRs come from `gh pr list`, so PR badges need the `gh` CLI
authenticated; everything else works without it.

## Settings

Stored at `~/.forest/settings.json` — only values that differ from the defaults
are written.

| key               | default     |                                                |
| ----------------- | ----------- | ---------------------------------------------- |
| `port`            | `7420`      | server port (restart)                          |
| `host`            | `127.0.0.1` | address the server binds (restart)             |
| `root`            | `~/Repos`   | directory scanned for repos (restart)          |
| `pollMs`          | `5000`      | worktree rescan interval                       |
| `prPollMs`        | `60000`     | `gh pr list` interval                          |
| `recentCount`     | `10`        | rows in the Recent group                       |
| `agoRefreshMs`    | `30000`     | how often relative times re-render             |
| `toastMs`         | `7000`      | toast lifetime                                 |
| `collapseMargin`  | `3`         | context lines kept around a hunk               |
| `collapseMinSize` | `5`         | shortest run of unchanged lines that collapses |
| `launchers`       | `{}`        | per-repo worktree-creation commands            |

`host` defaults to loopback for a reason: setting it to `0.0.0.0` serves your
repository metadata — paths, branches, diffs — and the unauthenticated `/mcp`
endpoint to everything on the LAN.

### Launchers

By default, "new worktree" runs `git worktree add <repo>-wt/<slug> -b <slug>`.
If a repo needs setup beyond that — copying an `.env`, installing deps — give it
a command template. Tokens `{slug}`, `{repo}`, `{path}`, `{root}` are
substituted; `*` is the fallback for repos without their own entry.

```json
{ "launchers": { "*": "./scripts/new-worktree.sh {slug}" } }
```

## Themes

Ships a default dark theme and imports any VS Code color theme — either a JSON
file you pick, or one VS Code already has installed (it scans VS Code, Insiders,
VSCodium, and Cursor extension dirs). Imported themes land in
`~/.forest/themes/`. Contrast is derived rather than trusted, so a theme whose
accent vanishes against its own background gets a readable fallback instead.

## Development

```sh
npm run dev       # vite on :5173, proxies /api to the deno server on :7420
deno task serve   # run this alongside it
```

```sh
deno task check   # fmt + lint + typecheck
deno task test    # 42 unit tests, no network or fixtures
deno task setup   # wire .githooks (check + test on commit and push)
```

Parsing is deliberately split out of `main.ts` into `parse.ts`, `src/theme.js`,
and `src/filter.js` — that's the part with edge cases worth testing, and it's
testable without spawning git.

## Desktop app

```sh
deno task desktop   # builds Forest.app via `deno desktop`
```

Same server, wrapped in a native window with a transparent titlebar. Cmd +/-/0
zoom only in that build.
