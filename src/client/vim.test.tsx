import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TranscriptViewport } from "./transcript-viewport";
import type { Actions } from "../actions";
import { measureMarkdown } from "./markdown";
import { selectionText, transcriptMatches, wordBack, wordEnd, wordForward } from "./vim";

const text = "alpha beta-gamma\n```sh\ndocker compose up -d\n```\nlast line";
const rows = measureMarkdown({ id: "a", kind: "assistant", text }, 40);
const at = (needle: string) => {
  const row = rows.findIndex((r) => r.spans.some((s) => s.text.includes(needle)));
  return {
    row,
    col: rows[row]!.spans.map((s) => s.text)
      .join("")
      .indexOf(needle),
  };
};

test("word motions follow editor classes: words, punctuation, and line breaks", () => {
  const start = at("alpha");
  const beta = wordForward(rows, start);
  expect(beta).toEqual(at("beta"));
  expect(wordForward(rows, beta)).toEqual({ ...beta, col: beta.col + 4 });
  expect(wordEnd(rows, start)).toEqual({ ...start, col: 4 });
  expect(wordBack(rows, beta)).toEqual(start);
});

test("selection spans wrapped pieces without breaking them and skips code chrome", () => {
  const narrow = measureMarkdown({ id: "b", kind: "assistant", text: "head\nabcdefghij\ntail" }, 6);
  const first = narrow.findIndex((r) => r.spans[0]?.text === "abcdef");
  expect(narrow[first + 1]?.spans[0]?.text).toBe("ghij");
  // Line mode takes the whole wrapped line from any piece of it.
  expect(
    selectionText(narrow, { row: first + 1, col: 0 }, { row: first + 1, col: 0 }, "line"),
  ).toBe("abcdefghij");
  expect(selectionText(narrow, { row: first, col: 4 }, { row: first + 1, col: 1 }, "char")).toBe(
    "efgh",
  );
  const code = at("docker");
  expect(selectionText(rows, { ...code, col: 7 }, { ...code, col: 13 }, "char")).toBe("compose");
});

test("v, V, y, yy and gg/G drive the transcript like an editor", async () => {
  const copied: string[] = [];
  const effects: Actions = { copy: (value) => void copied.push(value) };
  const view = await testRender(
    <TranscriptViewport
      effects={effects}
      cwd="/fixture"
      items={[{ id: "a", kind: "assistant", text }]}
      width={50}
      height={16}
    />,
    { width: 50, height: 16 },
  );
  const press = async (name: string, modifiers?: Record<string, boolean>) => {
    await act(async () => view.mockInput.pressKey(name, modifiers));
    await view.flush();
  };
  try {
    await view.waitForFrame((f) => f.includes("docker compose"));
    // First key places the cursor on the last visible line; gg goes to the top.
    await press("g");
    await press("g");
    await press("j"); // alpha line
    await press("w"); // beta
    await press("v");
    for (let i = 0; i < 3; i++) await press("l");
    expect(view.captureCharFrame()).toContain("VISUAL");
    // Right-click copies the Vim selection without moving its cursor or leaving visual mode.
    await act(async () => view.mockMouse.click(8, 1, 2));
    await view.flush();
    expect(view.captureCharFrame()).toContain("1 Copy");
    await press("1");
    expect(copied.at(-1)).toBe("beta");
    expect(view.captureCharFrame()).toContain("VISUAL");
    await press("y");
    expect(copied.at(-1)).toBe("beta");
    expect(view.captureCharFrame()).not.toContain("VISUAL");
    await press("y");
    await press("y");
    expect(copied.at(-1)).toBe("alpha beta-gamma");
    // A command inside a block, without taking the whole block.
    await press("j");
    await press("w");
    await press("v");
    await press("e");
    await press("y");
    expect(copied.at(-1)).toBe("compose");
    await press("G");
    await press("V");
    await press("y");
    expect(copied.at(-1)).toBe("last line");
    await press("v", { shift: true });
    await press("k");
    await press("y");
    expect(copied.at(-1)).toBe("docker compose up -d\nlast line");
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});

test("search finds literal text across wraps after wide graphemes", () => {
  const rows = measureMarkdown({ id: "a", kind: "assistant", text: "head\n👩‍💻abcdefghabcdefgh" }, 6);
  const hits = transcriptMatches(rows, "defgh");
  expect(hits).toHaveLength(2);
  expect(hits[0]?.start.col).toBe(4);
});

test("transcript search submits, cycles both ways and cancels", async () => {
  const view = await testRender(<TranscriptViewport items={[{ id: "s", kind: "user", text: "head\nfirst item\nsecond item" }]} width={60} height={8} />, { width: 60, height: 8, kittyKeyboard: true });
  const key = async (value: string) => {
    await act(async () => view.mockInput.pressKey(value));
    await view.flush();
  };
  try {
    await key("/");
    for (const c of "item") await key(c);
    await key("RETURN");
    expect(view.captureCharFrame()).toContain("/item · 1/2");
    await key("n");
    expect(view.captureCharFrame()).toContain("/item · 2/2");
    await key("N");
    expect(view.captureCharFrame()).toContain("/item · 1/2");
    await key("/");
    await key("ESCAPE");
    await view.waitForFrame((frame) => !frame.includes("Find in loaded transcript"));
    expect(view.captureCharFrame()).toContain("/item · 1/2");
  } finally {
    await view.dispose();
  }
});
