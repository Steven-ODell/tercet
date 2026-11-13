import { fileIcon } from "./icons";
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS as RPC,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { createClient } from "./runtime";
import { emptyTranscript } from "./transcript-state";
import { DiffPanel, diffFiles } from "./diff";
import { withSandbox, listThreads } from "../spikes/connect";

const id = ThreadId.make("fixture");
const patch =
  "diff --git a/hello.ts b/hello.ts\n--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-old content\n+new content\ndiff --git a/empty b/empty\nnew file mode 100644\n";
function fixture() {
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("unused"),
      wake: () => Effect.void,
      follow: () => Effect.never,
      pause: () => Effect.never,
    },
    false,
  );
  client.registry.set(client.status, "live");
  client.registry.set(client.selectedThreadId, id);
  const projection = {
    messages: [],
    checkpoints: [1, 2].map((n) => ({
      runId: `run${n}`,
      appRunOrdinal: n,
      status: "ready",
      files: [],
      capturedAt: DateTime.nowUnsafe(),
    })),
  } as unknown as OrchestrationV2ThreadProjection;
  client.registry.set(client.transcripts, new Map([[id, { ...emptyTranscript, projection }]]));
  return client;
}
async function click(view: Awaited<ReturnType<typeof testRender>>, label: string) {
  const lines = view.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(label));
  expect(y).toBeGreaterThanOrEqual(0);
  await act(async () => {
    await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
  });
  await view.flush();
}
test("unified diff counts hunk changes, keeps empty/binary/renamed files and quoted paths", () => {
  expect(diffFiles(patch).map((f) => [f.path, f.additions, f.deletions])).toEqual([
    ["hello.ts", 1, 1],
    ["empty", 0, 0],
  ]);
  expect(diffFiles('diff --git "a/a b" "b/a b"\nBinary files differ\n')[0]?.path).toBe("a b");
});
test("diff file list, stacked patch, turn/all selection, retry and back work by key and mouse", async () => {
  const client = fixture();
  const calls: unknown[] = [];
  let closed = 0;
  client.diffs.full = async (input) => {
    calls.push(["full", input]);
    return { ...input, fromTurnCount: 0, diff: patch };
  };
  client.diffs.turn = async (input) => {
    calls.push(["turn", input]);
    return { ...input, diff: patch };
  };
  const view = await testRender(
    <DiffPanel client={client} enabled height={28} close={() => closed++} />,
    { width: 80, height: 28, kittyKeyboard: true },
  );
  const key = async (name: string) => {
    await act(async () => view.mockInput.pressKey(name));
    await view.flush();
  };
  try {
    await view.waitForFrame((f) => f.includes("hello.ts +1 −1"));
    expect(calls[0]).toEqual(["full", { threadId: id, toTurnCount: 2, ignoreWhitespace: true }]);
    await key("RETURN");
    expect(view.captureCharFrame()).toContain("-old content");
    expect(view.captureCharFrame()).toContain("+new content");
    await key("ARROW_DOWN");
    await click(view, "[↑]");
    await click(view, "[↓]");
    await key("ESCAPE");
    await click(view, "hello.ts +1");
    expect(view.captureCharFrame()).toContain("+new content");
    await click(view, "[Esc Back]");
    await key("t");
    await view.waitForFrame((f) => f.includes("Turn 1") && f.includes("hello.ts"));
    expect(calls.at(-1)).toEqual([
      "turn",
      { threadId: id, fromTurnCount: 0, toTurnCount: 1, ignoreWhitespace: true },
    ]);
    await click(view, "[t Turn]");
    await view.waitForFrame((f) => f.includes("Turn 2") && f.includes("hello.ts"));
    await click(view, "[a All]");
    await key("t");
    await key("a");
    await key("r");
    await click(view, "[r Retry]");
    await view.waitForFrame((f) => f.includes("hello.ts"));
    await key("ARROW_DOWN");
    await key("RETURN");
    expect(view.captureCharFrame()).toContain("new file mode");
    await key("ESCAPE");
    await key("ESCAPE"); // top level: left for the frame to change panes
    expect(closed).toBe(0);
  } finally {
    await view.dispose();
    await client.dispose();
  }
});
test("diff j/k move, l opens a file, h goes back to the list without closing", async () => {
  const client = fixture();
  let closed = 0;
  client.diffs.full = async (input) => ({ ...input, fromTurnCount: 0, diff: patch });
  const view = await testRender(
    <DiffPanel client={client} enabled height={28} close={() => closed++} />,
    { width: 80, height: 28, kittyKeyboard: true },
  );
  const key = async (name: string) => {
    await act(async () => view.mockInput.pressKey(name));
    await view.flush();
  };
  try {
    await view.waitForFrame((f) => f.includes(`› ${fileIcon("hello.ts").glyph} hello.ts`));
    await key("j");
    expect(view.captureCharFrame()).toContain(`› ${fileIcon("empty").glyph} empty`);
    await key("k");
    expect(view.captureCharFrame()).toContain(`› ${fileIcon("hello.ts").glyph} hello.ts`);
    await key("l");
    expect(view.captureCharFrame()).toContain("+new content");
    await key("h");
    expect(view.captureCharFrame()).toContain(`› ${fileIcon("hello.ts").glyph} hello.ts`);
    expect(view.captureCharFrame()).not.toContain("+new content");
    await key("h");
    expect(closed).toBe(0);
  } finally {
    await view.dispose();
    await client.dispose();
  }
});
test("diff failures hide transport details and retry; empty diff and disconnect remain usable", async () => {
  const client = fixture();
  let attempts = 0;
  client.diffs.full = async (input) => {
    if (++attempts === 1) throw new Error("private transport detail");
    return { ...input, fromTurnCount: 0, diff: "" };
  };
  const view = await testRender(
    <DiffPanel client={client} enabled height={24} close={() => {}} />,
    { width: 70, height: 24 },
  );
  try {
    await view.waitForFrame((f) => f.includes("Diff unavailable"));
    expect(view.captureCharFrame()).not.toContain("private transport");
    await click(view, "[r Retry]");
    await view.waitForFrame((f) => f.includes("No changed files"));
    await act(async () => client.registry.set(client.status, "connecting"));
    await view.waitForFrame((f) => f.includes("Disconnected"));
  } finally {
    await view.dispose();
    await client.dispose();
  }
});
test.skipIf(process.env.TERCET_SANDBOX_TEST !== "1")(
  "real sandbox checkpoint diff renders without starting a provider turn",
  async () => {
    // Read only copied sandbox threads/checkpoints; never dispatch or call a provider.
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- OpenTUI owns the renderer runtime; sandbox helper scopes RPC reads.
    const data = await Effect.runPromise(
      withSandbox((session) =>
        Effect.gen(function* () {
          const threads = yield* listThreads(session);
          for (const thread of threads) {
            const items = yield* session.client[RPC.subscribeThread]({ threadId: thread.id }).pipe(
              Stream.take(1),
              Stream.runCollect,
            );
            const first = items[0];
            if (first?.kind !== "snapshot") continue;
            const checkpoint = first.projection.checkpoints.find(
              (c) => c.status === "ready" && c.appRunOrdinal !== null && c.files.length > 0,
            );
            if (!checkpoint || checkpoint.appRunOrdinal === null) continue;
            const result = yield* session.client[RPC.getTurnDiff]({
              threadId: thread.id,
              fromTurnCount: checkpoint.appRunOrdinal - 1,
              toTurnCount: checkpoint.appRunOrdinal,
              ignoreWhitespace: true,
            }).pipe(Effect.option);
            if (result._tag === "Some" && diffFiles(result.value.diff).length) {
              const full = yield* session.client[RPC.getFullThreadDiff]({
                threadId: thread.id,
                toTurnCount: checkpoint.appRunOrdinal,
                ignoreWhitespace: true,
              });
              return {
                threadId: thread.id,
                projection: first.projection,
                result: result.value,
                full,
              };
            }
          }
          return yield* Effect.die("No readable nonempty sandbox checkpoint diff");
        }),
      ),
    );
    const client = fixture();
    client.registry.set(
      client.transcripts,
      new Map([[data.threadId, { ...emptyTranscript, projection: data.projection }]]),
    );
    client.diffs.turn = async () => data.result;
    client.diffs.full = async () => data.full;
    const file = diffFiles(data.result.diff)[0]!;
    const view = await testRender(
      <DiffPanel
        client={client}
        target={{ threadId: data.threadId, turn: data.result.toTurnCount, path: file.path }}
        enabled
        height={40}
        close={() => {}}
      />,
      { width: 110, height: 40 },
    );
    try {
      await view.waitForFrame((f) => f.includes(file.path));
      expect(view.captureCharFrame()).toContain("diff --git");
      await click(view, "[a All]");
      await view.waitForFrame((f) => f.includes("Full thread") && f.includes(" files +"));
      expect(diffFiles(data.full.diff).length).toBeGreaterThan(0);
    } finally {
      await view.dispose();
      await client.dispose();
    }
  },
  30000,
);

test("work-log file changes open the matching turn/file by mouse and Enter", async () => {
  const { ThreadTranscript } = await import("./transcript");
  const client = fixture();
  const state = client.registry.get(client.transcripts).get(id)!;
  const projection = {
    ...state.projection!,
    visibleTurnItems: [
      {
        sourceThreadId: id,
        sourceItemId: "change",
        item: {
          id: "change",
          type: "file_change",
          status: "completed",
          runId: "run2",
          fileName: "hello.ts",
          additions: 1,
          deletions: 1,
        },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  client.registry.set(client.transcripts, new Map([[id, { ...state, projection }]]));
  const calls: unknown[] = [];
  const view = await testRender(
    <ThreadTranscript
      client={client}
      width={90}
      height={25}
      enabled
      openDiff={(target) => calls.push(target)}
    />,
    { width: 90, height: 25 },
  );
  try {
    await view.flush();
    await act(async () => view.mockInput.pressKey("RETURN"));
    await view.flush();
    await view.waitForFrame((f) => f.includes("hello.ts"));
    await click(view, "hello.ts");
    expect(calls.at(-1)).toEqual({ threadId: id, turn: 2, path: "hello.ts" });
    await act(async () => view.mockInput.pressKey("RETURN"));
    await view.flush();
    expect(calls).toHaveLength(2);
  } finally {
    await view.dispose();
    await client.dispose();
  }
});

test("patch content that resembles metadata does not change the file path", () => {
  const files = diffFiles(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n--- removed\n+++ added\n",
  );
  expect(files[0]?.path).toBe("a.ts");
  expect(files[0]?.additions).toBe(1);
  expect(files[0]?.deletions).toBe(1);
});
