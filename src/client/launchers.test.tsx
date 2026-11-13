import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { threadWebUrl } from "../actions";
import { composerFixture } from "./composer.test";
import { AppFrame } from "./frame";

test("web route encodes environment/thread segments", async () => {
  expect(threadWebUrl("https://host:123/", "env/a", "thread b")).toBe(
    "https://host:123/env%2Fa/thread%20b",
  );
});

test("launcher is a plain list: letters, arrows, Enter and clicks run entries", async () => {
  const h = await composerFixture();
  const calls: unknown[] = [];
  const view = await testRender(
    <AppFrame
      client={h.client}
      effects={{
        copy() {},
        shell: async (input) => {
          calls.push(["shell", input]);
        },
        openThread: async (input) => {
          calls.push(["web", input]);
        },
      }}
    />,
    { width: 160, height: 44, kittyKeyboard: true },
  );
  const key = async (name: string, meta = false) => {
    await act(async () => {
      view.mockInput.pressKey(name, { meta });
    });
    await view.flush();
  };
  const click = async (label: string) => {
    const rows = view.captureCharFrame().split("\n");
    const y = rows.findIndex((row) => row.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await view.mockMouse.click(rows[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  };
  try {
    // Files, Diff, Terminal and Shell are no longer status-bar hints; Web and Launchers are.
    await view.waitForFrame((f) => f.includes("Alt+l Launchers"));
    const bar = view.captureCharFrame();
    expect(bar).toContain("Alt+l Launchers");
    expect(bar).not.toContain("Alt+t Shell");
    expect(bar).not.toContain("Alt+f Files");
    await key("o", true);
    await click("Alt+o Web");
    expect(calls).toEqual([
      ["web", { threadId: "composer" }],
      ["web", { threadId: "composer" }],
    ]);
    await key("l", true);
    for (const label of ["Files (F)", "Diff (D)", "Terminal (T)", "Shell (S)"])
      expect(view.captureCharFrame()).toContain(label);
    await key("s");
    await view.waitForFrame((f) => f.includes("Shell ✓"));
    await key("ARROW_DOWN");
    await key("ARROW_DOWN");
    await key("ARROW_DOWN");
    await key("RETURN");
    await key("k");
    await key("j");
    await key("l");
    await click("Shell (S)");
    expect(calls.slice(2)).toEqual([
      ["shell", { cwd: "/fixture" }],
      ["shell", { cwd: "/fixture" }],
      ["shell", { cwd: "/fixture" }],
      ["shell", { cwd: "/fixture" }],
    ]);
    await click("[Close]");
    expect(view.captureCharFrame()).not.toContain("Shell (S)");
    // Panel entries swap the right panel (Diff needs real checkpoints, so the fixture opens Files).
    await key("l", true);
    await key("f");
    await view.waitForFrame((f) => !f.includes("Shell (S)"));
    await key("l", true);
    await view.waitForFrame((f) => f.includes("Files (F)"));
    await click("Files (F)");
    await view.waitForFrame((f) => !f.includes("Shell (S)"));
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});
