import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import { PINNED_SERVER_VERSION, supportedRange } from "./client/compat";

const root = join(import.meta.dir, "..");
const env = { PATH: process.env.PATH ?? "", HOME: "/nonexistent" };
const run = (args: string[]) => {
  const result = Bun.spawnSync(args, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString() };
};
const rangeLine = `T3 server: ${supportedRange}, tested on ${PINNED_SERVER_VERSION}`;

test("--version from source prints the version, the T3 range and the development build", () => {
  const { code, out } = run([process.execPath, "src/main.tsx", "--version"]);
  expect(code).toBe(0);
  expect(out).toBe(`tercet ${version} (development build)\n${rangeLine}\n`);
});

test.skipIf(!existsSync(join(root, "dist/tercet.js")))("the bundle is the production build", () => {
  const { code, out } = run([process.execPath, "dist/tercet.js", "--version"]);
  expect(code).toBe(0);
  expect(out).toBe(`tercet ${version}\n${rangeLine}\n`);
});
