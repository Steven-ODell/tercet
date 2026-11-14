// CI only: a real pinned Windows T3 server, isolated data, no provider turns or GitHub writes.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
if (process.platform !== "win32" || !process.env.CI) throw new Error("Windows CI only");
const binary = process.env.TERCET_TEST_T3;
if (!binary) throw new Error("Set TERCET_TEST_T3 to the pinned t3.exe");
const root = await mkdtemp(join(tmpdir(), "tercet server 界 "));
const base = join(root, ".t3");
const project = join(root, "repo with spaces");
const url = "http://127.0.0.1:3776";
const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config") };
const run = async (argv: string[]) => {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${argv[0]} failed (${code}): ${err.slice(-1000)}`);
  return out;
};
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "README.md"), "# Windows fixture\n");
  await run(["git", "-C", project, "init", "-b", "main"]);
  await run(["git", "-C", project, "add", "."]);
  await run(["git", "-C", project, "-c", "user.name=Tercet CI", "-c", "user.email=ci@example.invalid", "commit", "-m", "fixture"]);
  await run([binary, "project", "add", "--base-dir", base, "--title", "Windows fixture", project]);
  // An occupied port must fail rather than connect this test to an unrelated server.
  try { await fetch(`${url}/.well-known/t3/environment`, { signal: AbortSignal.timeout(500) }); throw new Error("Test port occupied"); }
  catch (error) { if (error instanceof Error && error.message === "Test port occupied") throw error; }
  server = Bun.spawn([binary, "serve", "--base-dir", base, "--host", "127.0.0.1", "--port", "3776", "--no-browser", project], { env, stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 60_000;
  while (true) {
    if (server.exitCode !== null) throw new Error(`T3 server exited (${server.exitCode})`);
    if (await fetch(`${url}/.well-known/t3/environment`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false)) break;
    if (Date.now() > deadline) throw new Error("T3 server did not start");
    await Bun.sleep(250);
  }
  const token = await run([binary, "auth", "session", "issue", "--base-dir", base, "--token-only", "--scope", "orchestration:read", "--label", "tercet-windows-ci"]);
  const tokenFile = join(root, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const out = await run([process.execPath, resolve("dist/tercet.js"), "--url", url, "--base-dir", base, "--token-file", tokenFile, "--read-only", "--dump-status"]);
  if (!out.includes("live threads=")) throw new Error("Client did not reach a live authenticated session");
  console.log("Windows pinned-server authentication and live snapshot: passed");
} finally {
  if (server) { server.kill(); await server.exited; }
  await rm(root, { recursive: true, force: true });
}
