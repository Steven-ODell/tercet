// Kokoro synthesis is independent of T3's dictation service. Never send T3 credentials here.
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { shellQuote } from "./actions";
import type { Host } from "./portable";
import type { Settings } from "./client/settings";

/** Preserve spoken content while removing common Markdown decoration and link destinations. */
export function spokenText(text: string) {
  return text
    .replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trim();
}

// One resident Python worker per tercet, using kokoro-onnx from the Kokoro home's venv. It reads one
// JSON request per stdin line and answers each with one JSON header line, then that many WAV bytes:
//   {"ok": true, "bytes": N}\n<N bytes>      or      {"ok": false, "error": "..."}\n
// No HTTP service or credentials. The voice prefix picks the language. Stray prints go to stderr.
const LOCAL_SYNTHESIS = String.raw`
import io, json, sys, wave
from pathlib import Path
import numpy as np
from kokoro_onnx import Kokoro
out = sys.stdout.buffer
sys.stdout = sys.stderr
home = Path(sys.argv[1])
model = Kokoro(str(home / "kokoro-v1.0.onnx"), str(home / "voices-v1.0.bin"))
for line in sys.stdin.buffer:
    try:
        req = json.loads(line)
        samples, rate = model.create(req["text"], voice=req["voice"], speed=float(req["speed"]), lang={"a":"en-us", "b":"en-gb"}.get(req["voice"][:1], "en-us"))
        pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(int(rate))
            wav.writeframes(pcm)
        data = audio.getvalue()
        head = {"ok": True, "bytes": len(data)}
    except Exception as e:
        data, head = b"", {"ok": False, "error": (type(e).__name__ + ": " + str(e))[:300]}
    out.write(json.dumps(head).encode() + b"\n" + data)
    out.flush()
`;
export const KOKORO_MODEL_FILE = "kokoro-v1.0.onnx";
export const KOKORO_VOICES_FILE = "voices-v1.0.bin";

/**
 * Where the Kokoro model files and venv live: `KOKORO_HOME`, then `readback.home` (already
 * expanded by the settings parser), then tercet's own data directory for the platform.
 */
export function readbackHome(
  env: NodeJS.ProcessEnv = process.env,
  settingsHome = "",
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
) {
  if (env.KOKORO_HOME) return env.KOKORO_HOME;
  if (settingsHome) return settingsHome;
  if (platform === "win32")
    return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "tercet", "kokoro");
  if (platform === "darwin") return join(home, "Library", "Application Support", "tercet", "kokoro");
  // A relative XDG_DATA_HOME is ignored (XDG spec).
  const data = env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : join(home, ".local", "share");
  return join(data, "tercet", "kokoro");
}

export function venvPython(modelHome: string, platform: NodeJS.Platform) {
  return platform === "win32"
    ? win32.join(modelHome, ".venv", "Scripts", "python.exe")
    : join(modelHome, ".venv", "bin", "python");
}

export function localReadbackCommand(
  env: NodeJS.ProcessEnv = process.env,
  settingsHome = "",
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
) {
  const modelHome = readbackHome(env, settingsHome, platform, home);
  const python = env.KOKORO_PYTHON || venvPython(modelHome, platform);
  return { python, args: ["-c", LOCAL_SYNTHESIS, modelHome] };
}

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

/** What a Read click and `tercet doctor` say while local read aloud has not been set up. */
export const READBACK_NOT_SET_UP = "Read aloud is not set up. Run `tercet readback setup`.";

/** The pieces local Read aloud needs: the Python that runs Kokoro and the two model files. */
export function readbackPieces(
  env: NodeJS.ProcessEnv = process.env,
  settingsHome = "",
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
) {
  const modelHome = readbackHome(env, settingsHome, platform, home);
  const { python } = localReadbackCommand(env, settingsHome, platform, home);
  const pathJoin = platform === "win32" ? win32.join : join;
  return {
    home: modelHome,
    python,
    pieces: [
      { label: env.KOKORO_PYTHON ? python : ".venv", path: python },
      ...[KOKORO_MODEL_FILE, KOKORO_VOICES_FILE].map((name) => ({ label: name, path: pathJoin(modelHome, name) })),
    ],
  };
}

/**
 * Whether local Read aloud can run: the venv Python and both model files exist. `has` is how a
 * path is checked (a real file by default); doctor passes answers it gathered through its probes.
 */
export function readbackStatus(
  env: NodeJS.ProcessEnv = process.env,
  settingsHome = "",
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  has: (path: string) => boolean = isFile,
) {
  const { home: modelHome, python, pieces } = readbackPieces(env, settingsHome, platform, home);
  const missing = pieces.filter((piece) => !has(piece.path)).map((piece) => piece.label);
  return { ready: missing.length === 0, home: modelHome, python, missing };
}

const MAX_AUDIO = 64 * 1024 * 1024;
const WORKER_IDLE = 2 * 60_000;
const CANNOT_START = "Cannot start local Kokoro Python. Run `tercet readback setup`, or check KOKORO_HOME, readback.home and KOKORO_PYTHON.";
const GENERATION_FAILED = "Local Kokoro generation failed. Run `tercet readback setup` to repair the install, and check readback.voice.";

type LocalCommand = ReturnType<typeof localReadbackCommand>;
interface LiveWorker {
  child: ChildProcess;
  key: string;
  buffer: Buffer;
  bytes?: number; // Set once a header arrived and that many audio bytes are awaited.
  dead: boolean;
  pending?: { resolve: (audio: Uint8Array) => void; reject: (error: Error) => void };
}

/**
 * One resident Kokoro process, so a piece costs synthesis only, not a model load. Started on the first
 * request, shared by every piece and Read (one at a time), killed after `idleMs` quiet, on process exit,
 * and whenever a piece is abandoned (Stop, new Read, timeout) so stale synthesis cannot delay the next
 * Read; it is then started again in the background. A crash fails the pending piece and the next request
 * starts a new one. The idle timer is unref'd and the process is only ref'd while a piece is made.
 */
export function createLocalWorker(options: { spawnProcess?: typeof spawn; idleMs?: number } = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const idleMs = options.idleMs ?? WORKER_IDLE;
  let current: LiveWorker | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let exitHook = false;

  const hold = (live: LiveWorker, on: boolean) => {
    for (const handle of [live.child, live.child.stdin, live.child.stdout] as any[]) handle?.[on ? "ref" : "unref"]?.();
  };
  const stopIdle = () => { clearTimeout(idle); idle = undefined; };
  const armIdle = () => {
    stopIdle();
    idle = setTimeout(() => { if (current) kill(current); }, idleMs);
    idle.unref?.();
  };
  const kill = (live: LiveWorker) => {
    live.dead = true;
    if (current === live) current = undefined;
    live.pending = undefined;
    live.child.kill();
  };
  const fail = (live: LiveWorker, error: Error) => {
    live.dead = true;
    if (current === live) current = undefined;
    const pending = live.pending;
    live.pending = undefined;
    pending?.reject(error);
  };
  const consume = (live: LiveWorker) => {
    while (!live.dead) {
      if (live.bytes === undefined) {
        const end = live.buffer.indexOf(10);
        if (end < 0) { if (live.buffer.length > 65_536) { fail(live, new Error(GENERATION_FAILED)); live.child.kill(); } return; }
        let head: any;
        try { head = JSON.parse(live.buffer.toString("utf8", 0, end)); } catch { head = undefined; }
        live.buffer = live.buffer.subarray(end + 1);
        const pending = live.pending;
        if (!pending || !head) { fail(live, new Error(GENERATION_FAILED)); live.child.kill(); return; }
        if (!head.ok) { live.pending = undefined; pending.reject(new Error(GENERATION_FAILED)); continue; }
        if (!Number.isSafeInteger(head.bytes) || head.bytes < 0) { fail(live, new Error(GENERATION_FAILED)); live.child.kill(); return; }
        if (head.bytes > MAX_AUDIO) { fail(live, new Error("Kokoro audio exceeds the 64 MB limit.")); live.child.kill(); return; }
        live.bytes = head.bytes;
      }
      const size = live.bytes as number;
      if (live.buffer.length < size) return;
      const audio = live.buffer.subarray(0, size);
      live.buffer = live.buffer.subarray(size);
      live.bytes = undefined;
      const pending = live.pending;
      live.pending = undefined;
      if (!pending) continue;
      if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") pending.reject(new Error("Local Kokoro returned invalid WAV audio."));
      else pending.resolve(Buffer.from(audio));
    }
  };
  const start = (command: LocalCommand): LiveWorker => {
    const child = spawnProcess(command.python, command.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const live: LiveWorker = { child, key: JSON.stringify([command.python, command.args.at(-1)]), buffer: Buffer.alloc(0), dead: false };
    child.once("error", () => fail(live, new Error(CANNOT_START)));
    child.once("close", () => fail(live, new Error(GENERATION_FAILED)));
    child.stdin!.on("error", () => {}); // An early exit is reported through close.
    child.stdout!.on("data", (part: Buffer) => {
      if (live.dead) return;
      live.buffer = Buffer.concat([live.buffer, part]);
      consume(live);
    });
    current = live;
    hold(live, false);
    if (!exitHook) { exitHook = true; process.once("exit", () => { if (current) kill(current); }); }
    return live;
  };
  const ensure = (command: LocalCommand) => {
    const key = JSON.stringify([command.python, command.args.at(-1)]);
    if (current && !current.dead && current.key === key && current.child.exitCode === null) return current;
    if (current) kill(current);
    return start(command);
  };

  const run = async (command: LocalCommand, payload: object, signal: AbortSignal) => {
    signal.throwIfAborted();
    stopIdle();
    let live: LiveWorker;
    try { live = ensure(command); } catch { armIdle(); throw new Error(CANNOT_START); }
    hold(live, true);
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        const abort = () => {
          kill(live);
          reject(signal.reason);
          try { hold(ensure(command), false); } catch { /* the next request reports it */ }
        };
        signal.addEventListener("abort", abort, { once: true });
        live.pending = {
          resolve: (audio) => { signal.removeEventListener("abort", abort); resolve(audio); },
          reject: (error) => { signal.removeEventListener("abort", abort); reject(error); },
        };
        live.child.stdin!.write(JSON.stringify(payload) + "\n");
      });
    } finally {
      if (current === live) hold(live, false);
      if (current) armIdle();
    }
  };

  return {
    request(command: LocalCommand, payload: object, signal: AbortSignal) {
      const result = queue.then(() => run(command, payload, signal));
      queue = result.catch(() => {});
      return result;
    },
    /** Kills the resident process, if any. */
    close() { stopIdle(); if (current) kill(current); },
    get running() { return !!current && !current.dead; },
  };
}

const sharedWorker = createLocalWorker();

/**
 * Checked on every Read, not once at startup, so a `tercet readback setup` run in another terminal
 * works without restarting tercet. Nothing is spawned until it passes.
 */
export async function synthesizeLocalReadback(text: string, settings: Settings["readback"], signal: AbortSignal, env: NodeJS.ProcessEnv = process.env, worker = sharedWorker) {
  const input = spokenText(text);
  if (!input) throw new Error("No text to read.");
  if (input.length > 30_000) throw new Error("Response is too long to read (30,000 character limit).");
  signal.throwIfAborted();
  if (!readbackStatus(env, settings.home).ready) throw new Error(READBACK_NOT_SET_UP);
  return worker.request(localReadbackCommand(env, settings.home), { text: input, voice: settings.voice, speed: settings.speed }, signal);
}

export async function synthesizeReadback(
  text: string,
  settings: Settings["readback"],
  signal: AbortSignal,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const input = spokenText(text);
  if (!input) throw new Error("No text to read.");
  if (input.length > 30_000) throw new Error("Response is too long to read (30,000 character limit).");
  let response: Response;
  try {
    response = await request(settings.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kokoro", input, voice: settings.voice,
        speed: settings.speed, response_format: "wav", stream: false }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Cannot reach Kokoro. Start Kokoro-FastAPI or check readback.endpoint in settings.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Kokoro returned HTTP ${response.status}; check the service and readback.voice.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Kokoro returned no audio.");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_AUDIO) throw new Error("Kokoro audio exceeds the 64 MB limit.");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const audio = Buffer.concat(parts);
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Kokoro returned invalid WAV audio.");
  return audio;
}

/** Spawn an audio-only player; never use an opener that could launch a window. */
export async function playReadback(audio: Uint8Array, signal: AbortSignal, host: Host) {
  const choice = [
    ["mpv", "--no-video", "--no-terminal", "--really-quiet"],
    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error"],
    ["afplay"],
  ].find(([name]) => host.which(name!));
  if (!choice) throw new Error("Readback needs mpv, ffplay or afplay installed on this device.");
  const dir = await mkdtemp(join(tmpdir(), "tercet-readback-"));
  try {
    const path = join(dir, "speech.wav");
    await writeFile(path, audio, { mode: 0o600 });
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(host.which(choice[0]!)!, [...choice.slice(1), path], {
        stdio: "ignore", env: host.env, windowsHide: true, signal,
      });
      let failure: Error | undefined;
      child.once("error", (error) => { failure = error; });
      child.once("close", (code) => failure ? reject(failure) : code === 0 ? resolve() : reject(new Error("Audio playback failed.")));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Plays the WAV on the machine you type from, for a tercet running over SSH. It runs on that machine
 * (non-interactive ssh has no XDG_RUNTIME_DIR, which PipeWire and PulseAudio sockets live under):
 * the first `head -c N` bytes of stdin are the audio, and the rest of stdin is a leash. Tercet keeps
 * it open while playing, so closing it (Stop, Esc, a dropped connection) EOFs the watcher, which
 * kills the player.
 */
export const REMOTE_PLAYER = `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
d=$(mktemp -d) || exit 1
trap 'rm -rf "$d"' EXIT
head -c "$1" > "$d/speech.wav" || exit 1
if command -v mpv >/dev/null 2>&1; then set -- mpv --no-video --no-terminal --really-quiet
elif command -v ffplay >/dev/null 2>&1; then set -- ffplay -nodisp -autoexit -loglevel error
elif command -v afplay >/dev/null 2>&1; then set -- afplay
elif command -v paplay >/dev/null 2>&1; then set -- paplay
else echo "no audio player (mpv, ffplay, afplay or paplay) on $(uname -n)" >&2; exit 127; fi
"$@" "$d/speech.wav" </dev/null >/dev/null 2>&1 &
p=$!
exec 3<&0 # background jobs in a non-interactive sh get /dev/null for stdin
{ cat <&3 >/dev/null 2>&1; kill "$p" 2>/dev/null; } &
w=$!
wait "$p"; rc=$?
kill "$w" 2>/dev/null
exit "$rc"`;

/** Plays through the speakers of `via`, the machine the user types from, over ssh. */
export async function playReadbackVia(audio: Uint8Array, signal: AbortSignal, host: Host, via: string) {
  const ssh = host.which("ssh");
  if (!ssh) throw new Error("Playing on the machine you type from needs ssh installed here.");
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ssh,
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", via, `sh -c ${shellQuote(REMOTE_PLAYER)} sh ${audio.length}`],
      { stdio: ["pipe", "ignore", "pipe"], env: host.env, windowsHide: true, signal },
    );
    let failure: Error | undefined;
    let said = "";
    child.once("error", (error) => { failure = error; });
    child.stderr.on("data", (part: Buffer) => { said = (said + part).slice(-300); });
    child.stdin.on("error", () => {}); // The remote end can exit first; close reports why.
    child.stdin.write(audio); // Left open on purpose: see REMOTE_PLAYER.
    child.once("close", (code) => {
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(said.trim() ? `Playback on ${via} failed: ${said.trim()}` : `Playback on ${via} failed (ssh exited ${code}).`));
    });
  });
}

/**
 * Splits speech at sentence ends so playback can start after the first piece is made instead of
 * after the whole reply. The first piece is small (about `first` characters) to start sooner; later
 * ones are bigger because every piece costs a player launch. Never splits inside a sentence (a single
 * long sentence stays whole) and never packs across a paragraph break (a blank line).
 */
export function speechChunks(text: string, first = 120, rest = 400) {
  const chunks: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    let buffer = "";
    for (const sentence of paragraph.split(/(?<=[.!?])\s+|\n+/)) {
      if (!sentence.trim()) continue;
      const budget = chunks.length ? rest : first;
      if (buffer && buffer.length + 1 + sentence.length > budget) { chunks.push(buffer); buffer = sentence; }
      else buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
    if (buffer) chunks.push(buffer);
  }
  return chunks;
}

const SYNTHESIS_TIMEOUT = 2 * 60_000;
/**
 * One active response at a time, including synthesis. A new Read cancels the old one.
 * Long text is spoken piece by piece: the next piece is made while the current one plays.
 */
export function createReadback(
  settings: Settings["readback"],
  synthesize: (text: string, settings: Settings["readback"], signal: AbortSignal) => Promise<Uint8Array> = (text, settings, signal) => settings.engine === "http" ? synthesizeReadback(text, settings, signal) : synthesizeLocalReadback(text, settings, signal),
  play: (audio: Uint8Array, signal: AbortSignal) => Promise<void>,
) {
  let active: AbortController | undefined;
  return {
    stopReadback() { active?.abort(); active = undefined; },
    async readback(text: string, onPhase?: (phase: "preparing" | "speaking") => void) {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const spoken = spokenText(text);
      if (spoken.length > 30_000) throw new Error("Response is too long to read (30,000 character limit).");
      const pieces = speechChunks(spoken);
      if (!pieces.length) pieces.push(text); // Let synthesis report "No text to read."
      let timedOut = false;
      const make = (piece: string) => {
        const limit = new AbortController();
        const timer = setTimeout(() => { timedOut = true; limit.abort(); }, SYNTHESIS_TIMEOUT);
        const made = synthesize(piece, settings, AbortSignal.any([controller.signal, limit.signal])).finally(() => clearTimeout(timer));
        made.catch(() => {}); // A piece abandoned by Stop must not become an unhandled rejection.
        return made;
      };
      try {
        onPhase?.("preparing");
        let next = make(pieces[0]!);
        for (let i = 0; i < pieces.length; i++) {
          let ready = false;
          void next.then(() => { ready = true; }, () => {});
          if (i > 0) await Promise.resolve(); // Let a piece that is already done say so.
          if (!ready) onPhase?.("preparing");
          const audio = await next;
          controller.signal.throwIfAborted();
          if (i + 1 < pieces.length) next = make(pieces[i + 1]!);
          onPhase?.("speaking");
          await play(audio, controller.signal);
          controller.signal.throwIfAborted();
        }
      } catch (error) {
        if (timedOut && !controller.signal.aborted) throw new Error("Readback timed out; retry.");
        if (!controller.signal.aborted) throw error;
      } finally {
        controller.abort(); // Cancels a piece still being made after a failure.
        if (active === controller) active = undefined;
      }
    },
  };
}
