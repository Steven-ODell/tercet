import { test, expect } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { connectionConfig } from "./config";
import type { TerminalOp } from "./connection";
import { platform } from "./platform";
import { createClient, waitForLive } from "./runtime";
import { sandboxUrl, tokenPath } from "../sandbox";

test.skipIf(process.env.TERCET_SANDBOX_TEST !== "1")(
  "sandbox shell: typed command runs on the server and its output reaches the emulator",
  async () => {
    const config = await connectionConfig(
      ["--url", sandboxUrl, "--token-file", tokenPath],
      async () => undefined,
      "/unused",
    );
    const client = createClient(platform(config), false);
    client.start();
    await waitForLive(client);
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "tercet-terminal-")));
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const seen = () =>
      Array.from({ length: term.buffer.active.length }, (_, y) =>
        term.buffer.active.getLine(y)!.translateToString(true),
      ).join("\n");
    let session: { send(op: TerminalOp): void; stop(): void } | undefined;
    let exited = () => {};
    const closed = new Promise<void>((resolve) => (exited = resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No output:\n${seen()}`)), 20_000);
        let typed = false;
        const check = () => {
          // The echoed command line holds "6*7"; only the shell's own output holds 42.
          if (!seen().includes("tercet-42-ok")) return;
          clearTimeout(timer);
          resolve();
        };
        session = client.terminal(
          {
            threadId: `tercet-terminal-${crypto.randomUUID()}`,
            terminalId: "term-1",
            cwd,
            cols: 80,
            rows: 24,
            restartIfNotRunning: true,
          },
          (event) => {
            if (event.type === "snapshot" && !typed) {
              typed = true;
              session!.send({ kind: "resize", cols: 80, rows: 24 });
              session!.send({ kind: "write", data: "echo tercet-$((6*7))-ok; pwd\r" });
            }
            if (event.type === "snapshot") term.write(event.snapshot.history, check);
            if (event.type === "output") term.write(event.data, check);
            if (event.type === "exited") exited();
            if (event.type === "error") reject(new Error(event.message));
          },
          (error) => reject(new Error(`Terminal stream ended: ${String(error)}`)),
        );
      });
      expect(seen()).toContain("tercet-42-ok");
      expect(seen()).toContain(cwd);
      session!.send({ kind: "write", data: "exit\r" });
      await closed;
    } finally {
      session?.stop();
      await client.dispose();
    }
  },
  30_000,
);
