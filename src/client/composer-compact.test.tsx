import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThreadComposer, compactComposerRows, wrapRows } from "./composer";
import { composerFixture } from "./composer.test";

const effects = {
  copy() {},
  pasteClipboard: async () => ({ type: "text" as const, text: "x" }),
  pasteImage: async () => new Uint8Array(),
  pickFiles: async () => [],
  toggleDictation: async () => {},
} as never;

async function render(
  h: Awaited<ReturnType<typeof composerFixture>>,
  width: number,
  props: Record<string, unknown> = {},
  height = 16,
) {
  return testRender(
    <ThreadComposer client={h.client} enabled compact effects={effects} {...props} />,
    { width, height, kittyKeyboard: true, exitOnCtrlC: false },
  );
}
const lines = (view: { captureCharFrame(): string }) => view.captureCharFrame().split("\n");
const labels = [
  "[Paste]",
  "[Paste image]",
  "[Attach]",
  "[mic]",
  "[send]",
  "[steer]",
  "[stop]",
  "[edit]",
  "[cancel]",
];

test.each([48, 24])(
  "compact at %i columns shows every button whole, wrapped inside the border",
  async (width) => {
    const h = await composerFixture();
    h.setRuns(true, true);
    const view = await render(h, width);
    try {
      await view.flush();
      const frame = view.captureCharFrame();
      for (const label of labels) expect(frame).toContain(label);
      // No label straddles the right edge: each shows whole on a single row.
      for (const label of labels)
        expect(lines(view).some((line) => line.includes(label))).toBe(true);
      expect(frame).not.toContain("Alt+Enter");
      expect(frame).not.toContain("Ctrl+s");
    } finally {
      await act(async () => view.renderer.destroy());
    }
  },
);

test("tapping [steer] and [stop] still fires, and a typed draft steers as a new message", async () => {
  const h = await composerFixture();
  h.setRuns(true, false);
  const view = await render(h, 48);
  const tapLabel = async (label: string, which: "first" | "last" = "last") => {
    const rows = lines(view);
    const y =
      which === "last"
        ? rows.findLastIndex((r) => r.includes(label))
        : rows.findIndex((r) => r.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await view.mockMouse.click(rows[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  };
  try {
    await view.flush();
    await act(async () => {
      await view.mockInput.pasteBracketedText("now");
    });
    await view.flush();
    await tapLabel("[steer]");
    expect(h.commands.at(-1)).toMatchObject({
      type: "message.dispatch",
      deliveryIntent: "steer",
      text: "now",
    });
    await tapLabel("[stop]");
    expect(h.commands.at(-1)).toMatchObject({ type: "run.interrupt", runId: "active" });
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("a queued message gets its own tap row: [steer] promotes it, [edit] loads it, [cancel] drops it", async () => {
  const h = await composerFixture();
  h.setRuns(true, true);
  const view = await render(h, 48);
  const tapFirst = async (label: string) => {
    const rows = lines(view);
    const y = rows.findIndex((r) => r.includes(label));
    await act(async () => {
      await view.mockMouse.click(rows[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  };
  try {
    await view.flush();
    expect(view.captureCharFrame()).toContain("Queued 1/1: queued original");
    await tapFirst("[steer]");
    expect(h.commands.at(-1)).toMatchObject({ type: "queued-message.promote-to-steer" });
    await tapFirst("[edit]");
    expect(view.captureCharFrame()).toContain("[save edit]");
    expect(view.captureCharFrame()).toContain("[leave edit]");
    await tapFirst("[cancel]");
    expect(h.commands.at(-1)).toMatchObject({ type: "queued-run.cancel" });
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("the media row is omitted when no media action exists, and the reported rows follow", async () => {
  const h = await composerFixture();
  const seen: number[] = [];
  const bare = await render(h, 48, {
    effects: { copy() {} },
    onRows: (rows: number) => seen.push(rows),
  });
  try {
    await bare.flush();
    const frame = bare.captureCharFrame();
    for (const label of ["[Paste]", "[Paste image]", "[Attach]", "[mic]"])
      expect(frame).not.toContain(label);
    expect(frame).toContain("[send]");
    // Action row + one draft row.
    expect(seen.at(-1)).toBe(2);
  } finally {
    await act(async () => bare.renderer.destroy());
  }
  const rich: number[] = [];
  const full = await render(h, 48, { onRows: (rows: number) => rich.push(rows) });
  try {
    await full.flush();
    expect(rich.at(-1)).toBe(3);
  } finally {
    await act(async () => full.renderer.destroy());
  }
});

test("compactComposerRows counts wrapped button rows at a given width", () => {
  const media = ["[Paste]", "[Paste image]", "[Attach]", "[mic]"];
  const actions = ["[send]", "[steer]", "[stop]"];
  expect(wrapRows(48, media)).toBe(1);
  expect(wrapRows(20, media)).toBe(3);
  expect(wrapRows(10, [])).toBe(0);
  expect(compactComposerRows(48, { media, actions })).toBe(3);
  expect(compactComposerRows(20, { media, actions })).toBe(3 + 1 + 2);
  expect(compactComposerRows(48, { actions })).toBe(2);
  expect(compactComposerRows(48, { media, actions, queued: 2, images: 1, choices: true })).toBe(10);
  expect(
    compactComposerRows(30, { collapsed: true, media, actions, notes: ["x".repeat(61)] }),
  ).toBe(4);
});

test("compact off keeps the desktop buttons", async () => {
  const h = await composerFixture();
  const view = await testRender(<ThreadComposer client={h.client} enabled effects={effects} />, {
    width: 100,
    height: 12,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await view.flush();
    const frame = view.captureCharFrame();
    expect(frame).toContain("[Alt+Enter steer]");
    expect(frame).toContain("[Ctrl+s stop]");
    expect(frame).toContain("[Ctrl+v Paste]");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});
