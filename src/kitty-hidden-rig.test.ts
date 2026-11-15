import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real tmux, off-screen: an "outer" private tmux server stands in for ghostty. Its pane runs
// `script`, which attaches a client of an "inner" private server (Sao's tmux: focus-events on,
// allow-passthrough on) and logs every byte that client's terminal receives. Inner session A runs a
// stand-in for tercet that wires clearKittyWhenHidden to real focus events, real tmux and the
// real client tty, and repaints with a passthrough placement. Switching the client away must put
// the delete on the client's tty; coming back must repaint; a terminal-only blur must not clear.
const tmux = Bun.which("tmux");
const script = Bun.which("script");
const ready = !!tmux && !!script && process.platform === "linux";
const outer = `tercet-hide-o-${process.pid}`;
const inner = `tercet-hide-i-${process.pid}`;
let dir = "";
const DELETE = "\x1b_Ga=d,d=i,i=7,q=2\x1b\\";
const PLACE = "\x1b_Ga=p,i=7,p=1,c=4,r=2,q=2\x1b\\";

const tm = async (socket: string, ...args: string[]) => {
  const child = Bun.spawn([tmux!, "-L", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMUX: "" },
  });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out;
};
const log = async () =>
  (await readFile(join(dir, "client.log")).catch(() => "")).toString("latin1");
const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 60 && !(await check()); i++) await Bun.sleep(100);
  return check();
};
const count = (text: string, part: string) => text.split(part).length - 1;

beforeAll(async () => {
  if (!ready) return;
  dir = await mkdtemp(join(tmpdir(), "tercet-hide-rig-"));
  await writeFile(
    join(dir, "inner.conf"),
    "set -g focus-events on\nset -g allow-passthrough on\nset -g status off\n",
  );
  await writeFile(
    join(dir, "pane.ts"),
    `import { appendFile } from "node:fs/promises";
import { clearKittyWhenHidden, kittyDeletePlacements, tmuxClientsShowing } from ${JSON.stringify(join(import.meta.dir, "kitty-output.ts"))};
const focus: (() => void)[] = [];
const blur: (() => void)[] = [];
const place = () => process.stdout.write("\\x1bPtmux;" + ${JSON.stringify(PLACE)}.replaceAll("\\x1b", "\\x1b\\x1b") + "\\x1b\\\\");
const output = async (args: string[]) => new Response(Bun.spawn(args, { stdout: "pipe" }).stdout).text();
process.stdin.setRawMode(true);
process.stdin.on("data", (b) => {
  const s = b.toString("latin1");
  if (s.includes("\\x1b[I")) focus.forEach((f) => f());
  if (s.includes("\\x1b[O")) blur.forEach((f) => f());
});
process.stdout.write("\\x1b[?1004h");
await clearKittyWhenHidden({
  showing: () => tmuxClientsShowing(process.env.TMUX_PANE!, output),
  clear: (tty) => appendFile(tty, kittyDeletePlacements(["7"])),
  repaint: place,
  onFocus: (f) => focus.push(f),
  onBlur: (f) => blur.push(f),
});
place();
process.stdout.write("pane-ready\\n");
`,
  );
  const conf = join(dir, "inner.conf");
  await tm(
    inner,
    "-f",
    conf,
    "new-session",
    "-d",
    "-s",
    "A",
    "-x",
    "80",
    "-y",
    "20",
    `bun ${join(dir, "pane.ts")}`,
  );
  await tm(inner, "new-window", "-d", "-t", "A:", "sleep 600");
  await tm(inner, "new-session", "-d", "-s", "B", "-x", "80", "-y", "20", "sleep 600");
  await waitFor(async () =>
    (await tm(inner, "capture-pane", "-p", "-t", "A:0")).includes("pane-ready"),
  );
  const attach = `TMUX= ${tmux} -L ${inner} attach -t A`;
  await tm(
    outer,
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-x",
    "80",
    "-y",
    "20",
    `${script} -qfc '${attach}' ${join(dir, "client.log")}`,
  );
});
afterAll(async () => {
  if (!ready) return;
  await tm(outer, "kill-server").catch(() => {});
  await tm(inner, "kill-server").catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

test.skipIf(!ready)(
  "a real tmux session or window switch clears tercet's placements on the client tty and repaints on return",
  async () => {
    const client = async () => (await tm(inner, "list-clients", "-F", "#{client_tty}")).trim();
    expect(await waitFor(async () => (await client()) !== "")).toBe(true);
    const tty = await client();
    // The attach drew session A; tmux's own focus-in on attach repaints nothing yet.
    expect(await waitFor(async () => (await log()).length > 0)).toBe(true);
    await Bun.sleep(300);

    // A terminal-only blur (ghostty lost focus) keeps the image: the pane is still shown.
    await tm(outer, "send-keys", "-H", "1b", "5b", "4f");
    await Bun.sleep(500);
    expect(count(await log(), DELETE)).toBe(0);
    await tm(outer, "send-keys", "-H", "1b", "5b", "49");
    await Bun.sleep(300);

    // Session switch: the delete reaches the client tty although pane A is hidden by then.
    await tm(inner, "switch-client", "-c", tty, "-t", "B");
    expect(await waitFor(async () => count(await log(), DELETE) === 1)).toBe(true);
    const places = count(await log(), PLACE);
    await tm(inner, "switch-client", "-c", tty, "-t", "A");
    expect(await waitFor(async () => count(await log(), PLACE) > places)).toBe(true);

    // Window switch inside session A: same clear, same repaint.
    await tm(inner, "select-window", "-t", "A:1");
    expect(await waitFor(async () => count(await log(), DELETE) === 2)).toBe(true);
    const again = count(await log(), PLACE);
    await tm(inner, "select-window", "-t", "A:0");
    expect(await waitFor(async () => count(await log(), PLACE) > again)).toBe(true);
  },
  30_000,
);
