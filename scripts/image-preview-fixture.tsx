import { imageOpenAction } from "../src/client/image-open";
import { kittyStdout } from "../src/kitty-output";
// Standalone, offline media fixture; g g / G scroll, t toggles another thread, q exits.
//   bun scripts/image-preview-fixture.tsx IMAGE [--protocol auto|kitty|sixel|blocks|none]
//     [--video FILE] [--tee FILE]
// --tee appends every byte written to the terminal to FILE, so a test can look for escapes.
import { appendFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { useState } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { TranscriptViewport } from "../src/client/transcript-viewport";
import { loadPreviewImage } from "../src/client/image-preview-source";
import { decideMedia, setMedia, tmuxMedia, type MediaProtocol } from "../src/client/media";
import { defaultSettings } from "../src/client/settings";
import { hostActions, systemHost } from "../src/portable";
import type { Actions } from "../src/actions";

const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const path = process.argv[2] ?? "/tmp/starlit-shore-preview.jpg";
const video = flag("--video");
const tee = flag("--tee");
if (tee) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    appendFileSync(tee, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return write(chunk, ...rest);
  }) as typeof process.stdout.write;
}
const run = async (args: string[]) => {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(child.stdout).text();
  return { code: await child.exited, stdout };
};
setMedia(
  decideMedia({
    setting: (flag("--protocol") ?? "auto") as MediaProtocol,
    env: process.env,
    replies: null,
    tmux: process.env.TMUX
      ? await tmuxMedia(run)
      : { inside: false, passthrough: null, client: null },
  }),
);

const items = [
  { id: "image", kind: "assistant", text: `![starlit-shore](<${path}>)` },
  ...(video ? [{ id: "video", kind: "user", text: `![demo](<${video}>)` }] : []),
  { id: "tail", kind: "assistant", text: "text after image\n".repeat(40) },
];
const renderer = await createCliRenderer({
  stdout: process.env.TMUX ? kittyStdout() : process.stdout,
  remote: false,
  exitOnCtrlC: true,
  useMouse: true,
  kittyImageTransport: "zlib",
});
// The real host actions on this PATH: no ffmpeg means no poster, never a crash.
const host = hostActions({
  settings: defaultSettings(),
  host: systemHost(),
  writeTerminal: () => {},
});
const effects: Actions = {
  copy() {},
  loadImage: (source: string, cwd?: string) =>
    loadPreviewImage(source, cwd, async () => {
      throw Error("offline fixture");
    }),
  probeMedia: host.probeMedia,
  inspectMedia: async (source) => {
    const size = (await stat(source)).size;
    return { ...(await host.probeMedia?.(source).catch(() => ({}))), size };
  },
  openMedia: async () => {},
};
effects.openImage = imageOpenAction(effects.loadImage!, undefined, async () => {});
function Fixture() {
  const [other, setOther] = useState(false);
  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy();
    if (key.name === "t") setOther((value) => !value);
  });
  return (
    <box width={120} height={40} flexDirection="row">
      <box width={24} height={40}>
        <text>All threads</text>
      </box>
      <box width={96} height={40} paddingTop={4}>
        <TranscriptViewport
          items={other ? [{ id: "other", kind: "assistant", text: "other thread" }] : items}
          width={96}
          height={36}
          effects={effects}
        />
      </box>
    </box>
  );
}
createRoot(renderer).render(<Fixture />);
