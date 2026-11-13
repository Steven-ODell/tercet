// Explicit integration check: writes only to the fixed sandbox, using the free model.
import {
  CommandId,
  RunId,
  MessageId,
  ThreadId,
  ProviderInstanceId,
  ORCHESTRATION_V2_WS_METHODS as RPC,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { withSandbox } from "./connect";
import { fileURLToPath } from "node:url";

const threadId = ThreadId.make(`tercet-smoke-${crypto.randomUUID()}`);
const modelSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "opencode/flint-40b-free",
};
await Effect.runPromise(
  withSandbox((session) =>
    Effect.gen(function* () {
      const snapshots = yield* session.client[RPC.subscribeShell]({}).pipe(
        Stream.filter((i) => i.kind === "snapshot"),
        Stream.take(1),
        Stream.runCollect,
      );
      const project = snapshots[0]?.snapshot.projects[0];
      if (!project) throw new Error("Seeded sandbox needs a project");
      yield* session.client[RPC.launchThread]({
        commandId: CommandId.make(crypto.randomUUID()),
        threadId,
        projectId: project.id,
        title: "tercet step 2 free-model smoke",
        generateTitle: false,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
    }),
  ),
);
console.log(`thread=${threadId}`);
const child = Bun.spawn(
  ["bun", "run", fileURLToPath(new URL("./connect.ts", import.meta.url)), "--follow", threadId],
  { stdout: "pipe", stderr: "inherit" },
);
async function follow() {
  let runId: string | undefined;
  try {
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let sent = false;
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Follow ended before a live provider event");
      buffered += value;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const item = JSON.parse(line);
        if (item.kind === "synchronized" && !sent) {
          sent = true;
          await Effect.runPromise(
            withSandbox((s) =>
              s.client[RPC.dispatchCommand]({
                type: "message.dispatch",
                commandId: CommandId.make(crypto.randomUUID()),
                threadId,
                messageId: MessageId.make(crypto.randomUUID()),
                text: "Reply with exactly sandbox-connected. Do not use tools or change any files.",
                attachments: [],
                createdBy: "user",
                creationSource: "server",
                modelSelection,
                dispatchMode: { type: "start_immediately" },
              }),
            ),
          );
        }
        if (item.kind === "event") {
          runId = item.event.runId ?? runId;
          console.log(`live ${item.event.type} sequence=${item.sequence}`);
          if (item.event.type === "provider-turn.updated") {
            console.log(JSON.stringify(item.event));
            return;
          }
        }
      }
    }
  } finally {
    child.kill();
    await child.exited;
    if (runId)
      await Effect.runPromise(
        withSandbox((s) =>
          s.client[RPC.dispatchCommand]({
            type: "run.interrupt",
            runId: RunId.make(runId!),
            holdQueue: true,
            commandId: CommandId.make(crypto.randomUUID()),
            threadId,
          }),
        ),
      );
  }
}
await follow();
