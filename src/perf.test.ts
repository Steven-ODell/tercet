import { expect, test } from "bun:test";
import { measure } from "../scripts/perf-large-thread";

// A 5,000-item thread on the real frame (headless). Bounds are loose so a loaded machine passes;
// they catch an O(n) regression per key or per streamed item. Numbers: docs/performance.md.
test("5,000 items: scrolling and streaming stay fast, memory stays bounded", async () => {
  const result = await measure(5000, { keys: 40, appends: 10 });
  expect(result.transcriptShown).toBe(true);
  for (const key of Object.values(result.keyMs)) expect(key.p99).toBeLessThan(100);
  expect(result.appendMs.p99).toBeLessThan(150);
  expect(result.heapMB).toBeLessThan(300);
}, 60_000);

test("the row cache's append path draws exactly what a full rebuild draws", async () => {
  const { MarkdownCache } = await import("./client/markdown");
  const message = (id: string, kind: string, text: string) => ({ id, kind, text });
  const base = [
    message("u1", "user", "Question **one**"),
    message("a1", "assistant", "Answer\n\n```bash\necho hi\n```"),
    message("w1", "[+] Ran 2 commands", ""),
    message("a2", "assistant", "Streaming tail, first part"),
  ];
  const next = [
    ...base.slice(0, 3),
    message("a2", "assistant", "Streaming tail, first part, then more"),
    message("u2", "user", "Next question"),
    message("a3", "assistant", "Reply"),
  ];
  const strip = (rows: readonly { id: string; spans: readonly { text: string }[] }[]) =>
    rows.map((row) => `${row.id}|${row.spans.map((s) => s.text).join("")}`);
  const incremental = new MarkdownCache();
  incremental.rows(base, 60);
  const appended = strip(incremental.rows(next, 60));
  expect(appended).toEqual(strip(new MarkdownCache().rows(next, 60)));
  // And again on top of an appended state.
  const more = [...next, message("u3", "user", "Third")];
  expect(strip(incremental.rows(more, 60))).toEqual(strip(new MarkdownCache().rows(more, 60)));
});
