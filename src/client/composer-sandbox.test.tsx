import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS as RPC,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { withSandbox, sandboxUrl, tokenPath } from "../spikes/connect";
import { createClient, waitForLive, type Client } from "./runtime";
import { platform } from "./platform";
import { connectionConfig } from "./config";
import { AppFrame } from "./frame";
import { createComposer } from "./composer-state";
import { createThreadActions } from "./thread-actions";

function waitProjection(client: Client, id: ThreadId, predicate: () => boolean) {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Sandbox composer stream timeout"));
    }, 75000);
    const unsubscribe = client.registry.subscribe(client.transcripts, () => {
      if (predicate()) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}
test.skipIf(process.env.TERCET_SANDBOX_TEST !== "1")(
  "sandbox typed composer sends explicitly free model and streams assistant text into frame",
  async () => {
    const id = ThreadId.make(`tercet-composer-${crypto.randomUUID()}`);
    // Bun/OpenTUI requires its own renderer harness; the scoped sandbox helper owns this Effect runtime.
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
    await Effect.runPromise(
      withSandbox((session) =>
        Effect.gen(function* () {
          const snapshots = yield* session.client[RPC.subscribeShell]({}).pipe(
            Stream.filter((item) => item.kind === "snapshot"),
            Stream.take(1),
            Stream.runCollect,
          );
          const project = snapshots[0]?.snapshot.projects[0];
          if (!project) throw new Error("No sandbox project");
          yield* session.client[RPC.launchThread]({
            commandId: CommandId.make(crypto.randomUUID()),
            threadId: id,
            projectId: project.id,
            title: "tercet step 10 composer smoke",
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
    const config = await connectionConfig(
      ["--url", sandboxUrl, "--token-file", tokenPath],
      async () => undefined,
      "/unused",
    );
    const boundary = platform(config);
    const client = createClient(
      {
        ...boundary,
        drafts: { read: async () => ({}), write: async () => {} },
        sendShortcut: async () => "enter",
      },
      false,
    );
    client.start();
    await waitForLive(client);
    const loaded = waitProjection(client, id, () => !!client.getThread(id).projection);
    client.openThread(id);
    await loaded;
    const view = await testRender(<AppFrame client={client} />, {
      width: 120,
      height: 40,
      kittyKeyboard: true,
      exitOnCtrlC: false,
    });
    let assistantUpdates = 0;
    const unsubscribe = client.registry.subscribe(client.transcripts, () => {
      if (
        client
          .getThread(id)
          .projection?.visibleTurnItems.some(
            (row) => row.item.type === "assistant_message" && row.item.text.length > 0,
          )
      )
        assistantUpdates++;
    });
    try {
      await act(async () => view.mockInput.pressKey("TAB"));
      await view.flush();
      await act(async () => {
        await view.mockInput.typeText(
          process.env.TERCET_RESTART_TEST === "1"
            ? "Begin with composer-sandbox-ok then write 500 numbered lines about terminal clients. Do not use tools or change files."
            : "Reply with exactly composer-sandbox-ok. Do not use tools or change files.",
        );
      });
      await view.flush();
      expect(view.captureCharFrame()).toContain("composer-sandbox-ok");
      const streamed = waitProjection(
        client,
        id,
        () =>
          client
            .getThread(id)
            .projection?.visibleTurnItems.some(
              (row) =>
                row.item.type === "assistant_message" &&
                row.item.text.includes("composer-sandbox-ok"),
            ) === true,
      );
      await act(async () => view.mockInput.pressKey("RETURN"));
      await act(async () => {
        await streamed;
      });
      await view.flush();
      expect(assistantUpdates).toBeGreaterThan(0);
      expect(view.captureCharFrame()).toContain("composer-sandbox-ok");
      if (process.env.TERCET_RESTART_TEST === "1") {
        expect(
          client
            .getThread(id)
            .projection?.runs.some((run) =>
              ["preparing", "starting", "running", "waiting"].includes(run.status),
            ),
        ).toBe(true);
        await act(async () => {
          await view.mockInput.typeText("draft survives server restart");
        });
        await view.flush();
        const previous = client.getThread(id).projection;
        const offline = new Promise<void>((resolve) => {
          const stop = client.registry.subscribe(client.status, (status) => {
            if (status === "retry") {
              stop();
              resolve();
            }
          });
        });
        const script = new URL("../../scripts/sandbox.sh", import.meta.url).pathname;
        const stop = Bun.spawn(["bash", script, "down"], { stdout: "ignore", stderr: "ignore" });
        expect(await stop.exited).toBe(0);
        await offline;
        expect(client.registry.get(client.selectedThreadId)).toBe(id);
        const start = Bun.spawn(["bash", script, "up"], { stdout: "ignore", stderr: "ignore" });
        expect(await start.exited).toBe(0);
        await act(async () => {
          await waitForLive(client, 60000);
          await waitProjection(
            client,
            id,
            () => client.getThread(id).projection !== previous && !client.getThread(id).error,
          );
        });
        await view.flush();
        expect(view.captureCharFrame()).toContain("draft survives server restart");
        expect(
          client
            .getThread(id)
            .projection?.visibleTurnItems.some(
              (row) =>
                row.item.type === "assistant_message" &&
                row.item.text.includes("composer-sandbox-ok"),
            ),
        ).toBe(true);
        console.log(
          "sandbox killed mid-assistant-stream; automatic shell/transcript recovery; draft preserved",
        );
      }
      if (process.env.TERCET_RESTART_TEST !== "1")
        await act(async () => {
          await waitProjection(
            client,
            id,
            () =>
              !client
                .getThread(id)
                .projection?.runs.some((run) =>
                  ["preparing", "starting", "running", "waiting"].includes(run.status),
                ),
          );
        });
      console.log(`free-model=opencode/flint-40b-free assistant-updates=${assistantUpdates}`);
    } finally {
      unsubscribe();
      await view.dispose();
      const active = client
        .getThread(id)
        .projection?.runs.findLast((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        );
      if (active)
        await client
          .dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId: id,
            runId: active.id,
            holdQueue: true,
          })
          .catch(() => {
            /* Completion can win the cleanup race. */
          });
      await client.dispose();
    }
  },
  95000,
);

// Real-server proof of title seeding: blank name -> seed -> generated title; named stays named;
// a second message retitles neither. Prints every title each thread passed through.
test.skipIf(process.env.TERCET_SANDBOX_TEST !== "1")(
  "sandbox titles: blank-named thread is named from its first message, named thread keeps its name",
  async () => {
    const config = await connectionConfig(
      ["--url", sandboxUrl, "--token-file", tokenPath],
      async () => undefined,
      "/unused",
    );
    const client = createClient(
      {
        ...platform(config),
        drafts: { read: async () => ({}), write: async () => {} },
        sendShortcut: async () => "enter",
      },
      false,
    );
    client.start();
    await waitForLive(client);
    const project = client.registry.get(client.snapshot)!.projects[0]!;
    client.registry.set(client.newModelSelection, {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "opencode/flint-40b-free",
    });
    const actions = createThreadActions(client);
    const composer = createComposer(client);
    const seen = new Map<string, string[]>();
    const titleOf = (id: string) =>
      client.registry.get(client.snapshot)?.threads.find((t) => t.id === id)?.title;
    const unsubscribe = client.registry.subscribe(client.snapshot, () => {
      for (const id of seen.keys()) {
        const title = titleOf(id);
        const list = seen.get(id)!;
        if (title !== undefined && list.at(-1) !== title) list.push(title);
      }
    });
    const until = async (what: string, ok: () => boolean, ms = 60000) => {
      const end = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > end) throw new Error(`timeout: ${what}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    // Only the selected thread streams a projection, so completion is read from the shell.
    const finished = (id: ThreadId) => {
      const shell = client.registry.get(client.snapshot)?.threads.find((t) => t.id === id);
      return !!shell?.latestRunCompletedAt && !shell.activeRunId;
    };
    const open = async (name?: string) => {
      const id = (await actions.run("new", undefined, name, false, undefined, project.id))!;
      seen.set(id, []);
      await until("thread in snapshot", () => titleOf(id) !== undefined);
      return id;
    };
    const say = async (id: ThreadId, text: string) => {
      composer.setDraft(id, text);
      expect(await composer.send(id)).toBe(true);
      await until("reply", () => finished(id), 90000).catch((error) => {
        const shell = client.registry.get(client.snapshot)?.threads.find((t) => t.id === id);
        console.log(
          `stuck: run=${shell?.latestRunId} active=${shell?.activeRunId} titles=${JSON.stringify(seen.get(id))}`,
        );
        throw error;
      });
    };
    try {
      const blank = await open();
      const named = await open("My own name");
      const first =
        "Fix the login redirect loop after OAuth callback. Reply with exactly ok. Do not use tools or change files.";
      await say(blank, first);
      await say(named, first);
      await until("generated title", () => (seen.get(blank)?.length ?? 0) >= 3, 45000).catch(
        () => {},
      );
      const afterFirst = { blank: titleOf(blank), named: titleOf(named) };
      await say(blank, "Now reply with exactly done. Do not use tools.");
      await say(named, "Now reply with exactly done. Do not use tools.");
      await new Promise((r) => setTimeout(r, 3000));
      console.log(`blank titles: ${JSON.stringify(seen.get(blank))}`);
      console.log(`named titles: ${JSON.stringify(seen.get(named))}`);
      console.log(
        `after first: ${JSON.stringify(afterFirst)} after second: ${JSON.stringify({ blank: titleOf(blank), named: titleOf(named) })}`,
      );
      expect(seen.get(named)).toEqual(["My own name"]);
      expect(seen.get(blank)![0]).toBe("New thread");
      expect(seen.get(blank)![1]).toStartWith("Fix the login redirect loop");
      expect(seen.get(blank)!.length).toBe(3);
      expect(titleOf(blank)).toBe(afterFirst.blank);
    } finally {
      unsubscribe();
      await client.dispose();
    }
  },
  300000,
);
