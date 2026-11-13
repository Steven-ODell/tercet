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
  expect(Object.keys(bare).sort()).toEqual(["copy"]);
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
  expect(build(headless.host, defaultSettings(), { sshHost: async () => "x" }).actions.pickFiles)
    .toBeDefined();
  expect(REMOTE_PICKER).toContain("wayland-");
});
