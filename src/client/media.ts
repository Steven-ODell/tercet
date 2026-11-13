import {
  audioMimeTypeFromExtension,
  mediaMimeTypeFromExtension,
} from "@t3tools/shared/mediaPreview";
import { videoMimeType } from "@t3tools/shared/video";

/**
 * The media ladder: how images draw in this terminal, first that works. `kitty` places real
 * pixels, `sixel` too where the terminal speaks it, `blocks` draws them as colored Block Elements
 * characters (opentui's half and quadrant blocks), `none` shows a placeholder card with the name,
 * size and dimensions or duration, and an open-externally action.
 */
export type Rung = "kitty" | "sixel" | "blocks" | "none";
export const MEDIA_PROTOCOLS = ["auto", "kitty", "sixel", "blocks", "none"] as const;
export type MediaProtocol = (typeof MEDIA_PROTOCOLS)[number];
/** Where Enter plays a video: the player launcher, or mpv inside this terminal. */
export const VIDEO_MODES = ["player", "terminal"] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

/** Kitty graphics query (a 1x1 RGB image, query only) and Primary Device Attributes. */
export const KITTY_QUERY = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";
export const DA1_QUERY = "\x1b[c";
/** The line `doctor` and the status line ask tmux users to add. */
export const PASSTHROUGH_LINE = "set -g allow-passthrough on";

/** Terminal names that speak Kitty graphics. Names are hints; a reply to the query wins. */
export const KITTY_TERMINALS = /kitty|ghostty|wezterm/i;

export interface Replies {
  /** The terminal answered the Kitty graphics query with OK. */
  kitty: boolean;
  /** DA1 listed attribute 4. */
  sixel: boolean;
  /** A DA1 reply arrived; every terminal sends one, so a missing Kitty reply before it is a no. */
  da1: boolean;
}

/** Reads the replies to KITTY_QUERY + DA1_QUERY out of whatever the terminal sent back. */
export function parseReplies(text: string): Replies {
  const da = /\x1b\[\?([\d;]*)c/.exec(text);
  return {
    kitty: /\x1b_Gi=31;OK\x1b\\/.test(text),
    // The first DA1 parameter is the device class; attributes follow it.
    sixel: !!da && da[1]!.split(";").slice(1).includes("4"),
    da1: !!da,
  };
}

export interface MediaInput {
  setting: MediaProtocol;
  env: Record<string, string | undefined>;
  /** null: not asked (inside tmux, or not a terminal) or no answer before the timeout. */
  replies: Replies | null;
  tmux: { inside: boolean; passthrough: string | null; client: string | null };
  /** `icons: "ascii"` draws nothing outside ASCII, so `auto` skips the block characters. */
  ascii?: boolean;
}

export interface MediaDecision {
  rung: Rung;
  reason: string;
  /** Shown once on the status line and by doctor: how to get real images. */
  hint?: string;
}

const tmuxHint = `images need it: add \`${PASSTHROUGH_LINE}\` to tmux.conf`;

/** The terminal a Kitty hint names, from the outer client name, TERM_PROGRAM, TERM and its env. */
export function kittyHint(env: MediaInput["env"], outer: string | null) {
  return (
    [outer, env.TERM_PROGRAM, env.TERM].find((name) => name && KITTY_TERMINALS.test(name)) ??
    (env.KITTY_WINDOW_ID ? "kitty" : env.GHOSTTY_RESOURCES_DIR ? "ghostty" : undefined)
  );
}

/** Picks the rung. Replies beat names; inside tmux the replies are tmux's, so names decide. */
export function decideMedia(input: MediaInput): MediaDecision {
  const { setting, env, replies, tmux } = input;
  const passthroughOff = tmux.inside && tmux.passthrough === "off";
  if (setting === "none") return { rung: "none", reason: 'media.protocol is "none"' };
  if (setting !== "auto")
    return {
      rung: setting,
      reason: `media.protocol is "${setting}"`,
      ...(passthroughOff && setting !== "blocks" ? { hint: tmuxHint } : {}),
    };
  const fallback = (reason: string, hint?: string): MediaDecision =>
    input.ascii
      ? { rung: "none", reason: `${reason}; icons are ascii`, ...(hint ? { hint } : {}) }
      : { rung: "blocks", reason, ...(hint ? { hint } : {}) };
  const outer = tmux.inside
    ? tmux.client
    : env.TERM_PROGRAM === "tmux"
      ? null
      : (env.TERM_PROGRAM ?? null);
  const hinted = kittyHint(tmux.inside ? env : { ...env, TERM_PROGRAM: undefined }, outer);
  if (tmux.inside) {
    if (passthroughOff) return fallback("tmux allow-passthrough is off", tmuxHint);
    return hinted
      ? { rung: "kitty", reason: `tmux passthrough to ${hinted}` }
      : fallback("tmux hides the outer terminal and its name is not a Kitty one");
  }
  if (replies?.kitty) return { rung: "kitty", reason: "the terminal answered the Kitty query" };
  if (replies?.da1)
    return replies.sixel
      ? { rung: "sixel", reason: "the terminal reports Sixel (DA1 attribute 4)" }
      : fallback("the terminal reports no Kitty or Sixel graphics");
  return hinted
    ? { rung: "kitty", reason: `${hinted} supports Kitty graphics` }
    : fallback("no reply from the terminal");
}

/** tmux's view of this pane: passthrough (on, off, all) and the outer terminal's name. */
export async function tmuxMedia(
  run: (args: string[]) => Promise<{ code: number; stdout: string }>,
): Promise<MediaInput["tmux"]> {
  const [passthrough, client] = await Promise.all([
    run(["tmux", "show-options", "-Apv", "allow-passthrough"]),
    run(["tmux", "display-message", "-p", "#{client_termname}"]),
  ]);
  return {
    inside: true,
    passthrough: passthrough.code === 0 ? passthrough.stdout.trim() || "off" : null,
    client: client.code === 0 ? client.stdout.trim() || null : null,
  };
}

interface TtyInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Sends the Kitty query and DA1, and reads the replies until DA1 arrives or `timeoutMs` passes.
 * Runs before the renderer owns stdin. null when stdin is not a terminal or nothing answered.
 */
export function queryTerminal(
  input: TtyInput,
  output: { write(bytes: string): unknown },
  timeoutMs = 300,
): Promise<Replies | null> {
  const raw = input.setRawMode?.bind(input);
  if (!input.isTTY || !raw) return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = "";
    const finish = (value: Replies | null) => {
      clearTimeout(timer);
      input.off("data", onData);
      raw(false);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      text += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      const replies = parseReplies(text);
      if (replies.da1) finish(replies);
    };
    const timer = setTimeout(() => finish(text ? parseReplies(text) : null), timeoutMs);
    raw(true);
    input.on("data", onData);
    input.resume();
    output.write(KITTY_QUERY + DA1_QUERY);
  });
}

// The decision for this run, set once before the first frame (like the theme).
let current: MediaDecision & { video: VideoMode } = {
  rung: "blocks",
  reason: "not detected",
  video: "player",
};
let noticeSent = false;
const noticeListeners = new Set<(text: string) => void>();
export const media = () => current;
export function setMedia(decision: MediaDecision, video: VideoMode = "player") {
  current = { ...decision, video };
  noticeSent = false;
}
/** The status line listens; a preview that fell back calls `mediaFellBack` and it shows once. */
export function onMediaNotice(listener: (text: string) => void) {
  noticeListeners.add(listener);
  return () => void noticeListeners.delete(listener);
}
export function mediaFellBack() {
  if (noticeSent || !current.hint) return;
  noticeSent = true;
  for (const listener of noticeListeners) listener(`Images: ${current.hint}`);
}

export type MediaKind = "image" | "video" | "audio" | "file";

/** A chat attachment that is not an image: `tercet-file:` plus its JSON, like `tercet-image:`. */
export interface FileSource {
  id: string;
  mime: string;
  name: string;
  size?: number;
}
export const fileSourceText = (file: FileSource) =>
  `tercet-file:${encodeURIComponent(JSON.stringify(file))}`;
export function fileSource(source: string): FileSource | null {
  if (!source.startsWith("tercet-file:")) return null;
  const value: unknown = JSON.parse(decodeURIComponent(source.slice("tercet-file:".length)));
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("mime" in value) ||
    !("name" in value) ||
    typeof value.id !== "string" ||
    typeof value.mime !== "string" ||
    typeof value.name !== "string"
  )
    throw new Error("Invalid file attachment");
  const size = "size" in value && typeof value.size === "number" ? value.size : undefined;
  return {
    id: value.id,
    mime: value.mime,
    name: value.name,
    ...(size === undefined ? {} : { size }),
  };
}

const kindOfMime = (mime: string): MediaKind | null =>
  mime.startsWith("image/")
    ? "image"
    : mime.startsWith("video/")
      ? "video"
      : mime.startsWith("audio/")
        ? "audio"
        : null;

/** What a preview source is, by attachment MIME type or the path's extension (web's tables). */
export function mediaKind(source: string): MediaKind {
  if (source.startsWith("tercet-image:")) return "image";
  const file = fileSource(source);
  if (file)
    return (
      kindOfMime(file.mime) ??
      (videoMimeType({ name: file.name, mimeType: file.mime }) ? "video" : "file")
    );
  const path = source.replace(/[?#].*$/, "");
  const ext = /(\.[a-z0-9]+)$/i.exec(path)?.[1];
  if (!ext) return "image";
  const mime = mediaMimeTypeFromExtension(ext) ?? audioMimeTypeFromExtension(ext);
  return mime ? (kindOfMime(mime) ?? "file") : "file";
}

/** Pixel size from a PNG, GIF, JPEG or WebP header; undefined for anything else. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR")
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF")
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (
    b.length >= 30 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X")
      return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === "VP8 ")
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 9 < b.length && b[at] === 0xff) {
      const marker = b[at + 1]!;
      const length = b.readUInt16BE(at + 2);
      // SOF0-SOF15 carry the size, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
      at += 2 + length;
    }
  }
  return undefined;
}

export const formatBytes = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${Math.ceil(size / 1024)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

export function formatDuration(seconds: number) {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** What ffmpeg says about a video or audio file, read from its stderr banner. */
export interface MediaProbe {
  poster?: Uint8Array;
  duration?: number;
  width?: number;
  height?: number;
}
export function parseFfmpegInfo(stderr: string): Omit<MediaProbe, "poster"> {
  const info: Omit<MediaProbe, "poster"> = {};
  const d = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const v = /Stream #[^\n]*Video:[^\n]*?, (\d{2,5})x(\d{2,5})[\s,[]/.exec(stderr);
  if (v) {
    info.width = Number(v[1]);
    info.height = Number(v[2]);
  }
  return info;
}

/** The placeholder's detail line: dimensions or duration, then size. ASCII only. */
export function mediaDetail(details: {
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
}) {
  return [
    details.duration !== undefined && formatDuration(details.duration),
    details.width && details.height && `${details.width}x${details.height}`,
    details.size !== undefined && formatBytes(details.size),
  ]
    .filter(Boolean)
    .join(", ");
}

/** mpv's video output for in-terminal playback on this rung. tmux gets text cells (tct). */
export function mpvOutput(rung: Rung, inTmux: boolean) {
  if (inTmux || rung === "blocks" || rung === "none") return "tct";
  return rung;
}
