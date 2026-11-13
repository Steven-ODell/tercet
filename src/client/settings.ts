import { lstatSync, renameSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ICON_MODES, type IconMode } from "./icons";
import { KeyConflict, resolveKeymap } from "./keymap";
import { PRESET_NAMES, type PresetName } from "./theme";
import { MEDIA_PROTOCOLS, VIDEO_MODES, type MediaProtocol, type VideoMode } from "./media";

/** A launcher or command: one shell-free argv array, or a single program name/path. */
export type CommandSpec = string | readonly string[];

export const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export const SEND_SHORTCUTS = ["enter", "mod-enter-multiline", "mod-enter"] as const;
export { MEDIA_PROTOCOLS };

/** Values a command template can name as `{name}`. */
export const PLACEHOLDERS = ["cwd", "text", "path", "url", "sshHost", "mime"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/**
 * The optional actions a user can define in `commands`, and the placeholders each one receives.
 * Every template also gets `{sshHost}`; text-carrying actions also get the text on stdin.
 */
export const COMMANDS = {
  /** Clipboard write; the data comes on stdin. */
  copy: ["mime"],
  /** Clipboard read; prints the clipboard in `{mime}`. */
  paste: ["mime"],
  shell: ["cwd"],
  editor: ["cwd", "path"],
  /** Types `{text}` into a terminal without running it. */
  tmux: ["cwd", "text"],
  /** Runs `{text}` (a closed shell code block) at once. */
  run: ["cwd", "text"],
  /** Sends `{text}` or the file at `{path}` somewhere else, such as another device. */
  send: ["text", "path"],
  /** Toggles dictation; may print `recording` or `idle`. */
  dictation: [],
  /** Prints the link to open in place of `{url}` (for example a tunnel's public address). */
  mapUrl: ["url"],
} as const satisfies Record<string, readonly Placeholder[]>;
export type CommandName = keyof typeof COMMANDS;

/** Placeholders each launcher receives; launchers without placeholders get the target appended. */
export const LAUNCHER_PLACEHOLDERS = {
  terminal: ["cwd"],
  editor: ["cwd", "path"],
  opener: ["url", "path"],
  player: ["path"],
  /** A file dialog that prints the picked paths, one per line. */
  picker: ["cwd"],
} as const satisfies Record<string, readonly Placeholder[]>;

/** Transcript keys a target may not take: the built-in target actions and vim's G and V. */
export const RESERVED_TARGET_KEYS = ["Y", "T", "X", "F", "O", "G", "V"];
/** Button labels already used by built-in actions, so a target cannot be named like one. */
export const RESERVED_TARGET_NAMES = ["copy", "open", "tmux", "run", "send", "path"];

/** Each target's capital, as `{ D: "desk" }`. */
export const settingsTargetKeys = (settings: Pick<Settings, "targets">) =>
  Object.fromEntries(
    Object.entries(settings.targets).flatMap(([name, t]) => (t.key ? [[t.key, name]] : [])),
  );

export interface Settings {
  server: { url?: string; tokenFile?: string; baseDir?: string; ignoreVersion?: boolean };
  theme: { preset?: PresetName; accent?: string };
  /** Command name to key, e.g. `"palette": "Ctrl+k"`; `"none"` unbinds. */
  keys: Record<string, string>;
  icons: IconMode;
  defaults: {
    /** Provider instance id, e.g. "codex"; narrows `model` when two providers share a slug. */
    provider?: string;
    model?: string;
    mode?: (typeof RUNTIME_MODES)[number];
    sendShortcut: (typeof SEND_SHORTCUTS)[number];
    favorites: { provider: string; model: string }[];
    sidebarWorkingShelf: boolean;
    /** The two rows of key hints at the bottom; the `hints` key toggles them. */
    hints: boolean;
  };
  launchers: {
    terminal?: CommandSpec;
    editor?: CommandSpec;
    opener?: CommandSpec;
    player?: CommandSpec;
    picker?: CommandSpec;
  };
  /** How images draw (`auto` asks the terminal) and where Enter plays a video. */
  media: { protocol: MediaProtocol; video: VideoMode };
  /** Optional action templates; an absent one means the action and its buttons are hidden. */
  commands: Partial<Record<CommandName, CommandSpec>>;
  /** Named clipboards (another machine, say) offered next to "copy", in file order. */
  targets: Record<string, { copy: CommandSpec; key?: string }>;
  /** Built-in dictation (used when `commands.dictation` is absent). */
  dictation: {
    /** Language hint sent with each recording: "auto" or a code such as "en". */
    language: string;
    /** A recorder that prints 16 kHz mono 32-bit float little-endian PCM to stdout until killed. */
    recorder?: CommandSpec;
  };
}

export const defaultSettings = (): Settings => ({
  server: {},
  theme: {},
  keys: {},
  icons: "unicode",
  defaults: { sendShortcut: "enter", favorites: [], sidebarWorkingShelf: false, hints: true },
  launchers: {},
  media: { protocol: "auto", video: "player" },
  commands: {},
  targets: {},
  dictation: { language: "auto" },
});

/** A bad settings file. The message is one line naming the file, line and key. */
export class SettingsError extends Error {
  override name = "SettingsError";
}

/** `$XDG_CONFIG_HOME/tercet`, or `~/.config/tercet`. A relative XDG_CONFIG_HOME is ignored (XDG spec). */
export function settingsDir(env: Record<string, string | undefined>, home: string) {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "tercet");
}

export const settingsFile = (dir: string) => join(dir, "settings.json");

/** The settings directory's name before the project was renamed from `t3t` (P9). */
export const LEGACY_DIR_NAME = "t3t";

const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Moves a pre-rename `<config>/t3t` to `<config>/tercet` when only the old one exists, and leaves
 * a symlink at the old path so an older install sharing the token keeps working. Returns the
 * one-line notice to print, or undefined when there was nothing to move.
 */
export function migrateLegacyDir(env: Record<string, string | undefined>, home: string) {
  const dir = settingsDir(env, home);
  const legacy = join(dirname(dir), LEGACY_DIR_NAME);
  if (present(dir) || !present(legacy)) return undefined;
  try {
    renameSync(legacy, dir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `tercet: could not move ${legacy} to ${dir} (${reason}); move it by hand.`;
  }
  try {
    symlinkSync(dir, legacy);
  } catch {
    return `tercet: moved ${legacy} to ${dir}.`;
  }
  return `tercet: moved ${legacy} to ${dir} and left a symlink at the old path.`;
}

export interface LoadedSettings {
  dir: string;
  path: string;
  found: boolean;
  settings: Settings;
}

/** Reads `<dir>/settings.json`. A missing file gives the defaults; a bad one throws SettingsError. */
export async function loadSettings(
  dir: string,
  read: (path: string) => Promise<string | undefined>,
  home: string,
): Promise<LoadedSettings> {
  const path = settingsFile(dir);
  const text = await read(path);
  if (text === undefined) return { dir, path, found: false, settings: defaultSettings() };
  return { dir, path, found: true, settings: parseSettings(text, path, { home, dir }) };
}

/** Key paths read like `defaults.model`, `commands["my cmd"]` and `defaults.favorites[0]`. */
export const keyPath = (parent: string, key: string) =>
  /^[A-Za-z_][\w-]*$/.test(key)
    ? parent
      ? `${parent}.${key}`
      : key
    : `${parent}[${JSON.stringify(key)}]`;

class SyntaxProblem extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * JSON with `//` and `/* *\/` comments and trailing commas. Also returns the line each key path
 * starts on, so schema errors can point at it. Duplicate keys are an error.
 */
export function parseJsonc(text: string): { value: unknown; lines: Map<string, number> } {
  const lines = new Map<string, number>();
  let i = 0;
  let line = 1;
  const fail = (message: string): never => {
    throw new SyntaxProblem(line, message);
  };
  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === "\n") {
        line++;
        i++;
      } else if (c === " " || c === "\t" || c === "\r" || c === "﻿") i++;
      else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) fail("unclosed /* comment");
        for (let j = i; j < end; j++) if (text[j] === "\n") line++;
        i = end + 2;
      } else return;
    }
  };
  const string = () => {
    const match = /^"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/.exec(text.slice(i));
    if (!match) fail("unterminated or invalid string");
    i += match![0].length;
    return JSON.parse(match![0]) as string;
  };
  const value = (path: string): unknown => {
    skip();
    const c = text[i];
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (text[i] === "}") {
          i++;
          return out;
        }
        if (text[i] !== '"')
          fail(path ? `expected a quoted key in ${path}` : "expected a quoted key");
        const keyLine = line;
        const key = string();
        const at = keyPath(path, key);
        if (Object.hasOwn(out, key)) fail(`duplicate key ${at}`);
        lines.set(at, keyLine);
        skip();
        if (text[i] !== ":") fail(`expected ":" after ${at}`);
        i++;
        // defineProperty, so a "__proto__" key is a plain key (and later rejected as unknown).
        Object.defineProperty(out, key, {
          value: value(at),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        skip();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail(`expected "," or "}" after ${at}`);
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      for (;;) {
        skip();
        if (text[i] === "]") {
          i++;
          return out;
        }
        const at = `${path}[${out.length}]`;
        lines.set(at, line);
        out.push(value(at));
        skip();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail(`expected "," or "]" after ${at}`);
      }
    }
    if (c === '"') return string();
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?![\w$])/.exec(
      text.slice(i),
    );
    if (!match)
      fail(c === undefined ? "unexpected end of file" : `unexpected ${JSON.stringify(c)}`);
    i += match![0].length;
    return JSON.parse(match![0]);
  };
  const result = value("");
  skip();
  if (i < text.length) fail("unexpected text after the settings object");
  return { value: result, lines };
}

const describe = (value: unknown) => {
  if (Array.isArray(value)) return "a list";
  if (value !== null && typeof value === "object") return "an object";
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
};

type Problem = (path: string, message: string) => never;
type Check = (value: unknown, path: string, problem: Problem) => unknown;

const expect =
  (wanted: string, ok: (value: unknown) => boolean): Check =>
  (value, path, problem) =>
    ok(value) ? value : problem(path, `expected ${wanted}, got ${describe(value)}`);

const text = expect("a non-empty string", (v) => typeof v === "string" && v.trim() !== "");
const bool = expect("true or false", (v) => typeof v === "boolean");
const oneOf = (options: readonly string[]) =>
  expect(`one of ${options.map((o) => JSON.stringify(o)).join(", ")}`, (v) =>
    options.includes(v as string),
  );
const color = expect(
  'a "#rrggbb" color',
  (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v),
);
const command = expect(
  "a program name or a non-empty list of arguments",
  (v) =>
    (typeof v === "string" && v.trim() !== "") ||
    (Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string" && a !== "")),
);
/** `{{` is a literal `{`; any other `{name}` with a lowercase first letter is a placeholder. */
export const PLACEHOLDER = /\{\{|\{([a-z][A-Za-z]*)\}/g;

/**
 * A command whose `{name}` placeholders are all in `allowed`. A placeholder inside the script
 * after `-c` (sh, bash, python) would splice thread text into code, so it must be its own
 * argument and the script reads it as "$1".
 */
/** Programs whose `-c` takes code; tmux's `-c` is a start directory and stays allowed. */
const interpreter = (arg: string) =>
  /^((ba|z|da|k|a|fi)?sh|python[\d.]*|perl|ruby|node|bun|deno)$/.test(arg.split("/").pop()!);
const template =
  (allowed: readonly string[]): Check =>
  (value, path, problem) => {
    command(value, path, problem);
    const args = typeof value === "string" ? [value] : (value as string[]);
    args.forEach((arg, index) => {
      for (const match of arg.matchAll(PLACEHOLDER)) {
        const name = match[1];
        if (!name) continue;
        const at = typeof value === "string" ? path : `${path}[${index}]`;
        if (!allowed.includes(name))
          problem(
            at,
            `unknown placeholder {${name}}; this one takes ${allowed.length ? allowed.map((a) => `{${a}}`).join(", ") : "no placeholders"} (write {{ for a literal brace)`,
          );
        if (
          index > 1 &&
          /^-[A-Za-z]*c$/.test(args[index - 1]!) &&
          args.slice(0, index - 1).some(interpreter)
        )
          problem(
            at,
            `{${name}} inside a -c script is unsafe; pass it as its own argument and read it as "$1"`,
          );
      }
    });
    return value;
  };
const withHost = (vars: readonly Placeholder[]) => template([...vars, "sshHost"]);

const target: Check = (value, path, problem) => {
  const out = struct({
    copy: withHost(["mime"]),
    key: expect("one capital letter", (v) => typeof v === "string" && /^[A-Z]$/.test(v)),
  })(value, path, problem) as { copy?: CommandSpec; key?: string };
  if (!out.copy) problem(path, "a target needs copy, a command that reads the data on stdin");
  if (out.key && RESERVED_TARGET_KEYS.includes(out.key))
    problem(
      keyPath(path, "key"),
      `${out.key} is taken; built-in keys are ${RESERVED_TARGET_KEYS.join(" ")}`,
    );
  return out;
};

const targets: Check = (value, path, problem) => {
  const out = record(
    /^[a-z][\w-]*$/,
    "target names start with a lowercase letter and use letters, digits, _ and -",
    target,
  )(value, path, problem) as Record<string, { key?: string }>;
  const keys = new Map<string, string>();
  for (const [name, entry] of Object.entries(out)) {
    if (RESERVED_TARGET_NAMES.includes(name))
      problem(keyPath(path, name), `"${name}" is a built-in button; pick another name`);
    if (entry.key && keys.has(entry.key))
      problem(
        keyPath(keyPath(path, name), "key"),
        `key ${entry.key} is already used by ${keys.get(entry.key)}`,
      );
    if (entry.key) keys.set(entry.key, name);
  }
  return out;
};

const origin: Check = (value, path, problem) => {
  text(value, path, problem);
  let url: URL | undefined;
  try {
    url = new URL(value as string);
  } catch {}
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    problem(
      path,
      `expected an http(s) server origin like "http://127.0.0.1:3773", got ${describe(value)}`,
    );
  return url!.origin;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const struct =
  (fields: Record<string, Check>): Check =>
  (value, path, problem) => {
    if (!isObject(value)) problem(path, `expected an object, got ${describe(value)}`);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const at = keyPath(path, key);
      const check = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!check)
        problem(
          at,
          `unknown key; ${path || "the top level"} takes ${Object.keys(fields).join(", ")}`,
        );
      out[key] = check!(item, at, problem);
    }
    return out;
  };

const record =
  (name: RegExp, nameHint: string, item: Check): Check =>
  (value, path, problem) => {
    if (!isObject(value)) problem(path, `expected an object, got ${describe(value)}`);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const at = keyPath(path, key);
      if (!name.test(key)) problem(at, `bad name; ${nameHint}`);
      out[key] = item(entry, at, problem);
    }
    return out;
  };

const list =
  (item: Check): Check =>
  (value, path, problem) => {
    if (!Array.isArray(value)) problem(path, `expected a list, got ${describe(value)}`);
    return (value as unknown[]).map((entry, index) => item(entry, `${path}[${index}]`, problem));
  };

const schema = struct({
  server: struct({ url: origin, tokenFile: text, baseDir: text, ignoreVersion: bool }),
  theme: struct({ preset: oneOf(PRESET_NAMES), accent: color }),
  keys: record(/^[A-Za-z][\w.-]*$/, "action names use letters, digits, ., _ and -", text),
  icons: oneOf(ICON_MODES),
  defaults: struct({
    provider: text,
    model: text,
    mode: oneOf(RUNTIME_MODES),
    sendShortcut: oneOf(SEND_SHORTCUTS),
    favorites: list(struct({ provider: text, model: text })),
    sidebarWorkingShelf: bool,
    hints: bool,
  }),
  launchers: struct(
    Object.fromEntries(
      Object.entries(LAUNCHER_PLACEHOLDERS).map(([name, vars]) => [name, withHost(vars)]),
    ),
  ),
  media: struct({ protocol: oneOf(MEDIA_PROTOCOLS), video: oneOf(VIDEO_MODES) }),
  commands: struct(
    Object.fromEntries(Object.entries(COMMANDS).map(([name, vars]) => [name, withHost(vars)])),
  ),
  targets,
  dictation: struct({ language: expect("a language code (2–16 characters)", (v) => typeof v === "string" && v.length >= 2 && v.length <= 16), recorder: template([]) }),
});

/** `~/x` is under home; other relative paths are relative to the settings directory. */
const expandPath = (path: string, home: string, dir: string) =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(dir, path);

/** Parses and validates a settings file's text; missing keys take their defaults. */
export function parseSettings(
  source: string,
  path: string,
  where: { home: string; dir: string },
): Settings {
  let parsed: ReturnType<typeof parseJsonc>;
  try {
    parsed = parseJsonc(source);
  } catch (error) {
    if (error instanceof SyntaxProblem)
      throw new SettingsError(`settings error in ${path}:${error.line}: ${error.message}`);
    throw error;
  }
  // Every path the schema reports came from the parser, which recorded its line; "" is the file.
  const problem: Problem = (at, message) => {
    throw new SettingsError(
      `settings error in ${path}:${parsed.lines.get(at) ?? 1}: ${at || "file"}: ${message}`,
    );
  };
  const raw = schema(parsed.value, "", problem) as Partial<Record<keyof Settings, any>>;
  const base = defaultSettings();
  const settings: Settings = {
    server: { ...base.server, ...raw.server },
    theme: { ...base.theme, ...raw.theme },
    keys: { ...base.keys, ...raw.keys },
    icons: raw.icons ?? base.icons,
    defaults: { ...base.defaults, ...raw.defaults },
    launchers: { ...base.launchers, ...raw.launchers },
    media: { ...base.media, ...raw.media },
    commands: { ...base.commands, ...raw.commands },
    targets: { ...base.targets, ...raw.targets },
    dictation: { ...base.dictation, ...raw.dictation },
  };
  try {
    resolveKeymap(settings.keys, settingsTargetKeys(settings));
  } catch (error) {
    if (error instanceof KeyConflict) problem(keyPath("keys", error.action), error.message);
    throw error;
  }
  if (settings.server.tokenFile)
    settings.server.tokenFile = expandPath(settings.server.tokenFile, where.home, where.dir);
  if (settings.server.baseDir)
    settings.server.baseDir = expandPath(settings.server.baseDir, where.home, where.dir);
  return settings;
}
