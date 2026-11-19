---
paths: ["src/**/*.svelte", "src/**/*.svelte.js", "src/app.css"]
---

- Frontend layout: `App.svelte` is the shell — title bar, the `.panes` grid, the
  `.band` wrappers, gutters, and wiring effects (SSE, clock, URL). A feature
  never adds `$state` or markup to it unless it is a new pane or layout.
- Split a `.svelte` file when it passes ~500 lines, or when it gains a second
  responsibility (a second popover, dialog, list or a block with its own state).
  `ui_test.ts` fails any component over 700.
- State read by more than one component lives in a `src/*.svelte.js` module as
  one exported class instance (`$state`/`$derived` fields) plus plain functions;
  no props drilling, no context. State one component uses stays in it. Modules
  import downward only: prefs ← ui ← menu ← rows ← nav ← agents ← wtActions
  ← commands ← components (`ui_test.ts` enforces it). No `$effect` in modules.
- `.svelte` and `.svelte.js` files hold no logic with edge cases: tests can't
  import them. Formatting, parsing, ranking and layout math go in `parse.ts`,
  `src/filter.js`, `src/theme.js` or `src/keys.js` with a test.
- CSS: a class used by two components is defined once in `src/app.css`
  (controls: `.btn`, `.circ`, `.seg`, `.cbx`, `.ctx`, `.bhead`, …); everything
  else is scoped in its component. No `:global` except for classes set on
  `<html>` or DOM a library renders. A parent never styles a child's insides.
- A snippet is for markup repeated inside one file with no state of its own.
  Anything with its own state, effect or over ~40 lines of markup is a component.
  Parents call into a child through functions it exports (`bind:this`), and
  children report up through `on*` props.
- Menu items name their shortcut by command id (`cmd`), never by calling
  `kbdOf`. Commands live in `src/commands.svelte.js`.
- Components stay flat in `src/` (`theme_test.ts` scans `src/*.svelte`).
