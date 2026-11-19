import { assertEquals } from "@std/assert";

const MAX_LINES = 700;
// Lower each entry as code moves out; delete it once the file is under the cap.
const RATCHET: Record<string, number> = { "App.svelte": 1637 };

// A layered module may import only modules in lower layers. Unknown modules are
// unlayered and unchecked.
const LAYERS = [
  ["prefs"],
  ["ui"],
  ["menu"],
  ["rows"],
  ["nav"],
  ["agents"],
  ["wtActions"],
  ["commands"],
];
const layerOf = (mod: string) => LAYERS.findIndex((l) => l.includes(mod));
const modName = (file: string) => file.replace(/(\.svelte)?\.js$/, "");

function upward(file: string, src: string): string[] {
  const own = layerOf(modName(file));
  if (own < 0) return [];
  const bad = [];
  for (
    const [, spec] of src.matchAll(
      /(?:from|import)\s*\(?\s*["']\.\/([\w.]+)["']/g,
    )
  ) {
    if (layerOf(modName(spec)) >= own) bad.push(`${file} imports ${spec}`);
  }
  return bad;
}

const srcFiles = [...Deno.readDirSync("src")].map((f) => f.name);

Deno.test("components stay under the size cap", () => {
  const over = srcFiles.filter((f) => f.endsWith(".svelte")).flatMap((f) => {
    const lines = Deno.readTextFileSync(`src/${f}`).split("\n").length - 1;
    return lines > (RATCHET[f] ?? MAX_LINES) ? [`${f}: ${lines}`] : [];
  });
  assertEquals(over, []);
});

Deno.test("stores import downward only", () => {
  assertEquals(
    upward("rows.svelte.js", `import { nav } from "./nav.svelte.js";`),
    [
      "rows.svelte.js imports nav.svelte.js",
    ],
  );
  assertEquals(upward("agents.svelte.js", `import "./wtActions.js";`), [
    "agents.svelte.js imports wtActions.js",
  ]);
  assertEquals(
    upward(
      "nav.svelte.js",
      `import { ui } from "./ui.svelte.js";\nimport "./parse.ts";`,
    ),
    [],
  );
  const bad = srcFiles.filter((f) => f.endsWith(".js")).flatMap((f) =>
    upward(f, Deno.readTextFileSync(`src/${f}`))
  );
  assertEquals(bad, []);
});
