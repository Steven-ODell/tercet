/** Mouse modes off, bracketed paste off, Kitty keyboard popped, cursor shown, main screen. */
export const TERMINAL_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[?25h\x1b[?1049l";

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/**
 * Restore terminal modes on quit, crash and SIGINT/SIGTERM/SIGHUP; never print raw provider
 * errors. `extraReset` is written with the last-resort reset (tercet passes the Kitty image delete
 * when images are on). A signal or crash exits once drafts are flushed: 128+signal, or 1.
 */
export function terminalLifecycle(
  renderer: { destroy(): void; once(event: "destroy", fn: () => void): unknown },
  dispose: () => Promise<unknown>,
  extraReset = "",
) {
  let closing = false;
  let mustExit = false;
  const cleanup = () => {
    try {
      renderer.destroy();
    } catch {
      // A renderer that throws while tearing down still gets the reset on exit.
      process.exitCode = 1;
      process.exit();
    }
  };
  const stop = (code: number) => {
    process.exitCode = code;
    mustExit = true;
    // A second signal while drafts flush, or a destroy that never finishes, exits now or soon.
    if (closing) process.exit();
    setTimeout(() => process.exit(), 3000).unref();
    cleanup();
  };
  const fatal = () => stop(1);
  const handlers = Object.entries(SIGNALS).map(
    ([signal, number]) => [signal, () => stop(128 + number)] as const,
  );
  const exit = () => {
    // Last-resort synchronous reset, including a throw during renderer creation/destruction.
    try {
      process.stdout.write(TERMINAL_RESET + extraReset);
    } catch {}
  };
  for (const [signal, handler] of handlers) process.on(signal, handler);
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  process.once("exit", exit);
  renderer.once("destroy", () => {
    if (closing) return;
    closing = true;
    void dispose()
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => {
        if (mustExit) process.exit();
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        process.removeListener("uncaughtException", fatal);
        process.removeListener("unhandledRejection", fatal);
      });
  });
  return cleanup;
}
