import { assertEquals, assertThrows } from "@std/assert";
import {
  contrast,
  mergeInclude,
  parseThemeText,
  resolveTheme,
  stripJsonc,
} from "./src/theme.js";

const t = (colors: Record<string, string>) => resolveTheme({ colors });

Deno.test("jsonc: comments and trailing commas stripped, strings intact", () => {
  const text = `{
    // line comment
    "url": "http://x", /* block */
    "list": [1, 2,],
  }`;
  assertEquals(parseThemeText(text), { url: "http://x", list: [1, 2] });
  assertEquals(stripJsonc(`{"a": "b,]"}`), `{"a": "b,]"}`);
});

Deno.test("chain picks first present key", () => {
  const { vars } = t({
    "editor.background": "#111111",
    "editorGroupHeader.tabsBackground": "#222222",
    "activityBarBadge.background": "#ff0000",
    "focusBorder": "#333333",
  });
  assertEquals(vars["--bg2"], "#222222");
  assertEquals(vars["--acc"], "#ff0000");
});

Deno.test("bg2/bg3 equal to bg get shifted apart, dark goes lighter", () => {
  const { vars, dark } = t({ "editor.background": "#101010" });
  assertEquals(dark, true);
  assertEquals(vars["--bg2"], "#181818");
  assertEquals(vars["--bg3"], "#1d1d1d");
});

Deno.test("light theme shifts darker", () => {
  const { vars, dark } = t({ "editor.background": "#ffffff" });
  assertEquals(dark, false);
  assertEquals(vars["--bg2"], "#f7f7f7");
});

Deno.test("missing dim/dimmer mix fg toward bg", () => {
  const { vars } = t({
    "editor.background": "#000000",
    "editor.foreground": "#ffffff",
  });
  assertEquals(vars["--dim"], "#949494");
  assertEquals(vars["--dimmer"], "#616161");
});

Deno.test("tk-cm blends fg halfway toward bg, even when the theme sets dim", () => {
  const { vars } = t({
    "editor.background": "#000000",
    "editor.foreground": "#ffffff",
    "descriptionForeground": "#ffffff",
  });
  assertEquals(vars["--tk-cm"], "#808080");
});

Deno.test("missing add/del derive from gitDecoration fg at 16% alpha", () => {
  const { vars } = t({
    "editor.background": "#000000",
    "gitDecoration.addedResourceForeground": "#00ff00",
  });
  assertEquals(vars["--add"], "#00ff0029");
});

Deno.test("no editor.background is rejected", () => {
  assertThrows(() => t({ foreground: "#ffffff" }));
});

Deno.test("a candidate that vanishes against bg is skipped", () => {
  const { vars } = t({
    "editor.background": "#000000",
    "activityBarBadge.background": "#000000",
    "textLink.foreground": "#00ffff",
  });
  assertEquals(vars["--acc"], "#00ffff");
});

Deno.test("light theme: light fallbacks, hl/hov derived from bg", () => {
  const { vars } = t({
    "editor.background": "#ffffff",
    "editor.foreground": "#000000",
  });
  assertEquals(vars["--addfg"], "#1a7f37");
  assertEquals(vars["--hl"], "#d6d6d6");
  assertEquals(vars["--hov"], vars["--bg3"]);
});

// 8-Bit (handsomeone.8bit): every UI surface is the editor bg and the badge
// bg equals it too. Text vars must still read against every surface.
const EIGHT_BIT = {
  dark: {
    "editor.background": "#000",
    "editor.foreground": "#FFF",
    "descriptionForeground": "#FFF",
    "editorLineNumber.foreground": "#FFF",
    "sideBar.background": "#000",
    "activityBarBadge.background": "#000",
    "textLink.foreground": "#0FF",
    "focusBorder": "#FF0",
    "contrastBorder": "#0FF",
    "selection.background": "#00F",
    "errorForeground": "#F00",
    "diffEditor.insertedTextBorder": "#0F0",
    "diffEditor.removedTextBorder": "#F00",
    "terminal.ansiYellow": "#FF0",
  },
  light: {
    "editor.background": "#FFF",
    "editor.foreground": "#000",
    "descriptionForeground": "#000",
    "editorLineNumber.foreground": "#000",
    "sideBar.background": "#FFF",
    "activityBarBadge.background": "#FFF",
    "textLink.foreground": "#0BF",
    "focusBorder": "#00F",
    "contrastBorder": "#00F",
    "selection.background": "#FF0",
    "errorForeground": "#F00",
    "diffEditor.insertedTextBorder": "#0B0",
    "diffEditor.removedTextBorder": "#F00",
    "terminal.ansiYellow": "#FF0",
  },
};
const TEXT = [
  "--fg",
  "--dim",
  "--dimmer",
  "--acc",
  "--warn",
  "--danger",
  "--merged",
  "--tk-cm",
];
const SURFACE = ["--bg", "--bg2", "--bg3", "--input", "--hov"];

for (const [name, colors] of Object.entries(EIGHT_BIT)) {
  Deno.test(`8bit ${name}: text reads against every surface`, () => {
    const { vars } = t(colors);
    for (const tx of TEXT) {
      for (const sf of SURFACE) {
        const c = contrast(vars[tx], vars[sf]);
        if (c < 1.8) throw new Error(`${tx} on ${sf}: ${c.toFixed(2)}`);
      }
    }
    if (contrast(vars["--hlfg"], vars["--hl"]) < 1.8) {
      throw new Error("hlfg on hl");
    }
  });
}

Deno.test("mergeInclude: child colors win, include key dropped", () => {
  const base = {
    name: "b",
    colors: { "editor.background": "#000", "foreground": "#fff" },
  };
  const child = {
    name: "c",
    include: "./b.json",
    colors: { foreground: "#eee" },
  };
  assertEquals(mergeInclude(base, child), {
    name: "c",
    colors: { "editor.background": "#000", foreground: "#eee" },
  });
});
