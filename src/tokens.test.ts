import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A canary token in a token file, and a hostile fake server that echoes whatever credential it
// receives into every error body and header. Nothing tercet prints, on any path, may contain it.
const CANARY = "tercet-canary-7f3a9c2e5b1d4a60";
const root = join(import.meta.dir, "..");
const tmux = Bun.which("tmux");
const socket = `tercet-p7-tok-${process.pid}`;
let dir = "";
let seen: string[] = [];
let version: string | undefined = "0.1.8";
let protocol = 2;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tercet-p7-tok-"));
  await mkdir(join(dir, "xdg/tercet"), { recursive: true });
  await writeFile(join(dir, "xdg/tercet/settings.json"), "{}\n");
  await writeFile(join(dir, "token"), `${CANARY}\n`, { mode: 0o600 });
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const credential = [
        request.headers.get("authorization"),
        url.searchParams.toString(),
        request.headers.get("cookie"),
      ]
        .filter(Boolean)
        .join(" ");
      if (credential) seen.push(credential);
      if (url.pathname === "/.well-known/t3/environment")
        return Response.json({
          environmentId: "env-canary",
          label: "canary box",
          platform: { os: "linux", arch: "x64" },
          ...(version ? { serverVersion: version } : {}),
          orchestrationProtocolVersion: protocol,
          capabilities: { repositoryIdentity: false },
        });
      return Response.json(
        {
          _tag: "EnvironmentAuthInvalidError",
          code: "auth_invalid",
          reason: "invalid_credential",
          // A hostile server: the trace id is the credential it was sent.
          traceId: `echo ${credential}`.slice(0, 300),
        },
        { status: 401, headers: { "x-echo": credential.slice(0, 200) } },
      );
    },
  });
});
afterAll(async () => {
  server?.stop(true);
  if (tmux) {
    const child = Bun.spawn([tmux, "-L", socket, "kill-server"], { stderr: "ignore" });
    await child.exited;
  }
  await rm(dir, { recursive: true, force: true });
});

async function tercet(...args: string[]) {
  const child = Bun.spawn(["bun", join(root, "src/main.tsx"), ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: join(dir, "xdg") },
    timeout: 40_000,
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code, all: out + err };
}

const tokenFile = () => join(dir, "token");

test("--dump-status against a server that echoes the token: rejected, and the token never printed", async () => {
  version = "0.1.8";
  seen = [];
  const result = await tercet(
    "--dump-status",
    "--url",
    server.url.origin,
    "--token-file",
    tokenFile(),
  );
  // The token did go out, so the echo had something to leak.
  expect(seen.join(" ")).toContain(CANARY);
  expect(result.code).not.toBe(0);
  expect(result.all).not.toContain(CANARY);
  expect(result.all).not.toContain(CANARY.slice(0, 16));
}, 45_000);

test("version gate, version-less and unreachable paths never print the token", async () => {
  for (const [v, p, expected] of [
    ["9.9.9", 3, "Incompatible server protocol"],
    [undefined, 2, "did not report a version"],
  ] as const) {
    version = v;
    protocol = p;
    const result = await tercet(
      "--dump-status",
      "--url",
      server.url.origin,
      "--token-file",
      tokenFile(),
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain(expected);
    expect(result.all).not.toContain(CANARY);
  }
  protocol = 2;
  const down = await tercet(
    "--dump-status",
    "--url",
    "http://127.0.0.1:1",
    "--token-file",
    tokenFile(),
  );
  expect(down.code).toBe(1);
  expect(down.err).toContain("Cannot reach the T3 server");
  expect(down.all).not.toContain(CANARY);
  // Bad flags and a bad URL go through the configuration error path.
  for (const args of [
    ["--token-file", tokenFile(), "--url", `http://x/?token=${"q"}`],
    ["--token-file", tokenFile(), "--bogus"],
  ]) {
    const bad = await tercet(...args);
    expect(bad.code).toBe(1);
    expect(bad.all).not.toContain(CANARY);
  }
}, 45_000);

test("doctor, plain and --json, names the token file but never the token", async () => {
  version = "0.1.8";
  for (const json of [[], ["--json"]]) {
    const result = await tercet(
      "doctor",
      ...json,
      "--url",
      server.url.origin,
      "--token-file",
      tokenFile(),
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain(tokenFile());
    expect(result.all).not.toContain(CANARY);
  }
}, 30_000);

test.skipIf(!tmux)(
  "the TUI on a rejecting server: neither the screen nor the bytes written carry the token",
  async () => {
    version = "0.1.8";
    seen = [];
    const run = async (...args: string[]) => {
      const child = Bun.spawn([tmux!, "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(child.stdout).text();
      await child.exited;
      return out;
    };
    const bytes = join(dir, "tui.bytes");
    await run(
      "new-session",
      "-d",
      "-s",
      "tui",
      "-x",
      "100",
      "-y",
      "30",
      "-e",
      `XDG_CONFIG_HOME=${join(dir, "xdg")}`,
      "-e",
      `HOME=${dir}`,
      `cd '${root}' && exec '${process.execPath}' src/main.tsx --url ${server.url.origin} --token-file '${tokenFile()}'`,
    );
    await run("pipe-pane", "-o", "-t", "tui", `cat >> '${bytes}'`);
    let text = "";
    for (let i = 0; i < 100 && !/rejected|unavailable/i.test(text); i++) {
      await Bun.sleep(100);
      text = await run("capture-pane", "-p", "-t", "tui");
    }
    expect(text).toMatch(/rejected|unavailable/i);
    expect(seen.join(" ")).toContain(CANARY);
    expect(text).not.toContain(CANARY);
    await run("send-keys", "-t", "tui", "C-c");
    await Bun.sleep(300);
    const written = await readFile(bytes, "latin1").catch(() => "");
    expect(written).not.toContain(CANARY);
    await run("kill-session", "-t", "tui").catch(() => {});
  },
  30_000,
);
