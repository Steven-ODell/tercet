import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { hostActions, playerChain, type Host } from "../portable";
import { defaultSettings } from "./settings";
import {
  DA1_QUERY,
  KITTY_QUERY,
  decideMedia,
  fileSourceText,
  imageSize,
  media,
  mediaDetail,
  mediaFellBack,
  mediaKind,
  mpvOutput,
  onMediaNotice,
  parseFfmpegInfo,
  parseReplies,
  queryTerminal,
  setMedia,
  type MediaInput,
} from "./media";
import { ImagePreview, InlineImage } from "./image-preview";

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);

afterEach(() => setMedia({ rung: "blocks", reason: "not detected" }));

// Canned replies from real terminals: the Kitty answer (if any) comes before DA1.
const REPLIES = {
  ghostty: "\x1b_Gi=31;OK\x1b\\\x1b[?62;22;52c",
  kitty: "\x1b_Gi=31;OK\x1b\\\x1b[?62;c",
  foot: "\x1b[?62;4;22;28c",
  xterm: "\x1b[?65;1;2;6;9;15;16;17;18;21;22;28;29c",
  vt100: "\x1b[?1;2c",
};

test("terminal replies: Kitty OK, DA1 attribute 4 for Sixel, the device class is not an attribute", () => {
  expect(parseReplies(REPLIES.ghostty)).toEqual({ kitty: true, sixel: false, da1: true });
  expect(parseReplies(REPLIES.kitty)).toEqual({ kitty: true, sixel: false, da1: true });
  expect(parseReplies(REPLIES.foot)).toEqual({ kitty: false, sixel: true, da1: true });
  expect(parseReplies(REPLIES.xterm)).toEqual({ kitty: false, sixel: false, da1: true });
  expect(parseReplies("\x1b[?4;6c").sixel).toBe(false);
  expect(parseReplies("\x1b_Gi=31;ENOTSUPPORTED\x1b\\").kitty).toBe(false);
  expect(parseReplies("")).toEqual({ kitty: false, sixel: false, da1: false });
});

const input = (over: Partial<MediaInput> = {}): MediaInput => ({
  setting: "auto",
  env: {},
  replies: null,
  tmux: { inside: false, passthrough: null, client: null },
  ...over,
});

test("the ladder: replies beat names, tmux needs passthrough, ascii skips blocks", () => {
  const rung = (over: Partial<MediaInput>) => decideMedia(input(over)).rung;
  expect(rung({ replies: parseReplies(REPLIES.ghostty) })).toBe("kitty");
  expect(rung({ replies: parseReplies(REPLIES.foot) })).toBe("sixel");
  expect(rung({ replies: parseReplies(REPLIES.xterm) })).toBe("blocks");
  // A terminal that answered no wins over a name that says yes.
  expect(rung({ replies: parseReplies(REPLIES.vt100), env: { TERM: "xterm-kitty" } })).toBe(
    "blocks",
  );
  // No answer: names are hints.
  expect(rung({ env: { TERM: "xterm-kitty" } })).toBe("kitty");
  expect(rung({ env: { KITTY_WINDOW_ID: "1" } })).toBe("kitty");
  expect(rung({ env: { TERM_PROGRAM: "WezTerm" } })).toBe("kitty");
  expect(rung({ env: { TERM: "xterm-256color" } })).toBe("blocks");
  expect(rung({ env: { TERM: "xterm-256color" }, ascii: true })).toBe("none");
  // Outside tmux a TERM_PROGRAM of tmux is a leftover, not the terminal.
  expect(decideMedia(input({ env: { TERM_PROGRAM: "tmux", TERM: "xterm-ghostty" } }))).toEqual({
    rung: "kitty",
    reason: "xterm-ghostty supports Kitty graphics",
  });
  const tmux = (passthrough: string, client: string | null) => ({
    inside: true,
    passthrough,
    client,
  });
  expect(decideMedia(input({ tmux: tmux("on", "xterm-ghostty") }))).toEqual({
    rung: "kitty",
    reason: "tmux passthrough to xterm-ghostty",
  });
  expect(rung({ tmux: tmux("all", null), env: { GHOSTTY_RESOURCES_DIR: "/x" } })).toBe("kitty");
  expect(rung({ tmux: tmux("on", "xterm-256color") })).toBe("blocks");
  expect(decideMedia(input({ tmux: tmux("off", "xterm-kitty") }))).toEqual({
    rung: "blocks",
    reason: "tmux allow-passthrough is off",
    hint: "images need it: add `set -g allow-passthrough on` to tmux.conf",
  });
});

test("media.protocol overrides detection; none always means placeholders", () => {
  const kitty = parseReplies(REPLIES.ghostty);
  for (const setting of ["kitty", "sixel", "blocks", "none"] as const)
    expect(decideMedia(input({ setting, replies: kitty })).rung).toBe(setting);
  expect(decideMedia(input({ setting: "none", env: { TERM: "xterm-kitty" } }))).toEqual({
    rung: "none",
    reason: 'media.protocol is "none"',
  });
  expect(
    decideMedia(
      input({ setting: "kitty", tmux: { inside: true, passthrough: "off", client: null } }),
    ).hint,
  ).toContain("set -g allow-passthrough on");
});

class FakeTty extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  paused = 0;
  setRawMode(mode: boolean) {
    this.raw.push(mode);
  }
  resume() {}
  pause() {
    this.paused++;
  }
}

test("the query goes out once, stops at DA1, restores cooked mode, and times out to null", async () => {
  for (const [name, reply] of Object.entries(REPLIES)) {
    const tty = new FakeTty();
    const sent: string[] = [];
    const result = queryTerminal(tty, {
      write: (bytes) => {
        sent.push(bytes);
        // Replies can arrive split anywhere.
        const cut = Math.floor(reply.length / 2);
        queueMicrotask(() => {
          tty.emit("data", Buffer.from(reply.slice(0, cut), "latin1"));
          tty.emit("data", Buffer.from(reply.slice(cut), "latin1"));
        });
      },
    });
    expect(await result, name).toEqual(parseReplies(reply));
    expect(sent).toEqual([KITTY_QUERY + DA1_QUERY]);
    expect(tty.raw).toEqual([true, false]);
    expect(tty.listenerCount("data")).toBe(0);
  }
  const silent = new FakeTty();
  expect(await queryTerminal(silent, { write() {} }, 20)).toBeNull();
  expect(silent.raw).toEqual([true, false]);
  const piped = Object.assign(new FakeTty(), { isTTY: false });
  expect(await queryTerminal(piped, { write: () => expect.unreachable() })).toBeNull();
});

test("the tmux hint goes to the status line once per run", () => {
  const seen: string[] = [];
  const stop = onMediaNotice((text) => seen.push(text));
  setMedia({ rung: "blocks", reason: "x" });
  mediaFellBack();
  expect(seen).toEqual([]);
  setMedia({ rung: "blocks", reason: "x", hint: "add it" });
  mediaFellBack();
  mediaFellBack();
  expect(seen).toEqual(["Images: add it"]);
  stop();
});

test("sources are classified like web: attachments by MIME, paths by extension", () => {
  const file = (name: string, mime: string) => fileSourceText({ id: "a1", mime, name, size: 2048 });
  expect(mediaKind("shot.png")).toBe("image");
  expect(mediaKind("https://x.test/a.jpg?w=1")).toBe("image");
  expect(mediaKind("/tmp/demo.mp4")).toBe("video");
  expect(mediaKind("clip.WEBM")).toBe("video");
  expect(mediaKind("voice.m4a")).toBe("audio");
  expect(mediaKind("report.pdf")).toBe("file");
  expect(mediaKind(file("rec.mov", "video/quicktime"))).toBe("video");
  expect(mediaKind(file("rec.mp4", "application/octet-stream"))).toBe("video");
  expect(mediaKind(file("data.csv", "text/csv"))).toBe("file");
  expect(mediaKind(file("memo.ogg", "audio/ogg"))).toBe("audio");
});

test("placeholder details: header sizes, ffmpeg's banner, ASCII only", () => {
  expect(imageSize(png)).toEqual({ width: 1, height: 1 });
  const gif = Buffer.from("GIF89a\x20\x03\x58\x02", "latin1");
  expect(imageSize(gif)).toEqual({ width: 800, height: 600 });
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0,
  ]);
  expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 });
  expect(imageSize(Buffer.from("not an image"))).toBeUndefined();
  const banner = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/demo.mp4':",
    "  Duration: 00:01:05.50, start: 0.000000, bitrate: 1100 kb/s",
    "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps",
  ].join("\n");
  expect(parseFfmpegInfo(banner)).toEqual({ duration: 65.5, width: 1920, height: 1080 });
  expect(parseFfmpegInfo("Duration: N/A")).toEqual({});
  const detail = mediaDetail({ duration: 65.5, width: 1920, height: 1080, size: 3_500_000 });
  expect(detail).toBe("1:06, 1920x1080, 3.3 MB");
  expect(/^[\x20-\x7e]*$/.test(detail)).toBe(true);
  expect(mpvOutput("kitty", false)).toBe("kitty");
  expect(mpvOutput("sixel", false)).toBe("sixel");
  expect(mpvOutput("kitty", true)).toBe("tct");
  expect(mpvOutput("none", false)).toBe("tct");
});

const fakeHost = (installed: string[]): Host => ({
  env: { PATH: "/fake/bin" },
  platform: "linux",
  which: (program) => (installed.includes(program) ? `/fake/bin/${program}` : null),
});

test("a fake PATH without ffmpeg or mpv: no probe, the opener plays, and no crash", async () => {
  const settings = defaultSettings();
  const bare = hostActions({ settings, host: fakeHost([]), writeTerminal() {} });
  expect(bare.probeMedia).toBeUndefined();
  expect(bare.play).toBeUndefined();
  expect(bare.playHere).toBeUndefined();
  expect(playerChain(settings, fakeHost(["xdg-open"]))?.name).toBe("xdg-open");
  expect(playerChain(settings, fakeHost(["xdg-open", "mpv"]))?.name).toBe("mpv");
  settings.launchers.player = ["vlc", "{path}"];
  expect(playerChain(settings, fakeHost(["mpv"]))?.name).toBe("launchers.player");
  const withMpv = hostActions({
    settings: defaultSettings(),
    host: fakeHost(["mpv"]),
    writeTerminal() {},
  });
  expect(withMpv.playHere).toBeDefined();
  expect(withMpv.probeMedia).toBeUndefined();

  // The card for a video with no ffmpeg: name and size, and the open button.
  const source = fileSourceText({ id: "v1", mime: "video/mp4", name: "demo.mp4", size: 5_000_000 });
  let opened = "";
  const view = await testRender(
    <ImagePreview
      image={{ source, alt: "demo.mp4", offset: 0, height: 6, id: "v", right: false }}
      width={60}
      visibleHeight={6}
      select={() => {}}
      perform={(action) => (opened = action)}
      effects={{
        copy() {},
        copyImage: async () => {},
        inspectMedia: async () => ({ size: 5_000_000 }),
        openMedia: async () => {},
      }}
    />,
    { width: 60, height: 8 },
  );
  await act(async () => view.renderOnce());
  await act(async () => view.renderOnce());
  const frame = view.captureCharFrame();
  expect(frame).toContain("[video demo.mp4] 4.8 MB");
  expect(frame).toContain("[open]");
  // A video card has no image clipboard button.
  expect(frame).not.toContain("[copy]");
  view.renderer.destroy();
  expect(opened).toBe("");
});

test('media.protocol "none" draws a placeholder with dimensions and size, never an image', async () => {
  setMedia(decideMedia(input({ setting: "none", replies: parseReplies(REPLIES.ghostty) })));
  expect(media().rung).toBe("none");
  const view = await testRender(
    <InlineImage bytes={png} width={30} height={4} fallback="[image shot]" />,
    { width: 40, height: 6 },
  );
  await act(async () => view.renderOnce());
  expect(view.captureCharFrame()).toContain("[image shot] 1x1, 68 B");
  view.renderer.destroy();
});

// 4x4 RGB: red on top, blue below.
const redBlue = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFklEQVQI12P8z4AATEhsBkYGhv/YZQBKoAIFlNbsOAAAAABJRU5ErkJggg==",
    "base64",
  ),
);

test("the blocks rung draws Block Elements characters in the cells", async () => {
  setMedia({ rung: "blocks", reason: "test" });
  const view = await testRender(<InlineImage bytes={redBlue} width={4} height={2} />, {
    width: 10,
    height: 4,
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 200));
    await view.renderOnce();
  });
  expect(view.captureCharFrame()).toMatch(/[▀-▟]/);
  view.renderer.destroy();
});

test("message attachments of every kind become media cards, from either speaker", async () => {
  const { workMessages } = await import("./work-log");
  const attachments = [
    { type: "image", id: "i1", name: "shot.png", mimeType: "image/png", sizeBytes: 10 },
    { type: "file", id: "v1", name: "rec.mp4", mimeType: "video/mp4", sizeBytes: 2048 },
    { type: "file", id: "f1", name: "data.csv", mimeType: "text/csv", sizeBytes: 5 },
  ];
  for (const type of ["user_message", "assistant_message"]) {
    const [message] = workMessages(
      [{ item: { type, id: "m", text: "see", attachments } } as never],
      new Set(),
    );
    const sources = [...message!.text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(sources.map(mediaKind)).toEqual(["image", "video", "file"]);
  }
});

test("media targets: local attachment file, else a signed URL; paths resolve; odd schemes refuse", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveMediaTarget } = await import("./image-open");
  const dir = await mkdtemp(join(tmpdir(), "tercet-media-"));
  try {
    await writeFile(join(dir, "v1.mp4"), Buffer.alloc(10));
    const source = fileSourceText({ id: "v1", mime: "video/mp4", name: "rec.mp4", size: 10 });
    const url = async (id: string, mime: string) => `https://srv/${id}?m=${mime}`;
    expect(await resolveMediaTarget(source, undefined, dir, url)).toEqual({
      target: join(dir, "v1.mp4"),
      size: 10,
    });
    expect(await resolveMediaTarget(source, undefined, undefined, url)).toEqual({
      target: "https://srv/v1?m=video/mp4",
      size: 10,
    });
    expect(await resolveMediaTarget("v1.mp4", dir, undefined, url)).toEqual({
      target: join(dir, "v1.mp4"),
      size: 10,
    });
    await expect(resolveMediaTarget("concat:a|b", dir, undefined, url)).rejects.toThrow();
    const bad = fileSourceText({ id: "../x", mime: "video/mp4", name: "x" });
    await expect(resolveMediaTarget(bad, dir, dir, url)).rejects.toThrow("Invalid attachment id");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!Bun.which("ffmpeg"))("ffmpeg gives a poster PNG, duration and size", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { systemHost } = await import("../portable");
  const dir = await mkdtemp(join(tmpdir(), "tercet-poster-"));
  try {
    const clip = join(dir, "clip.mp4");
    const made = Bun.spawnSync(
      [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x48:rate=10",
      ].concat(["-t", "1", "-pix_fmt", "yuv420p", clip]),
    );
    expect(made.exitCode).toBe(0);
    const actions = hostActions({
      settings: defaultSettings(),
      host: systemHost(),
      writeTerminal() {},
    });
    const probe = await actions.probeMedia!(clip);
    expect(probe).toMatchObject({ width: 64, height: 48 });
    expect(probe.duration).toBeCloseTo(1, 0);
    expect(imageSize(probe.poster!)).toEqual({ width: 64, height: 48 });
    // A file that is not media: no poster, no throw.
    expect((await actions.probeMedia!(join(dir, "missing.mp4"))).poster).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
