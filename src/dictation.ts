// Local audio capture for built-in dictation. A small recorder program (pw-record, parecord,
// arecord, ffmpeg or sox) writes raw 16 kHz mono 32-bit float PCM to its stdout, which is exactly
// what T3's `/api/voice/transcribe` takes. Audio stays in memory: there is no temporary file, so
// the only resource to clean up is the recorder process.
import { spawn, type ChildProcess } from "node:child_process";
import type { Recording } from "./actions";
import type { Host } from "./portable";

export const SAMPLE_RATE = 16_000;
/** T3 rejects more than five minutes of audio, so capture stops there. */
export const MAX_RECORDING_BYTES = SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * 5 * 60;

export interface RecorderTool {
  name: string;
  /** The program that must be installed. */
  program: string;
  platforms: readonly string[];
  args: readonly string[];
}

const RAW = ["--rate=16000", "--channels=1"];
/**
 * In preference order for the platform. Linux wants the sound server's own tool first
 * (pw-record, parecord), then ALSA, then ffmpeg and sox, which are common on macOS too.
 */
export const RECORDER_TOOLS: readonly RecorderTool[] = [
  {
    name: "pw-record",
    program: "pw-record",
    platforms: ["linux"],
    args: ["pw-record", "--rate", "16000", "--channels", "1", "--format", "f32", "--raw", "-"],
  },
  {
    name: "parecord",
    program: "parecord",
    platforms: ["linux"],
    args: ["parecord", ...RAW, "--format=float32le", "--raw", "--latency-msec=100"],
  },
  {
    name: "arecord",
    program: "arecord",
    platforms: ["linux"],
    args: ["arecord", "-q", "-t", "raw", "-f", "FLOAT_LE", "-r", "16000", "-c", "1"],
  },
  {
    name: "ffmpeg (pulse)",
    program: "ffmpeg",
    platforms: ["linux"],
    args: [
      ...["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"],
      ...["-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
    ],
  },
  {
    name: "ffmpeg (avfoundation)",
    program: "ffmpeg",
    platforms: ["darwin"],
    args: [
      ...["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"],
      ...["-f", "avfoundation", "-i", ":default", "-ac", "1", "-ar", "16000", "-f", "f32le"],
      "pipe:1",
    ],
  },
  {
    name: "sox",
    program: "rec",
    platforms: ["linux", "darwin"],
    args: [
      "rec",
      "-q",
      "-r",
      "16000",
      "-c",
      "1",
      "-b",
      "32",
      "-e",
      "floating-point",
      "-t",
      "raw",
      "-",
    ],
  },
];

/** What dictation can record with on this machine, and why not when it cannot. */
export type RecorderStatus =
  { ready: true; name: string; args: string[]; custom: boolean } | { ready: false; reason: string };

/** An SSH session has no microphone of the user's: the one here would be the server's. */
export const isRemoteSession = (env: Host["env"]) =>
  !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);

export const NO_RECORDER =
  "no recorder found; install pipewire-tools (pw-record), pulseaudio-utils (parecord), alsa-utils (arecord), ffmpeg or sox";

/**
 * The recorder to use: the settings one when set (even over SSH, since it was chosen on purpose),
 * else the first installed tool for this platform, and never over SSH.
 */
export function recorderStatus(host: Host, custom: readonly string[] | undefined): RecorderStatus {
  if (custom?.length) {
    return host.which(custom[0]!)
      ? { ready: true, name: custom[0]!, args: [...custom], custom: true }
      : { ready: false, reason: `dictation.recorder: ${custom[0]} is not installed` };
  }
  if (isRemoteSession(host.env))
    return {
      ready: false,
      reason:
        "this is an SSH session, which does not forward your microphone; set commands.dictation or dictation.recorder to choose one",
    };
  const tool = RECORDER_TOOLS.find(
    (candidate) => candidate.platforms.includes(host.platform) && host.which(candidate.program),
  );
  if (!tool) {
    return host.platform === "linux" || host.platform === "darwin"
      ? { ready: false, reason: NO_RECORDER }
      : { ready: false, reason: "built-in dictation supports Linux and macOS" };
  }
  return { ready: true, name: tool.name, args: [...tool.args], custom: false };
}

/** Recorders that are still running, so a crash or quit cannot leave one holding the microphone. */
const live = new Set<ChildProcess>();
let exitHook = false;
function track(child: ChildProcess) {
  live.add(child);
  child.once("close", () => live.delete(child));
  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => {
      for (const running of live) running.kill("SIGKILL");
    });
  }
}

/** Samples must be finite and within [-1, 1] or the server refuses the whole recording. */
export function sanitizePcm(bytes: Uint8Array): Uint8Array {
  const whole = bytes.length - (bytes.length % Float32Array.BYTES_PER_ELEMENT);
  const samples = new Float32Array(whole / Float32Array.BYTES_PER_ELEMENT);
  new Uint8Array(samples.buffer).set(bytes.subarray(0, whole));
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    samples[i] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  }
  return new Uint8Array(samples.buffer);
}

export interface StartOptions {
  /** The recorder is told to stop this long after SIGINT before it is killed. */
  stopGraceMs?: number;
  /** A recorder that exits within this time failed to start (no device, bad flags). */
  startGraceMs?: number;
  onLimit?: () => void;
  /** The recorder exited after starting without being asked to (unplugged device, crash). */
  onFailure?: (error: Error) => void;
}

const tail = (text: string) => text.trim().split("\n").at(-1)?.slice(0, 200) ?? "";

/**
 * Starts `args` and resolves once it has run past `startGraceMs`. The recording ends with `stop()`
 * (SIGINT, so the recorder flushes) or `cancel()` (kill, audio dropped). Neither leaves the
 * process running; `stop()` and `cancel()` can both be called more than once.
 */
export function startRecording(
  host: Host,
  args: readonly string[],
  options: StartOptions = {},
): Promise<Recording> {
  const [program, ...rest] = args;
  const stopGraceMs = options.stopGraceMs ?? 3000;
  const startGraceMs = options.startGraceMs ?? 400;
  return new Promise((resolve, reject) => {
    const child = spawn(host.which(program!) ?? program!, rest, {
      env: host.env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    track(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let limited = false;
    let stderr = "";
    let stopping = false;
    let cancelled = false;
    let stopped: Promise<Uint8Array> | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const closed = new Promise<void>((done) => {
      child.once("close", (code, signal) => {
        exit = { code, signal };
        done();
      });
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (cancelled) return;
      const room = MAX_RECORDING_BYTES - size;
      if (room <= 0) return;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(kept);
      size += kept.length;
      if (size >= MAX_RECORDING_BYTES && !limited) {
        limited = true;
        options.onLimit?.();
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const failure = () =>
      new Error(
        `${program} ${
          exit?.signal ? `was stopped by ${exit.signal}` : `exited with ${exit?.code}`
        }${tail(stderr) && `: ${tail(stderr)}`}`,
      );
    const recording: Recording = {
      stop() {
        return (stopped ??= (async () => {
          stopping = true;
          if (!exit) {
            child.kill("SIGINT");
            const kill = setTimeout(() => child.kill("SIGKILL"), stopGraceMs);
            await closed;
            clearTimeout(kill);
          }
          const audio = Buffer.concat(chunks);
          chunks.length = 0;
          // A recorder asked to stop may report any status; no audio is the failure that matters.
          if (!audio.length) throw exit?.code ? failure() : new Error("No audio was captured");
          return sanitizePcm(audio);
        })());
      },
      cancel() {
        cancelled = true;
        stopping = true;
        chunks.length = 0;
        if (!exit) child.kill("SIGKILL");
      },
    };
    child.once("error", (error) => reject(new Error(`${program}: ${error.message}`)));
    child.once("spawn", () => {
      let started = false;
      const timer = setTimeout(() => {
        started = true;
        resolve(recording);
      }, startGraceMs);
      child.once("close", () => {
        clearTimeout(timer);
        if (stopping) return;
        if (started) options.onFailure?.(failure());
        else reject(failure());
      });
    });
  });
}
