import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KITTY_CLEAR_PLACEMENTS } from "./kitty-output";

// The real tercet (`--hello`, no server) in a private tmux server (`tmux -L`): nothing attaches and
// nothing reaches the screen. Each case kills it a different way, then reads tmux's view of the
// pane: alternate screen, mouse modes and cursor, plus the bytes tercet wrote (pipe-pane) for the
// Kitty image delete. Images are on (`media.protocol: "kitty"`) so the delete is due.
const tmux = Bun.which("tmux");
const root = join(import.meta.dir, "..");
const socket = `tercet-p7-${process.pid}`;
let dir = "";

const run = async (...args: string[]) => {
  const child = Bun.spawn([tmux!, "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out;
};

beforeAll(async () => {
  if (!tmux) return;
  dir = await mkdtemp(join(tmpdir(), "tercet-p7-rig-"));
  await mkdir(join(dir, "xdg/tercet"), { recursive: true });
  await writeFile(join(dir, "xdg/tercet/settings.json"), '{ "media": { "protocol": "kitty" } }\n');
  // A crash on cue: the test touches the file once tercet owns the terminal.
  await writeFile(
    join(dir, "crash.ts"),
    `const cue = ${JSON.stringify(join(dir, "crash-now"))};
const timer = setInterval(async () => {
  if (await Bun.file(cue).exists()) { clearInterval(timer); throw new Error("rig crash"); }
}, 50);
timer.unref();
`,
  );
  await writeFile(join(dir, "tmux.conf"), "set -g allow-passthrough on\n");
});
afterAll(async () => {
  if (!tmux) return;
  await run("kill-server").catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const flags = async (name: string) => {
  const [alternate, any, button, standard, sgr, cursor] = (
    await run(
      "display-message",
      "-p",
      "-t",
      name,
      "#{alternate_on} #{mouse_any_flag} #{mouse_button_flag} #{mouse_standard_flag} #{mouse_sgr_flag} #{cursor_flag}",
    )
  )
    .trim()
    .split(" ");
  return { alternate, mouse: [any, button, standard, sgr].join(""), cursor };
};

async function kill(name: string, how: "SIGINT" | "SIGTERM" | "SIGHUP" | "crash") {
  const bytes = join(dir, `${name}.bytes`);
  const preload = how === "crash" ? `--preload '${join(dir, "crash.ts")}' ` : "";
  await run(
    "-f",
    join(dir, "tmux.conf"),
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "100",
    "-y",
    "30",
    "-e",
    `XDG_CONFIG_HOME=${join(dir, "xdg")}`,
    `cd '${root}' && '${process.execPath}' ${preload}src/main.tsx --hello; echo "tercet-exit=$?"; sleep 60`,
  );
  await run("pipe-pane", "-o", "-t", name, `cat >> '${bytes}'`);
  let up = { alternate: "", mouse: "", cursor: "" };
  for (let i = 0; i < 100; i++) {
    up = await flags(name);
    if (
      up.alternate === "1" &&
      (await run("capture-pane", "-p", "-t", name)).includes("tercet hello")
    )
      break;
    await Bun.sleep(100);
  }
  // While running: alternate screen, some mouse mode on, cursor hidden.
  expect(up.alternate).toBe("1");
  expect(up.mouse).toMatch(/1/);
  expect(up.cursor).toBe("0");
  if (how === "crash") await writeFile(join(dir, "crash-now"), "");
  else {
    const shell = (await run("display-message", "-p", "-t", name, "#{pane_pid}")).trim();
    const child = Bun.spawnSync(["pgrep", "-P", shell, "-f", "main.tsx"]);
    const pid = Number(child.stdout.toString().trim().split("\n")[0]);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, how);
  }
  let text = "";
  for (let i = 0; i < 100 && !text.includes("tercet-exit="); i++) {
    await Bun.sleep(100);
    text = await run("capture-pane", "-p", "-t", name);
  }
  const after = await flags(name);
  const written = (await readFile(bytes).catch(() => Buffer.alloc(0))).toString("latin1");
  await run("kill-session", "-t", name);
  return { text, after, written };
}

for (const [how, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
  ["crash", 1],
] as const)
  test.skipIf(!tmux)(
    `${how}: tercet exits ${code} and leaves the pane as it found it`,
    async () => {
      const { text, after, written } = await kill(how.toLowerCase(), how);
      expect(text).toContain(`tercet-exit=${code}`);
      // Back on the main screen: the hello screen is gone, the shell's line is there.
      expect(text).not.toContain("tercet hello");
      expect(after).toEqual({ alternate: "0", mouse: "0000", cursor: "1" });
      expect(written).toContain(KITTY_CLEAR_PLACEMENTS);
      expect(written).not.toContain("rig crash");
    },
    20_000,
  );
