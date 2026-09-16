// VS Code theme colors -> our CSS vars. In each chain the first key
// that parses as a color wins; "--" entries reference already-resolved vars.
// Vars left unresolved fall through to the default theme in app.css.
const CHAINS = {
  "--bg": ["editor.background"],
  "--bg2": ["sideBar.background", "editorGroupHeader.tabsBackground", "--bg"],
  "--bg3": [
    "titleBar.activeBackground",
    "editorGroupHeader.tabsBackground",
    "--bg2",
  ],
  "--fg": ["editor.foreground", "foreground"],
  "--dim": ["descriptionForeground", "editorLineNumber.foreground"],
  "--dimmer": ["editorLineNumber.foreground", "descriptionForeground"],
  "--line": [
    "panel.border",
    "editorGroup.border",
    "sideBar.border",
    "contrastBorder",
  ],
  "--hl": [
    "list.activeSelectionBackground",
    "list.hoverBackground",
    "editor.selectionBackground",
    "selection.background",
  ],
  "--hlfg": ["list.activeSelectionForeground", "--fg"],
  "--hov": ["list.hoverBackground"],
  "--acc": [
    "activityBarBadge.background",
    "textLink.foreground",
    "progressBar.background",
    "button.background",
    "focusBorder",
  ],
  "--add": [
    "diffEditor.insertedLineBackground",
    "diffEditor.insertedTextBackground",
  ],
  "--del": [
    "diffEditor.removedLineBackground",
    "diffEditor.removedTextBackground",
  ],
  "--addfg": [
    "gitDecoration.addedResourceForeground",
    "diffEditor.insertedTextBorder",
    "terminal.ansiGreen",
  ],
  "--delfg": [
    "gitDecoration.deletedResourceForeground",
    "diffEditor.removedTextBorder",
    "terminal.ansiRed",
  ],
  "--warn": [
    "gitDecoration.modifiedResourceForeground",
    "editorWarning.foreground",
    "terminal.ansiYellow",
  ],
  "--untr": ["gitDecoration.untrackedResourceForeground"],
  "--danger": ["editorError.foreground", "errorForeground"],
  "--input": ["input.background", "--bg"],
  "--tk-kw": ["terminal.ansiMagenta"],
  "--tk-str": ["terminal.ansiGreen"],
  "--tk-num": ["terminal.ansiRed"],
  "--tk-fn": ["terminal.ansiBlue"],
  "--tk-ty": ["terminal.ansiYellow"],
  "--tk-prop": ["terminal.ansiCyan"],
  "--tk-op": ["--acc"],
  "--tk-bad": ["--danger"],
  "--merged": ["charts.purple", "terminal.ansiMagenta", "--tk-kw"],
};

// Surfaces may legitimately equal --bg; anything drawn on a surface may not.
const SURFACES = new Set([
  "--bg",
  "--bg2",
  "--bg3",
  "--input",
  "--hl",
  "--hov",
]);

// app.css defaults are dark; a light theme that leaves these unresolved gets these.
const LIGHT = {
  "--addfg": "#1a7f37",
  "--delfg": "#cf222e",
  "--warn": "#9a6700",
  "--tk-kw": "#8250df",
  "--tk-str": "#0a3069",
  "--tk-num": "#0550ae",
  "--tk-fn": "#6639ba",
  "--tk-ty": "#953800",
  "--tk-prop": "#116329",
  "--tk-op": "#0550ae",
  "--tk-bad": "#cf222e",
  "--merged": "#8250df",
};

// VS Code themes may "include" a base file; the child's colors win.
export function mergeInclude(base, child) {
  const { include: _, ...rest } = child;
  return { ...base, ...rest, colors: { ...base.colors, ...child.colors } };
}

export function stripJsonc(text) {
  let out = "", i = 0, str = false;
  while (i < text.length) {
    const c = text[i];
    if (str) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') str = false;
      i++;
    } else if (c === '"') {
      str = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      if (c === "}" || c === "]") out = out.replace(/,\s*$/, "");
      out += c;
      i++;
    }
  }
  return out;
}

export const parseThemeText = (text) => JSON.parse(stripJsonc(text));

function parseColor(s) {
  const m = typeof s === "string" && s.match(/^#([0-9a-f]{3,8})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const n = parseInt(h, 16);
  return h.length === 6
    ? [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
    : [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, (n & 255) / 255];
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = (v) => clamp(v).toString(16).padStart(2, "0");
const toHex = ([r, g, b, a = 1]) =>
  `#${hex2(r)}${hex2(g)}${hex2(b)}${a >= 1 ? "" : hex2(a * 255)}`;

function lum([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const mix = (a, b, t) => a.map((v, i) => (i < 3 ? v + (b[i] - v) * t : v));

export function contrast(a, b) {
  const B = parseColor(b), A = mix(B, parseColor(a), parseColor(a)[3]);
  const [hi, lo] = [lum(A), lum(B)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function shift(hexColor, pct, dark) {
  const c = parseColor(hexColor);
  const d = Math.round(255 * pct) * (dark ? 1 : -1);
  return toHex([c[0] + d, c[1] + d, c[2] + d, c[3]]);
}

export function resolveTheme(theme) {
  const colors = theme.colors ?? {};
  const vars = /** @type {Record<string, string>} */ ({});
  for (const [v, chain] of Object.entries(CHAINS)) {
    for (const k of chain) {
      const val = k.startsWith("--") ? vars[k] : colors[k];
      if (!parseColor(val)) continue;
      if (SURFACES.has(v) || contrast(val, vars["--bg"] ?? val) >= 1.5) {
        vars[v] = val;
        break;
      }
    }
  }
  if (!vars["--bg"]) {
    throw new Error("no editor.background — not a VS Code color theme");
  }
  const dark = lum(parseColor(vars["--bg"])) < 0.5;
  const same = (a, b) =>
    a && b && toHex(parseColor(a)) === toHex(parseColor(b));
  const b2raw = vars["--bg2"], b3raw = vars["--bg3"];
  if (same(b2raw, vars["--bg"])) {
    vars["--bg2"] = shift(vars["--bg"], 0.03, dark);
  }
  if (same(b3raw, b2raw)) vars["--bg3"] = shift(vars["--bg2"], 0.02, dark);
  if (!vars["--hl"]) vars["--hl"] = shift(vars["--bg"], 0.16, dark);
  if (!vars["--hov"]) vars["--hov"] = vars["--bg3"];
  if (!dark) { for (const [k, c] of Object.entries(LIGHT)) vars[k] ??= c; }
  if (vars["--fg"]) {
    const f = parseColor(vars["--fg"]), g = parseColor(vars["--bg"]);
    if (!vars["--dim"]) vars["--dim"] = toHex(mix(f, g, 0.42));
    if (!vars["--dimmer"]) vars["--dimmer"] = toHex(mix(f, g, 0.62));
  }
  for (const [bgv, fgv] of [["--add", "--addfg"], ["--del", "--delfg"]]) {
    if (!vars[bgv] && vars[fgv]) {
      const c = parseColor(vars[fgv]);
      vars[bgv] = toHex([c[0], c[1], c[2], 0.16]);
    }
  }
  if (!vars["--untr"] && vars["--dim"]) vars["--untr"] = vars["--dim"];
  if (!vars["--merged"] && vars["--dim"]) vars["--merged"] = vars["--dim"];
  if (vars["--dim"]) vars["--tk-cm"] = vars["--dim"];
  return { vars, dark };
}
