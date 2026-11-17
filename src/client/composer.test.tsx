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
  tagMessage,
  type DraftStore,
} from "./composer-state";
import { connectionConfig } from "./config";
import { platform } from "./platform";
import { parseSettings } from "./settings";
import { ThreadComposer } from "./composer";
import { AppFrame } from "./frame";
import { setTheme } from "./theme";

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
      node instanceof TextareaRenderable ? node : node.getChildren().map(findEditor).find(Boolean);
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

test("keys typed in bursts (voxtype) keep every character and the caret at the end", async () => {
  const h = await composerFixture();
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const view = await testRender(
    <AppFrame client={h.client} effects={{ copy() {}, pasteImage: async () => png }} />,
    { width: 174, height: 22, kittyKeyboard: true, exitOnCtrlC: false },
  );
  const findEditor = (node: Renderable): TextareaRenderable | undefined =>
    node instanceof TextareaRenderable ? node : node.getChildren().map(findEditor).find(Boolean);
  const sentence =
    "Can we make it so that it also has these features as well where it shows the color of the assistant is blue and it says assistant above it and then the color of mine is green and it says user above mine. Also, can we make it so that there's more themes to choose from please ";
  const dictated = sentence.repeat(3);
  try {
    await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    await act(async () => view.mockInput.pasteBracketedText("hi "));
    await view.flush();
    // The image leaves the textarea two rows tall, so a long dictation has to scroll.
    await act(async () => view.mockInput.pressKey("p", { meta: true }));
    await view.flush();
    const editor = findEditor(view.renderer.root)!;
    let sent = 0;
    for (const char of dictated) {
      view.mockInput.typeText(char);
      // Between keys, React gets a turn; every fifth key the event loop does too.
      await Promise.resolve();
      if (++sent % 5 === 0) await Bun.sleep(1);
    }
    let previous = -1;
    while (previous !== editor.plainText.length) {
      previous = editor.plainText.length;
      await Bun.sleep(150);
    }
    await view.flush();
    expect(editor.plainText).toBe("hi " + dictated);
    expect(editor.cursorOffset).toBe(editor.plainText.length);
    const row = view.renderer.getCursorState().y - 1;
    expect(row).toBeGreaterThanOrEqual(editor.y);
    expect(row).toBeLessThan(editor.y + editor.height);
  } finally {
    await act(async () => view.renderer.destroy());
    await h.client.dispose();
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

test("while the composer is collapsed, the status line carries the mic's message", async () => {
  const h = await composerFixture();
  let fail: ((error: Error) => void) | undefined;
  (h.client as { speechStatus: () => Promise<unknown> }).speechStatus = async () => ({
    supported: true,
    state: "ready",
  });
  const effects = {
    copy() {},
    record: async (options?: { onFailure?: (error: Error) => void }) => {
      fail = options?.onFailure;
      return { stop: async () => new Uint8Array(4), cancel() {} };
    },
  };
  const view = await testRender(<AppFrame client={h.client} effects={effects} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const lines = () => view.captureCharFrame().split("\n");
  const status = () =>
    lines().find((line) => line.includes("Focus:") || line.includes("Mic ")) ?? "";
  try {
    await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    const composerRow = lines().findIndex((line) => line.includes("Composer─"));
    await act(async () => view.mockMouse.click(60, composerRow));
    await view.waitForFrame((frame) => frame.includes("Focus: composer"));
    await act(async () => view.mockInput.pressKey("v", { meta: true }));
    await view.waitForFrame((frame) => frame.includes("Recording]"));
    // Open: the message sits beside the mic button and the status line keeps the focus.
    expect(view.captureCharFrame()).toContain("Focus: composer");
    await act(async () => view.mockMouse.click(60, 5));
    await view.waitForFrame((frame) => !frame.includes("Recording]"));
    expect(status()).toContain("Mic recording");
    await act(async () => fail?.(new Error("pw-record exited with 1: device unplugged")));
    await view.flush();
    expect(view.captureCharFrame()).toContain("device unplugged");
  } finally {
    await act(async () => view.renderer.destroy());
    await h.client.dispose();
  }
});

test("a long dictation previews from its first words in the collapsed composer", async () => {
  const h = await composerFixture();
  const said = Array.from({ length: 30 }, (_, i) => `word${i + 1}`).join(" ");
  Object.assign(h.client, {
    speechStatus: async () => ({ supported: true, state: "ready" }),
    transcribe: async () => said,
  });
  const effects = {
    copy() {},
    record: async () => ({ stop: async () => new Uint8Array(4), cancel() {} }),
  };
  const view = await testRender(<AppFrame client={h.client} effects={effects} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const composerLines = () => {
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Composer─"));
    return { y, lines: lines.slice(y + 1, y + 3) };
  };
  try {
    await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    await act(async () => view.mockInput.pressKey("v", { meta: true }));
    await view.waitForFrame((frame) => frame.includes("Mic recording"));
    await act(async () => view.mockInput.pressKey("v", { meta: true }));
    await view.waitForFrame((frame) => frame.includes("transcript added"));
    // Alt+v opened the composer; leaving it collapses the composer with the transcript inside.
    await act(async () => view.mockMouse.click(60, 5));
    await view.waitForFrame((frame) => !frame.includes("send / queue]"));
    const collapsed = composerLines();
    expect(collapsed.lines[0]).toContain("word1 word2 word3");
    expect(collapsed.lines[0]).toContain("word30");
    await act(async () => view.mockMouse.click(60, collapsed.y + 1));
    await view.waitForFrame((frame) => frame.includes("send / queue]"));
    // Opened, the draft is whole and the caret still sits at its end.
    await act(async () => view.mockInput.typeText("!"));
    await view.flush();
    await act(async () => view.mockInput.pressKey("RETURN"));
    await view.flush();
    expect(h.commands[0]).toMatchObject({ type: "message.dispatch", text: `${said}!` });
  } finally {
    await act(async () => view.renderer.destroy());
    await h.client.dispose();
  }
});

test("Alt+v from another pane opens the composer, so typed dictation lands there whole", async () => {
  const h = await composerFixture();
  let recording = false;
  // voxtype and other external tools type the transcript as keys, after the stop press.
  const effects = {
    copy() {},
    toggleDictation: async () => ({ recording: (recording = !recording) }),
  };
  const view = await testRender(<AppFrame client={h.client} effects={effects} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    await act(async () => view.mockMouse.click(60, 5));
    await view.waitForFrame((frame) => frame.includes("Focus: transcript"));
    await act(async () => view.mockInput.pressKey("v", { meta: true }));
    await view.waitForFrame((frame) => frame.includes("Focus: composer"));
    await act(async () => view.mockInput.pressKey("v", { meta: true }));
    await view.flush();
    // In the transcript these letters were commands until an "o" (Vim's open) reached the composer.
    await act(async () => view.mockInput.typeText("hello there"));
    await view.flush();
    await act(async () => view.mockInput.pressKey("RETURN"));
    await view.flush();
    expect(h.commands[0]).toMatchObject({ type: "message.dispatch", text: "hello there" });
  } finally {
    await act(async () => view.renderer.destroy());
    await h.client.dispose();
  }
});

test.each([
  ["cyberdream", true],
  ["light", false],
  ["sand", false],
])("the caret is visible on %s", async (preset, dark) => {
  setTheme({ preset });
  const h = await composerFixture();
  const view = await testRender(<AppFrame client={h.client} effects={{ copy() {} }} />, {
    width: 100,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await view.waitForFrame((frame) => frame.includes("Focus: sidebar"));
    await act(async () => view.mockInput.pasteBracketedText("hello"));
    await view.flush();
    // White on the dark preset, as before; near black on the light ones, where white vanished.
    const red = view.renderer.getCursorState().color.buffer[0]!;
    if (dark) expect(red).toBe(255);
    else expect(red).toBeLessThan(60);
  } finally {
    await act(async () => view.renderer.destroy());
    setTheme({});
  }
});

const findTextEditor = (node: Renderable): TextareaRenderable | undefined =>
  node instanceof TextareaRenderable ? node : node.getChildren().map(findTextEditor).find(Boolean);

test("composer drag, right-click, Copy/Cut/Paste and undo preserve the draft and selection", async () => {
  const h = await composerFixture();
  const copied: string[] = [];
  let finish: (() => void) | undefined;
  let fail = false;
  const view = await testRender(
    <ThreadComposer
      client={h.client}
      enabled
      effects={{
        copy: async (text) => {
          copied.push(text);
          if (fail) throw new Error("clipboard rejected");
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        pasteClipboard: async () => ({ type: "text", text: "NEW" }),
      }}
    />,
    { width: 80, height: 24, kittyKeyboard: true, exitOnCtrlC: false },
  );
  const flush = () => view.flush();
  const key = async (name: string) => {
    await act(async () => view.mockInput.pressKey(name));
    await flush();
  };
  const editor = () => findTextEditor(view.renderer.root)!;
  const menu = async () => {
    await act(async () => view.mockMouse.click(editor().x + 8, editor().y, 2));
    await flush();
  };
  const pick = async (label: string) => {
    const rows = view.captureCharFrame().split("\n");
    const y = rows.findIndex((row) => new RegExp(`\\b${label}\\s*│`).test(row));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => view.mockMouse.click(rows[y]!.indexOf(label), y));
    await flush();
  };
  try {
    await act(async () => view.mockInput.pasteBracketedText("hello world"));
    await flush();
    await act(async () => view.mockMouse.drag(editor().x, editor().y, editor().x + 4, editor().y));
    await flush();
    const selected = editor().getSelectedText();
    expect(selected).toBe("hello");
    await menu();
    expect(editor().getSelectedText()).toBe(selected);
    await pick("Copy");
    expect(copied).toEqual([selected]);
    await act(async () => finish?.());
    await flush();
    expect(editor().plainText).toBe("hello world");
    await menu();
    await pick("Cut");
    expect(editor().plainText).toBe("hello world");
    await act(async () => finish?.());
    await flush();
    expect(editor().plainText).toBe(" world");
    await menu();
    await pick("Undo");
    expect(editor().plainText).toBe("hello world");
    await menu();
    await pick("Redo");
    expect(editor().plainText).toBe(" world");
    await menu();
    await pick("Select all");
    expect(editor().getSelectedText()).toBe(" world");
    fail = true;
    await menu();
    await pick("Cut");
    expect(editor().plainText).toBe(" world");
    expect(view.captureCharFrame()).toContain("clipboard rejected");
    fail = false;
    await menu();
    await pick("Cut");
    await act(async () => view.mockInput.typeText("changed while copying"));
    await flush();
    await act(async () => finish?.());
    await flush();
    expect(editor().plainText).toBe("changed while copying");
    await menu();
    await pick("Select all");
    await menu();
    await pick("Paste");
    expect(editor().plainText).toBe("NEW");
    await menu();
    await key("ESCAPE");
    expect(view.captureCharFrame()).not.toContain("Select all");
    await menu();
    await act(async () => view.mockMouse.click(70, 20));
    await flush();
    expect(view.captureCharFrame()).not.toContain("Select all");
    expect(h.commands).toHaveLength(0);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("selected composer Ctrl+C copies without arming quit in the full frame", async () => {
  const h = await composerFixture();
  const copied: string[] = [];
  let quits = 0;
  const view = await testRender(
    <AppFrame
      client={h.client}
      effects={{
        copy: (text) => {
          copied.push(text);
        },
      }}
      onQuit={() => quits++}
    />,
    { width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false },
  );
  const ctrlC = async () => {
    await act(async () => view.mockInput.pressKey("c", { ctrl: true }));
    await view.flush();
  };
  try {
    await act(async () => view.mockInput.pasteBracketedText("hello world"));
    await view.flush();
    const editor = findTextEditor(view.renderer.root)!;
    await act(async () => view.mockMouse.drag(editor.x, editor.y, editor.x + 4, editor.y));
    await view.flush();
    expect(editor.getSelectedText()).toBe("hello");
    await ctrlC();
    await ctrlC();
    expect(copied).toEqual(["hello", "hello"]);
    expect(view.captureCharFrame()).not.toContain("again to quit");
    expect(quits).toBe(0);
    await act(async () => {
      editor.editorView.resetSelection();
    });
    await ctrlC();
    expect(view.captureCharFrame()).toContain("again to quit");
    await ctrlC();
    expect(quits).toBe(1);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("messageTag: untagged by default; tags message.dispatch only, never twice, never queued edits; title seed stays untagged", async () => {
  const h = await composerFixture();
  const c = createComposer(h.client);
  const snapshot = h.client.registry.get(h.client.snapshot)!;
  try {
    // Off by default: no boundary lookup, text goes out as typed.
    c.setDraft(id, "plain");
    await c.send(id);
    expect(h.commands.at(-1)).toMatchObject({ type: "message.dispatch", text: "plain" });

    h.client.boundary.messageTag = async () => "<from PC>";
    c.setDraft(id, "hello");
    await c.send(id);
    expect(h.commands.at(-1)).toMatchObject({ type: "message.dispatch", text: "<from PC> hello" });

    // Already tagged (by hand, or by an earlier hop): left alone.
    c.setDraft(id, "<from laptop> hello");
    await c.send(id);
    expect(h.commands.at(-1)).toMatchObject({ text: "<from laptop> hello" });

    // A lookup that throws sends the message untagged instead of failing it.
    h.client.boundary.messageTag = async () => {
      throw new Error("tmux gone");
    };
    c.setDraft(id, "still sent");
    expect(await c.send(id)).toBe(true);
    expect(h.commands.at(-1)).toMatchObject({ text: "still sent" });

    // Queued-run edits keep the stored text, which was tagged when it was first sent.
    h.client.boundary.messageTag = async () => "<from PC>";
    c.setDraft(id, "edited");
    await c.send(id, false, RunId.make("queued"));
    expect(h.commands.at(-1)).toMatchObject({ type: "queued-run.edit", text: "edited" });

    // The title seed never carries the tag.
    h.client.registry.set(h.client.snapshot, {
      ...snapshot,
      threads: snapshot.threads.map((thread) => ({ ...thread, title: "New thread" })),
    });
    c.setDraft(id, "fix the login redirect");
    await c.send(id);
    expect(h.commands.at(-1)).toMatchObject({
      text: "<from PC> fix the login redirect",
      titleSeed: "fix the login redirect",
    });
  } finally {
    await h.client.dispose();
  }
});

test("tagMessage: one space, tag first; image-only becomes the tag; <from prefix is never doubled", () => {
  expect(tagMessage(undefined, "hi")).toBe("hi");
  expect(tagMessage("<from PC>", "hi")).toBe("<from PC> hi");
  expect(tagMessage("<from PC>", "")).toBe("<from PC>");
  expect(tagMessage("<from PC>", "  \n")).toBe("<from PC>");
  expect(tagMessage("<from PC>", "  <from laptop> hi")).toBe("  <from laptop> hi");
  expect(tagMessage("<from PC>", "<fromage> hi")).toBe("<from PC> <fromage> hi");
});

test("the platform boundary tags per send: local with no SSH client, ssh with a mapped or raw address", async () => {
  const base = await connectionConfig(["--url", "http://127.0.0.1:1"], async () => undefined, "/absent");
  const where = { home: "/home/u", dir: "/home/u/.config/tercet" };
  const tagged = parseSettings(
    '{"messageTag":{"local":"<from PC>","ssh":"<from {client} SSH to PC>","clients":{"100.97.33.14":"laptop"}}}',
    "settings.json",
    where,
  );
  let host: string | undefined;
  let lookups = 0;
  const lookup = async () => {
    lookups++;
    if (host === "boom") throw new Error("tmux gone");
    return host;
  };
  const boundary = platform({ ...base, settings: tagged }, lookup);
  expect(await boundary.messageTag()).toBe("<from PC>");
  host = "100.97.33.14";
  expect(await boundary.messageTag()).toBe("<from laptop SSH to PC>");
  host = "203.0.113.7";
  expect(await boundary.messageTag()).toBe("<from 203.0.113.7 SSH to PC>");
  host = "boom";
  expect(await boundary.messageTag()).toBe("<from PC>");
  // Off: no tag and no lookup at all.
  lookups = 0;
  expect(await platform({ ...base, settings: parseSettings("{}", "settings.json", where) }, lookup).messageTag()).toBeUndefined();
  expect(lookups).toBe(0);
  // Only ssh set: typing locally means no tag.
  host = undefined;
  const sshOnly = parseSettings('{"messageTag":{"ssh":"<ssh {client}>"}}', "settings.json", where);
  expect(await platform({ ...base, settings: sshOnly }, lookup).messageTag()).toBeUndefined();
});
