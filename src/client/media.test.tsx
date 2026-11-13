import type { Renderable } from "@opentui/core";
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";
import { composerFixture } from "./composer.test";
import { createComposer } from "./composer-state";
import { ThreadComposer } from "./composer";
import { NewThreadPicker, WorkspacePicker, workspaceChoices } from "./workspace";
import { createThreadActions } from "./thread-actions";
import { validateClipboardPng } from "./image";

export const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);

test("PNG validation rejects malformed and oversized data", async () => {
  expect(() => validateClipboardPng(new Uint8Array())).toThrow();
  const big = Buffer.from(png);
  big.writeUInt32BE(2001, 16);
  expect(() => validateClipboardPng(big)).toThrow("Resize");
});

test("image chip key/mouse removal and mic key/mouse use fake Actions; failed send keeps image", async () => {
  const h = await composerFixture();
  let uploads = 0,
    mic = 0;
  h.client.boundary.uploadImage = (_, bytes) =>
    Effect.sync(() => {
      expect(bytes).toEqual(png);
      uploads++;
      return {
        type: "image",
        id: "fixture-png",
        name: "clipboard.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
      };
    });
  const view = await testRender(
    <ThreadComposer
      client={h.client}
      enabled

      effects={{
        copy() {},
        pasteImage: async () => png,
        toggleDictation: async () => {
          return { recording: ++mic % 2 === 1 };
        },
      }}
    />,
    { width: 110, height: 12, kittyKeyboard: true },
  );
  async function key(name: string, meta = false) {
    await act(async () => {
      view.mockInput.pressKey(name, { meta });
    });
    await view.flush();
  }
  async function click(label: string) {
    const rows = view.captureCharFrame().split("\n"),
      y = rows.findIndex((row) => row.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await view.mockMouse.click(rows[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  }
  try {
    await key("p", true);
    expect(view.captureCharFrame()).toContain("clipboard.png");
    await key("BACKSPACE", true);
    expect(view.captureCharFrame()).not.toContain("clipboard.png");
    await click("[Alt+p");
    await click("× remove");
    expect(view.captureCharFrame()).not.toContain("clipboard.png");
    await key("v", true);
    expect(view.captureCharFrame()).toContain("Stop mic");
    await click("[Alt+v");
    expect(mic).toBe(2);
    await key("p", true);
    await key("RETURN");
    expect(h.commands.at(-1)).toMatchObject({
      type: "message.dispatch",
      text: "",
      attachments: [{ id: "fixture-png" }],
    });
    expect(uploads).toBe(1);
    expect(view.captureCharFrame()).not.toContain("clipboard.png");
    const composer = createComposer(h.client);
    composer.attach("composer", png);
    h.fail();
    expect(await composer.send(ThreadId.make("composer"))).toBe(false);
    expect(h.client.registry.get(composer.images).composer).toHaveLength(1);
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});

test("new thread workspace chooses existing worktree by keys and mouse", async () => {
  const h = await composerFixture();
  const refs = [
    { name: "main", current: true, isDefault: true, worktreePath: "/fixture" },
    { name: "feature", current: false, isDefault: false, worktreePath: "/fixture-feature" },
  ];
  expect(workspaceChoices("/fixture", refs)).toHaveLength(2);
  h.client.boundary.workspaceRefs = () => Effect.succeed(refs);
  let closed = 0;
  const view = await testRender(
    <WorkspacePicker
      client={h.client}
      target={h.client.registry.get(h.client.snapshot)!.threads[0]}
      actions={createThreadActions(h.client)}
      close={() => closed++}
    />,
    { width: 90, height: 16, kittyKeyboard: true },
  );
  try {
    await view.waitForFrame((frame) => frame.includes("/fixture-feature"));
    await act(async () => {
      view.mockInput.pressKey("ARROW_DOWN");
    });
    await view.flush();
    await act(async () => {
      view.mockInput.pressKey("RETURN");
    });
    await view.flush();
    expect(h.commands.at(-1)).toMatchObject({
      type: "thread.create",
      branch: "feature",
      worktreePath: "/fixture-feature",
    });
    const rows = view.captureCharFrame().split("\n"),
      y = rows.findIndex((row) => row.includes("feature ·"));
    await act(async () => {
      await view.mockMouse.click(10, y);
    });
    await view.flush();
    expect(closed).toBe(2);
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});

test("new thread picks a project and branch with vim keys; h steps back to the project list", async () => {
  const h = await composerFixture();
  const snapshot = h.client.registry.get(h.client.snapshot)!;
  h.client.registry.set(h.client.snapshot, {
    ...snapshot,
    projects: [
      { ...snapshot.projects[0]!, id: "other", title: "Other", workspaceRoot: "/other" } as never,
      ...snapshot.projects,
    ],
  });
  let refs = [
    { name: "main", current: true, isDefault: true, worktreePath: "/other" },
    { name: "feature", current: false, isDefault: false, worktreePath: "/other-feature" },
  ];
  h.client.boundary.workspaceRefs = () => Effect.succeed(refs);
  let created = 0;
  const view = await testRender(
    <NewThreadPicker
      client={h.client}
      target={h.client.registry.get(h.client.snapshot)!.threads[0]}
      actions={createThreadActions(h.client)}
      close={() => {}}
      created={() => created++}
    />,
    { width: 90, height: 16, kittyKeyboard: true },
  );
  const press = async (name: string) => {
    await act(async () => {
      view.mockInput.pressKey(name);
    });
    await view.flush();
  };
  try {
    await view.flush();
    // The thread's own project comes first even though the snapshot lists it second.
    expect(view.captureCharFrame()).toContain("› p · /fixture");
    expect(view.captureCharFrame()).not.toContain("Thread name");
    await press("j");
    await press("l");
    await view.waitForFrame((frame) => frame.includes("/other-feature"));
    await press("h");
    expect(view.captureCharFrame()).toContain("› Other · /other");
    refs = refs.slice(0, 1);
    await press("l");
    await view.waitForFrame(() => created === 1);
    expect(h.commands.at(-1)).toMatchObject({
      type: "thread.create",
      title: "New thread",
      projectId: "other",
      worktreePath: null,
    });
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});

test("new thread still works in a folder with no git refs, and a blank name stays the default", async () => {
  const h = await composerFixture();
  h.client.boundary.workspaceRefs = () => Effect.fail("not a repository") as never;
  let created = 0;
  const view = await testRender(
    <NewThreadPicker
      client={h.client}
      target={h.client.registry.get(h.client.snapshot)!.threads[0]}
      actions={createThreadActions(h.client)}
      close={() => {}}
      created={() => created++}
    />,
    { width: 90, height: 16, kittyKeyboard: true },
  );
  try {
    await view.flush();
    await act(async () => {
      view.mockInput.pressKey("RETURN");
    });
    await view.waitForFrame(() => created === 1);
    expect(h.commands.at(-1)).toMatchObject({ type: "thread.create", title: "New thread" });
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});

test("new thread on a server with no projects says where to add one", async () => {
  const h = await composerFixture();
  const snapshot = h.client.registry.get(h.client.snapshot)!;
  h.client.registry.set(h.client.snapshot, { ...snapshot, projects: [] });
  const view = await testRender(
    <NewThreadPicker client={h.client} actions={createThreadActions(h.client)} close={() => {}} />,
    { width: 90, height: 16, kittyKeyboard: true },
  );
  try {
    await view.flush();
    expect(view.captureCharFrame()).toContain("No projects on this server yet");
    expect(view.captureCharFrame()).toContain("t3 project add");
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});

test("only a first message in an unnamed thread seeds a title", async () => {
  const h = await composerFixture();
  const id = h.client.registry.get(h.client.selectedThreadId)!;
  const composer = createComposer(h.client);
  const snapshot = h.client.registry.get(h.client.snapshot)!;
  try {
    composer.setDraft(id, "named thread keeps its name");
    expect(await composer.send(id)).toBe(true);
    expect(h.commands.at(-1)).not.toHaveProperty("titleSeed");
    h.client.registry.set(h.client.snapshot, {
      ...snapshot,
      threads: snapshot.threads.map((thread) => ({ ...thread, title: "New thread" })),
    });
    composer.setDraft(id, "fix the login redirect");
    expect(await composer.send(id)).toBe(true);
    expect(h.commands.at(-1)).toMatchObject({ titleSeed: "fix the login redirect" });
  } finally {
    await h.client.dispose();
  }
});

test("a thread created here seeds its title even before it reaches the snapshot, unless it was named", async () => {
  const h = await composerFixture();
  const actions = createThreadActions(h.client);
  const composer = createComposer(h.client);
  const target = h.client.registry.get(h.client.snapshot)!.threads[0]!;
  try {
    // The fixture server never adds created threads to the snapshot: that is the race window.
    const blank = (await actions.run("new", target))!;
    const named = (await actions.run("new", target, "My name"))!;
    expect(h.client.registry.get(h.client.snapshot)!.threads.map((t) => t.id)).not.toContain(blank);
    composer.setDraft(blank, "fix the login redirect");
    composer.setDraft(named, "fix the login redirect");
    expect(await composer.send(blank)).toBe(true);
    expect(h.commands.at(-1)).toMatchObject({
      threadId: blank,
      titleSeed: "fix the login redirect",
    });
    expect(await composer.send(named)).toBe(true);
    expect(h.commands.at(-1)).not.toHaveProperty("titleSeed");
  } finally {
    await h.client.dispose();
  }
});

test("a new thread with no selected thread and no project default reuses the project's model", async () => {
  const h = await composerFixture();
  const snapshot = h.client.registry.get(h.client.snapshot)!;
  const shell = snapshot.threads[0]!;
  const project = { ...snapshot.projects[0]!, defaultModelSelection: null };
  h.client.registry.set(h.client.snapshot, { ...snapshot, projects: [project] });
  try {
    await createThreadActions(h.client).run("new", undefined, "", false, undefined, project.id);
    expect(h.commands.at(-1)).toMatchObject({
      type: "thread.create",
      projectId: project.id,
      modelSelection: shell.modelSelection,
    });
  } finally {
    await h.client.dispose();
  }
});

test("Ctrl+v attaches clipboard images; clickable Paste inserts text at the cursor and preserves drafts on failure", async () => {
  const h = await composerFixture();
  let value: "image" | "text" | "fail" = "image";
  const view = await testRender(
    <ThreadComposer
      client={h.client}
      enabled

      effects={{
        copy() {},
        pasteClipboard: async () => {
          if (value === "fail") throw new Error("clipboard unavailable");
          return value === "image"
            ? { type: "image", bytes: png }
            : { type: "text", text: "pasted\ntext" };
        },
      }}
    />,
    { width: 110, height: 12, kittyKeyboard: true },
  );
  const paste = async () => {
    await act(async () => {
      view.mockInput.pressKey("v", { ctrl: true });
    });
    await view.flush();
  };
  try {
    await act(async () => {
      await view.mockInput.typeText("draft ");
    });
    await paste();
    expect(view.captureCharFrame()).toContain("clipboard.png");
    value = "text";
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("[Ctrl+v Paste]"));
    await act(async () => {
      await view.mockMouse.click(lines[y]!.indexOf("[Ctrl+v Paste]") + 1, y);
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("draft pasted");
    expect(view.captureCharFrame()).toContain("text");
    value = "fail";
    await paste();
    expect(view.captureCharFrame()).toContain("Paste unavailable");
    expect(view.captureCharFrame()).toContain("draft pasted");
    expect(view.captureCharFrame()).toContain("clipboard.png");
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});

test("composer thumbnail cards sit side by side, reserve space only while attached and clear their native placements", async () => {
  const { setRendererCapabilities } = await import("@opentui/core/testing");
  const { ImageRenderable, TextareaRenderable } = await import("@opentui/core");
  const thumbnailPng = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAAA1BMVEUA//8ZXC8lAAAAC0lEQVQI12NgQAUAABAAAaHFIcEAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const h = await composerFixture();
  h.client.boundary.uploadImage = () =>
    Effect.succeed({
      type: "image",
      id: "thumbnail",
      name: "clipboard.png",
      mimeType: "image/png",
      sizeBytes: thumbnailPng.length,
    });
  const view = await testRender(
    <ThreadComposer
      client={h.client}
      enabled
      effects={{ copy() {}, pasteImage: async () => thumbnailPng }}
    />,
    { width: 110, height: 14, kittyKeyboard: true },
  );
  const descendants = (node: Renderable): Renderable[] =>
    node.getChildren().flatMap((child) => [child, ...descendants(child)]);
  const thumbnails = () =>
    descendants(view.renderer.root).filter((node) => node instanceof ImageRenderable);
  const inputY = () =>
    descendants(view.renderer.root).find((node) => node instanceof TextareaRenderable)!.y;
  try {
    await act(async () => view.renderOnce());
    const before = inputY();
    setRendererCapabilities(view.renderer, { kitty_graphics: true });
    await act(async () => {
      await view.mockInput.pressKey("p", { meta: true });
    });
    await view.flush();
    await act(async () => {
      await view.mockInput.pressKey("p", { meta: true });
    });
    await view.flush();
    const images = thumbnails();
    expect(images).toHaveLength(2);
    expect(images[0]!.y).toBe(images[1]!.y);
    expect(images[1]!.x).toBeGreaterThan(images[0]!.x + images[0]!.width);
    expect(images[0]!.height).toBe(3);
    expect(inputY()).toBe(before + 3);
    const rows = view.captureCharFrame().split("\n");
    expect(rows.find((row) => row.includes("clipboard.png 1"))).toContain("clipboard.png 2");
    const y = rows.findIndex((row) => row.includes("× remove"));
    await act(async () => {
      await view.mockMouse.click(rows[y]!.indexOf("× remove") + 1, y);
    });
    await view.flush();
    expect(images[0]!.isDestroyed).toBe(true);
    expect(thumbnails()).toHaveLength(1);
    await act(async () => {
      h.client.registry.set(h.client.selectedThreadId, ThreadId.make("other"));
    });
    await view.flush();
    expect(images[1]!.isDestroyed).toBe(true);
    expect(thumbnails()).toHaveLength(0);
    await act(async () => {
      h.client.registry.set(h.client.selectedThreadId, ThreadId.make("composer"));
    });
    await view.flush();
    const restored = thumbnails();
    expect(restored).toHaveLength(1);
    await act(async () => {
      await view.mockInput.pressKey("BACKSPACE", { meta: true });
    });
    await view.flush();
    expect(restored[0]!.isDestroyed).toBe(true);
    expect(thumbnails()).toHaveLength(0);
    expect(inputY()).toBe(before);
    await act(async () => {
      await view.mockInput.pressKey("p", { meta: true });
    });
    await view.flush();
    const sent = thumbnails();
    expect(sent).toHaveLength(1);
    await act(async () => {
      await view.mockInput.pressKey("RETURN");
    });
    await view.flush();
    expect(sent[0]!.isDestroyed).toBe(true);
    expect(thumbnails()).toHaveLength(0);
  } finally {
    await view.dispose();
    await h.client.dispose();
  }
});
