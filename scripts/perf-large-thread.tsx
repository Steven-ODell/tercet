// Large-thread measurement (P7): the real frame on a generated thread of N items, headless
// (opentui's test renderer: layout and drawing, no terminal writes). Prints one JSON line.
//   bun scripts/perf-large-thread.tsx 20000
// docs/performance.md records the numbers; src/perf.test.ts runs a smaller copy as a gate.
import * as Effect from "effect/Effect";
import type { OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import { createClient } from "../src/client/runtime";
import { AppFrame } from "../src/client/frame";
import { fixtureNow, flatFixture } from "../src/client/sidebar-fixture";
import { emptyTranscript } from "../src/client/transcript-state";

export function largeThread(threadId: ThreadId, count: number) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const turn = Math.floor(i / 10);
    const id = `i${i}`;
    const base = { id, status: "completed", runId: `run-${turn}` };
    const kind = i % 10;
    const item =
      kind === 0
        ? { ...base, type: "user_message", text: `Turn ${turn}: please look at **file ${i}.ts**.` }
        : kind <= 3
          ? {
              ...base,
              type: "command_execution",
              input: `rg -n pattern${i} src/`,
              output: `src/a${i}.ts:12: match\nsrc/b${i}.ts:40: match`,
              exitCode: 0,
            }
          : kind === 4
            ? { ...base, type: "reasoning", text: `Thinking about step ${i}.` }
            : kind === 5
              ? {
                  ...base,
                  type: "file_change",
                  fileName: `src/file${i}.ts`,
                  additions: 3,
                  deletions: 1,
                  diffStr: `@@ -1 +1,3 @@\n-old ${i}\n+new ${i}\n+more\n+lines`,
                }
              : kind === 6
                ? { ...base, type: "dynamic_tool", toolName: "Read", input: { file: `f${i}.md` } }
                : kind === 7
                  ? { ...base, type: "todo_list", steps: [{ text: `Step ${i}`, status: "done" }] }
                  : kind === 8
                    ? {
                        ...base,
                        type: "assistant_message",
                        text: `Done with turn ${turn}.\n\n- First point about \`thing${i}\`\n- Second point\n\n\`\`\`bash\necho ${i}\nbun test\n\`\`\`\n\nA closing paragraph long enough to wrap across more than one row of the transcript at the default width, so wrapping costs show up.`,
                      }
                    : { ...base, type: "system_notice", message: `Notice ${i}` };
    rows.push({ sourceThreadId: threadId, sourceItemId: id, item });
  }
  return rows;
}

const pct = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!.toFixed(2);
};
const stats = (samples: number[]) => ({
  p50: pct(samples, 0.5),
  p99: pct(samples, 0.99),
  max: +Math.max(...samples).toFixed(2),
});
const mb = (bytes: number) => +(bytes / 1024 / 1024).toFixed(1);

export async function measure(count: number, { keys = 200, appends = 50 } = {}) {
  // Loaded here: production React (the `--live` mode) has no act().
  const { act } = await import("react");
  const { testRender } = await import("@opentui/react/test-utils");
  Bun.gc(true);
  const baseRss = process.memoryUsage().rss;
  const snapshot = flatFixture();
  const threadId: ThreadId = snapshot.threads[0]!.id;
  const visibleTurnItems = largeThread(threadId, count);
  const projection = {
    thread: { id: threadId },
    runs: [],
    visibleTurnItems,
  } as unknown as OrchestrationV2ThreadProjection;
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
    },
    false,
    () => Date.parse(fixtureNow),
  );
  client.registry.set(client.snapshot, snapshot);
  client.registry.set(client.status, "live");
  client.registry.set(
    client.transcripts,
    new Map([[threadId, { ...emptyTranscript, projection }]]),
  );
  client.openThread(threadId);
  const started = performance.now();
  const view = await testRender(<AppFrame client={client} />, { width: 160, height: 48 });
  await view.renderOnce();
  const firstFrameMs = +(performance.now() - started).toFixed(1);
  Bun.gc(true);
  const rssFirstFrame = process.memoryUsage().rss;
  const press = async (key: string, modifiers?: { ctrl?: boolean }) => {
    const t = performance.now();
    await act(async () => view.mockInput.pressKey(key, modifiers));
    await view.renderOnce();
    return performance.now() - t;
  };
  // Focus the transcript (threads -> transcript), then scroll it.
  await press("l", { ctrl: true });
  const frame = view.captureCharFrame();
  const j: number[] = [];
  const k: number[] = [];
  const half: number[] = [];
  const jumps: number[] = [];
  for (let i = 0; i < keys; i++) k.push(await press("k"));
  for (let i = 0; i < keys; i++) j.push(await press("j"));
  for (let i = 0; i < keys / 4; i++) half.push(await press("u", { ctrl: true }));
  for (let i = 0; i < 5; i++) {
    jumps.push((await press("g")) + (await press("g")));
    jumps.push(await press("G"));
  }
  Bun.gc(true);
  const rssScrolled = process.memoryUsage().rss;
  // Streaming: one new item at the tail per update, as a live run does.
  const append: number[] = [];
  let rows = visibleTurnItems;
  for (let i = 0; i < appends; i++) {
    const id = `live${i}`;
    rows = [
      ...rows,
      {
        sourceThreadId: threadId,
        sourceItemId: id,
        item: {
          id,
          type: "assistant_message",
          status: "completed",
          runId: "live",
          text: `live ${i}`,
        },
      },
    ];
    const next = { ...projection, visibleTurnItems: rows } as unknown as typeof projection;
    const t = performance.now();
    await act(async () =>
      client.registry.set(
        client.transcripts,
        new Map([[threadId, { ...emptyTranscript, projection: next }]]),
      ),
    );
    await view.renderOnce();
    append.push(performance.now() - t);
  }
  Bun.gc(true);
  const memory = process.memoryUsage();
  const result = {
    items: count,
    rssBaseMB: mb(baseRss),
    rssFirstFrameMB: mb(rssFirstFrame),
    rssScrolledMB: mb(rssScrolled),
    rssMB: mb(memory.rss),
    heapMB: mb(memory.heapUsed),
    firstFrameMs,
    transcriptShown: frame.includes("Turn ") || frame.includes("Ran "),
    keyMs: { j: stats(j), k: stats(k), halfPage: stats(half), jump: stats(jumps) },
    appendMs: stats(append),
  };
  await act(async () => view.renderer.destroy());
  await client.dispose();
  return result;
}

if (import.meta.main && process.argv[2] !== "--live") {
  const count = Number(process.argv[2] ?? 5000);
  console.log(JSON.stringify(await measure(count)));
  process.exit(0);
}

/**
 * `--live N OUT`: the same thread on a real renderer (run it in a private tmux). Writes RSS after
 * the first frame to OUT, then again after each `!` key (the rig sends scroll keys between).
 */
export async function live(count: number, out: string) {
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const snapshot = flatFixture();
  const threadId: ThreadId = snapshot.threads[0]!.id;
  const projection = {
    thread: { id: threadId },
    runs: [],
    visibleTurnItems: largeThread(threadId, count),
  } as unknown as OrchestrationV2ThreadProjection;
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
    },
    false,
    () => Date.parse(fixtureNow),
  );
  client.registry.set(client.snapshot, snapshot);
  client.registry.set(client.status, "live");
  client.registry.set(
    client.transcripts,
    new Map([[threadId, { ...emptyTranscript, projection }]]),
  );
  client.openThread(threadId);
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  let written = "";
  const report = () => {
    Bun.gc(true);
    const line = `${process.env.NODE_ENV ?? "development"} rss=${mb(process.memoryUsage().rss)}\n`;
    void Bun.write(out, (written += line));
  };
  let rows = projection.visibleTurnItems;
  // `+` streams 100 items at 30 Hz, as a live run does, then reports.
  const stream = () => {
    let n = 0;
    const timer = setInterval(() => {
      const id = `live${rows.length}`;
      rows = [
        ...rows,
        {
          sourceThreadId: threadId,
          sourceItemId: id,
          item: { id, type: "assistant_message", status: "completed", runId: "live", text: id },
        } as unknown as (typeof rows)[number],
      ];
      client.registry.set(
        client.transcripts,
        new Map([
          [threadId, { ...emptyTranscript, projection: { ...projection, visibleTurnItems: rows } }],
        ]),
      );
      if (++n === 100) {
        clearInterval(timer);
        setTimeout(report, 500);
      }
    }, 33);
  };
  renderer.keyInput.on("keypress", (key: { name: string; sequence?: string }) => {
    if (key.name === "!" || key.sequence === "!") report();
    if (key.sequence === "+") stream();
  });
  createRoot(renderer).render(<AppFrame client={client} />);
  setTimeout(report, 1500);
}

if (import.meta.main && process.argv[2] === "--live")
  await live(Number(process.argv[3]), process.argv[4]!);
