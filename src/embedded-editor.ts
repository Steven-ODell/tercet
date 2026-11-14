import { Terminal } from "@xterm/headless";
import { isAbsolute, resolve } from "node:path";
import { expand } from "./portable";
import type { CommandSpec } from "./client/settings";

/** A local PTY independent of both React panes and the thread's server shell. */
export class EditorSession {
  readonly screen = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
  readonly child: ReturnType<typeof Bun.spawn>;
  running = true;
  exitCode: number | undefined;
  private disposed = false;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private answers;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private paint = () => {
    if (this.disposed) return;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      for (const fn of this.listeners) fn();
    }, 16);
  };
  constructor(
    readonly cwd: string,
    readonly path: string,
    argv: string[],
  ) {
    try {
      this.child = Bun.spawn(argv, {
        cwd,
        env: { ...process.env, TERM: "xterm-256color" },
        terminal: {
          cols: 80,
          rows: 24,
          data: (_, bytes) => {
            if (!this.disposed) this.screen.write(bytes, this.paint);
          },
        },
      });
    } catch (error) {
      this.screen.dispose();
      throw error;
    }
    this.answers = this.screen.onData((data) => this.write(data));
    void this.child.exited.then((code) => {
      this.running = false;
      this.exitCode = code;
      this.child.terminal?.close();
      this.paint();
    });
  }
  write(data: string) {
    if (this.running) this.child.terminal?.write(data);
  }
  resize(cols: number, rows: number) {
    this.screen.resize(cols, rows);
    if (this.running) this.child.terminal?.resize(cols, rows);
    this.paint();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.running) this.child.kill();
    this.child.terminal?.close();
    clearTimeout(this.timer);
    this.answers.dispose();
    this.screen.dispose();
    this.listeners.clear();
  }
}

/** Remote filesystem paths must never be interpreted on the client's machine. */
export function editorAction(url: string, spec?: CommandSpec) {
  let current: EditorSession | undefined;
  return {
    open: async ({ cwd, path }: { cwd: string; path: string }) => {
      if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))
        throw new Error("Embedded editor requires Tercet on the server machine; connect with SSH.");
      if (current?.running) return current;
      if (!isAbsolute(cwd)) throw new Error("Editor requires an absolute workspace path.");
      current?.dispose();
      const target = resolve(cwd, path);
      if (!spec && !Bun.which("nvim") && !Bun.which("vi"))
        throw new Error("No embedded editor found. Install Neovim or set commands.embeddedEditor in Tercet settings.");
      const command =
        spec ?? (Bun.which("nvim") ? ["nvim", "--clean", "--", "{path}"] : ["vi", "--", "{path}"]);
      current = new EditorSession(cwd, target, expand(command, { cwd, path: target }, [target]));
      return current;
    },
    dispose: () => {
      current?.dispose();
      current = undefined;
    },
  };
}
