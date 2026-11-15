import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TranscriptViewport } from "./transcript-viewport";
import { MarkdownCache, measureMarkdown, blockActions } from "./markdown";

test("Read shortcut preserves an existing custom R target", async () => {
  for (const custom of [false, true]) {
    const calls: string[] = [];
    const effects = {
      copy() {},
      targets: custom ? [{ name: "remote", key: "R" }] : [],
      copyTo: async (name: string) => { calls.push(name); },
      readback: async () => { calls.push("read"); },
    };
    const view = await testRender(<TranscriptViewport items={[{ id: "a", kind: "assistant", text: "Hello world" }]} width={60} height={12} effects={effects} />, { width: 60, height: 12 });
    try {
      await view.renderOnce();
      await act(async () => { view.mockInput.pressKey("v"); });
      await act(async () => { view.mockInput.pressKey("R"); });
      await view.flush();
      expect(calls).toEqual([custom ? "remote" : "read"]);
    } finally { await act(async () => view.renderer.destroy()); }
  }
});

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

test("the Read button shows a spinner while speech is made and a play icon while it plays", async () => {
  let phase!: (value: "preparing" | "speaking") => void;
  let finish!: () => void;
  const effects = { copy() {}, readback: async (_text: string, onPhase?: (value: "preparing" | "speaking") => void) => {
    phase = onPhase!; await new Promise<void>(resolve => { finish = resolve; });
  }, stopReadback() { finish?.(); } };
  const view = await testRender(<TranscriptViewport items={[{ id: "a", kind: "assistant", text: "Hello world" }]} width={60} height={12} effects={effects} />, {width:60, height:12});
  const readRow = () => view.captureCharFrame().split("\n").find(l => l.includes("[read]")) ?? "";
  try {
    await view.renderOnce();
    expect(readRow()).not.toMatch(/preparing|reading/);
    const row = view.captureCharFrame().split("\n").findIndex(l => l.includes("[read]"));
    await act(async () => { await view.mockMouse.click(2, row); });
    await view.renderOnce();
    expect(readRow()).toMatch(/\[read\] [⠋-⠏] preparing/);
    await act(async () => { phase("speaking"); });
    await view.renderOnce();
    expect(readRow()).toContain("[read] ▶ reading");
    await act(async () => { await view.mockMouse.click(2, row); }); // Read again stops it
    await view.renderOnce();
    expect(readRow()).not.toMatch(/preparing|reading/);
  } finally { await act(async () => view.renderer.destroy()); }
});

test("a Read click that fails because setup is missing shows the hint, and [read] stays", async () => {
  const hint = "Read aloud is not set up. Run `tercet readback setup`.";
  let ready = false;
  const calls: string[] = [];
  // Mirrors the app: the check runs on every click, so setup finished meanwhile works at once.
  const effects = { copy() {}, readback: async (text: string) => { calls.push(text); if (!ready) throw new Error(hint); } };
  const view = await testRender(<TranscriptViewport items={[{ id: "a", kind: "assistant", text: "Hello world" }]} width={80} height={12} effects={effects} />, { width: 80, height: 12 });
  const frame = () => view.captureCharFrame();
  try {
    await view.renderOnce();
    const row = frame().split("\n").findIndex(l => l.includes("[read]"));
    await act(async () => { await view.mockMouse.click(2, row); await Promise.resolve(); });
    await view.renderOnce();
    expect(frame()).toContain(`X ${hint}`);
    expect(frame()).toContain("[read]");
    expect(frame()).not.toMatch(/preparing|reading/);
    ready = true;
    await act(async () => { await view.mockMouse.click(2, row); await Promise.resolve(); });
    await view.renderOnce();
    expect(calls).toEqual(["Hello world", "Hello world"]);
    expect(frame()).not.toContain("not set up");
  } finally { await act(async () => view.renderer.destroy()); }
});
