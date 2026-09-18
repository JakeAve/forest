import { basename, dirname, join } from "@std/path";
import { mergeInclude, parseThemeText } from "./src/theme.js";

export const vscodeExtDirs = (home: string) => [
  ...[".vscode", ".vscode-insiders", ".vscode-oss", ".cursor"].map((d) =>
    join(home, d, "extensions")
  ),
  ...[
    "Visual Studio Code",
    "Visual Studio Code - Insiders",
    "VSCodium",
    "Cursor",
  ]
    .map((a) => `/Applications/${a}.app/Contents/Resources/app/extensions`),
];

const readJson = (p: string) =>
  Deno.readTextFile(p).then(parseThemeText).catch(() => null);

export async function scanVsCodeThemes(
  extDirs: string[],
): Promise<{ name: string; path: string }[]> {
  const found = new Map<string, string>();
  for (const root of extDirs) {
    const dirs = await Array.fromAsync(Deno.readDir(root)).catch(() => []);
    for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(root, d.name);
      const pkg = await readJson(join(dir, "package.json"));
      const themes = pkg?.contributes?.themes;
      if (!Array.isArray(themes)) continue;
      const nls = await readJson(join(dir, "package.nls.json")) ?? {};
      for (const t of themes) {
        const label = String(t.label ?? t.id ?? basename(t.path, ".json"))
          .replace(/^%(.+)%$/, (_, k) => nls[k] ?? k)
          .replace(/[^\w .()+-]/g, " ").trim();
        found.set(label, join(dir, t.path));
      }
    }
  }
  return [...found].map(([name, path]) => ({ name, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadVsCodeTheme(path: string): Promise<unknown> {
  const t = parseThemeText(await Deno.readTextFile(path));
  if (typeof t.include !== "string") return t;
  return mergeInclude(await loadVsCodeTheme(join(dirname(path), t.include)), t);
}

export function guardThemeName(n: unknown): string {
  const s = String(n ?? "");
  if (!/^[\w .()+-]+$/.test(s) || s.includes("..")) {
    throw new Error("bad theme name");
  }
  return s;
}
