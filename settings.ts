import { dirname } from "@std/path";
import { settingsOverrides } from "./parse.ts";

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 38471,
  root: "~/Repos",
  pollMs: 5000,
  prPollMs: 60000, // a repo with an open PR: only that state can still change
  prIdleMs: 300000, // a repo without one: catches PRs opened outside this machine
  autoRebaseMs: 300000, // how often opted-in worktrees follow origin/HEAD
  watch: true,
  watchDebounceMs: 300,
  watchMaxWaitMs: 2000,
  watchSweepMs: 300000,
  watchHotThreshold: 10,
  watchBackoffMaxMs: 30000,
  watchStormRate: 2000,
  recentCount: 10,
  agoRefreshMs: 30000,
  toastMs: 7000,
  collapseMargin: 3,
  collapseMinSize: 5,
  launchers: {} as Record<string, string>,
};

export type Settings = typeof DEFAULTS;

export const loadSettings = async (path: string): Promise<Settings> => ({
  ...DEFAULTS,
  ...(await Deno.readTextFile(path).then(JSON.parse).catch(() => ({}))),
});

export async function saveSettings(path: string, s: Settings): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify(settingsOverrides(DEFAULTS, s), null, 2) + "\n",
  );
}
