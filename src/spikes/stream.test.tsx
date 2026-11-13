import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { itemRows, makeTranscript, percentile, Stream, visibleRows } from "./stream";

test("mixed fixture and wrapping preserve all content across viewport boundaries", () => {
  const items = makeTranscript();
  expect(items).toHaveLength(5000);
  expect(new Set(items.map((item) => item.kind)).size).toBe(6);
  const rows = itemRows({ id: 1, kind: "assistant", text: "abcdefghijk\n\nlast" }, 4);
  expect(rows).toEqual(["0001", " ass", "ista", "nt", "abcd", "efgh", "ijk", "", "last"]);
  expect(visibleRows(rows, 3, 0)).toEqual(["ijk", "", "last"]);
  expect(visibleRows(rows, 3, 999)).toEqual(rows.slice(0, 3));
  expect(visibleRows([], 3, 0)).toEqual([]);
  expect(percentile([30, 10, 20, 40], 0.5)).toBe(20);
  expect(percentile([30, 10, 20, 40], 0.99)).toBe(40);
  expect(() => percentile([], 0.5)).toThrow("No frame samples");
});

test("5000-item frames stream at the tail, navigate history by key and mouse, and resize", async () => {
  const committed: number[] = [];
  let append: (chunk: string) => void = () => {
    throw new Error("not subscribed");
  };
  const view = await testRender(
    <Stream
      items={makeTranscript()}
      subscribe={(next) => {
        append = next;
        return () => {};
      }}
      onCommit={(tick) => committed.push(tick)}
    />,
    { width: 120, height: 40 },
  );
  try {
    await view.waitForFrame((frame) => frame.includes("#4999 "));
    await act(async () => {
      append(" token1");
    });
    await view.waitForFrame((frame) => frame.includes("token1"));
    expect(committed.some((tick) => tick > 0)).toBe(true);
    expect(view.captureCharFrame()).not.toContain("#0000 ");
    await act(async () => {
      view.mockInput.pressKey("HOME");
    });
    await view.waitForFrame((frame) => frame.includes("#0000 ") && frame.includes("history"));
    await act(async () => {
      await view.mockMouse.scroll(10, 8, "down");
    });
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("#0000 ");
    await act(async () => {
      view.mockInput.pressKey("END");
      view.mockInput.pressKey("x");
    });
    await view.waitForFrame((frame) => frame.includes("#4999 ") && frame.includes("key=1"));
    await act(async () => {
      view.resize(40, 12);
    });
    await view.flush();
    const narrow = view.captureCharFrame();
    expect(narrow.split("\n").filter(Boolean).length).toBeLessThanOrEqual(12);
    expect(narrow).toContain("token1");
    for (const [w, h] of [
      [80, 24],
      [32, 12],
      [120, 40],
    ]) {
      await act(async () => {
        view.resize(w!, h!);
        append(` resized${w}`);
      });
      await view.flush();
      expect(view.captureCharFrame()).toContain(`resized${w}`);
    }
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});

test("empty transcript has a visible state", async () => {
  const view = await testRender(<Stream items={[]} />, { width: 80, height: 24 });
  try {
    await view.waitForFrame((frame) => frame.includes("No messages yet"));
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});
