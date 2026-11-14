import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TextAttributes } from "@opentui/core";
import { ThreadComposer } from "./composer";
import { composerFixture } from "./composer.test";
import { createSpellChecker } from "./spell";
import { misspellingForCaret } from "./spell-ui";

// A tiny dictionary in the Hunspell format keeps these tests fast and exact.
const spell = (personalFile?: string) =>
  createSpellChecker({
    personalFile,
    load: async () => ({
      aff: "SET UTF-8\n",
      dic: "8\nhello\nworld\nthe\nquick\nbrown\nfox\nreceive\nreceipt\n",
    }),
  });

async function ready(checker: ReturnType<typeof spell>) {
  checker.check("");
  await new Promise<void>((resolve) => checker.subscribe(resolve));
}

const underlined = (frame: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>) =>
  frame.lines.flatMap((line) =>
    line.spans.filter((span) => span.attributes & TextAttributes.UNDERLINE).map((span) => span.text),
  );

test("a misspelled word is underlined once the caret leaves it, and a right-click offers fixes", async () => {
  const h = await composerFixture();
  const checker = spell();
  await ready(checker);
  const view = await testRender(<ThreadComposer client={h.client} enabled effects={{ copy() {}, spell: checker }} />, {
    width: 80,
    height: 14,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await act(async () => view.mockInput.pasteBracketedText("hello wrold the quick"));
    await view.flush();
    expect(underlined(view.captureSpans()).join("")).toContain("wrold");
    expect(underlined(view.captureSpans()).join("")).not.toContain("hello");
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("hello wrold"));
    const x = lines[y]!.indexOf("wrold") + 2;
    await act(async () => view.mockMouse.click(x, y, 2 /* right */));
    await view.flush();
    const frame = view.captureCharFrame();
    expect(frame).toContain("world");
    expect(frame).toContain("Add to dictionary");
    expect(frame).toContain("Ignore");
    await act(async () => view.mockInput.pressKey("RETURN"));
    await view.flush();
    expect(view.captureCharFrame()).toContain("hello world the quick");
    expect(underlined(view.captureSpans())).toEqual([]);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

const options = { width: 80, height: 14, kittyKeyboard: true, exitOnCtrlC: false };
async function typed(text: string, checker = spell()) {
  const h = await composerFixture();
  await ready(checker);
  const view = await testRender(
    <ThreadComposer client={h.client} enabled effects={{ copy() {}, spell: checker }} />,
    options,
  );
  await act(async () => view.mockInput.pasteBracketedText(text));
  await view.flush();
  return { view, checker, h };
}
const press = async (view: Awaited<ReturnType<typeof testRender>>, key: string, mods = {}) => {
  await act(async () => view.mockInput.pressKey(key, mods));
  await view.flush();
};

test("underlines land on the right words across lines", async () => {
  const { view } = await typed("hello wrold\nthe quikc brown\nfox lnie ");
  try {
    expect(underlined(view.captureSpans())).toEqual(["wrold", "quikc", "lnie"]);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("Alt+s opens the menu on the next misspelling; a number picks; Esc closes without a change", async () => {
  const { view } = await typed("wrold hello recieve ");
  try {
    await press(view, "s", { meta: true });
    expect(view.captureCharFrame()).toContain("Add to dictionary");
    await press(view, "ESCAPE");
    expect(view.captureCharFrame()).not.toContain("Add to dictionary");
    expect(view.captureCharFrame()).toContain("wrold hello recieve");
    // The caret sits at the start of the first word, so the first word's menu is up.
    await press(view, "s", { meta: true });
    await press(view, "1");
    expect(view.captureCharFrame()).toContain("world hello recieve");
    // Down moves the highlight; Enter picks. Next word is recieve; its first suggestion is receive.
    await press(view, "s", { meta: true });
    expect(view.captureCharFrame()).toContain("receive");
    await press(view, "RETURN");
    expect(view.captureCharFrame()).toContain("world hello receive");
    expect(underlined(view.captureSpans())).toEqual([]);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("Add to dictionary clears the underline and survives a restart; Ignore does too", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-spell-ui."));
  const file = join(dir, "dictionary.txt");
  const { view, checker } = await typed("zorp and blarg ", spell(file));
  try {
    expect(underlined(view.captureSpans())).toEqual(["zorp", "and", "blarg"]);
    await press(view, "s", { meta: true });
    // zorp has no suggestions: the note row, then Add (1) and Ignore (2).
    expect(view.captureCharFrame()).toContain("No suggestions");
    await press(view, "1");
    expect(underlined(view.captureSpans())).toEqual(["and", "blarg"]);
    expect(await readFile(file, "utf8")).toBe("zorp\n");
    await press(view, "s", { meta: true });
    await press(view, "2");
    expect(underlined(view.captureSpans())).toEqual(["blarg"]);
    expect(await readFile(file, "utf8")).toBe("zorp\n");
    expect(checker.check("and")).toEqual([]);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("Add to dictionary that cannot save says so and keeps the word for the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-spell-ui."));
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "");
  const { view } = await typed("zorp ", spell(join(blocker, "dictionary.txt")));
  try {
    await press(view, "s", { meta: true });
    await press(view, "1");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    await view.flush();
    expect(underlined(view.captureSpans())).toEqual([]);
    expect(view.captureCharFrame()).toContain('Could not save "zorp"');
    await act(async () => view.mockInput.typeText("x"));
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("Could not save");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("without a speller nothing is underlined and the key does nothing", async () => {
  const h = await composerFixture();
  const view = await testRender(<ThreadComposer client={h.client} enabled effects={{ copy() {} }} />, options);
  try {
    await act(async () => view.mockInput.pasteBracketedText("wrold"));
    await view.flush();
    await press(view, "s", { meta: true });
    expect(underlined(view.captureSpans())).toEqual([]);
    expect(view.captureCharFrame()).not.toContain("Ignore");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("Enter in the menu does not send the message", async () => {
  const { view, h } = await typed("wrold ");
  try {
    await press(view, "s", { meta: true });
    await press(view, "RETURN");
    expect(h.commands).toHaveLength(0);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("misspellingForCaret prefers the word at the caret, then the next, then the first", () => {
  const found = [
    { start: 0, end: 3, word: "abc" },
    { start: 10, end: 14, word: "wxyz" },
  ];
  expect(misspellingForCaret(found, 12)?.word).toBe("wxyz");
  expect(misspellingForCaret(found, 5)?.word).toBe("wxyz");
  expect(misspellingForCaret(found, 20)?.word).toBe("abc");
  expect(misspellingForCaret([], 0)).toBeUndefined();
});

test("the word still being typed is not underlined until the caret leaves it", async () => {
  const { view } = await typed("hello wrold");
  try {
    expect(underlined(view.captureSpans())).toEqual([]);
    await act(async () => view.mockInput.typeText(" "));
    await view.flush();
    expect(underlined(view.captureSpans())).toEqual(["wrold"]);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});
