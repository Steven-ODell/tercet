import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaKind } from "./media";
import { measureMarkdown, type Message } from "./markdown";
import {
  cachedShots,
  chromiumArgs,
  isPageSource,
  pageId,
  pageShotsFromEnv,
  pageSource,
  setPageShots,
  shootPage,
} from "./page-shot";

afterEach(() => setPageShots(false));

describe("page sources", () => {
  test("round-trip an id and count as images", () => {
    const source = pageSource("a b/c");
    expect(isPageSource(source)).toBe(true);
    expect(pageId(source)).toBe("a b/c");
    expect(mediaKind(source)).toBe("image");
    expect(isPageSource("tercet-image:x")).toBe(false);
  });
  test("only TERCET_PAGE_SHOTS=1 turns shots on", () => {
    expect(pageShotsFromEnv({ TERCET_PAGE_SHOTS: "1" })).toBe(true);
    expect(pageShotsFromEnv({ TERCET_PAGE_SHOTS: "0" })).toBe(false);
    expect(pageShotsFromEnv({})).toBe(false);
  });
});

describe("chromium command", () => {
  const args = chromiumArgs("http://x/p", "/o.png", "/prof");
  test("is headless, muted and windowless", () => {
    expect(args[0]).toBe("chromium");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--mute-audio");
    expect(args).toContain("--screenshot=/o.png");
    expect(args).toContain("--user-data-dir=/prof");
    expect(args.at(-1)).toBe("http://x/p");
  });
});

describe("shootPage", () => {
  test("reads the file chromium wrote and cleans up", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "page-shot-test-"));
    const png = new Uint8Array([1, 2, 3]);
    const bytes = await shootPage("http://x/p", async (argv) => {
      const out = argv.find((a) => a.startsWith("--screenshot="))!.slice("--screenshot=".length);
      await writeFile(out, png);
      return 0;
    }, tmp);
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(await readdir(tmp)).toEqual([]);
  });
  test("a failing chromium is an error and leaves nothing behind", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "page-shot-test-"));
    await expect(shootPage("http://x/p", async () => 1, tmp)).rejects.toThrow("Page render failed");
    expect(await readdir(tmp)).toEqual([]);
  });
});

describe("cachedShots", () => {
  test("shoots an id once, and retries after a failure", async () => {
    let calls = 0;
    let fail = true;
    const shot = cachedShots(async () => {
      calls++;
      if (fail) throw new Error("no");
      return new Uint8Array([9]);
    });
    await expect(shot("a")).rejects.toThrow("no");
    fail = false;
    await shot("a");
    await shot("a");
    expect(calls).toBe(2);
  });
});

describe("transcript row", () => {
  const rows = (text: string) =>
    measureMarkdown({ id: "m", kind: "Rendered page", text } as Message, 100);
  test("a page image card is taller than a photo's", () => {
    const page = rows(`[open](x)\n![p](${pageSource("id")})`).filter((r) => r.image);
    const photo = rows("x\n![p](tercet-image:%7B%7D)").filter((r) => r.image);
    expect(page.length).toBe(24);
    expect(photo.length).toBe(12);
  });
});
