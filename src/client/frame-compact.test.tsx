import { act } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import { createClient } from "./runtime";
import { AppFrame } from "./frame";

const SIDEBAR = "Thread fixture";
const TRANSCRIPT = "Transcript fixture";
const PANEL = "Panel file fixture";

async function rig(
  width: number,
  height: number,
  fn: (t: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const t = await setup(width, height);
  try {
    await fn(t);
  } finally {
    await act(async () => {
      await t.view.dispose();
    });
    await t.client.dispose();
  }
}

async function setup(width: number, height: number) {
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
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
