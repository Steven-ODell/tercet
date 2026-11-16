import { afterEach, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { deflateSync } from "node:zlib";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { setRendererCapabilities } from "@opentui/core/testing";
import { TranscriptViewport } from "./transcript-viewport";
import { setMedia } from "./media";
import { KittyPlacementOutput } from "../kitty-output";

afterEach(() => setMedia({ rung: "blocks", reason: "not detected" }));

/** A solid RGB PNG of the given size, built here so the test needs no image tools. */
function png(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

type Placement = { row: number; rows: number; y: number; h: number };

/** The Kitty placements and deletes in one frame's bytes; `row` is the 0-based screen row. */
function graphics(bytes: string) {
  const placements: Placement[] = [];
  let deletes = 0;
  for (const m of bytes.matchAll(/(?:\x1b\[(\d+);\d+H)?\x1b_G([^;\x1b]*)/g)) {
    const keys = Object.fromEntries(m[2]!.split(",").map((kv) => kv.split("=")));
    if (keys.a === "d") deletes++;
    if (keys.a !== "p") continue;
    placements.push({ row: Number(m[1]) - 1, rows: +keys.r!, y: +keys.y!, h: +keys.h! });
  }
  return { placements, deletes };
}

// Behind tmux (the maintainer's setup) every frame goes through KittyPlacementOutput, as in main.tsx.
test("a Kitty image behind tmux scrolls and crops row for row with the text around it", async () => {
  // 10x20 px cells. The card is 12 rows with a 10-row interior; 88x40 px fills 44x10 cells, so
  // one cell row is 4 source pixels.
  const PX_PER_ROW = 4;
  const INNER = 10;
  setMedia({ rung: "kitty", reason: "test" });
  const writes: string[] = [];
  const raw: string[] = [];
  const out = new KittyPlacementOutput();
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        // Inside tmux OpenTUI wraps each graphics command in passthrough; the test renderer cannot
        // detect tmux, so wrap them the same way here.
        const bytes = Buffer.from(chunk)
          .toString("latin1")
          .replace(
            /\x1b_G[^\x1b]*\x1b\\/g,
            (g) => `\x1bPtmux;${g.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`,
          );
        raw.push(bytes);
        writes.push(out.push(Buffer.from(bytes, "latin1")).toString("latin1"));
        done();
      },
    }),
    { isTTY: true, columns: 60, rows: 20, getColorDepth: () => 24 },
  );
  const image = png(88, 40);
  const effects = { copy() {}, loadImage: async () => image };
  const lines = Array.from({ length: 3 }, (_, i) => `before ${i}`);
  const after = Array.from({ length: 30 }, (_, i) => `after ${i}`);
  const items = [
    {
      id: "a",
      kind: "assistant",
      text: [...lines, "![swatch](/tmp/swatch.png)", ...after].join("\n"),
    },
  ];
  const view = await testRender(
    <TranscriptViewport items={items} width={60} height={20} effects={effects} />,
    { width: 60, height: 20, stdout: stdout as never, bufferedOutput: "stdout" },
  );
  setRendererCapabilities(view.renderer, { kitty_graphics: true, image_protocol: "kitty" });
  const r = view.renderer as unknown as {
    _resolution: { width: number; height: number };
    lib: { sessionSetImageResolution(...args: unknown[]): void };
    nativeSession: { context: unknown; session: unknown };
  };
  r._resolution = { width: 600, height: 400 };
  r.lib.sessionSetImageResolution(
    r.nativeSession.context,
    r.nativeSession.session,
    60,
    20,
    600,
    400,
  );

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await view.renderOnce();
        await Bun.sleep(10);
      });
    }
  };
  const frame = async (fresh = true) => {
    if (fresh) writes.length = raw.length = 0;
    await settle();
    const text = view.captureCharFrame().split("\n");
    const bytes = writes.join("");
    // Unwrap the passthrough to read the placements where the outer terminal will put them.
    const unwrapped = bytes.replaceAll("\x1bPtmux;", "").replaceAll("\x1b\x1b", "\x1b");
    return { text, bytes, raw: raw.join(""), ...graphics(unwrapped) };
  };
  /** Where the text says the image interior is: the card sits directly above "after 0". */
  const expected = (text: string[]) => {
    // The screen row "after 0" has (or would have, once scrolled off) from any visible "after N".
    const index = text.findIndex((line) => /\bafter \d+/.test(line));
    const below = index - Number(/\bafter (\d+)/.exec(text[index]!)![1]);
    const top = below - 1 - INNER; // first interior row, may be above the viewport
    const first = Math.max(0, top);
    const rows = below - 1 - first;
    return {
      below,
      top,
      placement: { row: first, rows, y: (first - top) * PX_PER_ROW, h: rows * PX_PER_ROW },
    };
  };

  await act(async () => {
    await view.mockInput.pressKey("g");
    await view.mockInput.pressKey("g");
  });
  // The image bytes load asynchronously; wait for the first placement.
  for (let i = 0; i < 50 && !writes.join("").includes("a=p,"); i++) await settle();
  let shot = await frame(false);
  let want = expected(shot.text);
  expect(want.top).toBeGreaterThan(0);
  expect(shot.placements.at(-1)).toEqual(want.placement);
  const startTop = want.top;

  // Scroll by exactly one row: move the cursor down until the view starts to follow it.
  for (let i = 0; i < 40 && want.top === startTop; i++) {
    await act(async () => view.mockInput.pressKey("j"));
    shot = await frame();
    want = expected(shot.text);
  }
  expect(want.top).toBe(startTop - 1);

  // Wheel steps of three rows: into the image, through it, and past its bottom.
  const tops: number[] = [want.top];
  for (let step = 0; step < 8; step++) {
    await act(async () => view.mockMouse.scroll(5, 5, "down"));
    shot = await frame();
    want = expected(shot.text);
    tops.push(want.top);
    expect(want.top).toBe(tops.at(-2)! - 3);
    if (want.below > 1) {
      // Partly or wholly visible: exactly one placement, cropped to the rows the text leaves it.
      expect(shot.placements).toEqual([want.placement]);
      // OpenTUI deletes then re-places; only the re-place may reach the terminal, or the image
      // flashes as an empty hole between the two (the bug seen in a screen recording).
      expect(shot.raw).toContain("a=d,d=i,");
      // The card keeps its picture while it scrolls: no image delete and no re-upload.
      expect(shot.raw).not.toContain("d=I,");
      expect(shot.raw).not.toContain("a=t,");
      expect(shot.bytes).not.toContain("a=d,d=i,");
    } else {
      // Scrolled past: no placement, and the old one is deleted rather than left parked.
      expect(shot.placements).toEqual([]);
      if (want.below > -3) expect(shot.deletes).toBeGreaterThan(0);
    }
  }
  // The walk covered a partly hidden image and one wholly scrolled past.
  expect(tops.some((top) => top < 0 && top > -INNER)).toBe(true);
  expect(tops.at(-1)!).toBeLessThan(-INNER);
  view.renderer.destroy();
});
