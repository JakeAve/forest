import { assertEquals } from "@std/assert";
import { createSse } from "./sse.ts";

const dec = new TextDecoder();

const fakeClient = (opts?: { boom?: boolean }) => {
  const frames: string[] = [];
  return {
    frames,
    ctrl: {
      enqueue(chunk: Uint8Array) {
        if (opts?.boom) throw new Error("dead socket");
        frames.push(dec.decode(chunk));
      },
    } as unknown as ReadableStreamDefaultController,
  };
};

Deno.test("broadcast writes a data frame", () => {
  const sse = createSse();
  const c = fakeClient();
  sse.add(c.ctrl);
  sse.broadcast('[{"name":"forest"}]');
  assertEquals(c.frames, ['data: [{"name":"forest"}]\n\n']);
  assertEquals(sse.size(), 1);
  sse.remove(c.ctrl);
  assertEquals(sse.size(), 0);
});

Deno.test("a controller that throws on enqueue is dropped", () => {
  const sse = createSse();
  const dead = fakeClient({ boom: true });
  const live = fakeClient();
  sse.add(dead.ctrl);
  sse.add(live.ctrl);
  sse.ping();
  assertEquals(sse.size(), 1);
  assertEquals(live.frames, [": ping\n\n"]);
});

Deno.test("setStatus merges fields and emits an event: status frame", () => {
  const sse = createSse();
  const c = fakeClient();
  sse.add(c.ctrl);
  sse.setStatus({ total: 3 });
  sse.setStatus({ done: 1 });
  assertEquals(c.frames, [
    'event: status\ndata: {"phase":"repos","done":0,"total":3}\n\n',
    'event: status\ndata: {"phase":"repos","done":1,"total":3}\n\n',
  ]);
  assertEquals(
    dec.decode(sse.statusChunk()),
    'event: status\ndata: {"phase":"repos","done":1,"total":3}\n\n',
  );
});
