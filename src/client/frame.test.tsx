import { act } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import { createClient } from "./runtime";
import { AppFrame } from "./frame";
import { cheatSheet, keymap } from "./keymap";
import { targetKeys } from "../actions";

const sheet = cheatSheet(keymap(), {}, targetKeys());
const helpRows = sheet.reduce((n, part) => n + part.rows.length + 2, 0);

for (const [width, height] of [
  [120, 40],
  [80, 24],
]) {
  test(`frame, keyboard, mouse and scroll routing at ${width}x${height}`, async () => {
    let quits = 0;
    let retries = 0;
    const client = createClient(
      {
        readToken: () => Effect.succeed("fake"),
        issueToken: () => Effect.die("no issuance"),
        wake: () => Effect.void,
        pause: () => Effect.never,
        follow: () => {
          retries++;
          return Effect.never;
        },
      },
      false,
    );
    client.registry.set(client.status, "live");
    const rows = (prefix: string) =>
      Array.from({ length: 100 }, (_, i) => (
        <text key={i} height={1}>
          {prefix} {String(i).padStart(3, "0")}
        </text>
      ));
    const view = await testRender(
      <AppFrame
        client={client}
        onQuit={() => {
          quits++;
        }}
        content={{ sidebar: rows("Thread"), transcript: rows("Message"), right: rows("File") }}
      />,
      { width, height, kittyKeyboard: true, exitOnCtrlC: false },
    );
    const key = async (name: string, modifiers?: { ctrl?: boolean; meta?: boolean }) => {
      await act(async () => {
        view.mockInput.pressKey(
          name === "tab" ? "TAB" : name === "escape" ? "ESCAPE" : name,
          modifiers,
        );
      });
      await view.flush();
    };
    const click = async (x: number, y: number) => {
      await act(async () => {
        await view.mockMouse.click(x, y);
      });
      await view.flush();
    };
    const clickHint = async () => {
      const lines = frame().split("\n");
      const y = lines.findIndex((line) => line.includes("Alt+b Sidebar"));
      await click(lines[y]!.indexOf("Alt+b Sidebar") + 2, y);
    };
    const frame = () => view.captureCharFrame();
    try {
      await view.waitForFrame((f) => f.includes("Focus: sidebar"));
      for (const title of ["Threads", "Transcript", "Composer", "Alt+b Sidebar", "? Help"])
        expect(frame()).toContain(title);
      expect(
        frame()
          .split("\n")
          .filter((line) => line.includes("╰")).length,
      ).toBeGreaterThan(0);
      await key("b", { ctrl: true }); // reserved tmux prefix must do nothing
      await key("space", { ctrl: true });
      expect(frame()).toContain("Threads");
      await key("b", { meta: true });
      expect(frame()).not.toContain("Threads");
      await clickHint();
      expect(frame()).toContain("Threads");
      await click(4, 3);
      expect(frame()).toContain("Focus: sidebar");
      await key("escape");
      expect(frame()).toContain("Focus: transcript");
      await key("escape");
      expect(frame()).toContain("Focus: composer");
      await key("escape");
      expect(frame()).toContain("Focus: sidebar");
      // Alt+h, Ctrl+j/k/l move to the neighbouring pane and stop at the edges.
      await key("h", { meta: true });
      expect(frame()).toContain("Focus: sidebar");
      await key("j", { ctrl: true });
      expect(frame()).toContain("Focus: sidebar");
      await key("l", { ctrl: true }); // returns to the last centre pane, here the composer
      expect(frame()).toContain("Focus: composer");
      await key("l", { ctrl: true });
      expect(frame()).toContain("Focus: composer");
      await key("j", { ctrl: true });
      expect(frame()).toContain("Focus: composer");
      await key("k", { ctrl: true });
      expect(frame()).toContain("Focus: transcript");
      await key("k", { ctrl: true });
      expect(frame()).toContain("Focus: transcript");
      await key("j", { ctrl: true });
      expect(frame()).toContain("Focus: composer");
      await key("h", { meta: true });
      expect(frame()).toContain("Focus: sidebar");
      await key("tab");
      expect(frame()).toContain("Focus: sidebar");
      const centerX = width === 80 ? 26 : 34;
      await click(centerX, 3);
      expect(frame()).toContain("Focus: transcript");
      for (const insertKey of ["i", "I", "a", "A", "o", "O"]) {
        await key(insertKey);
        expect(frame()).toContain("Focus: composer");
        await key("k", { ctrl: true });
        expect(frame()).toContain("Focus: transcript");
      }
      await act(async () => {
        await view.mockMouse.scroll(5, 5, "down");
      });
      await view.flush();
      expect(frame()).not.toContain("Thread 000");
      expect(frame()).toContain("Message 000");
      expect(frame()).toContain("Focus: transcript");
      await act(async () => {
        await view.mockMouse.scroll(centerX, 5, "down");
      });
      await view.flush();
      expect(frame()).not.toContain("Message 000");
      await key("f", { meta: true });
      expect(frame()).toContain("Files");
      expect(frame()).toContain("Focus: right");
      await key("h", { meta: true });
      expect(frame()).toContain("Focus: transcript");
      await key("l", { ctrl: true });
      expect(frame()).toContain("Focus: right");
      await key("escape"); // leaves the panel for the centre; the panel stays open
      expect(frame()).toContain("Focus: transcript");
      expect(frame()).toContain("Files");
      await key("l", { ctrl: true });
      expect(frame()).toContain("Focus: right");
      await key("c", { meta: true }); // Alt+c closes the panel even where it keeps Esc for itself
      expect(frame()).toContain("Focus: transcript");
      expect(frame()).not.toContain("Esc Back");
      await key("f", { meta: true });
      expect(frame()).toContain("Focus: right");
      await key("j", { ctrl: true }); // down from the panel is the composer
      expect(frame()).toContain("Focus: composer");
      await key("l", { ctrl: true });
      await key("k", { ctrl: true }); // up is the transcript
      expect(frame()).toContain("Focus: transcript");
      await key("d", { meta: true });
      expect(frame()).toContain("Diff");
      await key("escape");
      expect(frame()).toContain("Focus: transcript");
      expect(frame()).toContain("Diff");
      await key("d", { meta: true });
      expect(frame()).not.toContain("File 000");
      for (const [name, modifiers, expected] of [
        ["m", { meta: true }, "Model · Favorites first"],
        ["e", { meta: true }, "Effort · choose model"],
        ["p", { ctrl: true }, "Actions and thread search"],
        ["?", undefined, "[ Esc Close ]"],
      ] as const) {
        await key(name, modifiers);
        expect(frame()).toContain(expected);
        // The help list scrolls when the terminal is too short to show every row.
        if (name === "?" && height >= helpRows + 6)
          // Shell and dictation are listed only with their commands; this frame has no effects.
          for (const part of sheet)
            for (const row of part.rows) expect(frame()).toContain(row.keys);
        await click(4, 3); // modal blocks background pane focus
        expect(frame()).toContain("Focus: transcript");
        await key("r");
        expect(retries).toBe(0);
        await key("escape");
        expect(frame()).not.toContain(expected);
      }
      await key("c", { ctrl: true });
      expect(quits).toBe(0);
      expect(frame()).toContain("again to quit");
      await key("escape");
      await key("c", { ctrl: true });
      expect(quits).toBe(0);
      await key("c", { ctrl: true });
      expect(quits).toBe(1);
    } finally {
      await act(async () => {
        await view.dispose();
      });
      await client.dispose();
    }
  });
}

test("narrow resize collapses sidebar, allows key/mouse reopening and recovers width", async () => {
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.never,
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
    },
    false,
  );
  const view = await testRender(
    <AppFrame
      client={client}
      content={{
        sidebar: <text>Thread sidebar fixture</text>,
        transcript: <text>Transcript fixture</text>,
      }}
    />,
    { width: 120, height: 40 },
  );
  try {
    await view.flush();
    expect(view.captureCharFrame()).toContain("Thread sidebar fixture");
    await act(async () => view.resize(50, 24));
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("Thread sidebar fixture");
    expect(view.captureCharFrame()).toContain("Transcript fixture");
    await act(async () => view.mockInput.pressKey("b", { meta: true }));
    await view.flush();
    expect(view.captureCharFrame()).toContain("Threads");
    await act(async () => {
      const lines = view.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes("Alt+b Sidebar"));
      await view.mockMouse.click(lines[y]!.indexOf("Alt+b Sidebar") + 2, y);
    });
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("Threads");
    await act(async () => view.resize(120, 40));
    await view.flush();
    expect(view.captureCharFrame()).toContain("Thread sidebar fixture");
  } finally {
    await view.dispose();
    await client.dispose();
  }
});
