// ---- SSE ----
// ponytail: polls every worktree every pollMs; scope to expanded repo groups if it ever feels slow

const encoder = new TextEncoder();
export const enc = (s: string) => encoder.encode(s);

export type SseApi = {
  add(c: ReadableStreamDefaultController): void;
  remove(c: ReadableStreamDefaultController): void;
  broadcast(json: string): void;
  setStatus(o: Partial<{ phase: string; done: number; total: number }>): void;
  statusChunk(): Uint8Array;
  ping(): void;
  size(): number;
};

export function createSse(): SseApi {
  const clients = new Set<ReadableStreamDefaultController>();
  // Boot progress rides a named event so the snapshot stays a bare array. The
  // first sweep publishes each repo as it lands, so the list fills in instead of
  // appearing all at once; this says how much is still coming.
  let bootStatus = { phase: "repos", done: 0, total: 0 };

  function send(chunk: Uint8Array) {
    for (const c of clients) {
      try {
        c.enqueue(chunk);
      } catch {
        clients.delete(c);
      }
    }
  }

  const statusChunk = () =>
    enc(`event: status\ndata: ${JSON.stringify(bootStatus)}\n\n`);

  return {
    add: (c) => clients.add(c),
    remove: (c) => clients.delete(c),
    broadcast: (s) => send(enc(`data: ${s}\n\n`)),
    statusChunk,
    setStatus(o) {
      bootStatus = { ...bootStatus, ...o };
      send(statusChunk());
    },
    // A silent stream is indistinguishable from a dead one: enqueue on a dead
    // socket buffers rather than throwing, so the server keeps a zombie client and
    // the browser fires no error, never reconnects, and shows stale data until a
    // manual refresh. EventSource ignores comment lines.
    ping: () => send(enc(": ping\n\n")),
    size: () => clients.size,
  };
}
