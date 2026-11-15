import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { venvPython } from "./readback";
import {
  KOKORO_FILES,
  KOKORO_PACKAGES,
  KOKORO_RELEASE_URL,
  downloadTo,
  runReadback,
  runSetup,
  systemDeps,
  type ModelFile,
  type SetupDeps,
  type SetupOptions,
} from "./readback-setup";

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const FILES: ModelFile[] = [
  { name: "model.onnx", bytes: 5, sha256: sha("model") },
  { name: "voices.bin", bytes: 6, sha256: sha("voices") },
];
const BODY: Record<string, string> = { "model.onnx": "model", "voices.bin": "voices" };
const BASE = "https://example.test/release";

interface Entry {
  bytes: number;
  hash: string;
}

/** A made-up machine: an in-memory file system, a command log and canned downloads. */
function rig(
  settings: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    installed?: string[];
    files?: Record<string, string>;
    answer?: string;
    importsOk?: boolean;
    served?: Record<string, string>;
    failDownload?: boolean;
    failInstall?: boolean;
  } = {},
) {
  const platform = settings.platform ?? "linux";
  const at = platform === "win32" ? win32.join : join;
  const home = platform === "win32" ? "C:\\Users\\Jo Doe\\AppData\\Local\\tercet\\kokoro" : "/data/tercet/kokoro";
  const files = new Map<string, Entry>();
  const put = (path: string, text: string) => files.set(path, { bytes: text.length, hash: sha(text) });
  for (const [name, text] of Object.entries(settings.files ?? {})) put(at(home, name), text);
  const state = { importsOk: settings.importsOk ?? false };
  const commands: string[][] = [];
  const downloads: string[] = [];
  const prompts: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const operations: string[] = [];
  const installed = new Set(settings.installed ?? ["uv"]);
  const deps: SetupDeps = {
    platform,
    env: settings.env ?? {},
    files: FILES,
    baseUrl: BASE,
    packages: KOKORO_PACKAGES,
    which: (program) => (installed.has(program) ? `${program}` : null),
    run: async (command, _signal, quiet) => {
      if (quiet) return state.importsOk && files.has(command[0]!) ? 0 : 1;
      commands.push(command);
      if (command.includes("venv")) {
        put(venvPython(home, platform), "python");
        return 0;
      }
      if (settings.failInstall) return 1;
      state.importsOk = true;
      return 0;
    },
    download: async (url, dest) => {
      downloads.push(url);
      const name = url.slice(BASE.length + 1);
      put(dest, (settings.served ?? BODY)[name] ?? "");
      if (settings.failDownload) throw new Error("connection reset");
    },
    size: (path) => files.get(path)?.bytes,
    exists: (path) => [...files.keys()].some((key) => key === path || key.startsWith(path + (platform === "win32" ? "\\" : "/"))),
    sha256: async (path) => files.get(path)!.hash,
    mkdir: async (path) => void operations.push(`mkdir ${path}`),
    rename: async (from, to) => {
      operations.push(`rename ${from} ${to}`);
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    remove: async (path) => {
      operations.push(`remove ${path}`);
      for (const key of [...files.keys()]) if (key === path || key.startsWith(path + "/") || key.startsWith(path + "\\")) files.delete(key);
    },
    prompt: async (question) => {
      prompts.push(question);
      return settings.answer ?? "y";
    },
    log: (line) => void lines.push(line),
    error: (line) => void errors.push(line),
  };
  const options = (extra: Partial<SetupOptions> = {}): SetupOptions => ({
    home,
    usualHome: home,
    yes: false,
    dryRun: false,
    force: false,
    ...extra,
  });
  const run = (extra: Partial<SetupOptions> = {}, signal = new AbortController().signal) => runSetup(options(extra), deps, signal);
  return { deps, files, home, at, commands, downloads, prompts, lines, errors, operations, run, put, state };
}

const venv = (home: string) => join(home, ".venv");
const python = (home: string) => venvPython(home, "linux");

test("the pinned values describe the two release files", () => {
  expect(KOKORO_FILES.map((file) => file.name)).toEqual(["kokoro-v1.0.onnx", "voices-v1.0.bin"]);
  for (const file of KOKORO_FILES) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(KOKORO_RELEASE_URL).toContain("kokoro-onnx/releases/download/model-files-v1.0");
  expect(KOKORO_PACKAGES).toEqual(["kokoro-onnx==0.6.1", "numpy>=2.0.2,<3"]);
});

test("dry run prints the plan and changes nothing", async () => {
  const r = rig();
  expect(await r.run({ dryRun: true })).toBe(0);
  const text = r.lines.join("\n");
  expect(text).toContain(r.home);
  expect(text).toContain(`create the Python venv ${venv(r.home)} with uv`);
  expect(text).toContain("install kokoro-onnx==0.6.1 numpy>=2.0.2,<3");
  expect(text).toContain(`download model.onnx (0 MB) from ${BASE}/model.onnx`);
  expect(text).toContain("Dry run: nothing was created");
  expect(r.commands).toEqual([]);
  expect(r.downloads).toEqual([]);
  expect(r.operations).toEqual([]);
  expect(r.prompts).toEqual([]);
});

test("anything but y at the prompt changes nothing", async () => {
  for (const answer of ["", "n", "no", "maybe"]) {
    const r = rig({ answer });
    expect(await r.run()).toBe(1);
    expect(r.prompts).toEqual(["Continue? [y/N] "]);
    expect(r.lines.at(-1)).toBe("Cancelled. Nothing was changed.");
    expect(r.commands).toEqual([]);
    expect(r.downloads).toEqual([]);
    expect(r.operations).toEqual([]);
  }
  const yes = rig({ answer: "Y" });
  expect(await yes.run()).toBe(0);
  expect(yes.downloads).toHaveLength(2);
});

test("--yes skips the prompt; with uv it makes the venv and installs through uv, then downloads and verifies", async () => {
  const r = rig();
  expect(await r.run({ yes: true })).toBe(0);
  expect(r.prompts).toEqual([]);
  expect(r.commands).toEqual([
    ["uv", "venv", venv(r.home)],
    ["uv", "pip", "install", "--python", python(r.home), ...KOKORO_PACKAGES],
  ]);
  expect(r.downloads).toEqual([`${BASE}/model.onnx`, `${BASE}/voices.bin`]);
  expect(r.files.has(join(r.home, "model.onnx"))).toBe(true);
  expect(r.files.has(join(r.home, "voices.bin"))).toBe(true);
  expect([...r.files.keys()].some((key) => key.endsWith(".part"))).toBe(false);
  expect(r.lines.at(-1)).toBe(`Read aloud is set up in ${r.home}.`);
});

test("without uv it uses python3 -m venv and the venv's pip", async () => {
  const r = rig({ installed: ["python3"] });
  expect(await r.run({ yes: true })).toBe(0);
  expect(r.commands).toEqual([
    ["python3", "-m", "venv", venv(r.home)],
    [python(r.home), "-m", "pip", "install", ...KOKORO_PACKAGES],
  ]);
});

test("without uv or python it says so before changing anything", async () => {
  const r = rig({ installed: [] });
  expect(await r.run({ yes: true })).toBe(1);
  expect(r.errors.join("\n")).toContain("needs uv or Python 3 on PATH");
  expect(r.commands).toEqual([]);
  expect(r.operations).toEqual([]);
});

test("on Windows the venv Python is in Scripts and `py -3` is the fallback", async () => {
  const r = rig({ platform: "win32", installed: ["py"] });
  const scripts = "C:\\Users\\Jo Doe\\AppData\\Local\\tercet\\kokoro\\.venv\\Scripts\\python.exe";
  expect(await r.run({ yes: true })).toBe(0);
  expect(r.commands).toEqual([
    ["py", "-3", "-m", "venv", "C:\\Users\\Jo Doe\\AppData\\Local\\tercet\\kokoro\\.venv"],
    [scripts, "-m", "pip", "install", ...KOKORO_PACKAGES],
  ]);
  expect(r.files.has(scripts)).toBe(true);
  expect(r.files.has("C:\\Users\\Jo Doe\\AppData\\Local\\tercet\\kokoro\\model.onnx")).toBe(true);
  const uv = rig({ platform: "win32" });
  await uv.run({ dryRun: true });
  expect(uv.lines.join("\n")).toContain("create the Python venv C:\\Users\\Jo Doe\\AppData\\Local\\tercet\\kokoro\\.venv with uv");
});

test("an existing file that differs from the release is refused without --force", async () => {
  const r = rig({ files: { "model.onnx": "somebody elses model", "voices.bin": "voices" }, installed: ["uv"] });
  expect(await r.run({ yes: true })).toBe(1);
  expect(r.errors.join("\n")).toContain("refusing to overwrite a file that differs from the release");
  expect(r.lines.join("\n")).toContain("REFUSED: model.onnx is there but is not the release's file");
  expect(r.commands).toEqual([]);
  expect(r.downloads).toEqual([]);
  expect(r.files.get(join(r.home, "model.onnx"))!.hash).toBe(sha("somebody elses model"));
  // Same size, different content is caught by the checksum.
  const same = rig({ files: { "model.onnx": "modeX", "voices.bin": "voices" } });
  expect(await same.run({ yes: true })).toBe(1);
  expect(same.downloads).toEqual([]);
  // --dry-run reports it too, with the same exit code.
  const dry = rig({ files: { "model.onnx": "modeX" } });
  expect(await dry.run({ dryRun: true })).toBe(1);
});

test("--force replaces the mismatched file through a temp name", async () => {
  const r = rig({ files: { "model.onnx": "old model!", "voices.bin": "voices" } });
  expect(await r.run({ yes: true, force: true })).toBe(0);
  expect(r.downloads).toEqual([`${BASE}/model.onnx`]);
  expect(r.files.get(join(r.home, "model.onnx"))!.hash).toBe(sha("model"));
  expect(r.operations).toContain(`rename ${join(r.home, ".model.onnx.part")} ${join(r.home, "model.onnx")}`);
});

test("a download that does not match the pinned hash is rejected and removed", async () => {
  const r = rig({ served: { "model.onnx": "MODEL", "voices.bin": "voices" } });
  expect(await r.run({ yes: true })).toBe(1);
  expect(r.errors.join("\n")).toContain("does not match the pinned size and SHA-256");
  expect(r.files.has(join(r.home, "model.onnx"))).toBe(false);
  expect([...r.files.keys()].some((key) => key.endsWith(".part"))).toBe(false);
  expect(r.downloads).toEqual([`${BASE}/model.onnx`]);
});

test("a failed download leaves no half file, and the venv this run made is removed", async () => {
  const r = rig({ failDownload: true });
  expect(await r.run({ yes: true })).toBe(1);
  expect(r.errors.join("\n")).toContain("connection reset");
  expect([...r.files.keys()].some((key) => key.endsWith(".part"))).toBe(false);
  expect(r.operations).toContain(`remove ${venv(r.home)}`);
  expect(r.files.has(python(r.home))).toBe(false);
});

test("Ctrl+C is reported as 130 and cleans up", async () => {
  const r = rig();
  const controller = new AbortController();
  r.deps.download = async (url, dest) => {
    r.put(dest, "mod");
    controller.abort(new Error("interrupted"));
    throw new Error("The operation was aborted");
  };
  expect(await r.run({ yes: true }, controller.signal)).toBe(130);
  expect(r.errors.join("\n")).toContain("interrupted; partial files were removed");
  expect([...r.files.keys()].some((key) => key.endsWith(".part"))).toBe(false);
});

test("everything present and importable is a no-op that never prompts", async () => {
  const r = rig({ files: { "model.onnx": "model", "voices.bin": "voices", ".venv/bin/python": "python" }, importsOk: true });
  r.put(python(r.home), "python");
  expect(await r.run()).toBe(0);
  expect(r.lines).toEqual([`Read aloud is already set up at ${r.home}. Nothing to do.`]);
  expect(r.prompts).toEqual([]);
  expect(r.commands).toEqual([]);
  expect(r.downloads).toEqual([]);
  expect(r.operations).toEqual([]);
});

test("an existing venv is never recreated or deleted (a home shared with another program)", async () => {
  // Models missing, venv fine: only the downloads happen.
  const ok = rig({ importsOk: true });
  ok.put(python(ok.home), "python");
  expect(await ok.run({ yes: true })).toBe(0);
  expect(ok.commands).toEqual([]);
  expect(ok.downloads).toHaveLength(2);
  expect(ok.lines.join("\n")).toContain("keep the existing venv");
  // Packages missing: installed into it, still no venv command.
  const missing = rig({ files: { "model.onnx": "model", "voices.bin": "voices" } });
  missing.put(python(missing.home), "python");
  expect(await missing.run({ yes: true })).toBe(0);
  expect(missing.commands).toEqual([["uv", "pip", "install", "--python", python(missing.home), ...KOKORO_PACKAGES]]);
  // The install fails: the existing venv stays.
  const broken = rig({ files: { "model.onnx": "model", "voices.bin": "voices" }, failInstall: true });
  broken.put(python(broken.home), "python");
  expect(await broken.run({ yes: true })).toBe(1);
  expect(broken.operations.filter((op) => op.startsWith("remove"))).toEqual([]);
  expect(broken.files.has(python(broken.home))).toBe(true);
  // A .venv directory with no Python in it is reported, not replaced.
  const hollow = rig();
  hollow.put(join(venv(hollow.home), "pyvenv.cfg"), "x");
  expect(await hollow.run({ yes: true })).toBe(1);
  expect(hollow.errors.join("\n")).toContain("never deletes a venv it did not create");
  expect(hollow.commands).toEqual([]);
});

test("KOKORO_PYTHON is used as is and never installed into", async () => {
  const missing = rig({ env: { KOKORO_PYTHON: "/opt/py/bin/python" } });
  expect(await missing.run({ yes: true })).toBe(1);
  expect(missing.errors.join("\n")).toContain("KOKORO_PYTHON points at /opt/py/bin/python, which does not exist");
  const noPackages = rig({ env: { KOKORO_PYTHON: "/opt/py/bin/python" } });
  noPackages.put("/opt/py/bin/python", "python");
  expect(await noPackages.run({ yes: true })).toBe(1);
  expect(noPackages.errors.join("\n")).toContain("cannot import kokoro_onnx and numpy");
  const fine = rig({ env: { KOKORO_PYTHON: "/opt/py/bin/python" }, importsOk: true });
  fine.put("/opt/py/bin/python", "python");
  expect(await fine.run({ yes: true })).toBe(0);
  expect(fine.commands).toEqual([]);
  expect(fine.downloads).toHaveLength(2);
});

test("a --home that tercet does not read yet earns a note", async () => {
  const r = rig();
  expect(await r.run({ yes: true, usualHome: "/elsewhere" })).toBe(0);
  expect(r.lines.at(-1)).toContain("tercet reads /elsewhere right now");
  expect(r.lines.at(-1)).toContain("readback.home");
});

test("real file system and HTTP: download, verify, rename, then a second run does nothing", async () => {
  const body = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(BODY[new URL(req.url).pathname.slice(1)] ?? "", { status: BODY[new URL(req.url).pathname.slice(1)] ? 200 : 404 }) });
  const dir = mkdtempSync(join(tmpdir(), "tercet-setup-"));
  const lines: string[] = [];
  try {
    const home = join(dir, "kokoro home");
    const deps = systemDeps({
      files: FILES,
      baseUrl: `http://127.0.0.1:${body.port}`,
      env: {},
      which: () => "fake",
      log: (line) => void lines.push(line),
      error: (line) => void lines.push(line),
      // No pip here: pretend the venv commands worked and made a Python.
      run: async (command, _signal, quiet) => {
        if (quiet) return existsSync(python(home)) ? 0 : 1;
        if (command.includes("venv")) {
          await Bun.write(python(home), "python");
        }
        return 0;
      },
    });
    const options: SetupOptions = { home, usualHome: home, yes: true, dryRun: false, force: false };
    expect(await runSetup(options, deps, new AbortController().signal)).toBe(0);
    expect(readdirSync(home).sort()).toEqual([".venv", "model.onnx", "voices.bin"]);
    expect(await Bun.file(join(home, "model.onnx")).text()).toBe("model");
    lines.length = 0;
    expect(await runSetup(options, deps, new AbortController().signal)).toBe(0);
    expect(lines).toEqual([`Read aloud is already set up at ${home}. Nothing to do.`]);
  } finally {
    body.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated or failed real download leaves no part file", async () => {
  const short = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("mod") });
  const missing = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 404 }) });
  const dir = mkdtempSync(join(tmpdir(), "tercet-setup-"));
  try {
    for (const server of [short, missing]) {
      const home = join(dir, String(server.port));
      const deps = systemDeps({
        files: FILES,
        baseUrl: `http://127.0.0.1:${server.port}`,
        env: { KOKORO_PYTHON: join(dir, "py") },
        log: () => {},
        error: () => {},
        run: async () => 0,
      });
      await Bun.write(join(dir, "py"), "python");
      const code = await runSetup({ home, usualHome: home, yes: true, dryRun: false, force: false }, deps, new AbortController().signal);
      expect(code).toBe(1);
      expect(readdirSync(home)).toEqual([]);
    }
    await expect(downloadTo(`http://127.0.0.1:${short.port}/x`, join(dir, "x.part"), AbortSignal.abort())).rejects.toThrow();
  } finally {
    short.stop(true);
    missing.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `runReadback` with a throwaway config dir so the developer's real settings are never read. */
function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const config = mkdtempSync(join(tmpdir(), "tercet-config-"));
  const out: string[] = [];
  const err: string[] = [];
  const deps = systemDeps({ env: { XDG_CONFIG_HOME: config, ...env }, log: (line) => void out.push(line), error: (line) => void err.push(line) });
  return { done: runReadback(args, deps).finally(() => rmSync(config, { recursive: true, force: true })), out, err };
}

test("status lists what is missing and exits nonzero, then reports ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tercet-status-"));
  try {
    const none = cli(["status", "--home", dir]);
    expect(await none.done).toBe(1);
    expect(none.out.join("\n")).toContain("Read aloud is not set up. Missing: .venv, kokoro-v1.0.onnx, voices-v1.0.bin");
    expect(none.out.join("\n")).toContain(`home: ${dir}`);
    expect(none.out.join("\n")).toContain("Run `tercet readback setup`.");
    for (const file of ["kokoro-v1.0.onnx", "voices-v1.0.bin"]) await Bun.write(join(dir, file), "x");
    await Bun.write(python(dir), "python");
    const some = cli(["status", "--home", dir]);
    expect(await some.done).toBe(0);
    expect(some.out.join("\n")).toContain("Read aloud is ready.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup through the command: dry run on a home that does not exist creates nothing", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "tercet-dry-")), "kokoro");
  try {
    const dry = cli(["setup", "--dry-run", "--home", dir]);
    expect(await dry.done).toBe(0);
    expect(dry.out.join("\n")).toContain("Dry run: nothing was created");
    expect(existsSync(dir)).toBe(false);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("help, unknown commands and unknown options", async () => {
  const help = cli(["--help"]);
  expect(await help.done).toBe(0);
  expect(help.out.join("\n")).toContain("tercet readback setup");
  const bare = cli([]);
  expect(await bare.done).toBe(2);
  const unknown = cli(["speak"]);
  expect(await unknown.done).toBe(2);
  expect(unknown.err.join("\n")).toContain("unknown command speak");
  const flag = cli(["setup", "--nope"]);
  expect(await flag.done).toBe(2);
  const homeless = cli(["status", "--home"]);
  expect(await homeless.done).toBe(2);
  const statusFlag = cli(["status", "--yes"]);
  expect(await statusFlag.done).toBe(2);
});

test("neither the setup module nor readback.ts names the private setup", async () => {
  for (const file of ["readback.ts", "readback-setup.ts"]) {
    const text = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
    expect(text).not.toMatch(/phone.?assist|\bhub\b/i);
  }
});
