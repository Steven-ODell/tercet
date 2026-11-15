import { expect, test } from "bun:test";
import type { ServerProvider } from "@t3tools/contracts";
import { connectionConfig } from "./config";
import { defaultSelection, runtimeModeFor } from "./model-defaults";
import {
  SettingsError,
  defaultSettings,
  loadSettings,
  migrateLegacyDir,
  parseSettings,
  settingsDir,
} from "./settings";

const where = { home: "/home/u", dir: "/home/u/.config/tercet" };
const PATH = "/home/u/.config/tercet/settings.json";
const parse = (text: string) => parseSettings(text, PATH, where);
const failure = (text: string) => {
  try {
    parse(text);
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsError);
    const message = (error as Error).message;
    expect(message).not.toContain("\n");
    return message;
  }
  throw new Error("expected a settings error");
};

test("settings dir follows XDG_CONFIG_HOME and ignores a relative one", () => {
  expect(settingsDir({}, "/home/u")).toBe("/home/u/.config/tercet");
  expect(settingsDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/tercet");
  expect(settingsDir({ XDG_CONFIG_HOME: "rel" }, "/home/u")).toBe("/home/u/.config/tercet");
});

test("a missing settings file gives the defaults", async () => {
  const reads: string[] = [];
  const loaded = await loadSettings(
    "/cfg/tercet",
    async (path) => (reads.push(path), undefined),
    "/home/u",
  );
  expect(reads).toEqual(["/cfg/tercet/settings.json"]);
  expect(loaded).toEqual({
    dir: "/cfg/tercet",
    path: "/cfg/tercet/settings.json",
    found: false,
    settings: defaultSettings(),
  });
  expect(loaded.settings.defaults).toEqual({
    sendShortcut: "enter",
    favorites: [],
    sidebarWorkingShelf: false,
    hints: true,
  });
  expect(loaded.settings.media.protocol).toBe("auto");
  expect(parse("{}")).toEqual(defaultSettings());
  expect(parse("// nothing yet\n{ }\n")).toEqual(defaultSettings());
});

test("JSONC with comments and trailing commas fills every section", () => {
  const settings = parse(`{
  // where the server is
  "server": { "url": "http://box:3773/", "tokenFile": "~/secrets/tercet", "baseDir": "data", },
  /* look */
  "theme": { "preset": "cyberdream", "accent": "#b07cf5" },
  "keys": { "palette": "ctrl+k", "focusUp": "Alt+Up" },
  "icons": "nerd",
  "defaults": {
    "provider": "codex", "model": "gpt-5.5", "mode": "full-access",
    "sendShortcut": "mod-enter",
    "favorites": [{ "provider": "codex", "model": "gpt-5.5" },],
    "sidebarWorkingShelf": true,
    "hints": false,
  },
  "launchers": { "editor": "nvim", "opener": ["my-opener"], "player": ["mpv", "--no-terminal"] },
  "media": { "protocol": "none" },
  "commands": { "shell": ["tmux", "new-window", "-c", "{cwd}"], "send": "sender" },
  "targets": { "laptop": { "copy": ["ssh", "laptop", "remote-copy", "--type", "{mime}"], "key": "L" } },
}`);
  expect(settings.server).toEqual({
    url: "http://box:3773",
    tokenFile: "/home/u/secrets/tercet",
    baseDir: "/home/u/.config/tercet/data",
  });
  expect(settings.theme.accent).toBe("#b07cf5");
  expect(settings.keys).toEqual({ palette: "ctrl+k", focusUp: "Alt+Up" });
  expect(settings.icons).toBe("nerd");
  expect(settings.defaults).toEqual({
    provider: "codex",
    model: "gpt-5.5",
    mode: "full-access",
    sendShortcut: "mod-enter",
    favorites: [{ provider: "codex", model: "gpt-5.5" }],
    sidebarWorkingShelf: true,
    hints: false,
  });
  expect(settings.launchers.player).toEqual(["mpv", "--no-terminal"]);
  expect(settings.media.protocol).toBe("none");
  expect(Object.keys(settings.commands)).toEqual(["shell", "send"]);
  expect(settings.targets.laptop?.key).toBe("L");
  // A "//" inside a string is not a comment.
  expect(parse('{"server": {"url": "https://t3.example"}} // tail').server.url).toBe(
    "https://t3.example",
  );
});

test("unknown keys are ignored and reported when loading, so a newer settings file never blocks an older tercet", async () => {
  const text = '{\n  "theme": { "preset": "cyberdream", "futureKnob": 1 },\n  "readbackFuture": {},\n  "__proto__": { "polluted": true }\n}';
  const loaded = await loadSettings("/home/u/.config/tercet", async () => text, "/home/u");
  expect(loaded.settings.theme.preset).toBe("cyberdream");
  expect(loaded.warnings).toEqual([
    `${PATH}:2: theme.futureKnob: unknown key; theme takes preset, accent`,
    expect.stringContaining(`${PATH}:3: readbackFuture: unknown key; the top level takes `),
    expect.stringContaining(`${PATH}:4: __proto__: unknown key`),
  ]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  // A wrong value still stops startup, even next to an unknown key.
  await expect(
    loadSettings("/home/u/.config/tercet", async () => '{"nope": 1, "theme": {"accent": "purple"}}', "/home/u"),
  ).rejects.toThrow(':1: theme.accent: expected a "#rrggbb" color');
  // parseSettings without a warnings list stays strict.
  expect(() => parse('{"nope": 1}')).toThrow("nope: unknown key");
});

test("schema errors name the file, line and key", () => {
  expect(failure('{\n  "theme": {\n    "colour": "#fff"\n  }\n}')).toBe(
    `settings error in ${PATH}:3: theme.colour: unknown key; theme takes preset, accent`,
  );
  expect(failure('{\n  "sever": {}\n}')).toBe(
    `settings error in ${PATH}:2: sever: unknown key; the top level takes server, theme, keys, icons, defaults, launchers, media, commands, targets, spell, readback, dictation`,
  );
  expect(failure('{\n  "defaults": {\n\n    "mode": "yolo"\n  }\n}')).toBe(
    `settings error in ${PATH}:4: defaults.mode: expected one of "approval-required", "auto-accept-edits", "auto", "full-access", got "yolo"`,
  );
  expect(failure('{"theme": {"accent": "purple"}}')).toContain(
    ':1: theme.accent: expected a "#rrggbb" color, got "purple"',
  );
  expect(failure('{\n"defaults": {"sidebarWorkingShelf": "yes"}}')).toContain(
    ":2: defaults.sidebarWorkingShelf: expected true or false",
  );
  expect(
    failure('{"defaults": {"favorites": [\n  {"provider": "codex"},\n  {"model": 3}\n]}}'),
  ).toContain(":3: defaults.favorites[1].model: expected a non-empty string, got 3");
  expect(failure('{"commands": {\n  "run": []\n}}')).toContain(
    ":2: commands.run: expected a program name or a non-empty list of arguments, got a list",
  );
  expect(failure('{"commands": {\n  "my cmd": "x"\n}}')).toContain(
    ':2: commands["my cmd"]: unknown key; commands takes copy, paste, shell, embeddedEditor, editor, tmux, run, send, dictation, mapUrl',
  );
  expect(failure('{"server": {"url": "http://box:3773/path"}}')).toContain(
    ":1: server.url: expected an http(s) server origin",
  );
  expect(failure('{"server": "http://box"}')).toContain(
    ':1: server: expected an object, got "http://box"',
  );
  expect(failure('{"__proto__": {"polluted": true}}')).toContain(":1: __proto__: unknown key");
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(failure("[]")).toBe(`settings error in ${PATH}:1: file: expected an object, got a list`);
});

test("syntax errors give the line", () => {
  expect(failure('{\n  "theme": {}\n  "keys": {}\n}')).toBe(
    `settings error in ${PATH}:3: expected "," or "}" after theme`,
  );
  expect(failure('{\n  "theme": {},\n  "theme": {}\n}')).toBe(
    `settings error in ${PATH}:3: duplicate key theme`,
  );
  expect(failure("{\n/* open\n\n")).toContain(":2: unclosed /* comment");
  expect(failure("{\n  theme: {}\n}")).toContain(":2: expected a quoted key");
  expect(failure('{"keys": {"a": "b\nc"}}')).toContain(":1: unterminated or invalid string");
  expect(failure("{} {}")).toContain(":1: unexpected text after the settings object");
  expect(failure("")).toContain(":1: unexpected end of file");
});

test("settings feed the connection; flags still win", async () => {
  const files: Record<string, string> = {
    "/xdg/tercet/settings.json": JSON.stringify({
      server: { url: "https://box:4000", tokenFile: "token-for-box" },
    }),
  };
  const reads: string[] = [];
  const read = async (path: string) => (reads.push(path), files[path]);
  const config = await connectionConfig([], read, "/home/u", { XDG_CONFIG_HOME: "/xdg" });
  expect(config).toMatchObject({
    url: "https://box:4000",
    tokenFile: "/xdg/tercet/token-for-box",
    managedToken: false,
    autostart: false,
    settingsPath: "/xdg/tercet/settings.json",
    settingsFound: true,
  });
  // A configured URL means server-runtime.json is not consulted.
  expect(reads).toEqual(["/xdg/tercet/settings.json"]);
  const flagged = await connectionConfig(
    ["--url", "http://127.0.0.1:3775", "--token-file", "/t"],
    read,
    "/home/u",
    { XDG_CONFIG_HOME: "/xdg" },
  );
  expect(flagged).toMatchObject({ url: "http://127.0.0.1:3775", tokenFile: "/t" });
  const defaults = await connectionConfig([], async () => undefined, "/home/u", {
    XDG_CONFIG_HOME: "/xdg",
  });
  expect(defaults).toMatchObject({
    tokenFile: "/xdg/tercet/token",
    managedToken: true,
    settingsFound: false,
  });
  // An unknown key does not stop startup (see "unknown keys are ignored and reported"); a bad value does.
  files["/xdg/tercet/settings.json"] = '{\n  "server": { "url": 3 }\n}';
  await expect(connectionConfig([], read, "/home/u", { XDG_CONFIG_HOME: "/xdg" })).rejects.toThrow(
    "settings.json:2: server.url: expected",
  );
  files["/xdg/tercet/settings.json"] = '{\n  "server": { "tokn": "x" }\n}';
  await expect(connectionConfig([], read, "/home/u", { XDG_CONFIG_HOME: "/xdg" })).resolves.toMatchObject({
    settingsFound: true,
  });
});

test("server.ignoreVersion in the settings file matches --ignore-version", async () => {
  const env = { XDG_CONFIG_HOME: "/xdg" };
  const withFile = (text?: string) => async (path: string) =>
    path === "/xdg/tercet/settings.json" ? text : undefined;
  const on = await connectionConfig(
    [],
    withFile('{ "server": { "ignoreVersion": true } }'),
    "/home/u",
    env,
  );
  expect(on.ignoreVersion).toBe(true);
  expect((await connectionConfig([], withFile(), "/home/u", env)).ignoreVersion).toBe(false);
  expect(
    (await connectionConfig(["--ignore-version"], withFile(), "/home/u", env)).ignoreVersion,
  ).toBe(true);
  await expect(
    connectionConfig([], withFile('{ "server": { "ignoreVersion": "yes" } }'), "/home/u", env),
  ).rejects.toThrow("server.ignoreVersion: expected true or false");
});

const provider = (instanceId: string, slugs: string[], extra: Partial<ServerProvider> = {}) =>
  ({
    instanceId,
    driver: instanceId,
    enabled: true,
    status: "ready",
    models: slugs.map((slug) => ({ slug })),
    ...extra,
  }) as unknown as ServerProvider;

test("defaults pick the new thread's model and mode when a provider offers them", () => {
  const providers = [
    provider("off", ["m"], { enabled: false }),
    provider("a", ["m", "n"]),
    provider("b", ["m"]),
  ];
  expect(defaultSelection(providers, undefined)).toBeUndefined();
  expect(defaultSelection(providers, { model: "m" }) as unknown).toEqual({
    instanceId: "a",
    model: "m",
  });
  expect(defaultSelection(providers, { provider: "b", model: "m" }) as unknown).toEqual({
    instanceId: "b",
    model: "m",
  });
  expect(defaultSelection(providers, { provider: "b", model: "n" })).toBeUndefined();
  expect(defaultSelection(providers, { model: "gone" })).toBeUndefined();
  const limited = provider("c", ["m"], { supportedRuntimeModes: ["approval-required"] });
  expect(runtimeModeFor(limited, "full-access")).toBe("approval-required");
  expect(runtimeModeFor(provider("d", ["m"]), "auto-accept-edits")).toBe("auto-accept-edits");
  expect(runtimeModeFor(provider("codex", ["m"]), undefined)).toBe("full-access");
});

test("keys rebind commands, and a conflict names both actions on one line", () => {
  const settings = parse('{"keys": {"palette": "ctrl+k", "focusUp": "Alt+Up"}, "icons": "ascii"}');
  expect(settings.keys.palette).toBe("ctrl+k");
  expect(settings.icons).toBe("ascii");
  expect(parse("{}").icons).toBe("unicode");
  // Ctrl+k is focusUp's default, so moving palette there needs focusUp moved too.
  expect(failure('{\n  "keys": {\n    "palette": "Ctrl+k"\n  }\n}')).toBe(
    `settings error in ${PATH}:3: keys.palette: Ctrl+k is bound to both palette and focusUp; rebind one of them`,
  );
  expect(failure('{"keys": {"help": "Y"}}')).toContain(
    "keys.help: Y is bound to both help and copy",
  );
  expect(failure('{"keys": {"help": "G"}}')).toContain(
    "keys.help: G is bound to both help and vim G",
  );
  expect(failure('{"keys": {"diff": "Ctrl+d"}}')).toContain(
    "keys.diff: Ctrl+d is bound to both diff and vim Ctrl+d",
  );
  expect(
    failure('{"targets": {"desk": {"copy": ["true"], "key": "D"}},\n "keys": {"help": "D"}}'),
  ).toBe(
    `settings error in ${PATH}:2: keys.help: D is bound to both help and target desk; rebind one of them`,
  );
  // Legacy terminals send Ctrl+/ as Ctrl+_, so the two are one key.
  expect(failure('{"keys": {"palette": "Ctrl+_"}}')).toContain(
    "Ctrl+/ is bound to both palette and search",
  );
  expect(failure('{"keys": {"newthread": "Ctrl+t"}}')).toContain(
    "keys.newthread: unknown action; actions are shell, editor, terminal,",
  );
  expect(failure('{"keys": {"help": "h"}}')).toContain("a bare h types text; add Ctrl or Alt");
  expect(failure('{"keys": {"help": "Cmd+k"}}')).toContain("Cmd is not sent to terminal programs");
  expect(failure('{"keys": {"quit": "Ctrl+q"}}')).toContain("keys.quit: Ctrl+c is fixed for quit");
  expect(parse('{"keys": {"palette": "none", "search": "Ctrl+p"}}').keys.palette).toBe("none");
  expect(failure('{"theme": {"preset": "neon"}}')).toContain(
    'theme.preset: expected one of "cyberdream", "light", "ansi", "dark", "dusk"',
  );
  expect(failure('{"icons": "emoji"}')).toContain(
    'icons: expected one of "nerd", "unicode", "ascii"',
  );
});

test("a pre-rename t3t config dir moves to tercet and leaves a symlink", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const xdg = mkdtempSync(join(tmpdir(), "tercet-migrate-"));
  try {
    const env = { XDG_CONFIG_HOME: xdg };
    expect(migrateLegacyDir(env, "/nowhere")).toBeUndefined();
    mkdirSync(join(xdg, "t3t"));
    writeFileSync(join(xdg, "t3t", "token"), "secret");
    expect(migrateLegacyDir(env, "/nowhere")).toContain("left a symlink");
    expect(readFileSync(join(xdg, "tercet", "token"), "utf8")).toBe("secret");
    expect(readlinkSync(join(xdg, "t3t"))).toBe(join(xdg, "tercet"));
    // Both exist now: nothing more to do.
    expect(migrateLegacyDir(env, "/nowhere")).toBeUndefined();
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("dictation validates language and raw recorder command", () => {
  expect(parse('{"dictation":{"language":"en","recorder":["capture","--raw"]}}').dictation).toEqual(
    { language: "en", recorder: ["capture", "--raw"] },
  );
  expect(failure('{"dictation":{"language":12}}')).toContain("dictation.language");
});

test("spell defaults on, can be switched off, and takes a dictionary path", () => {
  expect(parse("{}").spell).toEqual({ enabled: true });
  expect(parse('{"spell":{"enabled":false}}').spell.enabled).toBe(false);
  expect(parse('{"spell":{"dictionary":"~/words.txt"}}').spell.dictionary).toBe(
    "/home/u/words.txt",
  );
  expect(failure('{"spell":{"enabled":"yes"}}')).toContain("spell.enabled");
});

test("readback.home defaults to empty, expands ~, resolves relative paths and rejects non-strings", () => {
  expect(parse("{}").readback.home).toBe("");
  expect(parse('{"readback":{"home":""}}').readback.home).toBe("");
  expect(parse('{"readback":{"home":"~/Projects/Side/kokoro"}}').readback.home).toBe(
    "/home/u/Projects/Side/kokoro",
  );
  expect(parse('{"readback":{"home":"/opt/kokoro"}}').readback.home).toBe("/opt/kokoro");
  expect(parse('{"readback":{"home":"models/kokoro"}}').readback.home).toBe(
    "/home/u/.config/tercet/models/kokoro",
  );
  expect(failure('{"readback":{"home":12}}')).toContain("readback.home");
});

test("server.hideWarning is off unless the settings file turns it on", async () => {
  const env = { XDG_CONFIG_HOME: "/xdg" };
  const withFile = (text?: string) => async (path: string) =>
    path === "/xdg/tercet/settings.json" ? text : undefined;
  expect((await connectionConfig([], withFile(), "/home/u", env)).hideWarning).toBe(false);
  const on = await connectionConfig(
    [],
    withFile('{ "server": { "hideWarning": true } }'),
    "/home/u",
    env,
  );
  expect(on.hideWarning).toBe(true);
  await expect(
    connectionConfig([], withFile('{ "server": { "hideWarning": 1 } }'), "/home/u", env),
  ).rejects.toThrow("server.hideWarning: expected true or false");
});

test("external editor destinations and executable argv are configurable", () => {
  for (const editorMode of ["terminal", "tmux", "direct"] as const) {
    const settings = parseSettings(
      JSON.stringify({ launchers: { editorMode, editor: ["/opt/VS Code/code", "{path}"] } }),
      PATH,
      { home: "/home/u", dir: "/x" },
    );
    expect(settings.launchers.editorMode).toBe(editorMode);
    expect(settings.launchers.editor).toEqual(["/opt/VS Code/code", "{path}"]);
  }
  expect(failure('{"launchers":{"editorMode":"unknown"}}')).toContain("launchers.editorMode");
});

test("theme.preset takes every preset and auto, and names them when it is wrong", async () => {
  for (const preset of ["nord", "catppuccin-latte", "one-dark", "auto"] as const) {
    const loaded = await loadSettings(
      "/home/u/.config/tercet",
      async () => `{"theme": {"preset": "${preset}"}}`,
      "/home/u",
    );
    expect(loaded.settings.theme.preset).toBe(preset);
  }
  await expect(
    loadSettings("/home/u/.config/tercet", async () => '{"theme": {"preset": "neon"}}', "/home/u"),
  ).rejects.toThrow("theme.preset: expected one of");
});
