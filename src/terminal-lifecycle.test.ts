import { expect, test } from "bun:test";

test.each([
  'setTimeout(() => { throw new Error("private payload"); }, 10)',
  'Promise.reject(new Error("private payload"))',
])("fatal cleanup restores terminal and awaits draft flush: %s", async (failure) => {
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `
      import { EventEmitter } from 'node:events';
      import { terminalLifecycle } from ${JSON.stringify(import.meta.dir + "/terminal-lifecycle.ts")};
      const renderer = new EventEmitter();
      renderer.destroy = () => renderer.emit('destroy');
      terminalLifecycle(renderer, async () => { await Bun.sleep(10); console.log('drafts flushed'); });
      ${failure};
    `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(1);
  expect(out).toContain("drafts flushed");
  expect(out).toContain("\x1b[?1006l");
  expect(out).toContain("\x1b[?1049l");
  expect(err).not.toContain("private payload");
});
