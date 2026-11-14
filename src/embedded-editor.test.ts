import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editorAction } from "./embedded-editor";
import { blockWrites } from "./client/read-only";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("editor timeout");
}

test("remote and read-only editor launches reject before opening a local path", async () => {
  const remote = editorAction("https://example.invalid");
  await expect(remote.open({ cwd: "/tmp", path: "file" })).rejects.toThrow("SSH");
  const local = editorAction("http://127.0.0.1:3775");
  const effects = blockWrites({ copy() {}, embeddedEditor: local.open });
  await expect(effects.embeddedEditor!({ cwd: "/tmp", path: "file" })).rejects.toThrow("Read-only");
});

test.skipIf(!Bun.which("nvim"))(
  "real editor saves a spaced path, preserves the originating workspace, resizes and exits natively",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tercet-editor-"));
    const path = "space ' $ file.txt";
    await writeFile(join(cwd, path), "before\n");
    const action = editorAction("http://127.0.0.1:3775");
    try {
      const session = await action.open({ cwd, path });
      await until(
        () =>
          session.screen.buffer.active.getLine(0)?.translateToString().includes("before") ?? false,
      );
      session.resize(57, 15);
      expect(session.screen.cols).toBe(57);
      expect(session.screen.rows).toBe(15);
      // A new request resumes the existing editor rather than moving its unsaved buffer.
      expect(await action.open({ cwd: "/other-workspace", path: "wrong" })).toBe(session);
      expect(session.cwd).toBe(cwd);
      session.write("gg0Cafter\x1b");
      await Bun.sleep(50);
      session.write(":wq\r");
      await until(() => !session.running);
      expect(session.exitCode).toBe(0);
      expect(await readFile(join(cwd, path), "utf8")).toBe("after\n");
    } finally {
      action.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("configured argv runs in the requested workspace and shutdown releases its PTY child", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tercet-editor-command-"));
  const path = "file with spaces.txt";
  const action = editorAction("http://localhost:3775", [
    process.execPath,
    "-e",
    "console.log(JSON.stringify({cwd:process.cwd(),path:process.argv[1]}));setInterval(()=>{},1000)",
    "{path}",
  ]);
  try {
    const session = await action.open({ cwd, path });
    await until(
      () => session.screen.buffer.active.getLine(0)?.translateToString().includes("cwd") ?? false,
    );
    // The process itself reports its argv and cwd, rather than asserting a template expansion.
    const text = Array.from(
      { length: session.screen.rows },
      (_, i) => session.screen.buffer.active.getLine(i)?.translateToString(true) ?? "",
    ).join("");
    expect(text).toContain(cwd);
    expect(text).toContain(join(cwd, path));
    action.dispose();
    await session.child.exited;
    expect(session.child.signalCode).toBeTruthy();
  } finally {
    action.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
