import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TranscriptViewport } from "./transcript-viewport";
import { MarkdownCache, measureMarkdown, blockActions } from "./markdown";

test("Read appears below assistant text, stays out of code blocks, and survives streamed cache updates", () => {
  const item = {id: "a", kind: "assistant", text: "Hello"};
  const cache = new MarkdownCache();
  expect(cache.rows([item], 60, 12, ["__readback"]).at(-1)!.spans[0]!.action).toBe("read");
  expect(cache.rows([{...item, text: "Hello world"}], 60, 12, ["__readback"]).at(-1)!.target!.text).toBe("Hello world");
  expect(cache.rows([item], 60).some(r => r.spans.some(s => s.action === "read"))).toBe(false);
  expect(measureMarkdown({...item, kind: "user"}, 60, 12, ["__readback"]).some(r => r.chrome)).toBe(false);
  expect(blockActions("sh", "echo hi", true, ["__readback", "run"])).toEqual(["copy", "run"]);
});

test("click Read then Stop cancels playback; unmount also stops", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const effects = { copy() {}, readback: async (text: string) => {
    calls.push(text); await new Promise<void>(resolve => { finish = resolve; });
  }, stopReadback() { calls.push("stop"); finish?.(); } };
  const view = await testRender(<TranscriptViewport items={[{ id: "a", kind: "assistant", text: "Hello world" }]} width={60} height={12} effects={effects} />, {width:60, height:12});
  try {
    await view.renderOnce();
    const lines = view.captureCharFrame().split("\n");
    const row = lines.findIndex(l => l.includes("[read]"));
    expect(row).toBeGreaterThan(0);
    await act(async () => { await view.mockMouse.click(2, row); });
    await view.renderOnce();
    expect(calls).toEqual(["Hello world"]);
    const stopRow = view.captureCharFrame().split("\n").findIndex(l => l.includes("[stop reading]"));
    expect(stopRow).toBeGreaterThan(row);
    await act(async () => { await view.mockMouse.click(2, stopRow); });
    await view.renderOnce();
    expect(calls).toEqual(["Hello world", "stop"]);
  } finally { await act(async () => view.renderer.destroy()); }
});
