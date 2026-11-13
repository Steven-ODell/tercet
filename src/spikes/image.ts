import { kittyStdout } from "../kitty-output";
// Step 2 spike: draw one PNG with OpenTUI's ImageRenderable inside a scrollable column.
//   bun src/spikes/image.ts <png> [auto|blocks|kitty] [--log FILE]
// j/k (or arrows) scroll the image up and down past a text viewport, q quits. The spike also
// logs the resolved protocol and capabilities to FILE so a headless run can read them.
import { appendFileSync } from "node:fs";
import { BoxRenderable, createCliRenderer, ImageRenderable, TextRenderable } from "@opentui/core";

const [path = "", protocol = "auto"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const logAt = process.argv.indexOf("--log");
const log = (line: string) =>
  logAt > 0 && appendFileSync(process.argv[logAt + 1] ?? "", `${line}\n`);

const renderer = await createCliRenderer({
  stdout: process.env.TMUX ? kittyStdout() : process.stdout,
  remote: false,
  exitOnCtrlC: true,
  useMouse: true,
});
const view = new BoxRenderable(renderer, {
  id: "view",
  width: "100%",
  height: "100%",
  overflow: "hidden",
});
renderer.root.add(view);

const image = new ImageRenderable(renderer, {
  id: "img",
  source: path,
  protocol: protocol as "auto" | "blocks" | "kitty",
  position: "absolute",
  left: 4,
  top: 3,
  width: 40,
  height: 10,
  fit: "fit",
  onLoad: (i) => log(`loaded ${i.width}x${i.height}`),
  onError: (e) => log(`error ${String(e)}`),
});
for (let i = 0; i < 40; i++) {
  view.add(
    new TextRenderable(renderer, {
      id: `t${i}`,
      content: `line ${String(i).padStart(2, "0")} ${"-".repeat(60)}`,
      position: "absolute",
      left: 0,
      top: i,
      fg: "#9180ad",
    }),
  );
}
view.add(image);
let top = 3;
const move = (to: number) => {
  top = to;
  image.top = top;
  renderer.requestRender();
};
renderer.keyInput.on("keypress", (k) => {
  if (k.name === "q") process.exit(0);
  if (k.name === "j" || k.name === "down") move(top + 1);
  if (k.name === "k" || k.name === "up") move(top - 1);
  if (k.name === "g") move(60);
});
renderer.on("capabilities", () => log(`caps ${JSON.stringify(renderer.capabilities)}`));
setTimeout(
  () => log(`resolved ${image.effectiveProtocol} caps ${JSON.stringify(renderer.capabilities)}`),
  1500,
);
