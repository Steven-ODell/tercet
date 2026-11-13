// Portable host actions: the clipboard, opener and player fallback chains, the ffmpeg poster probe,
// and the command template engine behind every optional action (shell, editor, tmux typing, run,
// send, dictation, link mapping).
// This is the only file in src/ that names desktop tools; anything personal lives in the user's
// settings file as a template.
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { Actions } from "./actions";
import { LinkCopied, shellQuote } from "./actions";
import { parseFfmpegInfo, type MediaProbe } from "./client/media";
import {
  PLACEHOLDER,
  type CommandName,
  type CommandSpec,
  type Placeholder,
  type Settings,
} from "./client/settings";

export type Vars = Partial<Record<Placeholder, string>>;

/** The machine tercet runs on, as far as actions care. Tests pass a fake PATH. */
export interface Host {
  env: Record<string, string | undefined>;
  platform: string;
  /** Full path of a program on `env.PATH`, or null. */
  which(program: string): string | null;
}

export const systemHost = (
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): Host => ({ env, platform, which: (program) => Bun.which(program, { PATH: env.PATH ?? "" }) });

const argsOf = (spec: CommandSpec) => (typeof spec === "string" ? [spec] : [...spec]);

/** Whether a template names `{name}`, so a costly value (the SSH host) is only looked up when used. */
export const mentions = (spec: CommandSpec | undefined, name: Placeholder) =>
  !!spec && argsOf(spec).some((arg) => [...arg.matchAll(PLACEHOLDER)].some((m) => m[1] === name));

/**
 * Template engine: fills each `{name}` inside its own argument, never through a shell, so thread
 * text cannot become code. Settings validation already refused unknown names and placeholders in
 * a `-c` script. A template without placeholders gets `append` on the end, so a launcher can be a
 * bare program name.
 */
export function expand(spec: CommandSpec, vars: Vars, append: readonly string[] = []) {
  let used = false;
  const args = argsOf(spec).map((arg) =>
    arg.replace(PLACEHOLDER, (_, name?: string) => {
      if (!name) return "{";
      used = true;
      return vars[name as Placeholder] ?? "";
    }),
  );
  return used ? args : [...args, ...append];
}

const TEXT = "text/plain";

/** One clipboard program pair: how to write and read a MIME type, and whether images work. */
export interface ClipboardTool {
  name: string;
  images: boolean;
  write(mime: string, vars: Vars): string[];
  read(mime: string, vars: Vars): string[];
  /** Lists the MIME types on offer; without it a read tries PNG, then text. */
  types?: string[];
}

interface BuiltinTool extends ClipboardTool {
  writer: string;
  reader: string;
  usable(host: Host): boolean;
}

/**
 * The clipboard fallback chain after a configured `commands.copy`/`commands.paste`: Wayland's
 * wl-copy/wl-paste, then X11's xclip or xsel, then macOS pbcopy/pbpaste. A display tool is only
 * used while its display is set, so an SSH session does not write some other desktop's clipboard.
 */
export const CLIPBOARD_TOOLS: readonly BuiltinTool[] = [
  {
    name: "wl-clipboard",
    writer: "wl-copy",
    reader: "wl-paste",
    images: true,
    usable: (host) => !!host.env.WAYLAND_DISPLAY,
    write: (mime) => ["wl-copy", "--type", mime],
    read: (mime) => ["wl-paste", "--no-newline", "--type", mime === TEXT ? "text" : mime],
    types: ["wl-paste", "--list-types"],
  },
  {
    name: "xclip",
    writer: "xclip",
    reader: "xclip",
    images: true,
    usable: (host) => !!host.env.DISPLAY,
    write: (mime) => ["xclip", "-selection", "clipboard", "-t", mime, "-i"],
    read: (mime) =>
      mime === TEXT
        ? ["xclip", "-selection", "clipboard", "-o"]
        : ["xclip", "-selection", "clipboard", "-t", mime, "-o"],
    types: ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
  },
  {
    name: "xsel",
    writer: "xsel",
    reader: "xsel",
    images: false,
    usable: (host) => !!host.env.DISPLAY,
    write: () => ["xsel", "--clipboard", "--input"],
    read: () => ["xsel", "--clipboard", "--output"],
  },
  {
    name: "pbcopy",
    writer: "pbcopy",
    reader: "pbpaste",
    images: false,
    usable: (host) => host.platform === "darwin",
    write: () => ["pbcopy"],
    read: () => ["pbpaste"],
  },
];

export interface ClipboardChain {
  write?: ClipboardTool;
  read?: ClipboardTool;
}

/** The first configured or usable clipboard tool for writes and for reads. OSC 52 is separate. */
export function clipboardChain(settings: Settings, host: Host): ClipboardChain {
  const configured = (name: "copy" | "paste"): ClipboardTool | undefined => {
    const spec = settings.commands[name];
    if (!spec) return undefined;
    const run = (mime: string, vars: Vars) => expand(spec, { ...vars, mime });
    return { name: `commands.${name}`, images: true, write: run, read: run };
  };
  const builtin = (program: "writer" | "reader") =>
    CLIPBOARD_TOOLS.find((tool) => tool.usable(host) && host.which(tool[program]));
  return {
    write: configured("copy") ?? builtin("writer"),
    read: configured("paste") ?? builtin("reader"),
  };
}

export interface Opener {
  name: string;
  args(target: string, vars: Vars): string[];
}

/** Opening files and links: `launchers.opener`, then xdg-open, then macOS `open`. */
export function openerChain(settings: Settings, host: Host): Opener | undefined {
  const spec = settings.launchers.opener;
  if (spec)
    return { name: "launchers.opener", args: (target, vars) => expand(spec, vars, [target]) };
  // Linux's `open` is often openvt, so it only counts on macOS.
  const program = host.which("xdg-open")
    ? "xdg-open"
    : host.platform === "darwin" && host.which("open")
      ? "open"
      : undefined;
  return program ? { name: program, args: (target) => [program, target] } : undefined;
}

/** Playing video and audio: `launchers.player`, then mpv, then the opener. */
export function playerChain(settings: Settings, host: Host): Opener | undefined {
  const spec = settings.launchers.player;
  if (spec)
    return { name: "launchers.player", args: (target, vars) => expand(spec, vars, [target]) };
  if (host.which("mpv")) return { name: "mpv", args: (target) => ["mpv", "--", target] };
  return openerChain(settings, host);
}

/**
 * The file dialog behind attach: `launchers.picker`, then zenity or kdialog on a desktop session,
 * then osascript on macOS. Each prints the picked paths one per line and exits 1 on cancel.
 */
export function pickerChain(settings: Settings, host: Host) {
  const spec = settings.launchers.picker;
  if (spec) return { name: "launchers.picker", args: (cwd: string, vars: Vars) => expand(spec, { ...vars, cwd }) };
  const desktop = !!(host.env.WAYLAND_DISPLAY || host.env.DISPLAY);
  if (desktop && host.which("zenity"))
    return {
      name: "zenity",
      args: (cwd: string) => [
        "zenity",
        "--file-selection",
        "--multiple",
        "--separator=\n",
        "--title=Attach files",
        `--filename=${cwd.replace(/\/?$/, "/")}`,
      ],
    };
  if (desktop && host.which("kdialog"))
    return {
      name: "kdialog",
      args: (cwd: string) => [
        "kdialog",
        "--title",
        "Attach files",
        "--getopenfilename",
        cwd,
        "--multiple",
        "--separate-output",
      ],
    };
  if (host.platform === "darwin" && host.which("osascript"))
    return {
      name: "osascript",
      args: (cwd: string) => [
        "osascript",
        "-e",
        `set picked to choose file with prompt "Attach files" default location (POSIX file ${JSON.stringify(cwd)}) with multiple selections allowed`,
        "-e",
        'set out to ""',
        "-e",
        "repeat with f in picked",
        "-e",
        "set out to out & POSIX path of f & linefeed",
        "-e",
        "end repeat",
        "-e",
        "return out",
      ],
    };
  return undefined;
}

/** ssh that never prompts (a prompt would land in the TUI) and gives up on a dead host quickly. */
const sshArgs = (host: string) => ["ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host];

/**
 * The picker over SSH, run on the machine you type from. A non-interactive ssh session has no
 * WAYLAND_DISPLAY, so it borrows the desktop's socket from XDG_RUNTIME_DIR (else DISPLAY=:0).
 * Starts in that machine's home; prints one path per line and exits 1 on Cancel, like the local ones.
 */
export const REMOTE_PICKER = `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ -z "\${WAYLAND_DISPLAY:-}" ]; then
  for s in "$XDG_RUNTIME_DIR"/wayland-*; do
    if [ -S "$s" ]; then export WAYLAND_DISPLAY="\${s##*/}"; break; fi
  done
fi
[ -n "\${WAYLAND_DISPLAY:-}\${DISPLAY:-}" ] || export DISPLAY=:0
if command -v zenity >/dev/null 2>&1; then
  exec zenity --file-selection --multiple --title="Attach files" --separator='
'
elif command -v kdialog >/dev/null 2>&1; then
  exec kdialog --title "Attach files" --getopenfilename "$HOME" --multiple --separate-output
elif command -v osascript >/dev/null 2>&1; then
  exec osascript -e 'set picked to choose file with prompt "Attach files" with multiple selections allowed' -e 'set out to ""' -e 'repeat with f in picked' -e 'set out to out & POSIX path of f & linefeed' -e 'end repeat' -e 'return out'
else
  echo "no file picker (zenity or kdialog) on $(uname -n)" >&2
  exit 2
fi`;

/** The largest file T3 takes as an attachment (PROVIDER_SEND_TURN_MAX_FILE_BYTES). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  zip: "application/zip",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  txt: "text/plain",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

/** A picked file's MIME type: image bytes by their magic number, else by extension. */
export function fileMime(name: string, bytes: Uint8Array) {
  try {
    return imageMime(bytes);
  } catch {
    const extension = name.toLowerCase().split(".").at(-1) ?? "";
    if (MIME_BY_EXTENSION[extension]) return MIME_BY_EXTENSION[extension];
    // Source and other text files: no NUL byte in the first 8 KB.
    return bytes.subarray(0, 8192).includes(0) ? "application/octet-stream" : "text/plain";
  }
}

/** ffmpeg args for a poster: the first video frame, at most 640 px wide, as PNG on stdout. */
export const posterArgs = (target: string) => [
  "ffmpeg",
  "-hide_banner",
  "-nostdin",
  "-protocol_whitelist",
  "file,http,https,tcp,tls,crypto",
  "-i",
  target,
  "-map",
  "0:v:0?",
  "-frames:v",
  "1",
  "-vf",
  "scale='min(640,iw)':-2",
  "-f",
  "image2pipe",
  "-c:v",
  "png",
  "pipe:1",
];

/** Runs argv and keeps stdout and stderr whatever the exit code; for ffmpeg's banner. */
function runBoth(host: Host, args: readonly string[], timeoutMs: number) {
  const [name, ...rest] = args;
  const program = name && host.which(name);
  if (!program) return Promise.reject(new Error(`${name ?? "command"} not found`));
  return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(program, rest, {
      env: host.env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (data: Buffer) => out.push(data));
    child.stderr.on("data", (data: Buffer) => {
      if (err.length < 64_000) err += data.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

export interface RunOptions {
  stdin?: string | Uint8Array;
  cwd?: string;
  /** Collect stdout and wait for the program to finish. */
  capture?: boolean;
  /** Launch mode: success once the program has run this long, so a GUI app may stay open. */
  graceMs?: number;
  timeoutMs?: number;
}

/** Runs argv (no shell) with the host's env; the program is looked up on the host's PATH. */
export function runArgs(host: Host, args: readonly string[], options: RunOptions = {}) {
  const [name, ...rest] = args;
  const program = name?.includes("/") ? name : name && host.which(name);
  if (!program) return Promise.reject(new Error(`${name ?? "command"} not found`));
  return new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn(program, rest, {
      cwd: options.cwd,
      env: host.env as NodeJS.ProcessEnv,
      detached: options.graceMs !== undefined,
      stdio: ["pipe", options.capture ? "pipe" : "ignore", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    let exit: number | null | undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      child.stdin?.destroy();
      if (!options.capture) child.stderr?.destroy();
      if (options.graceMs !== undefined) child.unref();
      error ? reject(error) : resolve(new Uint8Array(Buffer.concat(out)));
    };
    const failure = (code: number | null, signal: NodeJS.Signals | null) =>
      new Error(err.trim().split("\n").at(-1) || `${name} exited with ${signal ?? code}`);
    child.stdout?.on("data", (data: Buffer) => out.push(data));
    child.stderr?.on("data", (data: Buffer) => {
      err = (err + data.toString()).slice(-1200);
    });
    child.stdin?.on("error", () => {});
    child.once("error", (error) => finish(error));
    // A clipboard writer can fork a server that keeps stderr open, so only captured runs wait
    // for the pipes to close.
    child.once("exit", (code, signal) => {
      exit = code;
      if (!options.capture) finish(code === 0 ? undefined : failure(code, signal));
      else if (code !== 0) finish(failure(code, signal));
    });
    child.once("close", (code, signal) => {
      if (options.capture) finish(exit === 0 || code === 0 ? undefined : failure(code, signal));
    });
    child.once("spawn", () => {
      child.stdin?.end(options.stdin);
      if (options.graceMs !== undefined) timers.push(setTimeout(() => finish(), options.graceMs));
      timers.push(
        setTimeout(() => {
          child.kill();
          finish(new Error(`${name} timed out`));
        }, options.timeoutMs ?? 120_000),
      );
    });
  });
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The MIME type of image bytes a clipboard can take, from their magic numbers. */
export function imageMime(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(PNG)) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  throw new Error("Unsupported clipboard image format (PNG, JPEG, GIF or WebP required)");
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const isText = (type: string) =>
  type.startsWith("text/") || ["UTF8_STRING", "STRING", "TEXT"].includes(type);

export interface HostDeps {
  settings: Settings;
  host: Host;
  /** OSC 52 to the terminal. */
  writeTerminal(bytes: string): void;
  /** The machine the user types from when it is not this one (SSH), for `{sshHost}`. */
  sshHost?(): Promise<string | undefined>;
  /** Image bytes for copy-image; set by the caller, which knows the server. */
  loadImage?(source: string, cwd?: string): Promise<Uint8Array>;
  graceMs?: number;
}

/** Every host effect, built from settings and what is installed. Absent actions are not drawn. */
export function hostActions(deps: HostDeps): Actions {
  const { settings, host } = deps;
  const { commands, launchers } = settings;
  const grace = deps.graceMs ?? 1000;
  const chain = clipboardChain(settings, host);
  const opener = openerChain(settings, host);
  const vars = async (spec: CommandSpec | undefined, own: Vars): Promise<Vars> => ({
    ...own,
    sshHost: mentions(spec, "sshHost") ? ((await deps.sshHost?.()) ?? "") : "",
  });
  const command = (name: CommandName) => commands[name];
  const run = async (spec: CommandSpec, own: Vars, options: RunOptions = {}) =>
    runArgs(host, expand(spec, await vars(spec, own)), options);
  const osc52 = (text: string) =>
    deps.writeTerminal(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  const writeClipboard = async (data: string | Uint8Array, mime: string) => {
    const tool = chain.write;
    if (!tool) throw new Error("No clipboard tool");
    const spec = settings.commands.copy;
    await runArgs(host, tool.write(mime, await vars(spec, {})), { stdin: data, timeoutMs: 15_000 });
  };
  const readClipboard = async (mime: string) => {
    const tool = chain.read!;
    return runArgs(host, tool.read(mime, await vars(settings.commands.paste, {})), {
      capture: true,
      timeoutMs: 15_000,
    });
  };
  const copy = (text: string) => {
    osc52(text);
    // OSC 52 already reached the terminal; the local tool is a bonus, so its failure is quiet.
    if (chain.write) void writeClipboard(text, TEXT).catch(() => {});
  };
  const targets = Object.entries(settings.targets).map(([name, target]) => ({
    name,
    key: target.key,
    spec: target.copy,
  }));
  const targetSpec = (name: string) => {
    const target = targets.find((t) => t.name === name);
    if (!target) throw new Error(`No target ${name}`);
    return target.spec;
  };
  const open = async (target: string, own: Vars) => {
    if (!opener) throw new Error("No opener found");
    await runArgs(host, opener.args(target, await vars(launchers.opener, own)), { graceMs: grace });
  };
  const actions: Actions = { copy };
  if (targets.length) {
    actions.targets = targets.map(({ name, key }) => ({ name, key }));
    actions.copyTo = async (name, text) =>
      run(targetSpec(name), { mime: TEXT }, { stdin: text, timeoutMs: 15_000 });
  }
  if (chain.write?.images && deps.loadImage)
    actions.copyImage = async (source, cwd) => {
      const bytes = await deps.loadImage!(source, cwd);
      await writeClipboard(bytes, imageMime(bytes));
    };
  if (targets.length && deps.loadImage)
    actions.copyImageTo = async (name, source, cwd) => {
      const bytes = await deps.loadImage!(source, cwd);
      await run(targetSpec(name), { mime: imageMime(bytes) }, { stdin: bytes, timeoutMs: 30_000 });
    };
  if (chain.read) {
    const tool = chain.read;
    actions.pasteClipboard = async () => {
      if (tool.types) {
        const types = decode(await runArgs(host, tool.types, { capture: true })).split(/\r?\n/);
        if (tool.images && types.includes("image/png"))
          return { type: "image", bytes: await readClipboard("image/png") };
        if (!types.some(isText)) throw new Error("Clipboard has no image or text");
      } else if (tool.images) {
        // A configured reader cannot list types: try PNG, and fall back to text.
        const bytes = await readClipboard("image/png").catch(() => undefined);
        if (bytes && Buffer.from(bytes).subarray(0, 8).equals(PNG)) return { type: "image", bytes };
      }
      return { type: "text", text: decode(await readClipboard(TEXT)) };
    };
    if (tool.images) actions.pasteImage = () => readClipboard("image/png");
  }
  if (opener) {
    actions.openUrl = async (url) => {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Unsupported URL");
      let link = parsed.href;
      try {
        const map = command("mapUrl");
        if (map) link = decode(await run(map, { url: link }, { capture: true })).trim() || link;
        await open(link, { url: link });
      } catch {
        copy(link);
        throw new LinkCopied();
      }
    };
    actions.openPath = (path) => open(path, { url: path, path });
  }
  const picker = pickerChain(settings, host);
  // Over SSH the dialog opens where you type and the files come from there, so the action exists
  // whenever ssh does, even on a machine without a desktop.
  const remote = !picker?.name.startsWith("launchers") && deps.sshHost && host.which("ssh");
  if (picker || remote)
    actions.pickFiles = async (cwd) => {
      const via = remote ? await deps.sshHost!() : undefined;
      if (!via && !picker) throw new Error("No file picker found");
      let out: Uint8Array;
      try {
        out = await runArgs(
          host,
          via
            ? [...sshArgs(via), `sh -c ${shellQuote(REMOTE_PICKER)}`]
            : picker!.args(cwd ?? host.env.HOME ?? "/", await vars(launchers.picker, {})),
          { capture: true },
        );
      } catch (error) {
        // zenity and kdialog exit 1 on Cancel; osascript reports "User canceled. (-128)".
        if (error instanceof Error && /exited with 1$|cancel/i.test(error.message)) return [];
        throw error;
      }
      const paths = decode(out)
        .split(/\r?\n/)
        .filter((line) => line.startsWith("/"));
      const files = [];
      for (const path of paths) {
        const name = path.split("/").at(-1)!;
        let bytes: Uint8Array;
        if (via) {
          // One byte past the limit is enough to know it is too big without copying all of it.
          const read = `f=${shellQuote(path)}; [ -f "$f" ] || { echo "$f is not a file" >&2; exit 2; }; exec head -c ${MAX_FILE_BYTES + 1} -- "$f"`;
          bytes = await runArgs(host, [...sshArgs(via), read], { capture: true });
        } else {
          const info = await stat(path);
          if (!info.isFile()) throw new Error(`${name} is not a file`);
          if (info.size > MAX_FILE_BYTES) throw new Error(`${name} is over 50 MB`);
          bytes = new Uint8Array(await readFile(path));
        }
        if (!bytes.length) throw new Error(`${name} is empty`);
        if (bytes.length > MAX_FILE_BYTES) throw new Error(`${name} is over 50 MB`);
        files.push({ name, mimeType: fileMime(name, bytes), bytes });
      }
      return files;
    };
  const player = playerChain(settings, host);
  if (player)
    actions.play = async (target) => {
      const spec = player.name === "launchers.player" ? launchers.player : launchers.opener;
      await runArgs(host, player.args(target, await vars(spec, { path: target, url: target })), {
        graceMs: grace,
      });
    };
  if (host.which("mpv"))
    actions.playHere = (target, vo) =>
      new Promise((resolve, reject) => {
        // mpv owns the terminal until it exits; the caller has suspended the renderer.
        const child = spawn(host.which("mpv")!, [`--vo=${vo}`, "--really-quiet", "--", target], {
          env: host.env as NodeJS.ProcessEnv,
          stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve(undefined) : reject(new Error(`mpv exited with ${code}`)),
        );
      });
  // Without ffmpeg there is no poster or duration, and previews stay placeholders.
  if (host.which("ffmpeg"))
    actions.probeMedia = async (target): Promise<MediaProbe> => {
      const { stdout, stderr } = await runBoth(host, posterArgs(target), 20_000);
      const info = parseFfmpegInfo(stderr);
      const png = stdout.subarray(0, 8).equals(PNG);
      return png ? { ...info, poster: new Uint8Array(stdout) } : info;
    };
  const shell = command("shell") ?? launchers.terminal;
  if (shell)
    actions.shell = async ({ cwd }) => {
      await run(shell, { cwd }, { cwd, graceMs: grace });
    };
  const editor = command("editor");
  if (editor || launchers.editor)
    actions.editor = async ({ cwd, path }) => {
      if (editor) return run(editor, { cwd, path }, { cwd, graceMs: grace });
      // A terminal editor needs `launchers.terminal` in front of it; a GUI editor runs alone.
      const program = expand(launchers.editor!, { cwd, path }, [path]);
      const args = launchers.terminal
        ? [...expand(launchers.terminal, { cwd }), ...program]
        : program;
      return runArgs(host, args, { cwd, graceMs: grace });
    };
  for (const name of ["tmux", "run"] as const) {
    const spec = command(name);
    if (spec)
      actions[name] = ({ cwd, command: text }) => run(spec, { cwd, text }, { cwd, stdin: text });
  }
  const send = command("send");
  if (send)
    actions.send = (input) =>
      input.kind === "file"
        ? run(send, { path: input.path, text: "" })
        : run(send, { text: input.text, path: "" }, { stdin: input.text });
  const dictation = command("dictation");
  if (dictation) {
    let recording = false;
    actions.toggleDictation = async () => {
      const said = decode(await run(dictation, {}, { capture: true }))
        .trim()
        .split("\n")
        .at(-1);
      recording = said === "recording" ? true : said === "idle" ? false : !recording;
      return { recording };
    };
  }
  return actions;
}
