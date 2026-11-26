import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmux = Bun.which("tmux");
const nvim = Bun.which("nvim");
// The rig runs its own tmux server. Run from inside another tmux, the outer TMUX and TMUX_PANE
// would leak into that server and the launcher would act on the outer session instead.
const { TMUX: _tmux, TMUX_PANE: _pane, ...isolated } = process.env;

test.skipIf(!tmux || !nvim)(
  "external tmux editor saves the selected file and returns the same client to Tercet's session",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "tercet-external-rig-"));
    const socket = "tercet-external-" + process.pid;
    const path = join(dir, "space ' $ file.txt");
    const run = async (...args: string[]) => {
      const child = Bun.spawn([tmux!, "-L", socket, ...args], { env: isolated, stdout: "pipe", stderr: "pipe" });
      const text = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      if (await child.exited) throw new Error(error);
      return text.trim();
    };
    const until = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 150; i++) {
        if (await predicate()) return;
        await Bun.sleep(30);
      }
      throw new Error("external editor timeout");
    };
    let attach: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeFile(path, "before\n");
      // The launcher runs inside the real originating tmux pane, with its actual TMUX context.
      await writeFile(
        join(dir, "fixture.ts"),
        `
import { hostActions, systemHost } from ${JSON.stringify(join(import.meta.dir, "portable.ts"))};
import { defaultSettings } from ${JSON.stringify(join(import.meta.dir, "client/settings.ts"))};
const settings = defaultSettings();
settings.launchers = { editorMode: "tmux", editor: [${JSON.stringify(nvim)}, "--clean", "--", "{path}"] };
console.log("external fixture ready");
let launched = false;
setInterval(async () => {
  if (launched || !(await Bun.file(${JSON.stringify(join(dir, "cue"))}).exists())) return;
  launched = true;
  try {
    await hostActions({settings, host: systemHost(), writeTerminal() {}}).editor({cwd:${JSON.stringify(dir)},path:${JSON.stringify(path)}});
    await Bun.write(${JSON.stringify(join(dir, "launched"))}, "ok");
  } catch(e) { await Bun.write(${JSON.stringify(join(dir, "error"))}, String(e)); }
}, 25);
`,
      );
      await run(
        "new-session",
        "-d",
        "-s",
        "conversation",
        "-x",
        "100",
        "-y",
        "30",
        process.execPath,
        join(dir, "fixture.ts"),
      );
      attach = Bun.spawn([tmux!, "-L", socket, "attach-session", "-t", "conversation"], {
        env: { ...isolated, TERM: "xterm-256color" },
        terminal: { cols: 100, rows: 30, data() {} },
      });
      await until(async () =>
        (await run("list-clients", "-F", "#{session_name}")).includes("conversation"),
      );
      const client = await run("list-clients", "-F", "#{client_name}");
      await writeFile(join(dir, "cue"), "");
      await until(async () => {
        if (await Bun.file(join(dir, "error")).exists())
          throw new Error(await Bun.file(join(dir, "error")).text());
        return await Bun.file(join(dir, "launched")).exists();
      });
      const editor = await run("display-message", "-p", "-c", client, "#{session_id}");
      expect(await run("display-message", "-p", "-c", client, "#{session_name}")).not.toBe(
        "conversation",
      );
      await until(async () => (await run("capture-pane", "-p", "-t", editor)).includes("before"));
      await run("send-keys", "-t", editor, "-l", "gg0Cafter");
      await run("send-keys", "-t", editor, "Escape");
      await run("send-keys", "-t", editor, "-l", ":wq");
      await run("send-keys", "-t", editor, "Enter");
      await until(
        async () => (await run("list-clients", "-F", "#{session_name}")) === "conversation",
      );
      expect(await run("list-clients", "-F", "#{client_name}")).toBe(client);
      expect(await readFile(path, "utf8")).toBe("after\n");
      expect(await run("list-sessions", "-F", "#{session_name}")).toBe("conversation");
    } finally {
      await run("kill-server").catch(() => {});
      attach?.kill();
      attach?.terminal?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
