import { test, expect } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import type { TerminalAttachStreamEvent } from "@t3tools/contracts";
import { Terminal } from "@xterm/headless";
import { composerFixture } from "./composer.test";
import type { TerminalOp } from "./connection";
import { AppFrame } from "./frame";
import { TerminalPanel, type QueuedRun } from "./terminal";
import { encodeKey, paletteColor, screenText } from "./terminal-screen";

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));
const key = (name: string, extra: Partial<Parameters<typeof encodeKey>[0]> = {}) =>
  encodeKey({ name, ctrl: false, shift: false, sequence: "", raw: "", source: "kitty", ...extra }, false);

test("screen text keeps colors, the cursor block and full-width rows", async () => {
  const term = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
  await write(term, "\x1b[31mred\x1b[0m ok\r\n\x1b[48;5;21mbg\x1b[0m\r\n$ ");
  const chunks = screenText(term, true).chunks;
  const text = chunks.map((chunk) => chunk.text).join("");
  expect(text.split("\n")).toEqual(["red ok    ", "bg        ", "$         "]);
  const red = chunks.find((chunk) => chunk.text === "red")!;
  expect(red.fg!.toInts().slice(0, 3)).toEqual([255, 110, 94]);
  expect(chunks.find((chunk) => chunk.text === "bg")!.bg!.toInts().slice(0, 3)).toEqual([
    0, 0, 255,
  ]);
  // The cursor sits after "$ " and draws as a filled cell.
  const cursor = chunks[chunks.findIndex((chunk) => chunk.text === "$ ") + 1]!;
  expect(cursor.text).toBe(" ");
  expect(cursor.bg).toBeDefined();
  expect(screenText(term, false).chunks.some((chunk) => chunk.text === " " && chunk.bg)).toBe(
    false,
  );
  expect(paletteColor(244)).toBe("#808080");
});

test("keys encode to what a shell reads, whatever protocol the outer terminal speaks", () => {
  expect(key("c", { ctrl: true })).toBe("\x03");
  expect(key("return")).toBe("\r");
  expect(key("backspace")).toBe("\x7f");
  expect(key("escape")).toBe("\x1b");
  expect(key("tab", { shift: true })).toBe("\x1b[Z");
  expect(key("up")).toBe("\x1b[A");
  expect(key("left", { ctrl: true })).toBe("\x1b[1;5D");
  expect(key("delete")).toBe("\x1b[3~");
  expect(key("a", { shift: true, sequence: "A" })).toBe("A");
  expect(key("é", { sequence: "é" })).toBe("é");
  expect(key("a", { sequence: "\x1b[97u" })).toBe("a");
  expect(key("x", { source: "raw", raw: "x" })).toBe("x");
  expect(
    encodeKey({ name: "up", ctrl: false, shift: false, sequence: "", raw: "", source: "raw" }, true),
  ).toBe("\x1bOA");
});

test("Alt+j opens the thread shell, keys reach it, and Alt+h is the way out", async () => {
  const h = await composerFixture();
  const ops: TerminalOp[] = [];
  const attached: unknown[] = [];
  let emit: (event: TerminalAttachStreamEvent) => void = () => {};
  h.client.boundary.terminal = (_, input, receive, bind) =>
    Effect.sync(() => {
      attached.push(input);
      emit = receive;
      bind((op) => ops.push(op));
    }).pipe(Effect.andThen(Effect.never));
  let quit = 0;
  const view = await testRender(<AppFrame client={h.client} onQuit={() => quit++} />, {
    width: 120,
    height: 30,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const press = async (name: string, modifiers: { meta?: boolean; ctrl?: boolean } = {}) => {
    await act(async () => {
      view.mockInput.pressKey(name, modifiers);
    });
    await view.flush();
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await view.flush();
  };
  const base = { threadId: "composer", terminalId: "term-1" };
  try {
    await press("j", { meta: true });
    expect(attached).toEqual([
      {
        ...base,
        cwd: "/fixture",
        worktreePath: null,
        cols: 58,
        rows: 19,
        restartIfNotRunning: true,
      },
    ]);
    await act(async () => {
      emit({
        type: "snapshot",
        snapshot: {
          ...base,
          cwd: "/fixture",
          worktreePath: null,
          status: "running",
          pid: 1,
          // A replayed cursor-position query must not be answered into the live shell.
          history: "old line\r\n\x1b[6n",
          exitCode: null,
          exitSignal: null,
          label: "zsh",
          updatedAt: "now",
        },
      });
      emit({ ...base, type: "output", data: "\x1b[32mfixture $\x1b[0m " });
    });
    await settle();
    const frame = view.captureCharFrame();
    expect(frame).toContain("old line");
    expect(frame).toContain("fixture $");
    expect(frame).toContain("zsh · Alt+c leaves");
    expect(ops).toEqual([]);

    await press("l");
    await press("s");
    await press("c", { ctrl: true });
    await press("c", { ctrl: true });
    await press("ESCAPE");
    await press("p", { ctrl: true });
    await press("RETURN");
    expect(ops).toEqual(
      ["l", "s", "\x03", "\x03", "\x1b", "\x10", "\r"].map((data) => ({ kind: "write", data })),
    );
    expect(quit).toBe(0);
    expect(view.captureCharFrame()).toContain("Focus: right");

    await act(async () => {
      emit({ ...base, type: "exited", exitCode: 0, exitSignal: null });
    });
    await settle();
    expect(view.captureCharFrame()).toContain("Shell exited · Enter restarts");
    ops.length = 0;
    await press("x");
    await press("RETURN");
    expect(ops).toEqual([
      { kind: "restart", cwd: "/fixture", worktreePath: null, cols: 58, rows: 19 },
    ]);

    await press("h", { meta: true });
    expect(view.captureCharFrame()).not.toContain("Focus: right");
    await press("j", { meta: true });
    expect(view.captureCharFrame()).not.toContain("Shell exited");
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
    await h.client.dispose();
  }
});

test("a queued [run] is typed only into the shell of the thread it was clicked in", async () => {
  const base = { threadId: "composer", terminalId: "term-1" };
  const run = async (queuedRun: QueuedRun) => {
    const h = await composerFixture();
    const ops: TerminalOp[] = [];
    let emit: (event: TerminalAttachStreamEvent) => void = () => {};
    h.client.boundary.terminal = (_, _input, receive, bind) =>
      Effect.sync(() => {
        emit = receive;
        bind((op) => ops.push(op));
      }).pipe(Effect.andThen(Effect.never));
    const done: number[] = [];
    // Clears the run when told, as the frame does.
    function Host() {
      const [queued, setQueued] = useState<QueuedRun | undefined>(queuedRun);
      return (
        <TerminalPanel
          client={h.client}
          threadId={"composer" as never}
          cwd="/fixture"
          worktreePath={null}
          enabled={false}
          queuedRun={queued}
          onRunDone={(id) => {
            done.push(id);
            setQueued(undefined);
          }}
          width={40}
          height={10}
          close={() => {}}
        />
      );
    }
    const view = await testRender(<Host />, { width: 40, height: 10 });
    try {
      await act(async () => {
        emit({
          type: "snapshot",
          snapshot: {
            ...base,
            cwd: "/fixture",
            worktreePath: null,
            status: "running",
            pid: 1,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "zsh",
            updatedAt: "now",
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      await view.flush();
      return { ops, done };
    } finally {
      await act(async () => view.renderer.destroy());
    }
  };
  const here = await run({ id: 1, text: "echo hi\n", threadId: "composer" as never });
  expect(here.done).toEqual([1]);
  expect(here.ops).toEqual([
    { kind: "write", data: "echo hi" },
    { kind: "write", data: "\r" },
  ]);
  const elsewhere = await run({ id: 2, text: "echo hi", threadId: "other" as never });
  expect(elsewhere.done).toEqual([2]);
  expect(elsewhere.ops).toEqual([]);
});
