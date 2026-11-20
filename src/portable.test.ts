// Tests for the portable clipboard/opener chains and the template engine. Every program here is a
// stub script in a temp directory that is the whole PATH, so the real desktop is never touched.
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  imageActions,
  keyHints,
  LinkCopied,
  offeredActions,
  sshHostLookup,
  targetKeys,
} from "./actions";
import { defaultSettings, parseSettings, type Settings } from "./client/settings";
import {
  clipboardChain,
  expand,
  hostActions,
  imageMime,
  openerChain,
  pickerChain,
  REMOTE_PICKER,
  systemHost,
  type Host,
} from "./portable";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

/** A fake PATH holding `programs`. Each logs its argv and stdin, then prints `<dir>/<name>.out`. */
async function fakePath(programs: string[], env: Record<string, string> = {}) {
  const dir = await mkdtemp("/tmp/tercet-portable-test-");
  dirs.push(dir);
  for (const name of programs) {
    const path = `${dir}/${name}`;
    await writeFile(
      path,
      `#!/bin/sh
printf '%s\\n' "${name} $*" >> "${dir}/log"
/bin/cat >> "${dir}/${name}.in"
if [ -f "${dir}/${name}.fail" ]; then echo "${name} broke" >&2; exit 3; fi
if [ -f "${dir}/${name}.out" ]; then /bin/cat "${dir}/${name}.out"; fi
`,
    );
    await chmod(path, 0o755);
  }
  const host: Host = systemHost({ PATH: dir, ...env }, "linux");
  const log = async () =>
    (await readFile(`${dir}/log`, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const input = (name: string) => readFile(`${dir}/${name}.in`, "utf8").catch(() => "");
  const output = (name: string, data: string | Uint8Array) => writeFile(`${dir}/${name}.out`, data);
  const fail = (name: string) => writeFile(`${dir}/${name}.fail`, "");
  return { dir, host, log, input, output, fail };
}

const settingsWith = (text: string): Settings =>
  parseSettings(text, "/x/settings.json", { home: "/home/u", dir: "/x" });

const build = (host: Host, settings = defaultSettings(), extra = {}) => {
  const terminal: string[] = [];
  const actions = hostActions({
    settings,
    host,
    writeTerminal: (bytes) => terminal.push(bytes),
    graceMs: 50,
    ...extra,
  });
  return { actions, terminal };
};

/** `copy` writes the tool in the background; wait for the stub's stdin file. */
async function settled(read: () => Promise<string>, want: string) {
  for (let i = 0; i < 100 && (await read()) !== want; i++) await Bun.sleep(10);
  return read();
}

test("templates fill placeholders inside their own argument, never through a shell", () => {
  expect(
    expand(["tmux", "send", "-t", "{cwd}", "{text}"], { cwd: "/w", text: "a'b; rm -rf ~" }),
  ).toEqual(["tmux", "send", "-t", "/w", "a'b; rm -rf ~"]);
  expect(expand(["x", "pre-{path}-post"], { path: "p" })).toEqual(["x", "pre-p-post"]);
  // No placeholder: the target is appended, so a launcher can be a bare program.
  expect(expand("firefox", {}, ["https://a.test/"])).toEqual(["firefox", "https://a.test/"]);
  expect(expand(["sh", "-c", "echo {{cwd} ${HOME}", "{sshHost}"], { sshHost: "" })).toEqual([
    "sh",
    "-c",
    "echo {cwd} ${HOME}",
    "",
  ]);
});

test("settings refuse unknown placeholders, placeholders in -c scripts and clashing targets", () => {
  const error = (text: string) => {
    try {
      settingsWith(text);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  expect(error('{"commands": {"shell": ["x", "{text}"]}}')).toContain(
    "commands.shell[1]: unknown placeholder {text}; this one takes {cwd}, {sshHost}",
  );
  expect(error('{"commands": {"run": ["bash", "-c", "eval {text}"]}}')).toContain(
    'commands.run[2]: {text} inside a -c script is unsafe; pass it as its own argument and read it as "$1"',
  );
  expect(error('{"commands": {"mail": "x"}}')).toContain("commands.mail: unknown key");
  // tmux's -c is a start directory, not code, so only an interpreter's -c is refused.
  expect(
    settingsWith('{"commands": {"shell": ["tmux", "new-window", "-c", "{cwd}"]}}').commands.shell,
  ).toEqual(["tmux", "new-window", "-c", "{cwd}"]);
  expect(error('{"commands": {"run": ["ssh", "h", "/bin/sh", "-c", "{text}"]}}')).toContain(
    "inside a -c script is unsafe",
  );
  expect(error('{"targets": {"pc": {"key": "C"}}}')).toContain("targets.pc: a target needs copy");
  expect(error('{"targets": {"pc": {"copy": "x", "key": "T"}}}')).toContain(
    "targets.pc.key: T is taken",
  );
  expect(error('{"targets": {"run": {"copy": "x"}}}')).toContain(
    'targets.run: "run" is a built-in button',
  );
  expect(
    error('{"targets": {"a": {"copy": "x", "key": "C"}, "b": {"copy": "x", "key": "C"}}}'),
  ).toContain("targets.b.key: key C is already used by a");
  const ok = settingsWith(
    '{"commands": {"run": ["bash", "-c", "exec \\"$1\\"", "run", "{text}"]}, "targets": {"pc": {"copy": ["c", "{mime}"], "key": "C"}}}',
  );
  expect(ok.targets.pc).toEqual({ copy: ["c", "{mime}"], key: "C" });
});

test("clipboard chain: configured command, then wl-clipboard, xclip, xsel, pbcopy; display tools need a display", async () => {
  const all = ["wl-copy", "wl-paste", "xclip", "xsel", "pbcopy", "pbpaste"];
  const pick = async (
    programs: string[],
    env: Record<string, string>,
    platform = "linux",
    settings = defaultSettings(),
  ) => {
    const { host } = await fakePath(programs, env);
    const chain = clipboardChain(settings, { ...host, platform });
    return [chain.write?.name, chain.read?.name, chain.write?.images ?? null];
  };
  const both = { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" };
  expect(await pick(all, both)).toEqual(["wl-clipboard", "wl-clipboard", true]);
  expect(await pick(all, { DISPLAY: ":0" })).toEqual(["xclip", "xclip", true]);
  expect(await pick(["xsel", "pbcopy"], both)).toEqual(["xsel", "xsel", false]);
  // pbcopy is macOS only, and wl-clipboard is ignored without WAYLAND_DISPLAY (an SSH session).
  expect(await pick(["wl-copy", "pbcopy", "pbpaste"], {}, "darwin")).toEqual([
    "pbcopy",
    "pbcopy",
    false,
  ]);
  expect(await pick(all, {})).toEqual([undefined, undefined, null]);
  const configured = settingsWith('{"commands": {"copy": ["mycopy", "{mime}"]}}');
  expect(await pick(all, both, "linux", configured)).toEqual([
    "commands.copy",
    "wl-clipboard",
    true,
  ]);
});

test("copy is OSC 52 plus the chosen tool; without a tool only OSC 52, and no paste buttons", async () => {
  const wl = await fakePath(["wl-copy", "wl-paste", "xclip"], { WAYLAND_DISPLAY: "wayland-1" });
  const { actions, terminal } = build(wl.host);
  actions.copy("héllo");
  expect(terminal).toEqual([`\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`]);
  expect(await settled(() => wl.input("wl-copy"), "héllo")).toBe("héllo");
  expect(await wl.log()).toEqual(["wl-copy --type text/plain"]);
  const bare = build((await fakePath(["wl-copy"])).host).actions;
  bare.copy("x");
  // Built-in spell checking and readback remain available with actionable setup errors.
  expect(Object.keys(bare).sort()).toEqual(["copy", "readback", "spell", "stopReadback"]);
});

test("paste reads PNG before text where the tool lists types, and text only through xsel", async () => {
  const wl = await fakePath(["wl-paste"], { WAYLAND_DISPLAY: "wayland-1" });
  const { actions } = build(wl.host);
  await wl.output("wl-paste", "text/plain\nimage/png\n");
  const pasted = await actions.pasteClipboard!();
  expect(pasted.type).toBe("image");
  expect(await wl.log()).toEqual([
    "wl-paste --list-types",
    "wl-paste --no-newline --type image/png",
  ]);
  await wl.output("wl-paste", "text/plain;charset=utf-8\n");
  expect(await actions.pasteClipboard!()).toEqual({
    type: "text",
    text: "text/plain;charset=utf-8\n",
  });
  expect((await wl.log()).at(-1)).toBe("wl-paste --no-newline --type text");
  expect(actions.pasteImage).toBeDefined();

  const x = await fakePath(["xclip"], { DISPLAY: ":0" });
  await x.output("xclip", "UTF8_STRING\nTARGETS\n");
  expect((await build(x.host).actions.pasteClipboard!()).type).toBe("text");
  expect(await x.log()).toEqual([
    "xclip -selection clipboard -t TARGETS -o",
    "xclip -selection clipboard -o",
  ]);

  const xsel = await fakePath(["xsel"], { DISPLAY: ":0" });
  await xsel.output("xsel", "  keep spaces\n");
  const textOnly = build(xsel.host).actions;
  expect(textOnly.pasteImage).toBeUndefined();
  expect(await textOnly.pasteClipboard!()).toEqual({ type: "text", text: "  keep spaces\n" });

  // A configured reader cannot list types: PNG first, then text.
  const own = await fakePath(["mypaste"]);
  const configured = build(
    own.host,
    settingsWith('{"commands": {"paste": ["mypaste", "{mime}"]}}'),
  ).actions;
  await own.output("mypaste", "plain words");
  expect(await configured.pasteClipboard!()).toEqual({ type: "text", text: "plain words" });
  expect(await own.log()).toEqual(["mypaste image/png", "mypaste text/plain"]);
  await own.output("mypaste", PNG);
  expect((await configured.pasteClipboard!()).type).toBe("image");
});

test("images copy with their MIME type only where the clipboard tool takes images", async () => {
  const jpeg = new Uint8Array([255, 216, 255, 0, 1]);
  const wl = await fakePath(["wl-copy"], { WAYLAND_DISPLAY: "w" });
  const { actions } = build(wl.host, defaultSettings(), { loadImage: async () => jpeg });
  await actions.copyImage!("shore.jpg");
  expect(await wl.log()).toEqual(["wl-copy --type image/jpeg"]);
  expect(Buffer.from(await readFile(`${wl.dir}/wl-copy.in`))).toEqual(Buffer.from(jpeg));
  await expect(
    build(wl.host, defaultSettings(), { loadImage: async () => new Uint8Array([1]) }).actions
      .copyImage!("x"),
  ).rejects.toThrow("Unsupported clipboard image");
  const xsel = await fakePath(["xsel"], { DISPLAY: ":0" });
  expect(
    build(xsel.host, defaultSettings(), { loadImage: async () => jpeg }).actions.copyImage,
  ).toBeUndefined();
  expect(imageMime(PNG)).toBe("image/png");
});

test("opener chain: launchers.opener, then xdg-open, then open on macOS only", async () => {
  const name = async (programs: string[], platform: string, settings = defaultSettings()) => {
    const { host } = await fakePath(programs);
    return openerChain(settings, { ...host, platform })?.name;
  };
  expect(await name(["xdg-open", "open"], "linux")).toBe("xdg-open");
  expect(await name(["open"], "linux")).toBeUndefined();
  expect(await name(["open"], "darwin")).toBe("open");
  expect(await name([], "linux", settingsWith('{"launchers": {"opener": "firefox"}}'))).toBe(
    "launchers.opener",
  );
  const linux = await fakePath(["xdg-open"]);
  const { actions } = build(linux.host);
  await actions.openUrl!("https://a.test/x?y=1");
  await actions.openPath!("/tmp/a b.png");
  expect(await linux.log()).toEqual(["xdg-open https://a.test/x?y=1", "xdg-open /tmp/a b.png"]);
  await expect(actions.openUrl!("file:///etc/passwd")).rejects.toThrow("Unsupported URL");
  expect(build((await fakePath([])).host).actions.openUrl).toBeUndefined();
});

test("a failed open copies the link; mapUrl rewrites links first and gets {sshHost}", async () => {
  const fake = await fakePath(["xdg-open", "mapper"]);
  const settings = settingsWith('{"commands": {"mapUrl": ["mapper", "{url}", "{sshHost}"]}}');
  let lookups = 0;
  const { actions, terminal } = build(fake.host, settings, {
    sshHost: async () => {
      lookups++;
      return "100.1.2.3";
    },
  });
  await fake.output("mapper", "https://box.example.test/e/t\n");
  await actions.openUrl!("http://127.0.0.1:3773/e/t");
  expect(await fake.log()).toEqual([
    "mapper http://127.0.0.1:3773/e/t 100.1.2.3",
    "xdg-open https://box.example.test/e/t",
  ]);
  expect(lookups).toBe(1);
  await fake.fail("xdg-open");
  const failure = await actions.openUrl!("http://127.0.0.1:3773/e/t").catch((e) => e);
  expect(failure).toBeInstanceOf(LinkCopied);
  expect(terminal.at(-1)).toContain(Buffer.from("https://box.example.test/e/t").toString("base64"));
});

test("default media follows the current client through the SSH-aware photo opener", async () => {
  const fake = await fakePath(["mpv", "router"]);
  const settings = settingsWith('{"launchers": {"opener": ["router", "{sshHost}", "{path}", "{url}"]}}');
  let via: string | undefined = "laptop";
  let lookups = 0;
  const { actions } = build(fake.host, settings, { sshHost: async () => { lookups++; return via; } });
  const path = "/tmp/a 'video'; $(touch nope).mp4";
  await actions.play!(path);
  via = undefined;
  await actions.play!(path);
  via = "second-laptop";
  await actions.play!(path);
  expect(await fake.log()).toEqual([
    `router laptop ${path} ${path}`,
    `mpv -- ${path}`,
    `router second-laptop ${path} ${path}`,
  ]);
  expect(lookups).toBe(3);
});

test("remote media URLs are mapped and passed as URLs, with one destination lookup", async () => {
  const fake = await fakePath(["mpv", "router", "mapper"]);
  const settings = settingsWith(JSON.stringify({
    launchers: { opener: ["router", "{sshHost}", "{path}", "{url}"] },
    commands: { mapUrl: ["mapper", "{sshHost}", "{url}"] },
  }));
  let lookups = 0;
  const { actions } = build(fake.host, settings, { sshHost: async () => { lookups++; return "laptop"; } });
  await fake.output("mapper", "https://desktop.example/video?id=123\n");
  await actions.play!("http://127.0.0.1:3773/video?id=123");
  expect(await fake.log()).toEqual([
    "mapper laptop http://127.0.0.1:3773/video?id=123",
    "router laptop  https://desktop.example/video?id=123",
  ]);
  expect(lookups).toBe(1);
});

test("remote media failures never fall back to the desktop player", async () => {
  const fake = await fakePath(["mpv", "router", "mapper"]);
  const settings = settingsWith('{"launchers": {"opener": ["router", "{sshHost}", "{path}", "{url}"]}}');
  const extra = { sshHost: async () => "laptop" };
  await fake.fail("router");
  await expect(build(fake.host, settings, extra).actions.play!("/tmp/demo.mp4")).rejects.toThrow();
  expect(await fake.log()).toEqual(["router laptop /tmp/demo.mp4 /tmp/demo.mp4"]);
  settings.commands.mapUrl = ["mapper", "{url}"];
  await fake.fail("mapper");
  await expect(build(fake.host, settings, extra).actions.play!("http://127.0.0.1/v.mp4")).rejects.toThrow();
  expect(await fake.log()).toEqual([
    "router laptop /tmp/demo.mp4 /tmp/demo.mp4",
    "mapper http://127.0.0.1/v.mp4",
  ]);
});

test("default remote media refuses a non-routing opener", async () => {
  const fake = await fakePath(["mpv", "xdg-open"]);
  const { actions } = build(fake.host, defaultSettings(), { sshHost: async () => "laptop" });
  await expect(actions.play!("/tmp/demo.mp4")).rejects.toThrow("SSH-aware launchers.opener");
  expect(await fake.log()).toEqual([]);
});

test("an explicit media player keeps control of its own routing", async () => {
  const fake = await fakePath(["custom-player", "router"]);
  const settings = settingsWith('{"launchers": {"player": ["custom-player", "{sshHost}", "{path}"]}}');
  const { actions } = build(fake.host, settings, { sshHost: async () => "laptop" });
  await actions.play!("https://example.test/demo.mp4");
  expect(await fake.log()).toEqual(["custom-player laptop https://example.test/demo.mp4"]);
});

test("remote media can use the photo opener without mpv installed", async () => {
  const fake = await fakePath(["router"]);
  const settings = settingsWith('{"launchers": {"opener": ["router", "{sshHost}", "{path}", "{url}"]}}');
  const { actions } = build(fake.host, settings, { sshHost: async () => "laptop" });
  await actions.play!("/tmp/demo.mp4");
  await actions.play!("https://example.test/demo.mp4");
  expect(await fake.log()).toEqual([
    "router laptop /tmp/demo.mp4 /tmp/demo.mp4",
    "router laptop  https://example.test/demo.mp4",
  ]);
  const local = build(fake.host, settings, { sshHost: async () => undefined }).actions;
  await local.play!("https://example.test/local.mp4");
  expect((await fake.log()).at(-1)).toBe("router   https://example.test/local.mp4");
});

test("absent commands hide their actions; present ones run their argv with text on stdin", async () => {
  const none = build((await fakePath(["tmux", "xdg-open"])).host).actions;
  for (const name of [
    "shell",
    "editor",
    "tmux",
    "run",
    "send",
    "toggleDictation",
    "copyTo",
    "targets",
  ])
    expect(none[name as keyof typeof none]).toBeUndefined();
  const fake = await fakePath(["typer", "runner", "sender", "mic", "term", "ed", "clip"]);
  const settings = settingsWith(`{
    "commands": {
      "tmux": ["typer", "-d", "{cwd}", "--", "{text}"],
      "run": ["runner", "{cwd}", "{text}"],
      "send": ["sender", "{path}"],
      "dictation": ["mic", "{sshHost}"],
    },
    "launchers": { "terminal": ["term", "-e"], "editor": "ed" },
    "targets": { "desk": { "copy": ["clip", "{mime}", "{sshHost}"], "key": "D" } },
  }`);
  let hostLookups = 0;
  const { actions } = build(fake.host, settings, {
    sshHost: async () => {
      hostLookups++;
      return undefined;
    },
  });
  await actions.tmux!({ cwd: fake.dir, command: "echo '$(x)'" });
  expect(await fake.input("typer")).toBe("echo '$(x)'");
  await actions.run!({ cwd: fake.dir, command: "ls" });
  await actions.send!({ kind: "text", text: "hi" });
  expect(await fake.input("sender")).toBe("hi");
  await actions.send!({ kind: "file", path: "/w/a.txt" });
  await actions.editor!({ cwd: fake.dir, path: "src/a b.ts" });
  await actions.shell!({ cwd: fake.dir });
  expect(actions.targets).toEqual([{ name: "desk", key: "D" }]);
  await actions.copyTo!("desk", "for desk");
  expect(await fake.input("clip")).toBe("for desk");
  expect(await fake.log()).toEqual([
    `typer -d ${fake.dir} -- echo '$(x)'`,
    `runner ${fake.dir} ls`,
    "sender ",
    "sender /w/a.txt",
    "term -e ed src/a b.ts",
    "term -e",
    "clip text/plain",
  ]);
  // Only templates that name {sshHost} look it up.
  expect(hostLookups).toBe(1);
  await fake.output("mic", "recording\n");
  expect(await actions.toggleDictation!()).toEqual({ recording: true });
  await fake.output("mic", "idle\n");
  expect(await actions.toggleDictation!()).toEqual({ recording: false });
  await fake.output("mic", "");
  expect(await actions.toggleDictation!()).toEqual({ recording: true });
  await fake.fail("runner");
  await expect(actions.run!({ cwd: fake.dir, command: "ls" })).rejects.toThrow("runner broke");
});

test("buttons and capital keys follow the actions that exist", () => {
  const none = { copy() {} };
  expect(offeredActions(none)).toEqual([]);
  expect(imageActions(none)).toEqual([]);
  expect(targetKeys(none)).toEqual({ Y: "copy", O: "open" });
  expect(keyHints(none)).toBe("");
  const all = {
    copy() {},
    targets: [{ name: "desk", key: "D" }, { name: "tv" }],
    copyTo: async () => {},
    tmux: async () => {},
    run: async () => {},
    send: async () => {},
    copyImage: async () => {},
    openImage: async () => {},
  };
  expect(offeredActions(all)).toEqual(["desk", "tv", "tmux", "run", "send"]);
  // No copyImageTo, so the targets get no image buttons.
  expect(imageActions(all)).toEqual(["copy", "open"]);
  expect(targetKeys(all)).toEqual({
    Y: "copy",
    O: "open",
    T: "tmux",
    X: "run",
    F: "send",
    D: "desk",
  });
  expect(keyHints(all, ["run"])).toBe(" · T tmux · F send · D desk");
  // Targets without copyTo draw nothing.
  expect(offeredActions({ copy() {}, targets: all.targets })).toEqual([]);
});

test("{sshHost} comes from the most recently active tmux client, else SSH_CONNECTION", async () => {
  const environ = (connection?: string) =>
    ["PATH=/bin", ...(connection ? [`SSH_CONNECTION=${connection}`] : [])].join("\0");
  const asked: string[] = [];
  const lookup = (env: Record<string, string>, environs: Record<string, string>) =>
    sshHostLookup(
      env,
      async (args) => {
        asked.push(args.join(" "));
        return "100 11\n300 33\n200 22\n";
      },
      async (path) => {
        if (!(path in environs)) throw Error("gone");
        return environs[path]!;
      },
    )();
  const own = "10.0.0.9 5000 10.0.0.1 22";
  expect(
    await lookup(
      { TMUX: "/tmp/tmux-1/default,1,0", SSH_CONNECTION: own },
      { "/proc/33/environ": environ("10.0.0.3 5000 10.0.0.1 22") },
    ),
  ).toBe("10.0.0.3");
  expect(asked).toEqual(["tmux list-clients -F #{client_activity} #{client_pid}"]);
  // The active client is local: no host, even though the pane was started over SSH.
  expect(
    await lookup({ TMUX: "x", SSH_CONNECTION: own }, { "/proc/33/environ": environ() }),
  ).toBeUndefined();
  // Outside tmux, or when /proc can't be read, the process's own connection answers.
  expect(await lookup({ SSH_CONNECTION: own }, {})).toBe("10.0.0.9");
  expect(await lookup({ TMUX: "x", SSH_CONNECTION: own }, {})).toBe("10.0.0.9");
  expect(await lookup({}, {})).toBeUndefined();
});

test("picker chain: launchers.picker, then zenity or kdialog on a desktop, osascript on macOS", async () => {
  const name = async (
    programs: string[],
    env: Record<string, string>,
    platform = "linux",
    settings = defaultSettings(),
  ) => {
    const { host } = await fakePath(programs, env);
    return pickerChain(settings, { ...host, platform })?.name;
  };
  expect(await name(["zenity", "kdialog"], { WAYLAND_DISPLAY: "wayland-1" })).toBe("zenity");
  expect(await name(["kdialog"], { DISPLAY: ":0" })).toBe("kdialog");
  expect(await name(["zenity"], {})).toBeUndefined();
  expect(await name(["osascript"], {}, "darwin")).toBe("osascript");
  const picker = settingsWith('{"launchers": {"picker": ["my-picker", "{cwd}"]}}');
  expect(await name([], {}, "linux", picker)).toBe("launchers.picker");
  expect(build((await fakePath([])).host).actions.pickFiles).toBeUndefined();
});

test("picked files come back read, with a MIME type; Cancel is empty, other failures throw", async () => {
  const fake = await fakePath(["zenity"], { WAYLAND_DISPLAY: "wayland-1" });
  await writeFile(`${fake.dir}/shot.png`, PNG);
  await writeFile(`${fake.dir}/notes.ts`, "const a = 1;");
  await writeFile(`${fake.dir}/blob`, new Uint8Array([1, 0, 2]));
  await fake.output("zenity", `${fake.dir}/shot.png\n${fake.dir}/notes.ts\n${fake.dir}/blob\n`);
  const { actions } = build(fake.host);
  const picked = await actions.pickFiles!("/proj");
  expect(picked.map(({ name, mimeType }) => [name, mimeType])).toEqual([
    ["shot.png", "image/png"],
    ["notes.ts", "text/plain"],
    ["blob", "application/octet-stream"],
  ]);
  expect(picked[0]!.bytes).toEqual(PNG);
  expect((await fake.log()).join("\n")).toContain("--filename=/proj/");
  await writeFile(`${fake.dir}/empty`, "");
  await fake.output("zenity", `${fake.dir}/empty\n`);
  await expect(actions.pickFiles!("/proj")).rejects.toThrow("empty is empty");
  // zenity exits 1 on Cancel; any other failure is an error.
  await writeFile(`${fake.dir}/zenity`, "#!/bin/sh\nexit 1\n");
  expect(await actions.pickFiles!("/proj")).toEqual([]);
  await writeFile(`${fake.dir}/zenity`, "#!/bin/sh\necho 'no display' >&2\nexit 5\n");
  await expect(actions.pickFiles!("/proj")).rejects.toThrow("no display");
});

test("over SSH the picker runs on the machine typed from and the files are copied from there", async () => {
  // The stub ssh answers the picker with two paths and runs any other command here, as the
  // laptop would. A local zenity exists too, and must not be used.
  const fake = await fakePath(["zenity"], { WAYLAND_DISPLAY: "wayland-1" });
  await writeFile(`${fake.dir}/it's here.png`, PNG);
  await writeFile(`${fake.dir}/big`, "x");
  await writeFile(
    `${fake.dir}/ssh`,
    `#!/bin/sh
printf '%s\\n' "ssh $*" >> "${fake.dir}/log"
for last; do :; done
case "$last" in
  *zenity*) printf '%s\\n' "${fake.dir}/it's here.png" "${fake.dir}/notes.txt" ;;
  *) PATH=/usr/bin:/bin exec /bin/sh -c "$last" ;;
esac
`,
  );
  await chmod(`${fake.dir}/ssh`, 0o755);
  await writeFile(`${fake.dir}/notes.txt`, "remote notes");
  const { actions } = build(fake.host, defaultSettings(), { sshHost: async () => "laptop" });
  const picked = await actions.pickFiles!("/proj");
  expect(picked.map(({ name, mimeType }) => [name, mimeType])).toEqual([
    ["it's here.png", "image/png"],
    ["notes.txt", "text/plain"],
  ]);
  expect(picked[0]!.bytes).toEqual(PNG);
  const log = await fake.log();
  expect(log[0]).toStartWith("ssh -n -o BatchMode=yes -o ConnectTimeout=5 laptop sh -c");
  expect(log.some((line) => line.startsWith("zenity"))).toBe(false);
  // Not over SSH (no client host): the local picker.
  await fake.output("zenity", "");
  const local = build(fake.host, defaultSettings(), { sshHost: async () => undefined });
  expect(await local.actions.pickFiles!("/proj")).toEqual([]);
  expect((await fake.log()).filter((line) => line.startsWith("zenity"))).toHaveLength(1);
  // A machine without a desktop still offers attach when ssh can reach the client.
  const headless = await fakePath(["ssh"]);
  expect(
    build(headless.host, defaultSettings(), { sshHost: async () => "x" }).actions.pickFiles,
  ).toBeDefined();
  expect(REMOTE_PICKER).toContain("wayland-");
});

test("external editor uses VISUAL before EDITOR, opens terminal editors in a window, and keeps argv boundaries", async () => {
  const fake = await fakePath(["ghostty", "nvim", "vi"], {
    VISUAL: "nvim --clean",
    EDITOR: "vi",
    WAYLAND_DISPLAY: "test",
  });
  await writeFile(
    fake.dir + "/ghostty",
    "#!" +
      process.execPath +
      "\nawait Bun.write(" +
      JSON.stringify(fake.dir + "/argv.json") +
      ", JSON.stringify(process.argv.slice(2)));",
  );
  const { actions } = build(fake.host);
  const path = "a ' $(not-a-command).txt";
  await actions.editor!({ cwd: fake.dir, path });
  expect(JSON.parse(await readFile(fake.dir + "/argv.json", "utf8"))).toEqual([
    "--working-directory=" + fake.dir,
    "-e",
    "nvim",
    "--clean",
    fake.dir + "/" + path,
  ]);
});

test("external GUI editors use argv directly, including executable paths outside PATH", async () => {
  const fake = await fakePath(["code"], { VISUAL: "code --wait", WAYLAND_DISPLAY: "test" });
  await build(fake.host).actions.editor!({ cwd: fake.dir, path: "a.txt" });
  expect(await fake.log()).toEqual(["code --wait " + fake.dir + "/a.txt"]);
  const settings = settingsWith(
    JSON.stringify({ launchers: { editor: [fake.dir + "/code", "{path}"], editorMode: "direct" } }),
  );
  const withoutPath = systemHost({ PATH: "/not-here" }, "linux");
  await build(withoutPath, settings).actions.editor!({ cwd: fake.dir, path: "b.txt" });
  expect((await fake.log()).at(-1)).toBe("code b.txt");
});

test("no configured editor stays unset; missing editor gives linking guidance; custom commands win", async () => {
  const fake = await fakePath(["ghostty", "nvim"], { WAYLAND_DISPLAY: "test" });
  expect(build(fake.host).actions.editor).toBeUndefined();
  const missing = settingsWith('{"launchers":{"editor":"missing-editor","editorMode":"tmux"}}');
  await expect(
    build(fake.host, missing).actions.editor!({ cwd: fake.dir, path: "a" }),
  ).rejects.toThrow("full executable path");
  const custom = settingsWith(
    '{"commands":{"editor":["nvim","{path}"]},"launchers":{"editor":"missing-editor","editorMode":"tmux"}}',
  );
  await build(fake.host, custom).actions.editor!({ cwd: fake.dir, path: "custom" });
  expect((await fake.log()).at(-1)).toBe("nvim custom");
});

test("automatic external editing rejects direct remote paths and tmux mode explains missing attachment", async () => {
  const fake = await fakePath(["nvim", "tmux"], { EDITOR: "nvim" });
  const settings = settingsWith('{"launchers":{"editorMode":"tmux"}}');
  await expect(
    build(fake.host, settings, { localWorkspace: false }).actions.editor!({
      cwd: fake.dir,
      path: "a",
    }),
  ).rejects.toThrow("SSH");
  await expect(
    build(fake.host, settings).actions.editor!({ cwd: fake.dir, path: "a" }),
  ).rejects.toThrow("attached tmux");
});

test("quoted VISUAL paths and flags are parsed without expanding shell syntax", async () => {
  const fake = await fakePath(["code"], { VISUAL: "code --wait", EDITOR: "ignored" });
  fake.host.env.VISUAL = '"' + fake.dir + '/code" --reuse-window "$(literal)"';
  await build(fake.host).actions.editor!({ cwd: fake.dir, path: "file" });
  expect((await fake.log()).at(-1)).toBe("code --reuse-window $(literal) " + fake.dir + "/file");
  fake.host.env.VISUAL = '"unclosed';
  await expect(build(fake.host).actions.editor!({ cwd: fake.dir, path: "file" })).rejects.toThrow(
    "unclosed quote",
  );
});

test("missing custom editor commands also explain how to link an executable", async () => {
  const fake = await fakePath([]);
  const settings = settingsWith('{"commands":{"editor":"not-installed"}}');
  await expect(
    build(fake.host, settings).actions.editor!({ cwd: fake.dir, path: "file" }),
  ).rejects.toThrow("full executable path");
});

test("SSH never uses desktop clipboard tools, even with inherited displays on Linux/macOS", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const fake = await fakePath(["wl-copy", "wl-paste", "pbcopy", "pbpaste", "powershell.exe"], {
      SSH_CONNECTION: "10.0.0.2 1 10.0.0.1 22", WAYLAND_DISPLAY: "w", DISPLAY: ":0",
    });
    const host = { ...fake.host, platform };
    expect(clipboardChain(defaultSettings(), host)).toEqual({ write: undefined, read: undefined });
    const { actions, terminal } = build(host);
    await actions.copy("remote");
    expect(terminal).toEqual(["\x1b]52;c;cmVtb3Rl\x07"]);
    await expect(actions.pasteClipboard!()).rejects.toThrow("Ctrl+Shift+V or Cmd+V");
    expect(await fake.log()).toEqual([]);
  }
});

test("tmux actions follow local/remote client switches and wrap terminal writes when allowed", async () => {
  const fake = await fakePath(["wl-copy", "wl-paste"], { TMUX: "tmux", WAYLAND_DISPLAY: "w" });
  let local = false;
  const { actions, terminal } = build(fake.host, defaultSettings(), {
    clipboardLocal: async () => local, clipboardPassthrough: true,
    loadImage: async () => PNG,
  });
  await actions.copy("remote");
  expect(terminal).toEqual(["\x1bPtmux;\x1b\x1b]52;c;cmVtb3Rl\x07\x1b\\"]);
  await expect(actions.pasteClipboard!()).rejects.toThrow("Terminal clipboard reading is unavailable");
  await expect(actions.copyImage!("x")).rejects.toThrow("No clipboard tool");
  expect(await fake.log()).toEqual([]);
  local = true;
  await actions.copy("local");
  expect(await fake.input("wl-copy")).toBe("local");
  await fake.output("wl-paste", "text/plain\n");
  expect((await actions.pasteClipboard!()).type).toBe("text");
  const before = await fake.log();
  local = false;
  await expect(actions.pasteClipboard!()).rejects.toThrow("Terminal clipboard reading is unavailable");
  expect(await fake.log()).toEqual(before);
});

test("explicit clipboard commands and named targets own routing over SSH", async () => {
  const fake = await fakePath(["own-copy", "own-paste", "pc"], { SSH_TTY: "ssh" });
  const settings = settingsWith(JSON.stringify({
    commands: { copy: ["own-copy", "{mime}"], paste: ["own-paste", "{mime}"] },
    targets: { pc: { copy: ["pc", "{mime}"] } },
  }));
  const { actions, terminal } = build(fake.host, settings);
  await actions.copy("configured");
  expect(await fake.input("own-copy")).toBe("configured");
  expect(terminal).toEqual([]);
  await actions.copyTo!("pc", "named");
  expect(await fake.input("pc")).toBe("named");
  await fake.output("own-paste", "remote text");
  expect(await actions.pasteClipboard!()).toEqual({ type: "text", text: "remote text" });
  await fake.fail("own-copy");
  await expect(Promise.resolve(actions.copy("fail"))).rejects.toThrow("own-copy broke");
});


test("browser executable and profile override only URL opening", async () => {
  const fake = await fakePath(["xdg-open", "browser"]);
  const settings = settingsWith(JSON.stringify({ launchers: {
    browser: [fake.dir + "/browser", "-P", "{profile}", "{url}"],
    browserProfile: "Work Profile", browserLocation: "host",
  }}));
  const { actions } = build(fake.host, settings);
  await actions.openUrl!("https://example.com/path?a=1&b=2");
  await actions.openPath!("/tmp/file.txt");
  expect(await fake.log()).toEqual([
    "browser -P Work Profile https://example.com/path?a=1&b=2",
    "xdg-open /tmp/file.txt",
  ]);
});

test("client browser uses SSH with shell-quoted URL and profile arguments", async () => {
  const fake = await fakePath(["ssh"]);
  const settings = settingsWith(JSON.stringify({ launchers: {
    browser: ["zen", "-P", "{profile}", "{url}"],
    browserProfile: "Work Profile", browserLocation: "client",
  }}));
  const { actions } = build(fake.host, settings, { sshHost: async () => "100.1.2.3" });
  await actions.openUrl!("https://example.com/?a=1&b=$(touch%20oops)");
  expect(await fake.log()).toEqual([
    "ssh -- 100.1.2.3 'zen' '-P' 'Work Profile' 'https://example.com/?a=1&b=$(touch%20oops)'",
  ]);
  await expect(actions.openUrl!("file:///etc/passwd")).rejects.toThrow("Unsupported URL");
});


test("missing SSH client copies the URL without opening on the host", async () => {
  const fake = await fakePath(["xdg-open", "ssh"]);
  const settings = settingsWith('{"launchers":{"browserLocation":"client"}}');
  const { actions, terminal } = build(fake.host, settings, { sshHost: async () => undefined });
  await expect(actions.openUrl!("https://example.com/")).rejects.toBeInstanceOf(LinkCopied);
  expect(await fake.log()).toEqual([]);
  expect(terminal.at(-1)).toContain(Buffer.from("https://example.com/").toString("base64"));
});

test("region selection routes PNG output to the caller, locally or over SSH", async () => {
  const fake = await fakePath(["grim", "slurp", "ssh"], { WAYLAND_DISPLAY: "wayland-test" });
  await Bun.write(fake.dir + "/sh", "#!/bin/sh\nexec /bin/sh \"$@\"\n");
  await chmod(fake.dir + "/sh", 0o755);
  await fake.output("slurp", "1,2 30x40");
  await fake.output("grim", PNG);
  let via: string | undefined;
  const { actions } = build(fake.host, defaultSettings(), { sshHost: async () => via });
  expect(await actions.captureRegion!()).toEqual(PNG);
  expect(await fake.log()).toContain("grim -g 1,2 30x40 -");
  await writeFile(fake.dir + "/slurp", "#!/bin/sh\nexit 1\n");
  expect(await actions.captureRegion!()).toBeUndefined();
  via = "laptop";
  await fake.output("ssh", PNG);
  expect(await actions.captureRegion!()).toEqual(PNG);
  expect((await fake.log()).join("\n")).toContain("ConnectTimeout=5 laptop sh -c");
  await fake.fail("ssh");
  await expect(actions.captureRegion!()).rejects.toThrow("ssh broke");
});
