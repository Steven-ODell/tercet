import { act } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import { createClient } from "./runtime";
import { AppFrame } from "./frame";
import { keymap } from "./keymap";
import type { LayoutMode } from "./layout";

const SIDEBAR = "Thread fixture";
const TRANSCRIPT = "Transcript fixture";
const PANEL = "Panel file fixture";

async function rig(
  width: number,
  height: number,
  fn: (t: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  mode?: LayoutMode,
) {
  const t = await setup(width, height, mode);
  try {
    await fn(t);
  } finally {
    await act(async () => {
      await t.view.dispose();
    });
    await t.client.dispose();
  }
}

async function setup(width: number, height: number, mode?: LayoutMode) {
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
      layoutMode: async () => mode ?? "auto",
    },
    false,
  );
  client.registry.set(client.status, "live");
  const view = await testRender(
    <AppFrame
      client={client}
      content={{
        sidebar: <text>{SIDEBAR}</text>,
        transcript: <text>{TRANSCRIPT}</text>,
        right: <text>{PANEL}</text>,
      }}
    />,
    { width, height, kittyKeyboard: true, exitOnCtrlC: false },
  );
  await view.flush();
  const frame = () => view.captureCharFrame();
  const key = async (name: string, modifiers?: { ctrl?: boolean; meta?: boolean }) => {
    await act(async () => {
      view.mockInput.pressKey(name === "escape" ? "ESCAPE" : name, modifiers);
    });
    await view.flush();
  };
  const tap = async (label: string) => {
    const lines = frame().split("\n");
    const y = lines.findIndex((line) => line.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  };
  const resize = async (w: number, h: number) => {
    await act(async () => view.resize(w, h));
    await view.flush();
  };
  return { client, view, frame, key, tap, resize };
}

const views = (f: string) => ({
  threads: f.includes(SIDEBAR),
  chat: f.includes(TRANSCRIPT),
  composer: f.includes("Composer"),
  panel: f.includes(PANEL),
});

test("50x40 shows one view at a time with a tab strip", () =>
  rig(50, 40, async ({ frame, key, tap }) => {
    // Opens on Threads, full width, the strip has no panel tab yet.
    expect(views(frame())).toEqual({ threads: true, chat: false, composer: false, panel: false });
    expect(frame().split("\n")[0]).toContain("[Threads] [Chat]");
    expect(frame()).not.toContain("[Files]");
    const top = frame().split("\n");
    expect(top.find((line) => line.includes(SIDEBAR))!.indexOf("│", 2)).toBe(49);
    // Tapping [Chat] shows the transcript over the composer only.
    await tap("[Chat]");
    expect(views(frame())).toEqual({ threads: false, chat: true, composer: true, panel: false });
    // Alt+f shows Files full width with its tab.
    await key("f", { meta: true });
    expect(views(frame())).toEqual({ threads: false, chat: false, composer: false, panel: true });
    expect(frame().split("\n")[0]).toContain("[Threads] [Chat] [Files]");
    // Tabs switch views, and Alt+h / Ctrl+l walk them like the pane keys.
    await tap("[Threads]");
    expect(views(frame()).threads).toBe(true);
    await key("l", { ctrl: true });
    expect(views(frame())).toEqual({ threads: false, chat: true, composer: true, panel: false });
    await key("h", { meta: true });
    expect(views(frame()).threads).toBe(true);
    await tap("[Files]");
    expect(views(frame()).panel).toBe(true);
    // Esc walks Panel -> Threads -> Chat -> Panel.
    await key("escape");
    expect(views(frame()).threads).toBe(true);
    await key("escape");
    expect(views(frame()).chat).toBe(true);
    await key("escape");
    expect(views(frame()).panel).toBe(true);
    // Alt+b toggles Threads from the panel and back to the last centre pane.
    await key("b", { meta: true });
    expect(views(frame()).threads).toBe(true);
    await key("b", { meta: true });
    expect(views(frame()).chat).toBe(true);
  }));

test("the view survives a resize and 120x40 shows the three columns", () =>
  rig(50, 40, async ({ frame, key, tap, resize }) => {
    await tap("[Chat]");
    await resize(50, 20);
    expect(views(frame())).toEqual({ threads: false, chat: true, composer: true, panel: false });
    await resize(50, 40);
    expect(views(frame())).toEqual({ threads: false, chat: true, composer: true, panel: false });
    // A panel view stays put too, and so does Threads.
    await key("l", { meta: true }); // launchers
    expect(views(frame()).panel).toBe(true);
    await resize(50, 20);
    expect(views(frame()).panel).toBe(true);
    await resize(60, 40);
    expect(views(frame()).panel).toBe(true);
    await tap("[Threads]");
    await resize(50, 40);
    expect(views(frame()).threads).toBe(true);
    // Wide again: today's three columns.
    await resize(120, 40);
    expect(views(frame())).toEqual({ threads: true, chat: true, composer: true, panel: true });
    expect(frame().split("\n")[0]).toContain("tercet ·");
    expect(frame()).not.toContain("[Chat]");
  }));

test("120x40 and 80x24 keep the desktop frame", async () => {
  for (const [w, h] of [
    [120, 40],
    [80, 24],
  ] as const)
    await rig(w, h, async ({ frame }) => {
      expect(frame().split("\n")[0]).toContain("tercet ·");
      expect(frame()).not.toContain("[Chat]");
      expect(views(frame())).toMatchObject({ threads: true, chat: true, composer: true });
    });
});

test("layout full keeps the desktop frame at 50x40, compact slims it at 120x40", async () => {
  await rig(
    50,
    40,
    async ({ frame }) => {
      expect(frame().split("\n")[0]).toContain("tercet ·");
      expect(frame()).not.toContain("[Chat]");
      expect(frame()).not.toContain("[Menu]");
      expect(frame()).toContain("Focus:");
      expect(views(frame())).toMatchObject({ threads: true, chat: true, composer: true });
    },
    "full",
  );
  await rig(
    120,
    40,
    async ({ frame }) => {
      const text = frame();
      // Three columns, slim chrome: one action bar instead of the focus line and hint rows.
      expect(views(text)).toMatchObject({ threads: true, chat: true, composer: true });
      expect(text).toContain("[Menu] [Model] [Panels] [Threads] [Help]");
      expect(text).not.toContain("Focus:");
      expect(text).not.toContain("Alt+b Sidebar");
      expect(text).not.toContain("[Chat]");
    },
    "compact",
  );
});

test("110x20 keeps three columns and gives the panes 18 rows", () =>
  rig(110, 20, async ({ frame, key }) => {
    await key("l", { meta: true });
    const lines = frame().split("\n");
    expect(views(frame())).toEqual({ threads: true, chat: true, composer: true, panel: true });
    expect(lines[0]).toContain("tercet ·");
    // Row 0 is the status row and row 19 the action bar: no header rows, no hint rows.
    expect(lines[1]!.trimStart().startsWith("╭")).toBe(true);
    expect(lines[18]).toContain("╰");
    expect(lines[19]).toContain("[Menu]");
    expect(lines.slice(1, 19).length).toBeGreaterThanOrEqual(15);
  }));

test("50x12 with the composer focused keeps the draft and [send] above the keyboard", () =>
  rig(50, 12, async ({ client, frame, tap, key }) => {
    await act(async () => client.registry.set(client.selectedThreadId, "thread-1" as never));
    await tap("[Chat]");
    await key("i");
    const lines = frame().split("\n");
    expect(lines.some((line) => line.includes("Composer"))).toBe(true);
    expect(frame()).toContain("[send]");
    // The transcript gave its rows back: only its title row is left above the composer.
    const composerRow = lines.findIndex((line) => line.includes("Composer"));
    const transcriptRow = lines.findIndex((line) => line.includes("Transcript"));
    expect(composerRow - transcriptRow).toBeLessThanOrEqual(2);
    expect(lines.length - composerRow).toBeGreaterThanOrEqual(4);
  }));

test("each action bar item runs its command", async () => {
  await rig(50, 40, async ({ frame, tap }) => {
    await tap("[Menu]");
    expect(frame()).toContain("tap a row");
  });
  await rig(50, 40, async ({ frame, tap }) => {
    await tap("[Help]");
    expect(frame()).toContain("Keys");
    expect(frame()).toContain("Anywhere");
  });
  await rig(50, 40, async ({ frame, tap }) => {
    await tap("[Panels]");
    expect(views(frame()).panel).toBe(true);
    expect(frame().split("\n")[0]).toContain("[Launchers]");
  });
  await rig(50, 40, async ({ frame, tap }) => {
    await tap("[Chat]");
    expect(views(frame()).threads).toBe(false);
    const lines = frame().split("\n");
    const y = lines.findLastIndex((line) => line.includes("[Threads]"));
    await tap(lines[y]!.slice(lines[y]!.lastIndexOf("[Threads]")));
    expect(views(frame()).threads).toBe(true);
  });
  await rig(50, 40, async ({ frame, tap }) => {
    await tap("[Model]");
    expect(frame()).toContain("Model · Favorites first");
  });
});

test("every bound command has a tappable row in the compact Menu sheet", async () => {
  const rows = keymap().filter((b) => b.chord && !b.needs);
  expect(rows.length).toBeGreaterThan(20);
  for (const binding of rows)
    await rig(50, 80, async ({ frame, tap, key }) => {
      await key("slash", { shift: true } as never).catch(() => {});
      await tap("[Menu]");
      const text = `${binding.hint.padEnd(11)} ${binding.label}`;
      expect(frame()).toContain(text);
      await tap(text);
      const after = frame();
      if (binding.id === "help") expect(after).toContain("Anywhere");
      else if (binding.id === "close") expect(after).not.toContain("tap a row");
      else expect(after).not.toContain("tap a row");
      if (binding.id === "files") expect(views(after).panel).toBe(true);
      if (binding.id === "quit") expect(after).toContain("Press Ctrl+c again to quit");
      if (binding.id === "sidebar") expect(views(after).threads).toBe(false);
      if (binding.id === "hints") expect(after).toContain("[Menu]");
    });
});
