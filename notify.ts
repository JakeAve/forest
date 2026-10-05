import { type Draft, edges, type Facts, facts, snoozeKey } from "./parse.ts";
import { writeFileAtomic } from "./cache.ts";
import type { Shell } from "./exec.ts";
import type { Settings } from "./settings.ts";
import type { SseApi } from "./sse.ts";
import type { Repo } from "./types.ts";

export type Ev = Draft & { id: string; at: number; readAt: number | null };
export type Snooze = { key: string; at: number };

export type InboxStore = {
  load(): Promise<{ events: Ev[]; snoozes: Snooze[] }>;
  append(evs: Ev[]): Promise<void>;
  update(ids: string[], patch: Partial<Pick<Ev, "readAt">>): Promise<void>;
  snooze(s: Snooze): Promise<void>;
  unsnooze(key: string): Promise<void>;
  trim(max: number): Promise<void>;
};

export type NotifyApi = {
  load(): Promise<void>;
  observe(json: string): void;
  tick(): void;
  list(): Ev[];
  read(ids: string[] | "all"): Promise<void>;
  snooze(key: string): Promise<void>;
};

// Oldest first, like an append-only log.
export function memoryInbox(): InboxStore {
  let events: Ev[] = [];
  let snoozes: Snooze[] = [];
  return {
    load: () =>
      Promise.resolve({
        events: events.map((e) => ({ ...e })),
        snoozes: snoozes.map((s) => ({ ...s })),
      }),
    append(evs) {
      events.push(...evs.map((e) => ({ ...e })));
      return Promise.resolve();
    },
    update(ids, patch) {
      const set = new Set(ids);
      for (const e of events) if (set.has(e.id)) Object.assign(e, patch);
      return Promise.resolve();
    },
    snooze(s) {
      snoozes = [...snoozes.filter((x) => x.key !== s.key), { ...s }];
      return Promise.resolve();
    },
    unsnooze(key) {
      snoozes = snoozes.filter((s) => s.key !== key);
      return Promise.resolve();
    },
    trim(max) {
      events = events.slice(Math.max(0, events.length - max));
      return Promise.resolve();
    },
  };
}

// memoryInbox, written whole to one file after every change.
// ponytail: rewrites the file per op; fine at notifyMax rows
export function fileInbox(path: string): InboxStore {
  const mem = memoryInbox();
  let seeded = false;
  const save = async () =>
    writeFileAtomic(path, JSON.stringify(await mem.load()));
  return {
    async load() {
      if (!seeded) {
        seeded = true;
        const s = await Deno.readTextFile(path).then(JSON.parse).catch(() =>
          null
        );
        if (Array.isArray(s?.events)) await mem.append(s.events);
        if (Array.isArray(s?.snoozes)) {
          for (const z of s.snoozes) await mem.snooze(z);
        }
      }
      return mem.load();
    },
    append: (evs) => mem.append(evs).then(save),
    update: (ids, patch) => mem.update(ids, patch).then(save),
    snooze: (s) => mem.snooze(s).then(save),
    unsnooze: (key) => mem.unsnooze(key).then(save),
    trim: (max) => mem.trim(max).then(save),
  };
}

const DELIVER = new Set(["app", "os", "both"]);
const EMPTY: Facts = { active: new Map(), known: new Set() };

export function createNotify(
  { sh, settings, sse, inbox, now, os, log }: {
    sh: Shell;
    settings: Settings;
    sse: Pick<SseApi, "emit">;
    inbox: InboxStore;
    now: () => number;
    os: boolean;
    log: (o: Record<string, unknown>) => void;
  },
): NotifyApi {
  let events: Ev[] = []; // newest first
  const snoozed = new Set<string>();
  let last: Repo[] = [];
  let prev = EMPTY;
  let osFailed = false;
  // Serialized so a disk-backed store sees ops in the order they were made.
  let queue: Promise<void> = Promise.resolve();
  const write = (op: () => Promise<void>) =>
    queue = queue.then(op).catch((e) =>
      log({ type: "notify-inbox-error", error: String(e) })
    );

  const deliver = (d: Draft) => {
    const v = settings.notify?.[d.kind];
    return DELIVER.has(v) ? v : "off";
  };

  function osNotify(evs: Ev[]) {
    if (!os || !evs.length) return;
    const [body, title] = evs.length === 1 ? [evs[0].body, evs[0].title] : [
      [...new Set(evs.map((e) => e.repo.slice(e.repo.lastIndexOf("/") + 1)))]
        .join(", "),
      `Forest: ${evs.length} updates`,
    ];
    sh.exec("/", [
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e",
      "end run",
      "--",
      body,
      title,
    ]).catch((e) => {
      if (osFailed) return;
      osFailed = true;
      log({ type: "notify-os-error", error: String(e) });
    });
  }

  function cycle() {
    try {
      run();
    } catch (e) {
      log({ type: "notify-error", error: String(e) });
    }
  }

  function run() {
    const next = facts(last, {
      now: now(),
      ciStuckMin: settings.notifyCiStuckMin,
      halfDoneMin: settings.notifyHalfDoneMin,
      staleDirtyDays: settings.notifyStaleDirtyDays,
      unpushedHours: settings.notifyUnpushedHours,
    });
    const muted = new Set(
      Array.isArray(settings.notifyMuted) ? settings.notifyMuted : [],
    );
    const at = now();
    const kept: Ev[] = edges(prev, next)
      .filter((d) =>
        deliver(d) !== "off" && !muted.has(d.repo) &&
        !(d.wt && muted.has(d.wt)) && !snoozed.has(snoozeKey(d))
      )
      .map((d) => ({ ...d, id: crypto.randomUUID(), at, readAt: null }));
    prev = next;

    const live = new Set([...next.active.values()].map((d) => snoozeKey(d)));
    for (const key of snoozed) {
      if (live.has(key)) continue;
      snoozed.delete(key);
      write(() => inbox.unsnooze(key));
    }

    if (!kept.length) return;
    const max = settings.notifyMax;
    events = [...kept.toReversed(), ...events].slice(0, max);
    write(() => inbox.append(kept).then(() => inbox.trim(max)));
    for (const ev of kept) sse.emit("notify", JSON.stringify(ev));
    osNotify(kept.filter((e) => deliver(e) === "os" || deliver(e) === "both"));
  }

  return {
    async load() {
      const s = await inbox.load();
      events = s.events.toSorted((a, b) => b.at - a.at);
      for (const z of s.snoozes) snoozed.add(z.key);
    },
    observe(json) {
      try {
        last = JSON.parse(json);
      } catch (e) {
        return log({ type: "notify-error", error: String(e) });
      }
      cycle();
    },
    tick: cycle,
    list: () => events,
    read(ids) {
      const at = now();
      const want = ids === "all" ? null : new Set(ids);
      const hit = events.filter((e) =>
        e.readAt === null && (!want || want.has(e.id))
      );
      for (const e of hit) e.readAt = at;
      return write(() => inbox.update(hit.map((e) => e.id), { readAt: at }));
    },
    snooze(key) {
      snoozed.add(key);
      return write(() => inbox.snooze({ key, at: now() }));
    },
  };
}
