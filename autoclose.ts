import { dirname } from "@std/path";
import { doneAction } from "./parse.ts";
import type { StoreApi } from "./store.ts";
import type { TicketsApi } from "./tickets.ts";
import type { AutoClose } from "./types.ts";

export type AutoCloseApi = {
  load(): Promise<void>;
  set(wt: string, on: boolean): Promise<void>;
  status(wt: string): AutoClose | null;
  tick(): Promise<void>;
};

// Opted-in worktrees move their ticket to its done status once their PR
// merges, through the same ticket command as the card's buttons, then switch
// off. Runs on every snapshot, so it acts as soon as Forest sees the merge. A
// failure stays on the row until it is switched off and on again.
export function createAutoClose(
  { store, tickets, path, log }: {
    store: Pick<StoreApi, "byPath" | "known" | "publish">;
    tickets: Pick<TicketsApi, "act">;
    path: string;
    log: (o: Record<string, unknown>) => void;
  },
): AutoCloseApi {
  const on = new Map<string, string | null>(); // wt -> error
  const busy = new Set<string>();

  const save = async () => {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify([...on.keys()], null, 2) + "\n",
    );
  };

  async function close(wt: string) {
    const repo = store.byPath.get(store.known.get(wt) ?? "");
    const w = repo?.worktrees.find((w) => w.path === wt);
    if (!repo || w?.pr?.state !== "MERGED") return false;
    if (!w.ticket) throw new Error("no ticket");
    const info = w.ticket.info;
    if (!info) return false; // not read yet
    if (info.category !== "done" && info.category !== "canceled") {
      const to = doneAction(info);
      if (!to) throw new Error(`no done status offered for ${w.ticket.key}`);
      await tickets.act(repo.path, repo.name, w.ticket.key, to, w.pr.url);
      log({ type: "autoClose", wt, ticket: w.ticket.key, to });
    }
    return true;
  }

  async function tick() {
    for (const [wt, error] of on) {
      if (error !== null || busy.has(wt)) continue;
      busy.add(wt);
      try {
        if (!await close(wt)) continue;
        on.delete(wt);
        await save();
      } catch (e) {
        const error = (e as Error).message;
        on.set(wt, error);
        log({ type: "autoClose", wt, error });
      } finally {
        busy.delete(wt);
      }
      store.publish();
    }
  }

  return {
    load: async () => {
      const saved = await Deno.readTextFile(path).then(JSON.parse).catch(
        () => [],
      );
      for (const p of saved) if (typeof p === "string") on.set(p, null);
    },
    set: async (wt, enable) => {
      if (enable) on.set(wt, null);
      else on.delete(wt);
      for (const p of on.keys()) if (!store.known.has(p)) on.delete(p);
      await save();
      store.publish();
    },
    status: (wt) => on.has(wt) ? { on: true, error: on.get(wt)! } : null,
    tick,
  };
}
