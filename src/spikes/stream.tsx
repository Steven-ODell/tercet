import { TranscriptViewport } from "../client/transcript-viewport";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";

const kinds = ["user", "assistant", "command", "reasoning", "file", "notice"] as const;
export function makeTranscript(count = 5_000) {
  return Array.from({ length: count }, (_, id) => ({
    id,
    kind: kinds[id % kinds.length]!,
    text:
      `#${String(id).padStart(4, "0")} ` +
      [
        "Please inspect the streaming client and keep names wrapped.",
        "## Result\nThe transcript stays responsive.\n```ts\nconst ready = true;\n```",
        "$ bun test\n3 pass, 0 fail",
        "Checking the event order before changing the rendering boundary.",
        "+ src/client.ts\n- old connection path",
        "Checkpoint saved; no external action dispatched.",
      ][id % kinds.length]!,
  }));
}
export type TranscriptItem = ReturnType<typeof makeTranscript>[number];

// The spike uses terminal rows as its scroll coordinate. Only the visible slice is mounted.
// Step 8 must replace this simple wrapper with measured Markdown row heights.
export function itemRows(item: TranscriptItem, width: number) {
  const columns = Math.max(1, width);
  return [`${String(item.id).padStart(4, "0")} ${item.kind}`, ...item.text.split("\n")].flatMap(
    (line) =>
      line.length
        ? Array.from({ length: Math.ceil(line.length / columns) }, (_, i) =>
            line.slice(i * columns, (i + 1) * columns),
          )
        : [""],
  );
}
export function visibleRows(rows: readonly string[], height: number, away: number) {
  const end = Math.max(Math.min(height, rows.length), rows.length - Math.max(0, away));
  return rows.slice(Math.max(0, end - Math.max(1, height)), end);
}
export function percentile(values: readonly number[], fraction: number) {
  if (!values.length) throw new Error("No frame samples");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function Stream({
  items,
  updates = 0,
  onCommit,
  subscribe,
}: {
  items: readonly TranscriptItem[];
  updates?: number;
  onCommit?: (tick: number, started: number) => void;
  subscribe?: (append: (chunk: string) => void) => () => void;
}) {
  const { width, height } = useTerminalDimensions();
  const renderer = useRenderer();
  const [stream, setStream] = useState({ text: "", tick: 0, started: 0 });
  const [keys, setKeys] = useState(0);
  useEffect(() => {
    if (subscribe)
      return subscribe((chunk) => {
        const started = performance.now();
        setStream((old) => ({ text: old.text + chunk, tick: old.tick + 1, started }));
      });
    if (!updates) return;
    const timer = setInterval(() => {
      const started = performance.now();
      setStream((old) => ({
        text: old.text + ` token${old.tick + 1}`,
        tick: old.tick + 1,
        started,
      }));
    }, 1000 / updates);
    return () => clearInterval(timer);
  }, [updates, subscribe]);
  useLayoutEffect(() => {
    onCommit?.(stream.tick, stream.started);
  }, [stream, onCommit]);
  const liveItems = useMemo(
    () =>
      items.map((item, i) =>
        i === items.length - 1 ? { ...item, text: item.text + "\n" + stream.text } : item,
      ),
    [items, stream.text],
  );
  useKeyboard((key) => {
    if (key.name === "x") setKeys((n) => n + 1);
    if (key.name === "q") renderer.destroy();
  });
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor="#16181a">
      <text height={1} fg="#b07cf5">
        stream items={items.length} tick={stream.tick} key={keys} history/tail
      </text>
      <TranscriptViewport items={liveItems} width={width} height={height - 2} />
      <text height={1}>
        {width}x{height} · j/k/wheel | Home/End | x: echo | q: quit
      </text>
    </box>
  );
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    targetFps: 60,
    maxFps: 120,
    gatherStats: true,
  });
  const samples: number[] = [];
  let committed = { tick: 0, started: 0 };
  let presented = 0;
  renderer.on("frame", () => {
    if (committed.tick > presented) {
      samples.push(performance.now() - committed.started);
      presented = committed.tick;
    }
  });
  const timer = setTimeout(async () => {
    const output = process.env.TERCET_STREAM_METRICS;
    if (output)
      await Bun.write(
        output,
        JSON.stringify({
          samples,
          ticks: presented,
          rssBytes: process.memoryUsage().rss,
          render: renderer.getStats().frameTimes,
        }),
      );
  }, 12_000);
  renderer.once("destroy", () => clearTimeout(timer));
  process.once("SIGTERM", () => renderer.destroy());
  process.once("SIGINT", () => renderer.destroy());
  createRoot(renderer).render(
    <Stream
      items={makeTranscript()}
      updates={30}
      onCommit={(tick, started) => {
        committed = { tick, started };
      }}
    />,
  );
}
