// Private tmux capture entry: the real frame on a fixture conversation, no server or token.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import * as Effect from "effect/Effect";
import type { OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import { createClient } from "../src/client/runtime";
import { AppFrame } from "../src/client/frame";
import { fixtureNow, flatFixture } from "../src/client/sidebar-fixture";
import { emptyTranscript } from "../src/client/transcript-state";

const snapshot = flatFixture();
const threadId: ThreadId = snapshot.threads[0]!.id;
const row = (id: string, type: string, values: object) => ({
  sourceThreadId: threadId,
  sourceItemId: id,
  item: { id, type, status: "completed", runId: "run", ...values },
});
const projection = {
  thread: { id: threadId },
  visibleTurnItems: [
    row("u1", "user_message", { text: "Add a line between speakers." }),
    row("c1", "command_execution", { input: "rg measureMarkdown" }),
    row("c2", "command_execution", { input: "bun test" }),
    row("a1", "assistant_message", { text: "Tests pass.\n\n- One rule per change" }),
    row("a2", "assistant_message", { text: "A second reply stays on the same side." }),
    row("u2", "user_message", { text: "Show me." }),
    row("u3", "user_message", { text: "Two in a row each get a line." }),
    row("a3", "assistant_message", {
      text: "Here it is.\n\n```bash\nssh user@192.168.1.10 \"ls -la /var/www/\"\nnice -n 10 make\n```\n\n```python\nprint('no run button on this one')\n```",
    }),
    row("a4", "assistant_message", {
      text: "| Button | Key | What it does |\n| --- | :-: | --- |\n| `[copy]` | y | Copies to the clipboard of the device you're at, including over SSH |\n| `[run]` | x | Types it into a new tmux session 界 and presses Enter |\n\nA | in prose stays text.",
    }),
  ],
} as unknown as OrchestrationV2ThreadProjection;

const client = createClient(
  {
    readToken: () => Effect.succeed("fake"),
    issueToken: () => Effect.die("no issuance"),
    wake: () => Effect.void,
    pause: () => Effect.never,
    follow: () => Effect.never,
  },
  false,
  () => Date.parse(fixtureNow),
);
client.registry.set(client.snapshot, snapshot);
client.registry.set(client.status, "live");
client.registry.set(client.transcripts, new Map([[threadId, { ...emptyTranscript, projection }]]));
client.openThread(threadId);
createRoot(await createCliRenderer({ exitOnCtrlC: true })).render(<AppFrame client={client} />);
