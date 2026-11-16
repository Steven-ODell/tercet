// Private acceptance entry: real sandbox transport, deterministic request/diff fixtures.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  RuntimeRequestId,
  NodeId,
  ProviderSessionId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ThreadProjection,
  ORCHESTRATION_V2_WS_METHODS as RPC,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { withSandbox, sandboxUrl, tokenPath } from "../src/sandbox";
import { connectionConfig } from "../src/client/config";
import { platform, readOptional } from "../src/client/platform";
import { createClient, waitForLive } from "../src/client/runtime";
import { AppFrame } from "../src/client/frame";
import { hostActions, systemHost } from "../src/portable";
import { terminalLifecycle } from "../src/terminal-lifecycle";

const id = ThreadId.make(`tercet-acceptance-${crypto.randomUUID()}`);
await Effect.runPromise(
  withSandbox((session) =>
    Effect.gen(function* () {
      const snapshots = yield* session.client[RPC.subscribeShell]({}).pipe(
        Stream.filter((i) => i.kind === "snapshot"),
        Stream.take(1),
        Stream.runCollect,
      );
      const project = snapshots[0]?.snapshot.projects[0];
      if (!project) throw new Error("Sandbox project missing");
      yield* session.client[RPC.launchThread]({
        commandId: CommandId.make(crypto.randomUUID()),
        threadId: id,
        projectId: project.id,
        title: "tercet acceptance sandbox",
        generateTitle: false,
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opencode/flint-40b-free",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
    }),
  ),
);
// An empty settings file in the sandbox HOME: the actions are what a stranger gets by default.
const home = process.env.HOME!;
await Bun.write(`${home}/.config/tercet/settings.json`, "{}\n");
const config = await connectionConfig(
  ["--url", sandboxUrl, "--token-file", tokenPath],
  readOptional,
  home,
  {},
);
if (!config.settingsFound) throw new Error("Acceptance settings file missing");
const boundary = platform(config);
const dir = process.env.TERCET_ACCEPTANCE_CONTROL!;
let answered = false;
const client = createClient(
  {
    ...boundary,
    follow: (token, receive, config, archive) =>
      boundary.follow(
        token,
        (item) => {
          if (item.kind === "snapshot")
            receive({
              ...item,
              snapshot: {
                ...item.snapshot,
                threads: item.snapshot.threads.filter((t) => t.id === id),
                archivedThreads: [],
              },
            });
          else receive(item);
        },
        config,
        archive,
      ),
    drafts: { read: async () => ({}), write: async () => {} },
    dispatch: (token, command) => {
      if (
        command.type === "runtime-request.respond" &&
        command.requestId === "acceptance-question"
      ) {
        answered = true;
        return Effect.promise(() => Bun.write(`${dir}/answered`, JSON.stringify(command)));
      }
      if (
        "modelSelection" in command &&
        command.modelSelection?.model !== "opencode/flint-40b-free"
      )
        return Effect.fail(new Error("Only the authorized free model is allowed"));
      return boundary.dispatch(token, command);
    },
  },
  false,
);
client.start();
await waitForLive(client);
client.openThread(id);
const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
terminalLifecycle(renderer, () => client.dispose());
// No display variables, so the clipboard chain cannot reach the real desktop clipboard.
const effects = hostActions({
  settings: config.settings,
  host: systemHost({ ...process.env, WAYLAND_DISPLAY: undefined, DISPLAY: undefined }),
  writeTerminal: (bytes) => process.stdout.write(bytes),
});
createRoot(renderer).render(<AppFrame client={client} effects={effects} />);
const timer = setInterval(async () => {
  const state = client.getThread(id);
  if (!state.projection) return;
  if (
    (await Bun.file(`${dir}/question`).exists()) &&
    !answered &&
    !state.projection.runtimeRequests.some((r) => r.id === "acceptance-question")
  ) {
    // Local presenter fixture omits persisted timeline metadata.
    const item = {
      type: "user_input_request" as const,
      requestId: "acceptance-question",
      questions: [
        {
          id: "q",
          header: "Fixture",
          question: "Acceptance fixture: choose Purple",
          multiSelect: false,
          options: [{ label: "Purple", description: "Accent" }],
        },
      ],
    } as unknown as Extract<
      OrchestrationV2ThreadProjection["turnItems"][number],
      { type: "user_input_request" }
    >;
    client.registry.set(
      client.transcripts,
      new Map([
        [
          id,
          {
            ...state,
            projection: {
              ...state.projection,
              turnItems: [...state.projection.turnItems, item],
              visibleTurnItems: [
                ...state.projection.visibleTurnItems,
                {
                  item,
                  visibility: "local",
                } as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"][number],
              ],
              runtimeRequests: [
                ...state.projection.runtimeRequests,
                {
                  id: RuntimeRequestId.make("acceptance-question"),
                  nodeId: NodeId.make("acceptance-fixture"),
                  providerTurnId: null,
                  nativeRequestRef: null,
                  resolvedAt: null,
                  status: "pending",
                  kind: "user_input",
                  responseCapability: {
                    type: "live",
                    providerSessionId: ProviderSessionId.make("acceptance-fixture"),
                  },
                  createdAt: DateTime.nowUnsafe(),
                },
              ],
            },
          },
        ],
      ]),
    );
  }
  if (await Bun.file(`${dir}/diff`).exists()) {
    client.diffs.full = async (input) => ({
      ...input,
      fromTurnCount: 0,
      diff: "diff --git a/acceptance-fixture.ts b/acceptance-fixture.ts\n--- a/acceptance-fixture.ts\n+++ b/acceptance-fixture.ts\n@@ -1 +1 @@\n-old fixture\n+purple fixture\n",
    });
    if (!state.projection.checkpoints.length)
      client.registry.set(
        client.transcripts,
        new Map([
          [
            id,
            {
              ...state,
              projection: {
                ...state.projection,
                checkpoints: [
                  {
                    runId: state.projection.runs[0]?.id ?? "fixture",
                    appRunOrdinal: 1,
                    status: "ready",
                    files: [],
                    capturedAt: DateTime.nowUnsafe(),
                  } as unknown as OrchestrationV2Checkpoint,
                ],
              },
            },
          ],
        ]),
      );
    await Bun.write(`${dir}/diff-ready`, "ready");
  }
}, 100);
client.addFinalizer(async () => {
  clearInterval(timer);
});
