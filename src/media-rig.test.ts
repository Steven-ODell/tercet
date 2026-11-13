import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The media ladder in a private tmux server (`tmux -L`): nothing attaches, nothing is on screen.
// Each rung runs the offline fixture in its own session and reads the pane (text rungs) or the
// bytes the fixture wrote (Kitty).
const tmux = Bun.which("tmux");
const root = join(import.meta.dir, "..");
const socket = `tercet-p6-${process.pid}`;
let dir = "";

// 4x4 RGB: red on top, blue below.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFklEQVQI12P8z4AATEhsBkYGhv/YZQBKoAIFlNbsOAAAAABJRU5ErkJggg==",
  "base64",
);

const run = async (...args: string[]) => {
  const child = Bun.spawn([tmux!, "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out;
};

beforeAll(async () => {
  if (!tmux) return;
  dir = await mkdtemp(join(tmpdir(), "tercet-p6-rig-"));
  await writeFile(join(dir, "shore.png"), PNG);
  // Not a real video: without ffmpeg only its name and size matter.
  await writeFile(join(dir, "demo.mp4"), Buffer.alloc(3000));
  await writeFile(join(dir, "tmux.conf"), "set -g allow-passthrough on\n");
  // A PATH with bun and tmux but no ffmpeg or mpv.
  await mkdir(join(dir, "bin"));
  await symlink(process.execPath, join(dir, "bin", "bun"));
  await symlink(tmux, join(dir, "bin", "tmux"));
});
afterAll(async () => {
  if (!tmux) return;
  await run("kill-server").catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string, protocol: string, extra: string[] = [], env: string[] = []) {
  const tee = join(dir, `${name}.bytes`);
  const command = [
    "bun",
    join(root, "scripts/image-preview-fixture.tsx"),
    join(dir, "shore.png"),
    "--protocol",
    protocol,
    "--tee",
    tee,
    ...extra,
  ]
    .map((arg) => `'${arg}'`)
    .join(" ");
  await run(
    "-f",
    join(dir, "tmux.conf"),
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "120",
    "-y",
    "40",
    ...env.flatMap((pair) => ["-e", pair]),
    `cd '${root}' && exec ${command}`,
  );
  const screen = async () => run("capture-pane", "-p", "-t", name);
  let text = "";
  for (let i = 0; i < 100 && !text.includes("text after image"); i++) {
    await Bun.sleep(100);
    text = await screen();
  }
  // Starts at the tail; g g scrolls to the top so the cards are in view.
  await run("send-keys", "-t", name, "g", "g");
  return {
    async waitFor(check: (text: string) => boolean) {
      for (let i = 0; i < 100; i++) {
        text = await screen();
        if (check(text)) break;
        await Bun.sleep(100);
      }
      return text;
    },
    bytes: async () => (await readFile(tee).catch(() => Buffer.alloc(0))).toString("latin1"),
    stop: () => run("kill-session", "-t", name),
  };
}

test.skipIf(!tmux)(
  "kitty rung: the fixture sends Kitty graphics through tmux passthrough",
  async () => {
    const rig = await fixture("kitty", "kitty");
    let bytes = "";
    for (let i = 0; i < 100 && !/\x1b\x1b_G[^\x1b]*a=[Tp]/.test(bytes); i++) {
      await Bun.sleep(100);
      bytes = await rig.bytes();
    }
    expect(bytes).toContain("\x1bPtmux;\x1b\x1b_G");
    expect(bytes).toMatch(/\x1b\x1b_G[^\x1b]*a=[Tp]/);
    // No placeholder text where the image is.
    expect(await rig.waitFor(() => true)).not.toContain("[image starlit-shore]");
    await rig.stop();
  },
  20_000,
);

test.skipIf(!tmux)(
  "blocks rung: the image is Block Elements text in the pane, with no Kitty escapes",
  async () => {
    const rig = await fixture("blocks", "blocks");
    const text = await rig.waitFor((text) => /[▀-▟]/.test(text));
    expect(text).toMatch(/[▀-▟]{8}/);
    expect(await rig.bytes()).not.toContain("_G");
    await rig.stop();
  },
  20_000,
);

test.skipIf(!tmux)(
  "none rung and a PATH without ffmpeg: placeholders with details, and no crash",
  async () => {
    const rig = await fixture(
      "none",
      "none",
      ["--video", join(dir, "demo.mp4")],
      [`PATH=${join(dir, "bin")}`],
    );
    const text = await rig.waitFor((text) => text.includes("[video demo]"));
    expect(text).toContain(`[image starlit-shore] 4x4, ${PNG.length} B`);
    expect(text).toContain("[video demo] 3 KB");
    expect(await rig.bytes()).not.toContain("_G");
    // Still running: the session exists and still draws.
    expect(await run("list-sessions", "-F", "#{session_name}")).toContain("none");
    await rig.stop();
  },
  20_000,
);
