import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { recorderStatus, sanitizePcm, startRecording } from "./dictation";
import { systemHost } from "./portable";
test("SSH capture requires an explicit recorder and PCM sanitization rejects nonfinite samples", () => {
  const host = { platform: "linux", env: { SSH_CONNECTION: "remote" }, which: () => "/bin/tool" };
  expect(recorderStatus(host, undefined).ready).toBe(false);
  expect(recorderStatus(host, ["custom"]).ready).toBe(true);
  const samples = new Float32Array([NaN, Infinity, -2, 2, 0.5]);
  expect([...new Float32Array(sanitizePcm(new Uint8Array(samples.buffer)).buffer)]).toEqual([
    0, 0, -1, 1, 0.5,
  ]);
});
test("recorder stop flushes PCM and cancel terminates the child", async () => {
  // The grace must outlast the child's startup: a slow runner (macOS CI) can take over 100 ms to
  // run the script, and a SIGINT before its handler exists kills it with no audio.
  const host = systemHost();
  const script =
    'process.stdout.write(Buffer.alloc(640)); process.on("SIGINT",()=>process.exit(0)); setInterval(()=>{},1000)';
  const recording = await startRecording(host, [process.execPath, "-e", script], {
    startGraceMs: 1500,
  });
  const pcm = await recording.stop();
  expect(pcm.length).toBe(640);
  expect(await recording.stop()).toBe(pcm);
  const second = await startRecording(host, [process.execPath, "-e", script], {
    startGraceMs: 1500,
  });
  second.cancel();
  second.cancel();
});
test("a recorder that exits after starting reports it through onFailure", async () => {
  let failure: Error | undefined;
  const reported = new Promise<void>((done) => {
    void startRecording(
      systemHost(),
      [process.execPath, "-e", 'setTimeout(()=>{console.error("device gone");process.exit(3)},150)'],
      {
        startGraceMs: 50,
        onFailure: (error) => {
          failure = error;
          done();
        },
      },
    );
  });
  await reported;
  expect(failure?.message).toContain("exited with 3: device gone");
});

test("bad recorder arguments fail at startup", async () => {
  await expect(
    startRecording(systemHost(), [process.execPath, "-e", "process.exit(2)"]),
  ).rejects.toThrow("exited with 2");
});

test("cancel releases the operating-system recorder process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tercet-capture-test-"));
  const file = join(dir, "pid");
  let recording: Awaited<ReturnType<typeof startRecording>> | undefined;
  try {
    const script = `require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(()=>{},1000)`;
    recording = await startRecording(systemHost(), [process.execPath, "-e", script], {
      startGraceMs: 100,
    });
    const pid = Number(readFileSync(file, "utf8"));
    recording.cancel();
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      await Bun.sleep(10);
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  } finally {
    recording?.cancel();
    rmSync(dir, { recursive: true, force: true });
  }
});
