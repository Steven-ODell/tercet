import { expect, test } from "bun:test";
import { assetName, checksumFor, isNewer, runUpgrade } from "./upgrade";

test("assetName matches the files the release workflow uploads", () => {
  expect(assetName("linux", "x64")).toBe("tercet-linux-x64");
  expect(assetName("linux", "arm64")).toBe("tercet-linux-arm64");
  expect(assetName("darwin", "arm64")).toBe("tercet-darwin-arm64");
  expect(assetName("darwin", "x64")).toBe("tercet-darwin-x64");
  expect(assetName("win32", "x64")).toBe("tercet-windows-x64.exe");
  expect(assetName("freebsd", "x64")).toBeNull();
  expect(assetName("linux", "riscv64")).toBeNull();
});

test("checksumFor reads sha256sum output, text and binary mode, lowercasing the hash", () => {
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  const sums = `${a}  tercet-linux-x64\n${b} *tercet-windows-x64.exe\n`;
  expect(checksumFor(sums, "tercet-linux-x64")).toBe(a);
  expect(checksumFor(sums, "tercet-windows-x64.exe")).toBe("b".repeat(64));
  expect(checksumFor(sums, "tercet-darwin-x64")).toBeNull();
  expect(checksumFor("not a checksum line\n", "tercet-linux-x64")).toBeNull();
});

test("isNewer compares release tags with Bun's semver and never throws", () => {
  expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
  expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("v0.1.0", "0.2.0")).toBe(false);
  expect(isNewer("nightly", "0.1.0")).toBe(false);
});

test("upgrade from source says how to update instead of touching anything", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (text: string) => void lines.push(text);
  try {
    expect(await runUpgrade([], (() => Promise.reject(new Error("no network"))) as never)).toBe(1);
    expect(await runUpgrade(["--nope"])).toBe(2);
  } finally {
    console.error = original;
  }
  expect(lines[0]).toContain("release binary");
});
