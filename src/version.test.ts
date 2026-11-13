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

test("--help prints usage and exits 0; an unknown option says what was wrong", () => {
  const help = run([process.execPath, "src/main.tsx", "--help"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("Usage: tercet [options]");
  expect(help.out).toContain("--token-file PATH");
  const bad = Bun.spawnSync([process.execPath, "src/main.tsx", "--wat"], {
    cwd: root,
    env,
    stderr: "pipe",
  });
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toContain("tercet: unknown option --wat; see tercet --help");
});
