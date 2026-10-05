import { dirname } from "@std/path";
import type { PrsApi } from "./prs.ts";
import type { StoreApi } from "./store.ts";

const V = 1;

export type CacheApi = {
  load(): Promise<void>;
  save(json: string): void;
  flush(): Promise<void>;
};

// A reader never sees a half-written file: a crash leaves the old one whole.
export async function writeFileAtomic(path: string, text: string) {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path + ".tmp", text);
  await Deno.rename(path + ".tmp", path);
}

// The last snapshot, on disk, so a boot can paint before its first sweep. The
// sweep then replaces every entry, so nothing here has to be invalidated.
export function createCache(
  { path, store, prs, log, delayMs = 2000 }: {
    path: string;
    store: Pick<StoreApi, "byPath" | "publish">;
    prs: Pick<PrsApi, "restore">;
    log: (o: Record<string, unknown>) => void;
    delayMs?: number;
  },
): CacheApi {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Chained, so a flush also waits out a write the timer already started.
  let writing: Promise<void> = Promise.resolve();

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (pending !== null) {
      const body = `{"v":${V},"repos":${pending}}`;
      pending = null;
      writing = writing.catch(() => {}).then(() => writeFileAtomic(path, body));
    }
    return writing;
  }

  return {
    async load() {
      const c = await Deno.readTextFile(path).then(JSON.parse).catch(() =>
        null
      );
      if (c?.v !== V || !Array.isArray(c.repos)) return;
      try {
        for (const r of c.repos) store.byPath.set(r.path, r);
        prs.restore(c.repos);
        store.publish();
      } catch (e) {
        store.byPath.clear();
        log({ type: "cache-error", error: String(e) });
      }
    },
    // Not a trailing debounce: under a steady stream that would never write.
    save(json) {
      pending = json;
      timer ??= setTimeout(
        () =>
          flush().catch((e) => log({ type: "cache-error", error: String(e) })),
        delayMs,
      );
    },
    flush,
  };
}
