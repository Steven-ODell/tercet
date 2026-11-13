import { expect, test } from "bun:test";
import { useState, act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { workMessages, itemDetail, type WorkRow } from "./work-log";
import { TranscriptViewport } from "./transcript";
const fixtures = {
  command_execution: { input: "echo ready", output: "command result", exitCode: 0 },
  reasoning: { text: "Reasoning detail" },
  assistant_message: { text: "Assistant reply" },
  user_message: { text: "User prompt" },
  dynamic_tool: { toolName: "Read", input: { file: "README.md" }, output: "tool result" },
  checkpoint: { files: [{ path: "README.md", additions: 1 }] },
  file_change: { fileName: "README.md", diffStr: "+new content" },
  web_search: {
    patterns: ["OpenTUI"],
    results: [{ url: "https://example.com", title: "Search result" }],
  },
  error: { failure: { message: "Provider failed" } },
  notification: { title: "Notification title", detail: "Notice detail" },
  user_input_request: { questions: [{ question: "Which option?" }] },
  secret_request: { label: "Password", reason: "Authentication required", secretStatus: "pending" },
  file_search: {
    pattern: "hello",
    results: [{ fileName: "hello.ts", line: 2, preview: "hello world" }],
  },
  system_notice: { message: "System notice" },
  compaction: { summary: "Compacted summary", beforeTokenCount: 2000, afterTokenCount: 1000 },
  subagent: {
    prompt: "Review files",
    progress: "Reviewing",
    result: "Review done",
    childThreadId: "child",
  },
  run_interrupt_request: { message: "Stop requested" },
  run_interrupt_result: { message: "Stopped turn" },
  approval_request: { prompt: "Allow command?", requestKind: "command" },
  handoff: { toProviderInstanceId: "codex", toModel: "gpt", summary: "Transfer summary" },
  todo_list: { steps: [{ text: "Implement work log", status: "running" }] },
} satisfies Partial<Record<OrchestrationV2TurnItem["type"], object>>;
function row(type: string, values: object = {}, id = type): WorkRow {
  return {
    sourceThreadId: "thread",
    sourceItemId: id,
    item: { id, type, status: "completed", runId: "run", ...values },
  } as unknown as WorkRow;
}
function Harness({ rows }: { rows: WorkRow[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return (
    <TranscriptViewport
      width={100}
      height={35}
      items={workMessages(rows, expanded)}
      activate={(id) =>
        setExpanded((old) => {
          const next = new Set(old);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })
      }
    />
  );
}
test.each(Object.entries(fixtures))(
  "work-log %s has a visible frame and meaningful detail",
  async (type, values) => {
    const fixture = row(type, values);
    const collapsed = workMessages([fixture], new Set());
    expect(collapsed.length).toBeGreaterThan(0);
    expect(collapsed[0]!.kind.trim().length).toBeGreaterThan(0);
    expect(itemDetail(fixture.item).trim().length).toBeGreaterThan(0);
    const view = await testRender(<Harness rows={[fixture]} />, { width: 100, height: 35 });
    try {
      await view.flush();
      expect(view.captureCharFrame()).toContain(collapsed[0]!.kind);
      await act(async () => {
        view.mockInput.pressKey("RETURN");
      });
      await view.flush();
      if (String(collapsed[0]!.id).startsWith("work/")) {
        await act(async () => {
          view.mockInput.pressKey("}");
        });
        await view.flush();
        await act(async () => {
          view.mockInput.pressKey("RETURN");
        });
        await view.flush();
      }
      expect(view.captureCharFrame()).toContain(itemDetail(fixture.item).split("\n")[0]!);
    } finally {
      await act(async () => {
        await view.dispose();
      });
    }
  },
);
test("mouse expands group then item and collapses both; keyboard cycles and toggles", async () => {
  const view = await testRender(
    <Harness rows={[row("command_execution", fixtures.command_execution)]} />,
    { width: 100, height: 35 },
  );
  try {
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("command result");
    await act(async () => {
      await view.mockMouse.click(3, 0);
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("echo ready");
    expect(view.captureCharFrame()).not.toContain("command result");
    await act(async () => {
      await view.mockMouse.click(3, 1);
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("command result");
    await act(async () => {
      view.mockInput.pressKey("RETURN");
    });
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("command result");
    await act(async () => {
      view.mockInput.pressKey("{");
    });
    await view.flush();
    await act(async () => {
      view.mockInput.pressKey("RETURN");
    });
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("echo ready");
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});
test("groups split at visible events, runs and source threads, errors never hide, fallback stays visible", () => {
  const command = row("command_execution", fixtures.command_execution, "cmd");
  const failed = row("command_execution", { ...fixtures.command_execution, exitCode: 1 }, "failed");
  const notice = row("system_notice", fixtures.system_notice);
  const otherRun = row("reasoning", { text: "Other", runId: "other" });
  const inherited = { ...command, sourceThreadId: "parent" } as unknown as WorkRow;
  const rows = workMessages(
    [command, failed, notice, command, otherRun, inherited, row("future_type")],
    new Set(),
  );
  expect(rows.filter((r) => String(r.id).startsWith("work/"))).toHaveLength(4);
  expect(rows.some((r) => r.kind.includes("Exit"))).toBe(false);
  expect(rows.some((r) => r.kind.includes("echo ready"))).toBe(true);
  expect(rows.some((r) => r.kind.includes("System notice"))).toBe(true);
  expect(rows.at(-1)!.kind).toContain("unknown item: future_type");
});

test("a made-up item kind renders a labeled block with its type and raw fields, never blank", async () => {
  const strange = row("hologram_projection", {
    status: "running",
    beam: "violet",
    intensity: { lumens: 900 },
    notes: "line one\nline two",
  });
  const bare = row("", { status: undefined }, "bare");
  const rows = workMessages([strange, bare], new Set());
  expect(rows[0]).toMatchObject({
    kind: "[?] unknown item: hologram_projection · running",
    text: 'beam: violet, intensity: {"lumens":900}, notes: line one line two',
  });
  expect(rows[1]).toMatchObject({ kind: "[?] unknown item: untyped", text: "(no other fields)" });
  // Between known items it neither joins a work group nor hides.
  const mixed = workMessages(
    [row("command_execution", fixtures.command_execution, "a"), strange],
    new Set(),
  );
  expect(mixed.map((r) => r.kind.split(" · ")[0])).toEqual([
    "[+] Ran 1 command",
    "[?] unknown item: hologram_projection",
  ]);
  const view = await testRender(<Harness rows={[strange]} />, { width: 100, height: 10 });
  try {
    await view.flush();
    const frame = view.captureCharFrame();
    expect(frame).toContain("unknown item: hologram_projection");
    expect(frame).toContain("beam: violet");
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});

test("selected-thread detail is lazy, shows loading/failure, retries and caches the fetched output", async () => {
  const { createClient, waitForLive } = await import("./runtime");
  const { ThreadTranscript } = await import("./transcript");
  const { ThreadId } = await import("@t3tools/contracts");
  const Effect = await import("effect/Effect");
  const DateTime = await import("effect/DateTime");
  let calls = 0;
  const pending =
    Promise.withResolvers<import("@t3tools/contracts").OrchestrationV2GetTurnItemResult>();
  const fixture = row("command_execution", {
    input: "echo fetched",
    outputOmitted: true,
    updatedAt: DateTime.nowUnsafe(),
  });
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no writes"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: (_, receive) =>
        Effect.sync(() =>
          receive({
            kind: "snapshot",
            snapshot: {
              schemaVersion: 1,
              snapshotSequence: 0,
              projects: [],
              threads: [],
              archivedThreads: [],
            },
          }),
        ).pipe(Effect.andThen(Effect.never)),
      itemDetail: (_, input) => {
        expect(String(input.threadId)).toBe("thread");
        expect(String(input.itemId)).toBe("command_execution");
        calls++;
        return calls === 1 ? Effect.fail("offline") : Effect.promise(() => pending.promise);
      },
    },
    false,
  );
  client.start();
  await waitForLive(client);
  client.registry.set(client.selectedThreadId, ThreadId.make("thread"));
  client.registry.set(
    client.transcripts,
    new Map([
      [
        "thread",
        {
          projection: {
            thread: { id: "thread" },
            visibleTurnItems: [fixture],
          } as unknown as import("@t3tools/contracts").OrchestrationV2ThreadProjection,
          sequence: 1,
          error: null,
          history: {
            expanded: false,
            hasMoreHistory: false,
            loading: false,
            error: null,
            historyCursor: null,
            latestLocalTurnOrdinal: null,
          },
        },
      ],
    ]),
  );
  const view = await testRender(
    <ThreadTranscript client={client} width={100} height={35} enabled />,
    { width: 100, height: 35 },
  );
  const click = async (y: number) => {
    await act(async () => {
      await view.mockMouse.click(3, y);
    });
    await view.flush();
  };
  try {
    await view.flush();
    expect(calls).toBe(0);
    await click(0);
    expect(calls).toBe(0);
    await click(1);
    await view.waitForFrame((f) => f.includes("Detail unavailable"));
    expect(calls).toBe(1);
    await click(1);
    await click(1);
    await view.waitForFrame((f) => f.includes("Loading detail"));
    expect(calls).toBe(2);
    await act(async () => {
      pending.resolve({
        item: {
          ...fixture.item,
          output: "Fetched full output",
          outputOmitted: false,
        } as OrchestrationV2TurnItem,
      });
    });
    await view.waitForFrame((f) => f.includes("Fetched full output"));
    await click(1);
    await click(1);
    expect(calls).toBe(2);
    expect(view.captureCharFrame()).toContain("Fetched full output");
  } finally {
    await act(async () => {
      await view.dispose();
    });
    await client.dispose();
  }
});

test("html_render structured and MCP content outputs expose page open targets without expansion", () => {
  for (const output of [
    { htmlRender: { attachmentId: "page/id", title: "Revenue", height: 240 } },
    [
      {
        type: "text",
        text: JSON.stringify({
          htmlRender: { attachmentId: "page/id", title: "Revenue", height: 240 },
        }),
      },
    ],
  ]) {
    const messages = workMessages(
      [row("dynamic_tool", { toolName: "t3-code.html_render", output })],
      new Set(),
    );
    expect(messages.find((m) => m.kind === "Rendered page")?.text).toBe(
      "[open](tercet-page:page%2Fid)",
    );
  }
});

test("a subagent with its own thread reads [open] and carries the prompt; without one it still expands", () => {
  const withChild = workMessages(
    [row("subagent", { prompt: "Review the changed files\nand report", childThreadId: "child" })],
    new Set(),
  );
  expect(withChild[0]!.kind).toBe("[open] subagent · completed · Review the changed files");
  const without = workMessages(
    [row("subagent", { prompt: "Review", childThreadId: null })],
    new Set(),
  );
  expect(without[0]!.kind).toBe("[+] subagent · completed · Review");
});
