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

## Check a theme

```bash
deno eval 'import {parseThemeText,resolveTheme} from "./src/theme.js"; console.log(resolveTheme(parseThemeText(Deno.readTextFileSync(Deno.args[0]))))' -- ~/.vscode/extensions/<ext>/themes/<file>.json
```

Then `deno test -A theme_test.ts`. The 8-Bit palettes in that file are the contrast gate;
a theme with every surface equal to the editor bg is the worst case, so a change that
passes there passes everywhere.
