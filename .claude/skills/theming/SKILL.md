---
name: theming
description: Rules for any change that touches color, CSS vars, or VS Code theme import in Forest. Use when adding UI that needs a color, adding or renaming a --var, editing src/theme.js or src/app.css, or checking a VS Code theme for contrast.
---

# Theming

All color is a CSS var on `:root` in `src/app.css`. Imported VS Code themes overwrite those
vars through `resolveTheme` in `src/theme.js`; the mapping lives in its `CHAINS` and
`LIGHT`, and `theme_test.ts` pins it — keep the two in sync.

## Rules

- Never write a literal color, `rgba()`, or named color in `.svelte`/`.css`. Use a var, or
  `color-mix(in srgb, var(--x) N%, var(--y))` for a tint.
- Never use `opacity` to make text secondary. Use `--dim` / `--dimmer`; opacity breaks
  contrast on themes where the surfaces are already at the extremes.
- Surfaces are `SURFACES` in `src/theme.js`: `--bg --bg2 --bg3 --input --hl --hov`.
  Everything else is drawn on a surface and must read against all of them.
- Adding a var means all three: default in `app.css`, a chain in `CHAINS`, a light value
  in `LIGHT` if it is a foreground. Then extend `TEXT`/`SURFACE` in `theme_test.ts`.
- Chain order: identity color first, generic border/focus keys last. A candidate that does
  not reach 1.5:1 against `--bg` is skipped automatically; do not special-case a theme.
- Missing keys are repaired, not defaulted: derive from a sibling var (`shift`, `mix`,
  alpha) so the result follows the theme's own palette.
- Unusable keys count as missing. `--dim`/`--dimmer` under 1.3:1 against `--fg` are
  re-mixed from `--fg`, so text keeps three steps. `--line` over 3:1 against `--bg` (or
  absent) becomes `shift(--bg, 0.08)`, so borders stay hairlines.
- Agent badges use `--agent-a`/`--agent-b`, named by `tone` in `PROVIDERS` (`agents.ts`).
  A new provider takes one of these or a new `--agent-*` var, never a `--tk-*` one.

## Status tones

A status says two things: what it means (tone) and how loud it is (weight). `data-tone`
sets `--tone` and the text color. A `t-*` class from `app.css` sets the weight. Both are
defined once in `app.css`, and `theme_test.ts` fails if a component maps a tone itself.

| Tone | Var | Means |
|---|---|---|
| `ok` | `--acc` | ready, passed, approved, in progress |
| `warn` | `--warn` | running, pending, dirty, behind |
| `bad` | `--danger` | failing, conflicts, changes requested, errors |
| `ask` | `--fg` | waiting on a person (needs review) |
| `done` | `--merged` | merged, ticket done |
| `off` | `--dim` | draft, closed, skipped, canceled, quiet |

| Weight | Class | Use |
|---|---|---|
| text | (none) | inline in cards and lists |
| pill | `t-pill` | loud status in a row |
| edge | `t-edge` | status label in a card header |
| solid | `t-solid` | the PR number chip |
| band | `t-band` | banners |

- `off` is never filled: every treatment draws it hollow and dashed. `ask` and `off` are
  both neutral, and `--dim` may sit only 1.3:1 from `--fg`, so shape tells them apart,
  not color.
- Tints use the ladder `--wash` / `--edge` / `--ink`, not a new percentage.
- A new tone needs a reason no existing one covers, a hue that doesn't collide with
  `--agent-*`, and a row in both tables above.

## Check a theme

```bash
deno eval 'import {parseThemeText,resolveTheme} from "./src/theme.js"; console.log(resolveTheme(parseThemeText(Deno.readTextFileSync(Deno.args[0]))))' -- ~/.vscode/extensions/<ext>/themes/<file>.json
```

Then `deno test -A theme_test.ts`. The 8-Bit palettes in that file are the contrast gate;
a theme with every surface equal to the editor bg is the worst case, so a change that
passes there passes everywhere.
