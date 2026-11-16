import { expect, test } from "bun:test";
import { act, useState, useEffect } from "react";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import {
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { MarkdownCache, measureMarkdown, anchorIndex } from "./markdown";
import { TranscriptViewport, ThreadTranscript } from "./transcript";
import { HintsShown } from "./keymap";
import { workMessages, type WorkRow } from "./work-log";
import { createClient, waitForLive, type Boundary } from "./runtime";
import { platform } from "./platform";
import { connectionConfig } from "./config";
import { sandboxUrl, tokenPath } from "../spikes/connect";

const plain = (rows: ReturnType<typeof measureMarkdown>) =>
  rows.map((row) => row.spans.map((span) => span.text).join(""));
test("Markdown measures headings, lists, tables, code, wide graphemes and terminal controls", () => {
  const rows = measureMarkdown(
    {
      id: "a",
      kind: "assistant",
      text: "# Title\n- **bold** and `code`\n| Name | Value |\n| --- | --- |\n| 界 | 👩‍💻 |\n```ts\nconst ready = true;\n```\n\x1b[31m安全\x1b[0m",
    },
    24,
  );
  const text = plain(rows).join("\n");
  expect(text).toContain("Title");
  expect(text).not.toContain("# Title");
  expect(text).toContain("• bold and code");
  expect(text).toContain("│ Name │ Value │");
  expect(text).toContain("const ready = true;");
  expect(text).not.toContain("\x1b");
  expect(
    rows.some((row) =>
      row.spans.some((span) => span.text.includes("const") && span.color === "#b07cf5"),
    ),
  ).toBe(true);
  expect(plain(rows).every((row) => Bun.stringWidth(row) <= 24)).toBe(true);
  const narrow = measureMarkdown({ id: 1, kind: "user", text: "界界é👩‍💻abcd" }, 4);
  expect(plain(narrow).slice(1).join("")).toContain("界界é👩‍💻abcd");
});
test("transcript wraps whole words across styles and preserves long text", () => {
  const rows = measureMarkdown(
    { id: "wrap", kind: "assistant", text: "hello **wonder**ful world abcdefghijkl" },
    10,
  );
  const lines = plain(rows).slice(1);
  expect(lines).toEqual(["hello ", "wonderful ", "world ", "abcdefghij", "kl"]);
  expect(lines.join("")).toBe("hello wonderful world abcdefghijkl");
});
const tableText = (text: string, width: number) =>
  plain(measureMarkdown({ id: "t", kind: "assistant", text }, width)).slice(1);
test("table columns line up with wide characters and the separator matches the table", () => {
  const lines = tableText(
    "| Name | Key |\n| --- | :-: |\n| 界界 | 👩‍💻 |\n| abc | é |\n\nplain | pipe",
    40,
  );
  const table = lines.slice(0, 4);
  expect(table.map((line) => Bun.stringWidth(line))).toEqual([14, 14, 14, 14]);
  expect(table[1]).toBe("├──────┼─────┤");
  const bars = (line: string) =>
    [...line].reduce<number[]>((found, ch, i, chars) => {
      if (ch === "│") found.push(Bun.stringWidth(chars.slice(0, i).join("")));
      return found;
    }, []);
  expect(bars(table[0]!)).toEqual(bars(table[2]!));
  expect(bars(table[0]!)).toEqual(bars(table[3]!));
  // A pipe in prose is still text.
  expect(lines.at(-1)).toBe("plain | pipe");
});
test("table cells keep inline code targets and wrap inside the cell when over-wide", () => {
  const rows = measureMarkdown(
    {
      id: "t",
      kind: "assistant",
      text: "| Call | Meaning |\n| --- | --- |\n| `src/a.ts` | a very long explanation that cannot fit on one line |",
    },
    30,
  );
  const lines = plain(rows).slice(1);
  expect(lines.every((line) => Bun.stringWidth(line) === 30)).toBe(true);
  expect(lines.length).toBeGreaterThan(4);
  const code = rows.flatMap((row) => row.spans).find((span) => span.text === "src/a.ts");
  expect(code?.target).toEqual({ kind: "file", text: "src/a.ts" });
  // Wrapped lines of one source row keep that line's id prefix and count up.
  const ids = rows.slice(1).map((row) => row.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter((id) => id.startsWith("t:3:")).length).toBeGreaterThan(1);
});
test("a half-streamed table does not crash and realigns as rows arrive", () => {
  const full = "| A | B |\n| --- | --- |\n| one | two |";
  for (let i = 1; i <= full.length; i++) tableText(full.slice(0, i), 20);
  expect(tableText("| A | B |", 20)).toEqual(["| A | B |"]);
  expect(tableText("| A | B |\n| --- | --- |\n| one", 20).at(-1)).toBe("│ one │   │");
});
test("cached rows stay identical; anchors survive prepending, streaming and rewrap", () => {
  const cache = new MarkdownCache();
  const items = [
    { id: "a", kind: "user", text: "abcdefghijklmnopqrstuvwxyz" },
    { id: "b", kind: "assistant", text: "tail" },
  ];
  const before = cache.rows(items, 8);
  const anchor = before[2]!.id;
  const after = cache.rows(
    [
      { id: "old", kind: "user", text: "earlier" },
      items[0]!,
      { ...items[1]!, text: "tail growing" },
    ],
    8,
  );
  expect(after[anchorIndex(after, anchor, 4)]).toBe(before[2]);
  const resized = cache.rows(items, 12);
  expect(resized[anchorIndex(resized, anchor, 4)]?.id.startsWith("a:1:")).toBe(true);
  expect(anchorIndex(after, null, 4)).toBe(after.length - 4);
});
test("real viewport follows streams, pauses when scrolled away, pages without jumping, and resumes by click", async () => {
  let items = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    kind: "assistant",
    text: `Message ${i}`,
  }));
  let pages = 0;
  let redraw = () => {};
  function Harness() {
    const [, setTick] = useState(0);
    useEffect(() => {
      redraw = () => setTick((n) => n + 1);
    }, []);
    return render();
  }
  const render = () => (
    <TranscriptViewport
      items={items}
      width={60}
      height={10}
      history={{ hasMoreHistory: true, loading: false, error: null }}
      loadEarlier={() => {
        pages++;
        items = [{ id: "older", kind: "user", text: "Old page" }, ...items];
        redraw();
      }}
    />
  );
  const view = await testRender(<Harness />, { width: 60, height: 10 });
  try {
    await view.waitForFrame((f) => f.includes("Message 29"));
    await act(async () => {
      view.mockInput.pressKey("HOME");
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Message 0");
    items = [...items, { id: "30", kind: "assistant", text: "Latest streamed text" }];
    await act(async () => {
      redraw();
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Message 0");
    expect(view.captureCharFrame()).not.toContain("Latest streamed");
    await act(async () => {
      view.mockInput.pressKey("p");
    });
    await view.flush();
    expect(pages).toBe(1);
    expect(view.captureCharFrame()).toContain("Message 0");
    expect(view.captureCharFrame()).not.toContain("Old page");
    await act(async () => {
      view.mockInput.pressKey("END");
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Latest streamed text");
    await act(async () => {
      await view.mockMouse.scroll(4, 4, "up");
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Follow tail");
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});

// Minimal projection is enough for rendering and shared history merge behavior.
function projection(id: string): OrchestrationV2ThreadProjection {
  return {
    thread: { id },
    visibleTurnItems: [],
    turnItems: [],
    runs: [],
    attempts: [],
  } as unknown as OrchestrationV2ThreadProjection;
}
test("selected subscriptions cancel, cached switch is immediate, paging failures are local and retryable", async () => {
  const receivers = new Map<string, (item: OrchestrationV2ThreadStreamItem) => void>();
  const cancelled: string[] = [];
  let pageCalls = 0;
  const boundary: Boundary = {
    readToken: () => Effect.succeed("fake"),
    issueToken: () => Effect.die("no"),
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
    followThread: (_, id, receive) =>
      Effect.sync(() => receivers.set(id, receive)).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            cancelled.push(String(id));
          }),
        ),
      ),
    historyPage: () =>
      ++pageCalls === 1
        ? Effect.fail("offline")
        : Effect.succeed({
            snapshotSequence: 2,
            items: [],
            nextCursor: null,
            hasMoreHistory: false,
          }),
  };
  const client = createClient(boundary, false);
  client.start();
  await waitForLive(client);
  const ready = () => client.runtime.runPromise(Effect.yieldNow);
  try {
    client.openThread(ThreadId.make("a"));
    await ready();
    receivers.get("a")!({
      kind: "snapshot",
      snapshotSequence: 1,
      projection: projection("a"),
      historyCursor: "page",
      hasMoreHistory: true,
    });
    client.openThread(ThreadId.make("b"));
    await ready();
    expect(cancelled).toContain("a");
    client.openThread(ThreadId.make("a"));
    expect(String(client.getThread("a").projection?.thread.id)).toBe("a");
    await ready();
    client.loadEarlier(ThreadId.make("a"));
    await ready();
    expect(client.getThread("a").history.error).toContain("unavailable");
    expect(client.registry.get(client.status)).toBe("live");
    client.loadEarlier(ThreadId.make("a"));
    await ready();
    expect(client.getThread("a").history.hasMoreHistory).toBe(false);
  } finally {
    await client.dispose();
  }
});

test.skipIf(process.env.TERCET_SANDBOX_TEST !== "1")(
  "sandbox selected thread renders user and assistant history end to end",
  async () => {
    const config = await connectionConfig(
      ["--url", sandboxUrl, "--token-file", tokenPath],
      async () => undefined,
      "/unused",
    );
    const client = createClient(platform(config), false);
    client.start();
    await waitForLive(client);
    const thread = client.registry
      .get(client.snapshot)!
      .threads.find((t) => t.visibleItemCount > 1);
    expect(thread).toBeDefined();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error("Sandbox transcript timeout"));
      }, 15000);
      const stop = client.registry.subscribe(client.transcripts, (states) => {
        if (states.get(thread!.id)?.projection) {
          clearTimeout(timer);
          stop();
          resolve();
        }
      });
      client.openThread(thread!.id);
    });
    const types = client
      .getThread(thread!.id)
      .projection!.visibleTurnItems.map((row) => row.item.type);
    expect(types).toContain("user_message");
    expect(types).toContain("assistant_message");
    const view = await testRender(
      <ThreadTranscript client={client} width={100} height={30} enabled />,
      { width: 100, height: 30 },
    );
    try {
      await view.waitForFrame((f) => f.includes("assistant") && f.includes("Following tail"));
    } finally {
      await act(async () => {
        await view.dispose();
      });
      await client.dispose();
    }
  },
);

test("paging merges older rows into current streamed content and blocks duplicate requests", async () => {
  const pending =
    Promise.withResolvers<import("@t3tools/contracts").OrchestrationV2ThreadHistoryPage>();
  let receive: (item: OrchestrationV2ThreadStreamItem) => void = () => {};
  let requests = 0;
  const row = (id: string, text: string) =>
    ({
      sourceThreadId: ThreadId.make("a"),
      sourceItemId: id,
      position: 0,
      visibility: "local",
      item: { id, type: "assistant_message", text },
    }) as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
      followThread: (_, __, next) =>
        Effect.sync(() => {
          receive = next;
        }).pipe(Effect.andThen(Effect.never)),
      historyPage: () =>
        Effect.sync(() => {
          requests++;
        }).pipe(Effect.andThen(Effect.promise(() => pending.promise))),
    },
    false,
  );
  try {
    client.start();
    await client.runtime.runPromise(Effect.yieldNow);
    client.openThread(ThreadId.make("a"));
    await client.runtime.runPromise(Effect.yieldNow);
    const projectionA = {
      ...projection("a"),
      visibleTurnItems: [row("current", "streamed text")],
      turnItems: [row("current", "streamed text").item],
    };
    receive({
      kind: "snapshot",
      snapshotSequence: 1,
      projection: projectionA,
      historyCursor: "page",
      hasMoreHistory: true,
    });
    client.loadEarlier(ThreadId.make("a"));
    client.loadEarlier(ThreadId.make("a"));
    await client.runtime.runPromise(Effect.yieldNow);
    expect(requests).toBe(1);
    pending.resolve({
      snapshotSequence: 1,
      items: [row("older", "earlier"), row("current", "stale")],
      nextCursor: null,
      hasMoreHistory: false,
    });
    await client.runtime.runPromise(Effect.yieldNow);
    const rows = client.getThread("a").projection!.visibleTurnItems;
    expect(rows.map((row) => String(row.sourceItemId))).toEqual(["older", "current"]);
    expect(rows[1]!.item).toHaveProperty("text", "streamed text");
    expect(client.getThread("a").history.loading).toBe(false);
  } finally {
    await client.dispose();
  }
});

test("unknown live item advances cursor and renders an explicit safe fallback", async () => {
  const { receiveThread, emptyTranscript } = await import("./transcript-state");
  const state = receiveThread(emptyTranscript, {
    kind: "unknown-event",
    sequence: 9,
    eventType: "turn-item.updated",
  });
  expect(state.sequence).toBe(9);
  expect(state.unsupported).toBe(true);
  // Unknown rows supplied directly to the presenter also remain nonblank.
  const { itemLabel, itemDetail } = await import("./work-log");
  const future = {
    type: "future_tool",
  } as unknown as import("@t3tools/contracts").OrchestrationV2TurnItem;
  expect(itemLabel(future)).toBe("future tool");
  expect(itemDetail(future)).toBe("future tool");
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.never,
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
    },
    false,
  );
  client.registry.set(
    client.transcripts,
    new Map([["future", { ...state, projection: projection("future") }]]),
  );
  client.registry.set(client.status, "live");
  client.openThread(ThreadId.make("future"));
  const view = await testRender(
    <ThreadTranscript client={client} width={100} height={20} enabled />,
    { width: 100, height: 24 },
  );
  try {
    await view.flush();
    expect(view.captureCharFrame()).toContain("Unsupported server item");
    expect(view.captureCharFrame()).toContain("Alt+o");
  } finally {
    await view.dispose();
    await client.dispose();
  }
});

test("speaker colors distinguish prose while retaining inline code highlighting", () => {
  const assistant = measureMarkdown(
    { id: "a", kind: "assistant", text: "Reply **bold** `code`" },
    80,
  );
  const user = measureMarkdown({ id: "u", kind: "user", text: "My message" }, 80);
  expect(assistant[1]!.spans.find((s) => s.text.includes("Reply"))?.color).toBe("#9ef3ff");
  expect(assistant[1]!.spans.find((s) => s.text.includes("bold"))?.color).toBe("#9ef3ff");
  expect(assistant[1]!.spans.find((s) => s.text === "code")?.color).toBe("#5ef1ff");
  expect(user[1]!.spans[0]!.color).toBe("#5eff6c");
  expect(user[0]!.spans[0]!.color).toBe("#5eff6c");
  const tool = measureMarkdown({ id: "tool", kind: "command", text: "Tool output" }, 80);
  expect(tool[0]!.spans[0]!.color).toBe("#b07cf5");
  expect(user[1]!.spans[0]!.color).not.toBe(tool[0]!.spans[0]!.color);
});

test("messages are labeled by speaker alone, without their item id", () => {
  const id = "f4b28b1b/turn-item:provider:claudeAgent:native-item:b3cc7d47";
  expect(plain(measureMarkdown({ id, kind: "assistant", text: "Hi" }, 80))).toEqual([
    "assistant",
    "Hi",
  ]);
  expect(plain(measureMarkdown({ id, kind: "user", text: "Hi" }, 80))[0]).toBe("user");
});

const ruleText = (rows: ReturnType<typeof measureMarkdown>, id: string) =>
  rows.find((row) => row.id === `rule/${id}:1:0`)?.spans[0]?.text;

test("a blank row and a rule mark each speaker change, none at the top or between agent items", () => {
  const rows = new MarkdownCache().rows(
    [
      { id: "u1", kind: "user", text: "first" },
      { id: "a1", kind: "assistant", text: "reply" },
      { id: "a2", kind: "assistant", text: "more" },
      { id: "w1", kind: "[+] work", compact: true, action: true, text: "" },
      { id: "u2", kind: "user", text: "second" },
      { id: "u3", kind: "user", text: "third" },
      { id: "a3", kind: "assistant", text: "last" },
    ],
    20,
  );
  expect(rows[0]!.id).toBe("u1:0:0");
  expect(rows.filter((row) => row.separator).map((row) => row.id)).toEqual(
    ["a1", "u2", "u3", "a3"].flatMap((id) => [`rule/${id}:0:0`, `rule/${id}:1:0`]),
  );
  rows.forEach((row, index) => {
    if (!row.id.endsWith(":1:0") || !row.separator) return;
    expect(row.spans[0]!.text).toBe("─".repeat(20));
    expect(rows[index - 1]!.spans).toEqual([]);
    // The rule sits directly on the message it introduces.
    expect(rows[index + 1]!.id).toBe(`${row.id.slice("rule/".length, -":1:0".length)}:0:0`);
  });
});

test("a work group after a user message gets a rule", () => {
  const work = (id: string, type: string, values: object) =>
    ({
      sourceThreadId: "thread",
      sourceItemId: id,
      item: { id, type, status: "completed", runId: "run", ...values },
    }) as unknown as WorkRow;
  const items = workMessages(
    [
      work("u", "user_message", { text: "Run it" }),
      work("c1", "command_execution", { input: "echo a" }),
      work("c2", "command_execution", { input: "echo b" }),
      work("a", "assistant_message", { text: "Done" }),
    ],
    new Set(),
  );
  expect(items.map((item) => item.id)).toEqual(["thread/u", "work/thread/c1", "thread/a"]);
  const rows = new MarkdownCache().rows(items, 30);
  const rule = rows.findIndex((row) => row.id === "rule/work/thread/c1:1:0");
  expect(rule).toBeGreaterThan(0);
  expect(rows[rule + 1]!.id).toBe("work/thread/c1:0:0");
  expect(plain(rows.slice(rule + 1, rule + 2))[0]).toContain("Ran 2 commands");
  // The reply after the group is still the same speaker.
  expect(ruleText(rows, "thread/a")).toBeUndefined();
});

test("rules redraw at the new width after a resize", async () => {
  const items = [
    { id: "u", kind: "user", text: "Prompt" },
    { id: "a", kind: "assistant", text: "Reply" },
  ];
  let setWidth: (width: number) => void = () => {};
  function Harness() {
    const [width, set] = useState(50);
    useEffect(() => {
      setWidth = set;
    }, []);
    return <TranscriptViewport items={items} width={width} height={10} />;
  }
  const view = await testRender(<Harness />, { width: 60, height: 10 });
  const ruleLength = () =>
    view
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("─"))
      ?.trim().length;
  try {
    await view.flush();
    expect(ruleLength()).toBe(50);
    await act(async () => setWidth(30));
    await view.flush();
    expect(ruleLength()).toBe(30);
    await act(async () => setWidth(45));
    await view.flush();
    expect(ruleLength()).toBe(45);
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});

test("streaming and prepending keep earlier rows and anchors, rule anchors included", () => {
  const cache = new MarkdownCache();
  const user = { id: "u", kind: "user", text: "Prompt" };
  const before = cache.rows([user, { id: "a", kind: "assistant", text: "start" }], 20);
  const ruleIndex = before.findIndex((row) => row.id === "rule/a:1:0");
  const rule = before[ruleIndex]!;
  const streamedTail = { id: "a", kind: "assistant", text: "start and a tail that wraps twice" };
  const streamed = cache.rows([user, streamedTail], 20);
  // Everything above the tail is the same object, so React and the measurer leave it alone.
  for (let i = 0; i <= ruleIndex; i++) expect(streamed[i]).toBe(before[i]);
  expect(streamed.filter((row) => row.separator)).toHaveLength(2);
  expect(streamed[anchorIndex(streamed, rule.id, 5)]).toBe(rule);
  const prepended = cache.rows(
    [{ id: "old", kind: "assistant", text: "older" }, user, streamedTail],
    20,
  );
  // The old first message gains a rule, but anchored rows do not move relative to their ids.
  expect(ruleText(prepended, "u")).toBe("─".repeat(20));
  expect(prepended[anchorIndex(prepended, "u:0:0", 5)]).toBe(before[0]);
  expect(prepended[anchorIndex(prepended, rule.id, 5)]).toBe(rule);
  // A rule that stops existing leaves the anchor on its message, not at the top.
  const between = cache.rows(
    [user, { id: "x", kind: "assistant", text: "inserted" }, streamedTail],
    20,
  );
  expect(ruleText(between, "a")).toBeUndefined();
  expect(between[anchorIndex(between, rule.id, 5)]!.id).toBe("a:0:0");
});

test("a viewport anchored on a rule does not jump while streaming or prepending", async () => {
  const user = { id: "u", kind: "user", text: "Prompt" };
  let items: { id: string; kind: string; text: string }[] = [
    user,
    { id: "a", kind: "assistant", text: "start" },
  ];
  let redraw = () => {};
  function Harness() {
    const [, setTick] = useState(0);
    useEffect(() => {
      redraw = () => setTick((n) => n + 1);
    }, []);
    return (
      <TranscriptViewport
        items={items}
        width={40}
        height={6}
        anchorState={{ value: "rule/a:1:0", set: () => {} }}
      />
    );
  }
  const view = await testRender(<Harness />, { width: 40, height: 6 });
  const top = () => view.captureCharFrame().split("\n").slice(0, 2);
  const update = async (next: typeof items) => {
    items = next;
    await act(async () => redraw());
    await view.flush();
  };
  try {
    await view.flush();
    const first = top();
    expect(first[0]).toContain("─".repeat(40));
    expect(first[1]).toContain("assistant");
    await update([user, { id: "a", kind: "assistant", text: "start and more" }]);
    expect(top()).toEqual(first);
    await update([{ id: "old", kind: "assistant", text: "older" }, ...items]);
    expect(top()).toEqual(first);
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});

test("rule rows ignore clicks and stay out of copied selections", async () => {
  const copied: string[] = [];
  const activated: string[] = [];
  const view = await testRender(
    <TranscriptViewport
      effects={{
        copy: (text) => {
          copied.push(text);
        },
      }}
      activate={(id) => activated.push(id)}
      items={[
        { id: "u", kind: "user", text: "first" },
        { id: "w", kind: "[+] work", compact: true, action: true, text: "" },
      ]}
      width={40}
      height={12}
    />,
    { width: 40, height: 12 },
  );
  const click = async (y: number) => {
    await act(async () => {
      await view.mockMouse.click(3, y);
    });
    await view.flush();
  };
  try {
    await view.flush();
    const lines = view.captureCharFrame().split("\n");
    expect(lines[2]!.trim()).toBe("");
    expect(lines[3]).toContain("─".repeat(40));
    expect(lines[4]).toContain("[+] work");
    await click(2);
    await click(3);
    expect(activated).toEqual([]);
    await click(4);
    expect(activated).toEqual(["w"]);
    await act(async () => {
      await view.mockMouse.drag(0, 1, 6, 4);
    });
    await view.flush();
    const text = copied.at(-1)!;
    expect(text).toContain("first");
    expect(text).toContain("[+] wo");
    expect(text).not.toContain("─");
    expect(text).not.toContain("\n\n");
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});

test("hidden hints drop the vim key rows and give one back to the transcript", async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `u${i}`,
    kind: "user" as const,
    text: `line ${String(i).padStart(2, "0")}`,
  }));
  const render = async (shown: boolean) => {
    const view = await testRender(
      <HintsShown.Provider value={shown}>
        <TranscriptViewport effects={{ copy: () => {} }} items={items} width={60} height={8} />
      </HintsShown.Provider>,
      { width: 60, height: 8 },
    );
    await view.flush();
    const frame = view.captureCharFrame();
    view.renderer.destroy();
    return frame;
  };
  const shown = await render(true);
  expect(shown).toContain("hjkl wbe move");
  expect(shown).toContain("focus block");
  const hidden = await render(false);
  expect(hidden).not.toContain("hjkl");
  expect(hidden).not.toContain("focus block");
  // Following the tail, the last message sits one row lower when the hint row is gone.
  const lastAt = (frame: string) => frame.split("\n").findIndex((l) => l.includes("line 11"));
  expect(lastAt(shown)).toBeGreaterThan(0);
  expect(lastAt(hidden)).toBe(lastAt(shown) + 1);
});

test("transcript right-click Copy preserves exact drag text, scrolling and dismissal", async () => {
  const copied: string[] = [];
  let reject = false;
  const view = await testRender(
    <TranscriptViewport
      effects={{
        copy: async (text) => {
          if (reject) throw new Error("rejected");
          copied.push(text);
        },
      }}
      items={[
        { id: "a", kind: "assistant", text: "alpha 界 beta\nsecond line\nthird line\nfourth line" },
      ]}
      width={40}
      height={12}
    />,
    { width: 40, height: 12, kittyKeyboard: true, exitOnCtrlC: false },
  );
  const mouse = async (fn: () => Promise<void>) => {
    await act(fn);
    await view.flush();
  };
  const key = async (name: string) => {
    await act(async () => view.mockInput.pressKey(name));
    await view.flush();
  };
  const open = () => mouse(() => view.mockMouse.click(10, 2, 2));
  try {
    await view.flush();
    await mouse(() => view.mockMouse.drag(2, 1, 5, 2));
    const selected = view.renderer.getSelection()!.getSelectedText();
    expect(selected).toBe("pha 界 beta\nsecond");
    expect(copied.at(-1)).toBe(selected); // Existing drag auto-copy.
    await open();
    expect(view.captureCharFrame()).toContain("1 Copy");
    expect(view.renderer.getSelection()!.getSelectedText()).toBe(selected);
    await mouse(() => view.mockMouse.scroll(12, 2, "up"));
    expect(view.renderer.getSelection()!.getSelectedText()).toBe(selected);
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("1 Copy"));
    await mouse(() => view.mockMouse.click(lines[y]!.indexOf("Copy"), y));
    expect(copied).toEqual([selected, selected]);
    expect(view.renderer.getSelection()!.getSelectedText()).toBe(selected);
    await open();
    await key("ESCAPE");
    expect(view.captureCharFrame()).not.toContain("1 Copy");
    await open();
    await mouse(() => view.mockMouse.click(35, 9));
    expect(view.captureCharFrame()).not.toContain("1 Copy");
    await mouse(() => view.mockMouse.drag(0, 1, 4, 1));
    await open();
    reject = true;
    await key("RETURN");
    expect(view.captureCharFrame()).toContain("copy failed");
    reject = false;
    await mouse(() => view.mockMouse.click(3, 1, 2, { modifiers: { shift: true } }));
    expect(view.captureCharFrame()).not.toContain("1 Copy");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});
