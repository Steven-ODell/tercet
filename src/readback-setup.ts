import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { createInterface } from "node:readline";
import { SettingsError, loadSettings, settingsDir } from "./client/settings";
import { readOptional } from "./client/platform";
import { KOKORO_MODEL_FILE, KOKORO_VOICES_FILE, readbackHome, readbackStatus, venvPython } from "./readback";

export interface ModelFile {
  name: string;
  bytes: number;
  sha256: string;
}

/** The kokoro-onnx GitHub release that holds the model files. */
export const KOKORO_RELEASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";

/**
 * Size and SHA-256 of the two files that release serves. GitHub publishes no digest for them, so
 * these come from downloading each once on 2026-11-14; a changed release fails the check below
 * instead of installing something unreviewed.
 */
export const KOKORO_FILES: readonly ModelFile[] = [
  { name: KOKORO_MODEL_FILE, bytes: 325_532_387, sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5" },
  { name: KOKORO_VOICES_FILE, bytes: 28_214_398, sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d" },
];

/** kokoro-onnx 0.6.1 asks for numpy>=2.0.2; the cap keeps a numpy 3 from arriving unreviewed. */
export const KOKORO_PACKAGES = ["kokoro-onnx==0.6.1", "numpy>=2.0.2,<3"] as const;

export const READBACK_USAGE = `Usage: tercet readback setup [--yes] [--dry-run] [--force] [--home DIR]
       tercet readback status [--home DIR]

setup makes read aloud work: it creates a Python venv in the Kokoro home, installs
kokoro-onnx and numpy there, and downloads the Kokoro model files (about 354 MB) from the
kokoro-onnx GitHub release after checking their SHA-256. It asks before doing anything and
never runs on its own. An existing venv is left alone, and a model file that differs from the
release is never replaced without --force.
  --yes       Do not ask first
  --dry-run   Print the plan and change nothing
  --force     Replace a model file that differs from the release
  --home DIR  Kokoro home (default: KOKORO_HOME, then readback.home, then tercet's data directory)

status prints ready, or what is missing, and exits 1 when read aloud is not ready.`;

export interface SetupDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  files: readonly ModelFile[];
  baseUrl: string;
  packages: readonly string[];
  which(program: string): string | null;
  /** Runs a command and returns its exit code; `quiet` hides its output. */
  run(command: string[], signal: AbortSignal, quiet?: boolean): Promise<number>;
  download(url: string, dest: string, signal: AbortSignal): Promise<void>;
  /** Size of the file at `path`, or undefined when there is no file. */
  size(path: string): number | undefined;
  /** True when something (file or directory) exists at `path`. */
  exists(path: string): boolean;
  sha256(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  prompt(question: string): Promise<string>;
  log(line: string): void;
  error(line: string): void;
}

export interface SetupOptions {
  home: string;
  /** Where tercet reads from when no --home is given; a different `home` earns a note. */
  usualHome: string;
  yes: boolean;
  dryRun: boolean;
  force: boolean;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** The setup, with every side effect behind `deps`. Returns the exit code. */
export async function runSetup(options: SetupOptions, deps: SetupDeps, signal: AbortSignal): Promise<number> {
  const win = deps.platform === "win32";
  const at = win ? win32.join : join;
  const { home } = options;
  const venvDir = at(home, ".venv");
  const ownVenv = !deps.env.KOKORO_PYTHON;
  const python = deps.env.KOKORO_PYTHON || venvPython(home, deps.platform);
  const fail = (message: string) => {
    deps.error(`tercet readback setup: ${message}`);
    return 1;
  };

  // What is there now. Nothing below changes anything until the prompt is answered.
  const todo: ModelFile[] = [];
  const refused: string[] = [];
  for (const file of deps.files) {
    const path = at(home, file.name);
    const size = deps.size(path);
    if (size === undefined) todo.push(file);
    else if (size !== file.bytes || (await deps.sha256(path)) !== file.sha256) {
      refused.push(`${file.name} is there but is not the release's file (${size} bytes here, ${file.bytes} in the release)`);
      if (options.force) todo.push(file);
    }
  }
  const pythonThere = deps.size(python) !== undefined;
  if (!ownVenv && !pythonThere) return fail(`KOKORO_PYTHON points at ${python}, which does not exist`);
  if (ownVenv && !pythonThere && deps.exists(venvDir))
    return fail(`${venvDir} exists but has no Python. Remove it and run setup again; tercet never deletes a venv it did not create.`);
  const packagesReady = pythonThere && (await deps.run([python, "-c", "import kokoro_onnx, numpy"], signal, true)) === 0;
  if (!ownVenv && !packagesReady)
    return fail(`KOKORO_PYTHON (${python}) cannot import kokoro_onnx and numpy. Install them there, or unset KOKORO_PYTHON.`);

  const uv = deps.which("uv");
  const system = win ? (deps.which("python") ? ["python"] : deps.which("py") ? ["py", "-3"] : null) : deps.which("python3") ? ["python3"] : deps.which("python") ? ["python"] : null;
  const createVenv = !pythonThere && ownVenv;
  const blocker = !uv && !system && (createVenv || (!packagesReady && ownVenv)) ? "setup needs uv or Python 3 on PATH; install one and run it again" : null;
  const toInstall = ownVenv && !packagesReady;
  const venvCommand = uv ? [uv, "venv", venvDir] : [...(system ?? []), "-m", "venv", venvDir];
  const installCommand = uv
    ? [uv, "pip", "install", "--python", python, ...deps.packages]
    : [python, "-m", "pip", "install", ...deps.packages];

  if (!createVenv && !toInstall && !todo.length && !refused.length) {
    deps.log(`Read aloud is already set up at ${home}. Nothing to do.`);
    return 0;
  }

  const plan: string[] = [`Read aloud setup, in ${home}`];
  if (createVenv) plan.push(`  create the Python venv ${venvDir} with ${uv ? "uv" : (system ?? ["python"]).join(" ") + " -m venv"}`);
  if (toInstall) plan.push(`  install ${deps.packages.join(" ")}${createVenv ? "" : ` into the existing venv ${venvDir}`}`);
  else if (pythonThere && ownVenv) plan.push(`  keep the existing venv ${venvDir} (kokoro-onnx and numpy already import)`);
  for (const file of todo) plan.push(`  download ${file.name} (${megabytes(file.bytes)}) from ${deps.baseUrl}/${file.name}`);
  const total = todo.reduce((sum, file) => sum + file.bytes, 0);
  if (total) plan.push(`  about ${megabytes(total)} of model files${toInstall ? ", plus the Python packages" : ""}`);
  for (const line of refused) plan.push(`  ${options.force ? "replace (--force)" : "REFUSED"}: ${line}`);
  for (const line of plan) deps.log(line);
  if (blocker) return fail(blocker);
  if (refused.length && !options.force) {
    deps.error("tercet readback setup: refusing to overwrite a file that differs from the release; run it with --force, or pick another --home. Nothing was changed.");
    return 1;
  }
  if (options.dryRun) {
    deps.log("Dry run: nothing was created, installed or downloaded.");
    return 0;
  }
  if (!options.yes) {
    const answer = (await deps.prompt("Continue? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      deps.log("Cancelled. Nothing was changed.");
      return 1;
    }
  }

  let createdVenv = false;
  const parts: string[] = [];
  try {
    await deps.mkdir(home);
    if (createVenv) {
      createdVenv = true;
      if ((await deps.run(venvCommand, signal)) !== 0) throw new Error(`could not create the venv with: ${venvCommand.join(" ")}`);
    }
    if (toInstall) {
      if ((await deps.run(installCommand, signal)) !== 0) throw new Error(`installing the Python packages failed (${installCommand.join(" ")})`);
      if ((await deps.run([python, "-c", "import kokoro_onnx, numpy"], signal, true)) !== 0)
        throw new Error("the Python packages installed but kokoro_onnx does not import");
    }
    for (const file of todo) {
      const part = at(home, `.${file.name}.part`);
      parts.push(part);
      deps.log(`Downloading ${file.name}...`);
      await deps.download(`${deps.baseUrl}/${file.name}`, part, signal);
      if (deps.size(part) !== file.bytes || (await deps.sha256(part)) !== file.sha256)
        throw new Error(`the downloaded ${file.name} does not match the pinned size and SHA-256 (the release may have changed); nothing was kept`);
      await deps.rename(part, at(home, file.name));
    }
  } catch (error) {
    // Ctrl+C and failures alike: no half files, and a venv only if this run made it.
    for (const part of parts) await deps.remove(part).catch(() => {});
    if (createdVenv) await deps.remove(venvDir).catch(() => {});
    if (signal.aborted) {
      deps.error("tercet readback setup: interrupted; partial files were removed.");
      return 130;
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
  deps.log(`Read aloud is set up in ${home}.`);
  if (home !== options.usualHome)
    deps.log(`tercet reads ${options.usualHome} right now. To use ${home}, set readback.home to it or export KOKORO_HOME.`);
  return 0;
}

const isFile = (path: string) => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
};

export function systemDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    platform: process.platform,
    env: process.env,
    files: KOKORO_FILES,
    baseUrl: KOKORO_RELEASE_URL,
    packages: KOKORO_PACKAGES,
    which: (program) => Bun.which(program),
    run: (command, signal, quiet) =>
      new Promise((resolve) => {
        const child = spawn(command[0]!, command.slice(1), { stdio: quiet ? "ignore" : "inherit", windowsHide: true, signal });
        child.once("error", (error) => resolve((error as NodeJS.ErrnoException).code === "ABORT_ERR" ? 130 : 127));
        child.once("close", (code) => resolve(code ?? 1));
      }),
    download: downloadTo,
    size: isFile,
    exists: (path) => {
      try {
        statSync(path);
        return true;
      } catch {
        return false;
      }
    },
    sha256: (path) =>
      new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(path).on("data", (chunk) => hash.update(chunk)).once("error", reject).once("end", () => resolve(hash.digest("hex")));
      }),
    mkdir: async (path) => void (await mkdir(path, { recursive: true })),
    rename,
    remove: (path) => rm(path, { recursive: true, force: true }),
    prompt: (question) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let answered = false;
        rl.question(question, (answer) => {
          answered = true;
          rl.close();
          resolve(answer);
        });
        rl.once("close", () => answered || resolve(""));
      }),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    ...overrides,
  };
}

/** Streams `url` to `dest` (a temp name the caller cleans up). A generic client name only. */
export async function downloadTo(url: string, dest: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "tercet-readback-setup" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
  });
  if (!response.ok || !response.body) throw new Error(`download answered ${response.status} for ${url}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const file = await open(dest, "w");
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      await file.write(chunk);
      received += chunk.length;
      const step = total && process.stdout.isTTY ? Math.floor((received / total) * 20) * 5 : -1;
      if (step > shown) {
        shown = step;
        process.stdout.write(`\r  ${step}%`);
      }
    }
  } finally {
    await file.close();
    if (shown >= 0) process.stdout.write("\r      \r");
  }
}

function parseFlags(args: string[]) {
  const bools = new Set<string>();
  let home: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["--yes", "-y", "--dry-run", "--force"].includes(arg)) bools.add(arg === "-y" ? "--yes" : arg);
    else if (arg === "--home" || arg.startsWith("--home=")) {
      const value = arg === "--home" ? args[++i] : arg.slice("--home=".length);
      if (!value || value.startsWith("--")) throw new Error("missing value for --home");
      home = value;
    } else throw new Error(`unknown option ${arg}; see tercet readback --help`);
  }
  return { bools, home };
}

/** `tercet readback setup|status`. */
export async function runReadback(args: string[], deps: SetupDeps = systemDeps()): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    deps.log(READBACK_USAGE);
    return sub || rest.length ? 0 : 2;
  }
  if (sub !== "setup" && sub !== "status") {
    deps.error(`tercet readback: unknown command ${sub}; see tercet readback --help`);
    return 2;
  }
  let flags: ReturnType<typeof parseFlags>;
  try {
    flags = parseFlags(rest);
    if (sub === "status" && [...flags.bools].length) throw new Error(`unknown option ${[...flags.bools][0]}; see tercet readback --help`);
  } catch (error) {
    deps.error(`tercet readback ${sub}: ${(error as Error).message}`);
    return 2;
  }
  const user = homedir();
  let settingsHome = "";
  let engine = "local";
  try {
    const { settings } = await loadSettings(settingsDir(deps.env, user), readOptional, user);
    settingsHome = settings.readback.home;
    engine = settings.readback.engine;
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    deps.error(`tercet readback ${sub}: ${error.message}`);
    return 1;
  }
  const usualHome = readbackHome(deps.env, settingsHome, deps.platform, user);
  const home = flags.home ?? usualHome;
  if (sub === "status") {
    // `--home` stands in for KOKORO_HOME, so the check sees exactly what Read would see there.
    const env = flags.home ? { ...deps.env, KOKORO_HOME: flags.home } : deps.env;
    const status = readbackStatus(env, settingsHome, deps.platform, user);
    if (status.ready) {
      deps.log(`Read aloud is ready.\n  home: ${status.home}\n  python: ${status.python}`);
      if (engine === "http") deps.log("  readback.engine is http, so Read uses readback.endpoint, not this setup.");
      return 0;
    }
    deps.log(`Read aloud is not set up. Missing: ${status.missing.join(", ")}\n  home: ${status.home}\nRun \`tercet readback setup\`.`);
    return 1;
  }
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new Error("interrupted"));
  process.once("SIGINT", onInterrupt);
  try {
    return await runSetup(
      { home, usualHome, yes: flags.bools.has("--yes"), dryRun: flags.bools.has("--dry-run"), force: flags.bools.has("--force") },
      deps,
      controller.signal,
    );
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}
