import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureMarkdown } from "./markdown";
import { TranscriptViewport } from "./transcript-viewport";
import { assertPublicUrl, loadPreviewImage, attachmentSource } from "./image-preview-source";
import { media, setMedia } from "./media";

const text = "![shore](/tmp/shore.jpg)\n![file URL](file:///tmp/shore.jpg)";
test("local Markdown images reserve stable rows, preserve file URLs, and ignore code fences", () => {
  const rows = measureMarkdown({ id: "a", kind: "assistant", text }, 60);
  expect(rows.filter((r) => r.image).length).toBe(24);
  expect(rows.filter((r) => r.image?.offset === 0).map((r) => r.image?.source)).toEqual([
    "/tmp/shore.jpg",
    "file:///tmp/shore.jpg",
  ]);
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  expect(
    measureMarkdown({ id: "a", kind: "assistant", text: `\`\`\`md\n${text}\n\`\`\`` }, 60).some(
      (r) => r.image,
    ),
  ).toBe(false);
});
test("only visible images load; failed loads keep clickable fallback and scrolling unmounts images", async () => {
  const calls: string[] = [];
  let opened = "";
  const copies: string[] = [];
  const effects = {
    copy() {},
    copyImage: async (source: string) => {
      copies.push(source);
    },
    loadImage: async (source: string) => {
      calls.push(source);
      throw Error("missing");
    },
    openImage: async (source: string) => {
      opened = source;
    },
  };
  const items = [
    { id: "a", kind: "assistant", text: "![shore](/tmp/shore.jpg)\n" + "after\n".repeat(40) },
  ];
  const view = await testRender(
    <TranscriptViewport items={items} width={60} height={16} effects={effects} />,
    { width: 60, height: 16 },
  );
  await act(async () => view.renderOnce());
  expect(calls).toEqual([]); // starts at the tail, off-screen image never loads
  await act(async () => {
    await view.mockInput.pressKey("g");
    await view.mockInput.pressKey("g");
  });
  await act(async () => view.renderOnce());
  expect(calls).toEqual(["/tmp/shore.jpg"]);
  expect(view.captureCharFrame()).toContain("[image shore] (unavailable)");
  // Mouse uses the same dedicated full-image opener, including on the fallback.
  const lines = view.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("[image shore]"));
  await act(async () => {
    await view.mockMouse.click(lines[y]!.indexOf("[image shore]") + 1, y);
  });
  await act(async () => view.renderOnce());
  expect(opened).toBe("");
  expect(view.captureCharFrame()).toContain("[open]");
  await act(async () => {
    await view.mockInput.pressKey("v");
    await view.mockInput.pressKey("y");
  });
  expect(copies).toEqual(["/tmp/shore.jpg"]);
  await act(async () => {
    await view.mockInput.pressKey("l");
  });
  expect(opened).toBe("/tmp/shore.jpg");
  opened = "";
  await act(async () => {
    await view.mockInput.pressKey("RETURN");
  });
  expect(opened).toBe("/tmp/shore.jpg");
  await act(async () => {
    await view.mockInput.pressKey("O");
  });
  expect(opened).toBe("/tmp/shore.jpg");
  await act(async () => {
    await view.mockInput.pressKey("G");
  });
  await act(async () => view.renderOnce());
  expect(view.captureCharFrame()).not.toContain("[image shore]");
  view.renderer.destroy();
});
test("image byte loader handles absolute and file paths and signed attachment URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-image-"));
  try {
    const file = join(dir, "shore.jpg");
    const bytes = Uint8Array.from([1, 2, 3]);
    await writeFile(file, bytes);
    const mint = async () => {
      throw Error("must not mint local paths");
    };
    expect(await loadPreviewImage(file, undefined, mint)).toEqual(bytes);
    expect(await loadPreviewImage(`file://${file}`, undefined, mint)).toEqual(bytes);
    await expect(loadPreviewImage(join(dir, "missing.png"), undefined, mint)).rejects.toThrow();
    expect(
      attachmentSource(
        `tercet-image:${encodeURIComponent(JSON.stringify({ id: "a", mime: "image/png" }))}`,
      ),
    ).toEqual({ id: "a", mime: "image/png" });
    await expect(loadPreviewImage("javascript:alert(1)", undefined, mint)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("images are semantic Vim targets but never contaminate selected text", async () => {
  const { isText, selectionText, moveRows } = await import("./vim");
  const rows = measureMarkdown(
    { id: "a", kind: "assistant", text: "before\n![shore](shore.jpg)\nafter" },
    60,
    5,
  );
  const images = rows.filter((r) => r.image);
  expect(images.length).toBe(5);
  expect(images.filter(isText).length).toBe(1);
  const index = rows.findIndex((r) => r.image);
  expect(moveRows(rows, { row: index, col: 0 }, 1, 0).row).toBe(index + 5);
  expect(selectionText(rows, { row: index, col: 0 }, { row: index, col: 0 }, "line")).toBe("");
});

test("speaker alignment moves the entire image box and its clickable corner actions", async () => {
  for (const kind of ["assistant", "user"]) {
    const opened: string[] = [];
    const view = await testRender(
      <TranscriptViewport
        items={[{ id: "a", kind, text: "![shore](/tmp/shore.jpg)" }]}
        width={80}
        height={18}
        effects={{
          copy() {},
          copyImage: async () => {},
          targets: [{ name: "pc" }, { name: "laptop" }],
          copyTo: async () => {},
          copyImageTo: async () => {},
          loadImage: async () => {
            throw Error("missing");
          },
          openImage: async (source) => {
            opened.push(source);
          },
        }}
      />,
      { width: 80, height: 18 },
    );
    await act(async () => view.renderOnce());
    const lines = view.captureCharFrame().split("\n");
    const top = lines.findIndex((line) => line.includes("╭"));
    expect(lines[top]!.indexOf("╭")).toBe(kind === "user" ? 32 : 0);
    expect(lines[top]).toContain("[copy]");
    expect(lines[top]).toContain("[pc]");
    expect(lines[top]).toContain("[laptop]");
    const x = lines[top]!.indexOf("[open]") + 2;
    await act(async () => {
      await view.mockMouse.click(x, top);
    });
    expect(opened).toEqual(["/tmp/shore.jpg"]);
    await act(async () => {
      await view.mockInput.pressKey("RETURN");
    });
    await act(async () => {
      await view.mockInput.pressKey("l");
    });
    expect(opened).toHaveLength(3);
    view.renderer.destroy();
  }
});

test("remote images never reach loopback or private addresses, redirects included", async () => {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      hits.push(path);
      return path === "/start"
        ? Response.redirect(`http://127.0.0.1:${server.port}/secret`, 302)
        : new Response("secret");
    },
  });
  const mint = async () => "unused";
  try {
    for (const url of [
      `http://127.0.0.1:${server.port}/secret`,
      `http://[::ffff:127.0.0.1]:${server.port}/secret`,
      "http://[::1]/x",
      "http://10.1.2.3/x",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.1/x",
      "http://100.100.100.100/x",
      "http://[fd00::1]/x",
    ])
      await expect(loadPreviewImage(url, undefined, mint)).rejects.toThrow("private network");
    // A name that resolves to a private address is refused before any request.
    await expect(
      assertPublicUrl(new URL("http://intranet.example/"), async () => ["10.0.0.7"]),
    ).rejects.toThrow("private network");
    await assertPublicUrl(new URL("https://example.com/"), async () => ["93.184.215.14"]);
    // "localhost" passes as public here only so the first hop reaches the server; its redirect
    // to 127.0.0.1 is checked again and refused.
    await expect(
      loadPreviewImage(`http://localhost:${server.port}/start`, undefined, mint, async () => [
        "93.184.215.14",
      ]),
    ).rejects.toThrow("private network");
    expect(hits).toEqual(["/start"]);
  } finally {
    server.stop(true);
  }
});

test("remote images wait for [load] and never load when media.protocol is none", async () => {
  const calls: string[] = [];
  const effects = {
    copy() {},
    loadImage: async (source: string) => {
      calls.push(source);
      throw Error("offline");
    },
  };
  const source = "https://tracker.example/pixel.png";
  const items = [{ id: "a", kind: "assistant", text: `![pixel](${source})\n/local\n` }];
  const view = await testRender(
    <TranscriptViewport items={items} width={60} height={16} effects={effects} />,
    { width: 60, height: 16 },
  );
  await act(async () => view.renderOnce());
  expect(calls).toEqual([]);
  await act(async () => {
    await view.mockInput.pressKey("g");
    await view.mockInput.pressKey("g");
  });
  await act(async () => view.renderOnce());
  expect(view.captureCharFrame()).toContain("[image pixel] (remote)");
  const lines = view.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("[load]"));
  await act(async () => {
    await view.mockMouse.click(lines[y]!.indexOf("[load]") + 1, y);
  });
  await act(async () => view.renderOnce());
  expect(calls).toEqual([source]);
  view.renderer.destroy();

  const before = media();
  setMedia({ rung: "none", reason: "test" });
  try {
    // Even the image the user already let in stays unloaded: there is nothing to draw it with.
    const plain = await testRender(
      <TranscriptViewport items={items} width={60} height={16} effects={effects} />,
      { width: 60, height: 16 },
    );
    await act(async () => {
      await plain.mockInput.pressKey("g");
      await plain.mockInput.pressKey("g");
    });
    await act(async () => plain.renderOnce());
    expect(calls).toEqual([source]);
    expect(plain.captureCharFrame()).toContain("[image pixel] (remote)");
    expect(plain.captureCharFrame()).not.toContain("[load]");
    plain.renderer.destroy();
  } finally {
    setMedia(before, before.video);
  }
});
