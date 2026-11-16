import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { assertSandboxUrl, listThreads, sandboxUrl, withSandbox } from "./sandbox";

test("sandbox gate refuses live, remote and ambiguous sandbox destinations before I/O", () => {
  for (const url of [
    "http://127.0.0.1:3773",
    "http://localhost:3775",
    "http://127.0.0.1:3774",
    "https://example.com",
    `${sandboxUrl}/`,
  ]) {
    expect(() => assertSandboxUrl(url)).toThrow("Sandbox gate only accepts");
  }
  expect(() => assertSandboxUrl(sandboxUrl)).not.toThrow();
});

const integration = process.env.TERCET_SANDBOX_TEST === "1" ? test : test.skip;
integration("Bun session lists seeded sandbox threads", async () => {
  const threads = await Effect.runPromise(withSandbox(listThreads));
  expect(threads.length).toBeGreaterThan(0);
  expect(threads.some((t) => t.title.trim().length > 0)).toBe(true);
});
integration("sandbox rejects invalid bearer credentials", async () => {
  const result = await Effect.runPromise(
    withSandbox((s) => s.ready, "invalid-token").pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
});
