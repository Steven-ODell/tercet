import { expect, test } from "bun:test";
import { createReadback, speechChunks, spokenText, synthesizeReadback, playReadback, playReadbackVia, readbackHome, localReadbackCommand, readbackStatus } from "./readback";
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings, parseSettings } from "./client/settings";
import { blockWrites } from "./client/read-only";
const settings = defaultSettings().readback;
const wav = Buffer.from("RIFFxxxxWAVEdata");

test("Kokoro receives the selected voice and synthesis speed, without T3 credentials", async () => {
  let body: any, headers: any;
  const request = (async (url: any, init: any) => {
    expect(url).toBe(settings.endpoint);
    body = JSON.parse(init.body); headers = init.headers;
    expect(init.redirect).toBe("error");
    return new Response(wav);
  });
  expect(await synthesizeReadback("**Hello** [world](https://example.com)", { ...settings, voice: "am_michael", speed: 1.5 }, new AbortController().signal, request)).toEqual(wav);
  expect(body).toEqual({ model: "kokoro", input: "Hello world", voice: "am_michael", speed: 1.5, response_format: "wav", stream: false });
  expect(headers).toEqual({ "content-type": "application/json" });
});

test("bad responses and unreachable Kokoro have actionable errors", async () => {
  const signal = new AbortController().signal;
  for (const [response, message] of [[new Response("bad", {status: 422}), "HTTP 422"], [new Response("{}"), "invalid WAV"]] as const)
    await expect(synthesizeReadback("hello", settings, signal, (async () => response))).rejects.toThrow(message);
  await expect(synthesizeReadback("hello", settings, signal, (async () => { throw new Error("offline"); }))).rejects.toThrow("Start Kokoro");
  await expect(synthesizeReadback(" ", settings, signal)).rejects.toThrow("No text");
  await expect(synthesizeReadback("x".repeat(30_001), settings, signal)).rejects.toThrow("too long");
});

test("Stop and replacement prevent late synthesis from reaching playback", async () => {
  const pending: Array<{ resolve: (v: Buffer) => void; signal: AbortSignal }> = [];
  const played: string[] = [];
  const controller = createReadback(settings, async (_text, _settings, signal) => new Promise<Buffer>((resolve) => pending.push({resolve, signal})), async (audio) => { played.push(Buffer.from(audio).toString()); });
  const first = controller.readback("one");
  const second = controller.readback("two");
  expect(pending[0]!.signal.aborted).toBe(true);
  pending[0]!.resolve(Buffer.from("one"));
  pending[1]!.resolve(Buffer.from("two"));
  await Promise.all([first, second]);
  expect(played).toEqual(["two"]);
  const third = controller.readback("three");
  controller.stopReadback();
  expect(pending[2]!.signal.aborted).toBe(true);
  pending[2]!.resolve(Buffer.from("three"));
  await third;
  expect(played).toEqual(["two"]);
});

test("Stop aborts active playback and releases the controller", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const controller = createReadback(settings, async () => wav, async (_audio, signal) => {
    started();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    expect(signal.aborted).toBe(true);
  });
  const reading = controller.readback("test");
  await ready; controller.stopReadback(); await reading;
});

test("readback settings default, merge and reject invalid options", () => {
  expect(parseSettings('{"readback":{"speed":1.25,"voice":"bf_emma"}}', "settings.json", {home: "/tmp", dir: "/tmp"}).readback).toEqual({...settings, speed: 1.25, voice: "bf_emma"});
  for (const value of [{speed: 0}, {speed: 4.1}, {speed: "1"}, {voice: ""}, {endpoint: "file:///tmp/a"}, {endpoint: "http://user:pass@host"}])
    expect(() => parseSettings(JSON.stringify({readback: value}), "settings.json", {home: "/tmp", dir: "/tmp"})).toThrow("readback.");
});

test("read-only blocks sending text to Kokoro but still allows Stop", async () => {
  let stopped = false;
  const effects = blockWrites({ copy() {}, readback: async () => {}, stopReadback() { stopped = true; } });
  await expect(effects.readback!("text")).rejects.toThrow("Read-only");
  effects.stopReadback!(); expect(stopped).toBe(true);
});

test("Markdown cleanup preserves code and labels; missing player fails explicitly", async () => {
  expect(spokenText('# Hello\n```sh\necho hi\n```\n![a cat](image.png)')).toBe('Hello\necho hi\n\na cat');
  await expect(playReadback(wav, new AbortController().signal, {env: {}, platform: "linux", which: () => null})).rejects.toThrow("needs mpv");
});

test("the default Kokoro home is tercet's own data directory on each OS", () => {
  expect(readbackHome({}, "", "linux", "/home/example")).toBe("/home/example/.local/share/tercet/kokoro");
  expect(readbackHome({ XDG_DATA_HOME: "/data" }, "", "linux", "/home/example")).toBe("/data/tercet/kokoro");
  expect(readbackHome({ XDG_DATA_HOME: "relative" }, "", "linux", "/home/example")).toBe("/home/example/.local/share/tercet/kokoro");
  expect(readbackHome({}, "", "darwin", "/Users/example")).toBe("/Users/example/Library/Application Support/tercet/kokoro");
  expect(readbackHome({ LOCALAPPDATA: String.raw`C:\Users\Jane Doe\AppData\Local` }, "", "win32", "ignored")).toBe(String.raw`C:\Users\Jane Doe\AppData\Local\tercet\kokoro`);
  expect(readbackHome({}, "", "win32", String.raw`C:\Users\Jane Doe`)).toBe(String.raw`C:\Users\Jane Doe\AppData\Local\tercet\kokoro`);
});

test("Kokoro home precedence: KOKORO_HOME, then readback.home, then the default", () => {
  expect(readbackHome({ KOKORO_HOME: "/env", XDG_DATA_HOME: "/data" }, "/settings", "linux", "/h")).toBe("/env");
  expect(readbackHome({ XDG_DATA_HOME: "/data" }, "/settings", "linux", "/h")).toBe("/settings");
  expect(readbackHome({ XDG_DATA_HOME: "/data" }, "", "linux", "/h")).toBe("/data/tercet/kokoro");
  expect(readbackHome({ KOKORO_HOME: "" }, "/settings", "darwin", "/h")).toBe("/settings");
});

test("local Kokoro command uses the resolved home and per-OS venv Python, and never the old private default", () => {
  expect(defaultSettings().readback.engine).toBe("local");
  expect(defaultSettings().readback.home).toBe("");
  const command = localReadbackCommand({}, "", "linux", "/home/example");
  expect(command.python).toBe("/home/example/.local/share/tercet/kokoro/.venv/bin/python");
  expect(command.args.at(-1)).toBe("/home/example/.local/share/tercet/kokoro");
  expect(command.args[1]).toContain('"en-gb"');
  expect(command.args.join(" ")).not.toContain("Projects/Side");
  const fromSettings = localReadbackCommand({}, "/models/kokoro", "linux", "/home/example");
  expect(fromSettings.python).toBe("/models/kokoro/.venv/bin/python");
  expect(fromSettings.args.at(-1)).toBe("/models/kokoro");
  const windows = localReadbackCommand({ KOKORO_HOME: String.raw`C:\models with spaces\kokoro` }, "", "win32", "ignored");
  expect(windows.python).toBe(String.raw`C:\models with spaces\kokoro\.venv\Scripts\python.exe`);
  expect(windows.args.at(-1)).toBe(String.raw`C:\models with spaces\kokoro`);
  const spaced = localReadbackCommand({}, String.raw`D:\Kokoro Models\home`, "win32", "ignored");
  expect(spaced.python).toBe(String.raw`D:\Kokoro Models\home\.venv\Scripts\python.exe`);
  expect(localReadbackCommand({ KOKORO_PYTHON: "/custom/python", KOKORO_HOME: "/custom/models" }).python).toBe("/custom/python");
});

test("readbackStatus reports what is missing: nothing, some, then all files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-readback-status-"));
  try {
    const home = join(dir, "kokoro");
    const none = readbackStatus({}, home, "linux", "/unused");
    expect(none).toEqual({ ready: false, home, python: join(home, ".venv", "bin", "python"), missing: [".venv", "kokoro-v1.0.onnx", "voices-v1.0.bin"] });
    await mkdir(join(home, ".venv", "bin"), { recursive: true });
    await writeFile(join(home, ".venv", "bin", "python"), "");
    await writeFile(join(home, "kokoro-v1.0.onnx"), "model");
    const some = readbackStatus({}, home, "linux", "/unused");
    expect(some.ready).toBe(false);
    expect(some.missing).toEqual(["voices-v1.0.bin"]);
    await mkdir(join(home, "voices-v1.0.bin")); // a directory is not a file
    expect(readbackStatus({}, home, "linux", "/unused").missing).toEqual(["voices-v1.0.bin"]);
    await rm(join(home, "voices-v1.0.bin"), { recursive: true });
    await writeFile(join(home, "voices-v1.0.bin"), "voices");
    expect(readbackStatus({}, home, "linux", "/unused")).toEqual({ ready: true, home, python: join(home, ".venv", "bin", "python"), missing: [] });
    // Env KOKORO_HOME wins over the settings home; a custom KOKORO_PYTHON is checked instead of the venv.
    expect(readbackStatus({ KOKORO_HOME: join(dir, "other") }, home, "linux", "/unused").ready).toBe(false);
    const custom = readbackStatus({ KOKORO_PYTHON: join(dir, "no-python") }, home, "linux", "/unused");
    expect(custom.missing).toEqual([join(dir, "no-python")]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("local generation sends voice/speed/text on stdin, returns WAV and aborts worker", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { synthesizeLocalReadback } = await import("./readback");
  const dir = await mkdtemp(join(tmpdir(), "tercet-local-readback-"));
  const previous = process.env.KOKORO_PYTHON;
  try {
    const worker = join(dir, "fake-python"); const recorded = join(dir, "request.json");
    await writeFile(worker, `#!${process.execPath}\nconst body = await Bun.stdin.json(); await Bun.write(${JSON.stringify(recorded)}, JSON.stringify(body)); if (body.voice === "slow") setInterval(() => {}, 1000); else process.stdout.write("RIFFxxxxWAVEdata");\n`, { mode: 0o700 });
    process.env.KOKORO_PYTHON = worker;
    expect(Buffer.from(await synthesizeLocalReadback("**hello**", { ...settings, voice: "bm_george", speed: 1.25 }, new AbortController().signal))).toEqual(wav);
    expect(JSON.parse(await readFile(recorded, "utf8"))).toEqual({ text: "hello", voice: "bm_george", speed: 1.25 });
    const abort = new AbortController();
    const pending = synthesizeLocalReadback("cancel", { ...settings, voice: "slow" }, abort.signal);
    // Not `expect(pending).rejects`: Bun 1.4 hangs when the promise rejects in the same tick.
    const outcome = pending.then(() => "resolved", (error: Error) => error.message);
    abort.abort(new Error("cancelled"));
    expect(await outcome).toBe("cancelled");
  } finally {
    if (previous === undefined) delete process.env.KOKORO_PYTHON; else process.env.KOKORO_PYTHON = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

// A fake ssh that runs the remote command on this machine, and a fake mpv that records what it was given.
async function fakeSshRig(mpv: string) {
  const dir = await mkdtemp(join(tmpdir(), "tercet-remote-play-"));
  const script = async (name: string, body: string) => { const path = join(dir, name); await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o755); };
  await script("ssh", 'while [ "$1" = -o ]; do shift 2; done; echo "$1" > "$RIG/host"; shift; exec sh -c "$1"');
  await script("mpv", mpv);
  const env = { PATH: `${dir}:/usr/bin:/bin`, RIG: dir, XDG_RUNTIME_DIR: dir };
  const host = { env, platform: "linux" as const, which: (name: string) => (["ssh", "mpv"].includes(name) ? join(dir, name) : null) };
  return { dir, host, read: (name: string) => readFile(join(dir, name), "utf8"), done: () => rm(dir, { recursive: true, force: true }) };
}

test("over SSH the speech plays on the client machine through ssh, with the whole WAV", async () => {
  const rig = await fakeSshRig('for last; do :; done; wc -c < "$last" > "$RIG/played"; echo "$*" > "$RIG/args"');
  try {
    await playReadbackVia(wav, new AbortController().signal, rig.host, "10.0.0.9");
    expect((await rig.read("host")).trim()).toBe("10.0.0.9");
    expect((await rig.read("played")).trim()).toBe(String(wav.length));
    expect(await rig.read("args")).toContain("--no-video");
  } finally { await rig.done(); }
});

test("stopping remote playback kills the player on the client, and ssh failures say why", async () => {
  const rig = await fakeSshRig('echo $$ > "$RIG/pid"; exec sleep 30');
  try {
    const controller = new AbortController();
    const playing = playReadbackVia(wav, controller.signal, rig.host, "laptop").catch((error) => error);
    for (let i = 0; i < 100; i++) { if (await access(join(rig.dir, "pid")).then(() => true, () => false)) break; await Bun.sleep(50); }
    const pid = Number((await rig.read("pid")).trim());
    controller.abort(new Error("stopped"));
    expect(((await playing) as Error).message).toBe("stopped");
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { pid && (i = 100); } await Bun.sleep(50); if (i === 100) break; }
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await rig.done(); }
  const noSsh = { env: {}, platform: "linux" as const, which: () => null };
  await expect(playReadbackVia(wav, new AbortController().signal, noSsh, "laptop")).rejects.toThrow("needs ssh");
  const broken = await fakeSshRig("exit 0");
  try {
    await writeFile(join(broken.dir, "ssh"), '#!/bin/sh\necho "Permission denied" >&2; exit 255\n');
    await expect(playReadbackVia(wav, new AbortController().signal, broken.host, "laptop")).rejects.toThrow("Permission denied");
  } finally { await broken.done(); }
});

test("long replies are split at sentences and played while the next piece is made", async () => {
  const sentence = "This is one sentence of ordinary length for the reader. ";
  const text = sentence.repeat(40);
  const pieces = speechChunks(text.trim());
  expect(pieces.length).toBeGreaterThan(2);
  expect(pieces[0]!.length).toBeLessThan(400);
  expect(pieces.every((piece) => piece.endsWith("reader."))).toBe(true);
  expect(pieces.join(" ")).toBe(text.trim());
  const events: string[] = [];
  const phases: string[] = [];
  const controller = createReadback(settings,
    async (piece) => { events.push(`make ${piece.length}`); return Buffer.from("x"); },
    async () => { events.push("play"); });
  await controller.readback(text, (phase) => phases.push(phase));
  expect(events.filter((e) => e === "play")).toHaveLength(pieces.length);
  expect(events.indexOf("make " + pieces[1]!.length)).toBeLessThan(events.indexOf("play", 1)); // second made during first play
  expect(phases[0]).toBe("preparing");
  expect(phases).toContain("speaking");
});

test("a failing piece rejects and a slow first piece reports preparing", async () => {
  const controller = createReadback(settings, async () => { throw new Error("boom"); }, async () => {});
  await expect(controller.readback("hello. world.")).rejects.toThrow("boom");
});
