import { expect, test } from "bun:test";
import type { ThreadId } from "@t3tools/contracts";
import { createDictation } from "./dictation";
const a = "a" as ThreadId,
  b = "b" as ThreadId;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const response = deferred<string>();
  let cancelled = 0;
  let signal: AbortSignal | undefined;
  const notices: string[] = [];
  const drafts: Record<string, string> = { a: "before" };
  const controller = createDictation(
    {
      speechStatus: async () => ({ supported: true, state: "ready" }) as never,
      transcribe: async (_pcm, _options, abort) => {
        signal = abort;
        return response.promise;
      },
    },
    {
      copy() {},
      record: async () => ({
        stop: async () => new Uint8Array(4),
        cancel() {
          cancelled++;
        },
      }),
    },
    (text) => notices.push(text),
  );
  controller.setFallback((id, text) => {
    drafts[id] = (drafts[id] ?? "") + text;
  });
  return {
    controller,
    response,
    drafts,
    notices,
    cancelled: () => cancelled,
    signal: () => signal,
  };
}
test("late transcript belongs to original draft and preserves edits while transcribing", async () => {
  const f = fixture();
  await f.controller.toggle(a);
  const done = f.controller.toggle(b);
  await Promise.resolve();
  f.drafts.a += " edited";
  f.response.resolve(" speech");
  await done;
  expect(f.drafts).toEqual({ a: "before edited speech" });
  expect(f.controller.getSnapshot()).toBe("idle");
});
test("visible editor receives insertion; unmounted editor falls back to draft", async () => {
  const f = fixture();
  const inserted: string[] = [];
  const unregister = f.controller.register(a, (text) => inserted.push(text));
  await f.controller.toggle(a);
  const done = f.controller.toggle();
  f.response.resolve("voice");
  await done;
  expect(inserted).toEqual(["voice"]);
  unregister();
  await f.controller.toggle(a);
  await f.controller.toggle();
  expect(f.drafts.a).toBe("beforevoice");
});
test("repeated toggle cancels transcription and ignores transports that resolve after abort", async () => {
  const f = fixture();
  await f.controller.toggle(a);
  const done = f.controller.toggle();
  await Promise.resolve();
  await f.controller.toggle(b);
  expect(f.signal()?.aborted).toBe(true);
  f.response.resolve("discard");
  await done;
  expect(f.drafts.a).toBe("before");
});
test("dispose kills recording and pending start cannot leak a recorder", async () => {
  const f = fixture();
  await f.controller.toggle(a);
  f.controller.dispose();
  expect(f.cancelled()).toBe(1);
  const pending = deferred<any>();
  let cancelled = false;
  const c = createDictation(
    {
      speechStatus: async () => ({ supported: true, state: "ready" }) as never,
      transcribe: async () => "",
    },
    { copy() {}, record: () => pending.promise },
  );
  const start = c.toggle(a);
  await Promise.resolve();
  c.dispose();
  pending.resolve({
    cancel() {
      cancelled = true;
    },
  });
  await start;
  expect(cancelled).toBe(true);
});
test("setup and transport failures are visible and retryable", async () => {
  let ready = false;
  const messages: string[] = [];
  const c = createDictation(
    {
      speechStatus: async () =>
        ({ supported: true, state: ready ? "ready" : "missing-model" }) as never,
      transcribe: async () => {
        throw new Error("offline");
      },
    },
    { copy() {}, record: async () => ({ stop: async () => new Uint8Array(4), cancel() {} }) },
    (s) => messages.push(s),
  );
  await c.toggle(a);
  expect(c.getSnapshot()).toBe("error");
  expect(messages.at(-1)).toContain("Settings, Voice");
  ready = true;
  await c.toggle(a);
  await c.toggle();
  expect(messages.at(-1)).toBe("offline");
});
test("external override never sends state text to the draft or calls speech", async () => {
  let calls = 0;
  const c = createDictation(
    {
      speechStatus: async () => {
        throw new Error("must not call");
      },
      transcribe: async () => {
        throw new Error("must not call");
      },
    },
    { copy() {}, toggleDictation: async () => ({ recording: ++calls === 1 }) },
  );
  c.setFallback(() => {
    throw new Error("must not insert");
  });
  await c.toggle(a);
  expect(c.getSnapshot()).toBe("recording");
  await c.toggle(b);
  expect(c.getSnapshot()).toBe("idle");
});

test("capture limit automatically stops and transcribes exactly once", async () => {
  let limit: (() => void) | undefined;
  let stops = 0;
  const inserted: string[] = [];
  const c = createDictation(
    {
      speechStatus: async () => ({ supported: true, state: "ready" }) as never,
      transcribe: async () => "at limit",
    },
    {
      copy() {},
      record: async (options) => {
        limit = options?.onLimit;
        return {
          stop: async () => {
            stops++;
            return new Uint8Array(4);
          },
          cancel() {},
        };
      },
    },
  );
  c.setFallback((_id, text) => inserted.push(text));
  await c.toggle(a);
  limit?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(stops).toBe(1);
  expect(inserted).toEqual(["at limit"]);
  c.dispose();
});
