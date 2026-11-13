import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { connectionConfig } from "../src/client/config";
import { platform } from "../src/client/platform";
import { createClient, waitForLive } from "../src/client/runtime";
import { AppFrame } from "../src/client/frame";

const config = await connectionConfig(
  ["--read-only", "--token-file", process.argv[2]!],
  async (path) =>
    Bun.file(path)
      .exists()
      .then((exists) => (exists ? Bun.file(path).text() : undefined)),
);
const client = createClient(platform(config), false);
try {
  client.start();
  await waitForLive(client);
  const thread = client.registry.get(client.snapshot)?.threads[0];
  if (!thread) throw new Error("No live threads");
  client.openThread(thread.id);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error("Live transcript timeout"));
    }, 30000);
    const done = () => {
      if (!client.getThread(thread.id).projection) return;
      clearTimeout(timeout);
      stop();
      resolve();
    };
    const stop = client.registry.subscribe(client.transcripts, done);
    done();
  });
  const view = await testRender(<AppFrame client={client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await act(async () => {
      await view.flush();
    });
    await view.waitForFrame((f) => f.includes("Threads") && f.includes("Transcript"));
    const frame = view.captureCharFrame();
    await Bun.write("/tmp/tercet-step20-live-frame.txt", frame);
    if (!frame.includes("Threads") || !frame.includes("Transcript"))
      throw new Error("Live frame missing sidebar or selected title");
    const projection = client.getThread(thread.id).projection!;
    if (!projection.visibleTurnItems.length) throw new Error("Live transcript empty");
    // Screens stay private: real threads may contain sensitive information.
    await Bun.write("/tmp/tercet-step20-live-frame.txt", frame);
    console.log(
      `PASS live read-only sidebar + transcript: ${client.registry.get(client.threadCount)} threads, ${projection.visibleTurnItems.length} visible items; private capture /tmp/tercet-step20-live-frame.txt`,
    );
  } finally {
    await view.dispose();
  }
} finally {
  await client.dispose();
}
