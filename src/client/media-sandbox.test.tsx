import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  CommandId,
  ThreadId,
  ProviderInstanceId,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS as RPC,
} from "@t3tools/contracts";
import { withSandbox, sandboxUrl, tokenPath } from "../sandbox";
import { connectionConfig } from "./config";
import { platform } from "./platform";
import { createClient, waitForLive } from "./runtime";
import { createComposer } from "./composer-state";
import { createThreadActions } from "./thread-actions";
import { workspaceChoices } from "./workspace";

test.skipIf(process.env.TERCET_SANDBOX_TEST !== "1")(
  "sandbox PNG upload/send persists bytes and chosen worktree without provider dispatch",
  async () => {
    const config = await connectionConfig(
      ["--url", sandboxUrl, "--token-file", tokenPath],
      async () => undefined,
      "/unused",
    );
    const boundary = platform(config);
    const client = createClient(
      {
        ...boundary,
        drafts: undefined,
        // Exercise the full send/upload path but defer execution: no provider process or usage.
        dispatch: (token, command) =>
          boundary.dispatch(
            token,
            command.type === "message.dispatch"
              ? { ...command, dispatchMode: { type: "defer_start" } }
              : command,
          ),
      },
      false,
    );
    client.start();
    await waitForLive(client);
    let id: ThreadId | undefined;
    try {
      const snapshot = client.registry.get(client.snapshot)!;
      // TERCET_SANDBOX_PROJECT and TERCET_SANDBOX_WORKTREE pick a project root and one of its
      // worktrees; otherwise the first project and its first worktree are used.
      const project =
        snapshot.projects.find((p) => p.workspaceRoot === process.env.TERCET_SANDBOX_PROJECT) ??
        snapshot.projects[0];
      if (!project) throw new Error("Sandbox has no project");
      const refs = await client.workspaceRefs(project.workspaceRoot);
      const chosen = workspaceChoices(project.workspaceRoot, refs).find(
        (row) =>
          row.worktreePath != null &&
          (process.env.TERCET_SANDBOX_WORKTREE === undefined ||
            row.worktreePath === process.env.TERCET_SANDBOX_WORKTREE),
      );
      if (!chosen) throw new Error("Sandbox project has no worktree returned by VCS");
      client.registry.set(client.snapshot, {
        ...snapshot,
        projects: [project, ...snapshot.projects.filter((p) => p.id !== project.id)],
      });
      client.registry.set(client.newModelSelection, {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opencode/flint-40b-free",
      });
      id = await createThreadActions(client).run("new", undefined, undefined, false, chosen);
      expect(id).toBeDefined();
      const png = new Uint8Array(
        await Bun.file(new URL("../fixtures/clipboard.png", import.meta.url)).arrayBuffer(),
      );
      const composer = createComposer(client);
      composer.attach(id!, png);
      composer.setDraft(id!, "step17 fixture image (deferred, no provider)");
      expect(await composer.send(id!)).toBe(true);
      // Read the durable snapshot over a fresh scoped session, independent of the optimistic UI.
      // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
      await Effect.runPromise(
        withSandbox((session) =>
          Effect.gen(function* () {
            const frames = yield* session.client[RPC.subscribeThread]({ threadId: id! }).pipe(
              Stream.filter((item) => item.kind === "snapshot"),
              Stream.take(1),
              Stream.runCollect,
            );
            const frame = frames[0];
            if (!frame || frame.kind !== "snapshot") throw new Error("Missing snapshot");
            expect(frame.projection.thread).toMatchObject(chosen);
            const message = frame.projection.messages.find((m) =>
              m.text.includes("step17 fixture"),
            );
            expect(message?.attachments[0]).toMatchObject({
              name: "clipboard.png",
              mimeType: "image/png",
              sizeBytes: png.length,
            });
            const asset = yield* session.client[WS_METHODS.assetsCreateUrl]({
              resource: { _tag: "attachment", attachmentId: message!.attachments[0]!.id },
            });
            const stored = yield* Effect.promise(
              async () =>
                new Uint8Array(
                  await (await fetch(new URL(asset.relativeUrl, sandboxUrl))).arrayBuffer(),
                ),
            );
            expect(stored).toEqual(png);
            expect(frame.projection.runs.every((run) => run.status === "preparing")).toBe(true);
          }),
        ),
      );
    } finally {
      if (id)
        await client.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: id,
        });
      await client.dispose();
    }
  },
  45000,
);
