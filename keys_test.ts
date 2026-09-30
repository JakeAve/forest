import { assertEquals } from "@std/assert";
import { combo, label, norm, resolve } from "./src/keys.js";

const ev = (code: string, mods: Record<string, boolean> = {}) => ({
  code,
  ...mods,
});

Deno.test("combo: physical key, modifiers in fixed order", () => {
  assertEquals(combo(ev("KeyC", { metaKey: true, altKey: true })), "alt+cmd+c");
  assertEquals(
    combo(ev("Equal", { shiftKey: true, metaKey: true })),
    "shift+cmd+equal",
  );
  assertEquals(combo(ev("Digit0", { metaKey: true })), "cmd+0");
  assertEquals(combo(ev("Escape")), "escape");
});

Deno.test("combo: bare modifier or missing code is no combo", () => {
  assertEquals(combo(ev("ShiftLeft", { shiftKey: true })), null);
  assertEquals(combo(ev("MetaRight", { metaKey: true })), null);
  assertEquals(combo(ev("")), null);
});

Deno.test("norm: aliases, case and order", () => {
  assertEquals(norm("Cmd+Shift+C"), "shift+cmd+c");
  assertEquals(norm(" option + meta + c "), "alt+cmd+c");
  assertEquals(norm("k"), "k");
});

Deno.test("label: mac glyphs", () => {
  assertEquals(label("alt+shift+cmd+c"), "⌥⇧⌘C");
  assertEquals(label("cmd+equal"), "⌘=");
  assertEquals(label("f10"), "F10");
  assertEquals(label("cmd+numpadadd"), "⌘+");
  assertEquals(label("cmd+numpad0"), "⌘0");
});

const C = [
  { id: "palette", keys: "cmd+k, cmd+p" },
  { id: "open", keys: "cmd+o" },
  { id: "bare" },
];

Deno.test("resolve: defaults, several keys per command", () => {
  const { byId, byCombo } = resolve(C);
  assertEquals(byId, {
    palette: ["cmd+k", "cmd+p"],
    open: ["cmd+o"],
    bare: [],
  });
  assertEquals(byCombo.get("cmd+p"), "palette");
});

Deno.test("resolve: an override replaces the default and wins a shared key", () => {
  const { byId, byCombo } = resolve(C, { open: "cmd+p", bare: "Shift+Cmd+B" });
  assertEquals(byId, {
    palette: ["cmd+k"],
    open: ["cmd+p"],
    bare: ["shift+cmd+b"],
  });
  assertEquals(byCombo.get("cmd+p"), "open");
  assertEquals(byCombo.has("cmd+o"), false);
});
