import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { Terminal } from "@xterm/headless";
import { composerFixture } from "./composer.test";
import { AppFrame } from "./frame";
import type { EditorSession } from "../embedded-editor";

test("file edit stays pinned; editor owns Esc/Ctrl/paste, hides and resumes, and guards app quit", async () => {
  const h = await composerFixture();
  const initial = h.client.registry.get(h.client.snapshot)!;
  h.client.registry.set(h.client.snapshot, {
    ...initial,
    threads: initial.threads.map((thread) => ({ ...thread, worktreePath: "/worktree" })),
  });
  const writes: string[] = [];
  const launches: unknown[] = [];
  const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const session = {
    cwd: "/worktree",
    path: "/worktree/file.txt",
    screen,
    running: true,
    write: (text: string) => writes.push(text),
    subscribe: () => () => {},
    resize: (cols: number, rows: number) => screen.resize(cols, rows),
  } as unknown as EditorSession;
  h.client.files.list = async () => ({
    entries: [{ name: "file.txt", path: "file.txt", kind: "file" }],
    truncated: false,
  });
  h.client.files.read = async () => ({
    relativePath: "file.txt",
    byteLength: 6,
    contents: "before",
    truncated: false,
  });
  let quits = 0;
  const view = await testRender(
    <AppFrame
      client={h.client}
      onQuit={() => quits++}
      effects={{
        copy() {},
        embeddedEditor: async (input) => {
          launches.push(input);
          return session;
        },
      }}
    />,
    { width: 120, height: 32, kittyKeyboard: true, exitOnCtrlC: false },
  );
  const press = async (name: string, modifiers: { meta?: boolean; ctrl?: boolean } = {}) => {
    await act(async () => {
      view.mockInput.pressKey(name, modifiers);
      await Bun.sleep(5);
    });
    await view.flush();
  };
  try {
    await press("f", { meta: true });
    await press("RETURN");
    await press("e");
    expect(launches).toEqual([{ cwd: "/worktree", path: "file.txt" }]);
    expect(view.captureCharFrame()).toContain("Editor");
    expect(screen.cols).toBe(58);
    await press("ESCAPE");
    await press("p", { ctrl: true });
    await press("c", { ctrl: true });
    await press("k", { ctrl: true });
    expect(writes).toEqual(["\x1b", "\x10", "\x03", "\x0b"]);
    expect(quits).toBe(0);
    await act(async () => {
      await view.mockInput.pasteBracketedText("pasted\ntext");
    });
    expect(writes.at(-1)).toBe("pasted\rtext");
    await press("c", { meta: true });
    expect(session.running).toBe(true);
    await act(async () => {
      h.client.openThread("other-thread" as import("@t3tools/contracts").ThreadId);
    });
    expect(session.cwd).toBe("/worktree");
    await press("r", { meta: true });
    expect(launches).toHaveLength(1);
    await press("h", { meta: true });
    expect(view.captureCharFrame()).not.toContain("Focus: right");
    await press("c", { ctrl: true });
    await press("c", { ctrl: true });
    expect(quits).toBe(0);
    expect(view.captureCharFrame()).toContain("Quit the editor");
    session.running = false;
    await press("RETURN");
    expect(view.captureCharFrame()).toContain("Files");
  } finally {
    view.renderer.destroy();
    screen.dispose();
    await h.client.dispose();
  }
});
