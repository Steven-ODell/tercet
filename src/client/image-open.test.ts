import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { imageOpenAction } from "./image-open";

test("local files and attachments open in place; other images go through a private temp file", async () => {
  const dir = await mkdtemp("/tmp/tercet-open-test-");
  const opened: string[] = [];
  const open = imageOpenAction(
    async () => new Uint8Array([1, 2, 3]),
    dir,
    async (path) => {
      opened.push(path);
    },
    `${dir}/tmp`,
  );
  try {
    await writeFile(`${dir}/original.png`, "image");
    await writeFile(`${dir}/thread-id.png`, "attachment");
    await expect(open("original.png", dir)).resolves.toBe("launched image viewer");
    expect(opened[0]).toBe(`${dir}/original.png`);
    expect(await readFile(`${dir}/original.png`, "utf8")).toBe("image");
    await open(
      `tercet-image:${encodeURIComponent(JSON.stringify({ id: "thread-id", mime: "image/png" }))}`,
    );
    expect(opened[1]).toBe(`${dir}/thread-id.png`);
    await open("https://remote/image");
    expect(opened[2]).toStartWith(`${dir}/tmp/image-`);
    expect(await readFile(opened[2]!)).toEqual(Buffer.from([1, 2, 3]));
    await expect(open(`${dir}/missing`)).rejects.toThrow();
    await expect(open("javascript:alert(1)")).rejects.toThrow("Unsupported image source");
    expect(opened).toHaveLength(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
