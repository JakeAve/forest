const MODS = ["ctrl", "alt", "shift", "cmd"];
const ALIAS = { meta: "cmd", command: "cmd", option: "alt", control: "ctrl" };
const GLYPH = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  cmd: "⌘",
  minus: "-",
  numpadadd: "+",
  numpadsubtract: "-",
  equal: "=",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  bracketleft: "[",
  bracketright: "]",
  enter: "↩",
  escape: "⎋",
  backspace: "⌫",
  tab: "⇥",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

// ponytail: matches the physical key (e.code) so ⌥ can't turn C into ç; non-QWERTY layouts get QWERTY positions.
export function combo(e) {
  const key = e.code?.replace(/^(Key|Digit)/, "").toLowerCase();
  if (!key || /^(meta|os|alt|shift|control)(left|right)?$/.test(key)) {
    return null;
  }
  const on = {
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    cmd: e.metaKey,
  };
  return [...MODS.filter((m) => on[m]), key].join("+");
}

export function norm(s) {
  const parts = s.toLowerCase().split("+").map((p) =>
    ALIAS[p.trim()] ?? p.trim()
  );
  const key = parts.pop();
  return [...MODS.filter((m) => parts.includes(m)), key].join("+");
}

export const label = (c) =>
  c.split("+").map((p) =>
    GLYPH[p] ?? p.replace(/^numpad(\d)$/, "$1").toUpperCase()
  ).join("");

export function resolve(commands, overrides = {}) {
  const own = (id) => Object.hasOwn(overrides, id);
  const byId = Object.fromEntries(commands.map((c) => [
    c.id,
    (own(c.id) ? overrides[c.id] : c.keys ?? "").split(",").map((s) => s.trim())
      .filter(Boolean).map(norm),
  ]));
  const byCombo = new Map();
  for (const c of [...commands].sort((a, b) => own(a.id) - own(b.id))) {
    for (const k of byId[c.id]) byCombo.set(k, c.id);
  }
  for (const id in byId) {
    byId[id] = byId[id].filter((k) => byCombo.get(k) === id);
  }
  return { byId, byCombo };
}
