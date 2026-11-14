import { fileIcon } from "./icons";
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TextareaRenderable, type Renderable } from "@opentui/core";
import * as Effect from "effect/Effect";
import {
  ThreadId,
  RunId,
  ProviderInstanceId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { createClient, waitForLive } from "./runtime";
import { baseThread } from "./sidebar-fixture";
import { emptyTranscript } from "./transcript-state";
import {
  createComposer,
  requiresModifier,
  completionTrigger,
  type DraftStore,
} from "./composer-state";
import { ThreadComposer } from "./composer";
import { AppFrame } from "./frame";

const id = ThreadId.make("composer");
test("a long draft wraps inside the composer and keeps the caret beside the text", async () => {
  const h = await composerFixture();
  const view = await testRender(<AppFrame client={h.client} effects={{ copy() {} }} />, {
    width: 100,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const draft =
    "I need to get back to how the workstation was because I am going to change how I use it in the future";
  try {
    await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    await act(async () => view.mockInput.pasteBracketedText(draft));
    await view.flush();
    const lines = view.captureCharFrame().split("\n");
    const end = lines.findIndex((line) => line.includes("future"));
    expect(end).toBeGreaterThan(lines.findIndex((line) => line.includes("I need")));
    expect(view.renderer.getCursorState()).toMatchObject({
      x: lines[end]!.indexOf("future") + "future".length + 1,
      y: end + 1,
      visible: true,
    });
    const findEditor = (node: Renderable): TextareaRenderable | undefined =>
      node instanceof TextareaRenderable
        ? node
        : node.getChildren().map(findEditor).find(Boolean);
    const editor = findEditor(view.renderer.root)!;
    const rightBorder = lines[end]!.lastIndexOf("│");
    for (const length of [editor.width - 1, editor.width, editor.width + 1, editor.width * 2]) {
      await act(async () => {
        editor.setText("x".repeat(length));
        editor.cursorOffset = length;
      });
      await view.flush();
      // Cursor coordinates are one-based; the border's string index is zero-based.
      expect(view.renderer.getCursorState().x).toBeLessThanOrEqual(rightBorder);
    }
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test.each(["typing", "dictation", "clipboard"])(
  "%s opens the composer when it still has focus after a send",
  async (input) => {
    const h = await composerFixture();
    const view = await testRender(
      <AppFrame
        client={h.client}
        effects={{
          copy: () => {},
          pasteClipboard: async () => ({ type: "text", text: "next message" }),
        }}
      />,
      { width: 120, height: 40, kittyKeyboard: true, exitOnCtrlC: false },
    );
    try {
      await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
      await act(async () => view.mockInput.pasteBracketedText("first message"));
      await view.flush();
      await act(async () => view.mockInput.pressKey("RETURN"));
      await view.flush();
      expect(view.captureCharFrame()).toContain("Focus: composer");
      expect(view.captureCharFrame()).not.toContain("send / queue]");

      await act(async () => {
        if (input === "typing") await view.mockInput.typeText("next message");
        else if (input === "dictation") await view.mockInput.pasteBracketedText("next message");
        else await view.mockInput.pressKey("v", { ctrl: true });
      });
      await view.flush();
      expect(view.captureCharFrame()).toContain("send / queue]");
      expect(view.captureCharFrame()).toContain("next message");
      expect(h.commands).toHaveLength(1);
      await act(async () => view.mockInput.pressKey("RETURN"));
      await view.flush();
      expect(h.commands[1]).toMatchObject({ type: "message.dispatch", text: "next message" });
    } finally {
      await act(async () => view.renderer.destroy());
      await h.client.dispose();
    }
  },
);

test("dictation pastes keep their insertion point when opening the collapsed composer", async () => {
  const h = await composerFixture();
  const view = await testRender(<AppFrame client={h.client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    await act(async () => view.mockInput.pasteBracketedText("hello world"));
    await view.flush();
    // Keep a deliberate insertion point, then leave and reopen the one-line preview.
    await act(async () => {
      for (let i = 0; i < 5; i++) await view.mockInput.pressArrow("left");
    });
    await act(async () => view.mockInput.pressKey("ESCAPE"));
    await view.flush();
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Composer─"));
    const x = lines[y]!.indexOf("Composer");
    await act(async () => view.mockMouse.pressDown(x, y + 1));
    await view.flush();
    await act(async () => view.mockMouse.release(x, y + 1));
    await view.flush();
    await act(async () => view.mockInput.pasteBracketedText("pasted "));
    await view.flush();
    await act(async () => view.mockInput.pressKey("RETURN"));
    await view.flush();
    expect(h.commands[0]).toMatchObject({ type: "message.dispatch", text: "hello pasted world" });
  } finally {
    await act(async () => view.renderer.destroy());
    await h.client.dispose();
  }
});

test("a queued message keeps the composer open while another pane has focus", async () => {
  const h = await composerFixture({
    read: async () => ({ composer: "unfinished draft" }),
    write: async () => {},
  });
  const view = await testRender(<AppFrame client={h.client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await view.waitForFrame((frame) => frame.includes("unfinished draft"));
    expect(view.captureCharFrame()).not.toContain("[steer]");
    await act(async () => h.setRuns(true, true));
    await view.waitForFrame((frame) => frame.includes("[steer]"));
    expect(view.captureCharFrame()).toContain("Queued (Ctrl+j next): queued original");
    await act(async () => h.setRuns(true, false));
    await view.waitForFrame((frame) => !frame.includes("[steer]"));
  } finally {
    await act(async () => view.renderer.destroy());
    await h.client.dispose();
  }
});

test("a slow click opens a collapsed draft without releasing onto Send", async () => {
  const h = await composerFixture({
    read: async () => ({ composer: "unfinished draft" }),
    write: async () => {},
  });
  const view = await testRender(<AppFrame client={h.client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await view.waitForFrame((frame) => frame.includes("unfinished draft"));
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Composer─"));
    const x = lines[y]!.indexOf("Composer") + 2;
    await act(async () => view.mockMouse.pressDown(x, y + 1));
    await view.flush();
    await act(async () => view.mockMouse.release(x, y + 1));
    await view.flush();
    expect(h.commands).toEqual([]);
    expect(view.captureCharFrame()).toContain("send / queue]");
    expect(view.captureCharFrame()).toContain("unfinished draft");
  } finally {
    await act(async () => view.renderer.destroy());
    await h.client.dispose();
  }
});
export async function composerFixture(storage?: DraftStore) {
  const commands: OrchestrationV2Command[] = [];
  let failing = false;
  const client = createClient(
    {
      drafts: storage,
      scheduleCompletion: (callback) => {
        callback();
        return () => {};
      },
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: (_, receive) =>
        Effect.sync(() =>
          receive({
            kind: "snapshot",
            snapshot: {
              schemaVersion: 1,
              snapshotSequence: 0,
              projects: [],
              threads: [],
              archivedThreads: [],
            },
          }),
        ).pipe(Effect.andThen(Effect.never)),
      dispatch: (_, command) =>
        failing
          ? Effect.fail("offline")
          : Effect.sync(() => {
              commands.push(command);
            }),
      complete: (_, cwd, prefix, query) => {
        expect(cwd).toBe("/fixture");
        return Effect.succeed(
          prefix === "@"
            ? ["@src/a.ts", "@src/b.ts"].filter((value) => value.includes(query))
            : ["$review"],
        );
      },
    },
    false,
  );
  client.start();
  await waitForLive(client);
  client.registry.set(client.selectedThreadId, id);
  const setRuns = (running = true, queued = false) =>
    client.registry.set(
      client.transcripts,
      new Map([
        [
          id,
          {
            ...emptyTranscript,
            projection: {
              thread: { id },
              visibleTurnItems: [],
              runs: [
                ...(running ? [{ id: RunId.make("active"), status: "running" }] : []),
                ...(queued
                  ? [
                      {
                        id: RunId.make("queued"),
                        status: "queued",
                        userMessageId: "queued-message",
                        queuePosition: 1,
                      },
                    ]
                  : []),
              ],
              messages: [{ id: "queued-message", text: "queued original" }],
            } as unknown as OrchestrationV2ThreadProjection,
          },
        ],
      ]),
    );
  setRuns();
  client.registry.set(client.snapshot, {
    schemaVersion: 1,
    snapshotSequence: 0,
    archivedThreads: [],
    projects: [{ id: "p", title: "p", workspaceRoot: "/fixture" }],
    threads: [
      {
        ...baseThread,
        id,
        projectId: "p",
        title: "Composer thread",
        worktreePath: null,
        modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "free" },
      },
    ],
  } as unknown as OrchestrationV2ShellSnapshot);
  return {
    client,
    commands,
    setRuns,
    fail: () => {
      failing = true;
    },
  };
}
test("send queues by default, alternate steers, stop holds queue, edits and cancels persist server-side; failures keep drafts", async () => {
  const h = await composerFixture();
  const c = createComposer(h.client);
  try {
    c.setDraft(id, "queue");
    await c.send(id);
    c.setDraft(id, "steer");
    await c.send(id, true);
    await c.stop(id);
    c.setDraft(id, "edited");
    await c.send(id, false, RunId.make("queued"));
    await c.cancel(id, RunId.make("queued"));
    expect(h.commands.map((command) => command.type)).toEqual([
      "message.dispatch",
      "message.dispatch",
      "run.interrupt",
      "queued-run.edit",
      "queued-run.cancel",
    ]);
    expect(h.commands[0]).toMatchObject({
      dispatchMode: { type: "queue_after_active" },
      text: "queue",
    });
    expect(h.commands[1]).toMatchObject({ deliveryIntent: "steer", text: "steer" });
    expect(h.commands[2]).toMatchObject({ runId: "active", holdQueue: true });
    h.setRuns(false);
    c.setDraft(id, "idle");
    await c.send(id);
    expect(h.commands[5]).toMatchObject({ dispatchMode: { type: "start_immediately" } });
    h.fail();
    c.setDraft(id, "recover");
    expect(await c.send(id)).toBe(false);
    expect(h.client.registry.get(c.drafts)[id]).toBe("recover");
  } finally {
    await h.client.dispose();
  }
});
test("draft hydration merges concurrent typing; serialized writes survive a new composer and isolate threads", async () => {
  const pending = Promise.withResolvers<Record<string, string>>();
  let saved: Record<string, string> = {};
  const store = {
    read: () => pending.promise,
    write: async (value: Record<string, string>) => {
      saved = { ...value };
    },
  };
  const h = await composerFixture();
  const c = createComposer(h.client, store);
  try {
    c.setDraft(id, "new typing");
    pending.resolve({ composer: "old disk", other: "other thread" });
    await c.ready;
    await c.flush();
    expect(saved).toEqual({ composer: "new typing", other: "other thread" });
    const restarted = createComposer(h.client, { read: async () => saved, write: store.write });
    await restarted.ready;
    expect(h.client.registry.get(restarted.drafts)).toEqual(saved);
  } finally {
    await h.client.dispose();
  }
});
test("shortcut modes and completion token ranges", () => {
  expect(requiresModifier("enter", "a\nb")).toBe(false);
  expect(requiresModifier("mod-enter", "a")).toBe(true);
  expect(requiresModifier("mod-enter-multiline", "a")).toBe(false);
  expect(requiresModifier("mod-enter-multiline", "a\nb")).toBe(true);
  expect(completionTrigger("see @src/a rest", 10)).toMatchObject({
    prefix: "@",
    query: "src/a",
    start: 4,
    end: 10,
  });
  expect(completionTrigger("email@domain", 12)).toBeNull();
  expect(completionTrigger("hi :fir", 7)).toMatchObject({ prefix: ":", query: "fir", start: 3 });
  expect(completionTrigger("note:fir", 8)).toBeNull();
});
const createComposerForDebug = (h: { client: any }) => createComposer(h.client);
test("Alt+Enter with nothing typed steers the selected queued message, and so does its [steer] button", async () => {
  const h = await composerFixture();
  h.setRuns(true, true);
  const view = await testRender(<ThreadComposer client={h.client} enabled />, {
    width: 100,
    height: 12,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const steerKey = async () => {
    await act(async () => view.mockInput.pressKey("RETURN", { meta: true }));
    await view.flush();
  };
  try {
    await steerKey();
    expect(h.commands[0]).toMatchObject({
      type: "queued-message.promote-to-steer",
      queuedRunId: "queued",
      targetRunId: "active",
    });
    // A typed draft still steers as a new message, as before.
    await act(async () => {
      await view.mockInput.pasteBracketedText("now");
    });
    await view.flush();
    await steerKey();
    expect(h.commands[1]).toMatchObject({ type: "message.dispatch", deliveryIntent: "steer" });
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("[steer]"));
    const x = lines[y]!.indexOf("[steer]") + 2;
    await act(async () => {
      await view.mockMouse.click(x, y);
    });
    await view.flush();
    expect(h.commands[2]).toMatchObject({ type: "queued-message.promote-to-steer" });
  } finally {
    await act(async () => view.renderer.destroy());
  }
});
test("OpenTUI paste, multiline, shortcuts, queue/steer/stop, queued keyboard edit and cancel, clickable stop", async () => {
  let saved: Record<string, string> = {};
  const h = await composerFixture({
    read: async () => ({ composer: "restored" }),
    write: async (value) => {
      saved = { ...value };
    },
  });
  h.setRuns(true, true);
  const view = await testRender(<ThreadComposer client={h.client} enabled />, {
    width: 100,
    height: 12,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const key = async (
    name: string,
    modifiers?: { ctrl?: boolean; meta?: boolean; shift?: boolean },
  ) => {
    await act(async () => view.mockInput.pressKey(name, modifiers));
    await view.flush();
  };
  try {
    await view.waitForFrame((frame) => frame.includes("restored"));
    await key("RETURN");
    expect(h.commands[0]).toMatchObject({
      text: "restored",
      dispatchMode: { type: "queue_after_active" },
    });
    await act(async () => {
      await view.mockInput.pasteBracketedText("line one\nline two");
    });
    await view.flush();
    expect(h.commands.length).toBe(1);
    expect(view.captureCharFrame()).toContain("line two");
    await key("RETURN", { shift: true });
    expect(h.commands.length).toBe(1);
    await key("x");
    expect(view.captureCharFrame()).toMatch(/line two +\nx /);
    await key("RETURN", { meta: true });
    expect(h.commands[1]).toMatchObject({ text: "line one\nline two\nx", deliveryIntent: "steer" });
    await key("s", { ctrl: true });
    expect(h.commands[2]).toMatchObject({ type: "run.interrupt" });
    await key("u", { ctrl: true });
    expect(view.captureCharFrame()).toContain("[save queued edit]");
    await key("RETURN");
    expect(h.commands[3]).toMatchObject({ type: "queued-run.edit", text: "queued original" });
    await key("x", { ctrl: true });
    expect(h.commands[4]).toMatchObject({ type: "queued-run.cancel" });
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("[Ctrl+s stop]"));
    const x = lines[y]!.indexOf("[Ctrl+s stop]") + 2;
    await act(async () => {
      await view.mockMouse.click(x, y);
    });
    await view.flush();
    expect(h.commands[5]?.type).toBe("run.interrupt");
    await act(async () => {
      await view.mockInput.typeText("draft");
    });
    await view.flush();
    await view.dispose();
    expect(saved.composer).toBe("draft");
  } finally {
    await h.client.dispose();
  }
});
test("emoji completion inserts the character, also after an emoji earlier in the draft", async () => {
  const h = await composerFixture();
  const view = await testRender(<AppFrame client={h.client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const type = async (text: string) => {
    await act(async () => {
      await view.mockInput.typeText(text);
    });
    await view.flush();
  };
  const accept = async () => {
    await act(async () => view.mockInput.pressKey("TAB"));
    await view.flush();
  };
  try {
    // Launch focus is the sidebar; two Esc reach the composer.
    for (let i = 0; i < 2; i++) {
      await act(async () => view.mockInput.pressKey("ESCAPE"));
      await view.flush();
    }
    await type(":fir");
    await view.waitForFrame((frame) => frame.includes("› 🔥 fire"));
    await accept();
    expect(view.captureCharFrame()).toContain("🔥 ");
    expect(view.captureCharFrame()).not.toContain(":fir");
    await type("and :rock");
    await view.waitForFrame((frame) => frame.includes("› 🚀 rocket"));
    await accept();
    await type("end");
    const frame = view.captureCharFrame();
    expect(frame).toContain("🔥 and 🚀 end");
    expect(h.commands).toHaveLength(0);
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});
test("completion accepts keyboard and mouse without sending, frame focus keeps literal question marks", async () => {
  const h = await composerFixture();
  const view = await testRender(<AppFrame client={h.client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    for (let i = 0; i < 2; i++) {
      await act(async () => view.mockInput.pressKey("ESCAPE"));
      await view.flush();
    }
    await act(async () => {
      await view.mockInput.typeText("@src");
    });
    await view.waitForFrame((frame) => frame.includes(`› ${fileIcon("a.ts").glyph} @src/a.ts`));
    await act(async () => view.mockInput.pressKey("ARROW_DOWN"));
    await view.flush();
    await act(async () => view.mockInput.pressKey("TAB"));
    await view.flush();
    expect(view.captureCharFrame()).toContain("@src/b.ts");
    expect(view.captureCharFrame()).toContain("Focus: composer");
    await act(async () => {
      await view.mockInput.typeText("/rev");
    });
    await view.waitForFrame((frame) => frame.includes("› $review"));
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("› $review"));
    const x = lines[y]!.indexOf("$review");
    await act(async () => {
      await view.mockMouse.click(x, y);
    });
    await view.flush();
    await act(async () => {
      await view.mockInput.typeText("?");
    });
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("[ Esc Close ]");
    expect(h.commands).toHaveLength(0);
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});

test.each(["mod-enter", "mod-enter-multiline"] as const)(
  "OpenTUI %s adds newline on Enter, sends on Ctrl+Enter, isolates thread drafts",
  async (shortcut) => {
    const h = await composerFixture();
    h.client.boundary.sendShortcut = async () => shortcut;
    const view = await testRender(<ThreadComposer client={h.client} enabled />, {
      width: 100,
      height: 12,
      kittyKeyboard: true,
      exitOnCtrlC: false,
    });
    try {
      await act(async () => {
        await view.mockInput.pasteBracketedText("first\nsecond");
      });
      await view.flush();
      await act(async () => view.mockInput.pressKey("RETURN"));
      await view.flush();
      expect(h.commands).toHaveLength(0);
      await act(async () => view.mockInput.pressKey("RETURN", { ctrl: true }));
      await view.flush();
      expect(h.commands[0]).toMatchObject({ text: "first\nsecond\n" });
      await act(async () => {
        await view.mockInput.typeText("thread one");
      });
      await view.flush();
      await act(async () => h.client.openThread(ThreadId.make("other")));
      await view.flush();
      expect(view.captureCharFrame()).not.toContain("thread one");
      await act(async () => {
        await view.mockInput.typeText("thread two");
      });
      await view.flush();
      await act(async () => h.client.openThread(id));
      await view.flush();
      expect(view.captureCharFrame()).toContain("thread one");
      expect(view.captureCharFrame()).not.toContain("thread two");
    } finally {
      await act(async () => {
        await view.dispose();
      });
      await h.client.dispose();
    }
  },
);
test("tercet opens on the threads, and a paste from any pane lands in the composer", async () => {
  const h = await composerFixture();
  const view = await testRender(
    <AppFrame
      client={h.client}
      effects={{
        copy: () => {},
        pasteClipboard: async () => ({ type: "text", text: "from-the-laptop" }),
      }}
    />,
    { width: 120, height: 40, kittyKeyboard: true, exitOnCtrlC: false },
  );
  try {
    await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    await act(async () => view.mockInput.pressKey("v", { ctrl: true }));
    await view.waitForFrame((frame) => frame.includes("from-the-laptop"));
    expect(view.captureCharFrame()).toContain("Focus: composer");
    await act(async () => view.mockInput.pressKey("ESCAPE"));
    await view.flush();
    expect(view.captureCharFrame()).toContain("Focus: sidebar");
    await act(async () => view.mockInput.pasteBracketedText(" and-the-terminal"));
    await view.waitForFrame((frame) => frame.includes("and-the-terminal"));
    expect(view.captureCharFrame()).toContain("Focus: composer");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});
test("the composer shows only its draft line until it is focused, and again after a send", async () => {
  const h = await composerFixture();
  const view = await testRender(<AppFrame client={h.client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const full = (frame: string) => frame.includes("send / queue]");
  try {
    await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    expect(full(view.captureCharFrame())).toBe(false);
    const composerRow = () =>
      view
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Composer─"));
    await act(async () => view.mockMouse.click(60, composerRow()));
    await view.waitForFrame((frame) => full(frame));
    expect(view.captureCharFrame()).toContain("Focus: composer");

    await act(async () => view.mockInput.pasteBracketedText("hello"));
    await view.flush();
    await act(async () => view.mockInput.pressKey("RETURN"));
    await view.waitForFrame((frame) => !full(frame));
    expect(h.commands.some((command) => command.type === "message.dispatch")).toBe(true);
    expect(view.captureCharFrame()).toContain("Focus: composer");

    await act(async () => view.mockMouse.click(60, composerRow()));
    await view.waitForFrame((frame) => full(frame));

    await act(async () => view.mockInput.pressKey("ESCAPE"));
    await view.waitForFrame((frame) => !full(frame));
  } finally {
    await act(async () => view.renderer.destroy());
  }
});
test("paste, image paste and mic buttons draw only when their effect exists", async () => {
  const h = await composerFixture();
  const render = (effects?: Parameters<typeof AppFrame>[0]["effects"]) =>
    testRender(<AppFrame client={h.client} effects={effects} />, {
      width: 120,
      height: 40,
      kittyKeyboard: true,
      exitOnCtrlC: false,
    });
  const bare = await render();
  try {
    await bare.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    await act(async () => bare.mockInput.pasteBracketedText("typed"));
    await bare.waitForFrame((frame) => frame.includes("send / queue]"));
    expect(bare.captureCharFrame()).not.toContain("Paste]");
    expect(bare.captureCharFrame()).not.toContain("mic]");
  } finally {
    await act(async () => bare.renderer.destroy());
  }
  const full = await render({
    copy: () => {},
    pasteClipboard: async () => ({ type: "text", text: "typed" }),
    pasteImage: async () => new Uint8Array(),
    toggleDictation: async () => ({ recording: true }),
  });
  try {
    await full.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    await act(async () => full.mockInput.pasteBracketedText("typed"));
    await full.waitForFrame((frame) => frame.includes("[Alt+v mic]"));
    expect(full.captureCharFrame()).toContain("[Ctrl+v Paste]");
    expect(full.captureCharFrame()).toContain("[Alt+p Paste image]");
  } finally {
    await act(async () => full.renderer.destroy());
  }
});
