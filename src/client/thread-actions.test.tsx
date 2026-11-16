import { claude } from "./usage-fixture";
import { paneGlyphs } from "./icons";
import { act } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  CommandId,
  OrchestrationV2ThreadShell,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { createClient, waitForLive, type Client } from "./runtime";
import { allThreads, createThreadActions, fuzzyScore } from "./thread-actions";
import { platform } from "./platform";
import { connectionConfig } from "./config";
import { sandboxUrl, tokenPath } from "../sandbox";
import { AppFrame } from "./frame";

const at = DateTime.makeUnsafe("2026-11-08T12:00:00Z");
const shell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell)({
  id: "one",
  projectId: "project-a",
  title: "A thread with a long searchable name",
  providerInstanceId: "opencode",
  modelSelection: { instanceId: "opencode", model: "opencode/flint-40b-free" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "one" },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
});
function waitAtom<A>(
  client: Client,
  atom: import("effect/reactivity/Atom").Atom<A>,
  predicate: () => boolean,
) {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Sandbox state timeout"));
    }, 20000);
    const changed = () => {
      if (predicate()) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    };
    const first = client.registry.subscribe(atom, changed);
    const second = client.registry.subscribe(client.archives, changed);
    const unsubscribe = () => {
      first();
      second();
    };
  });
}
test("fuzzy abbreviated title and action matching", () => {
  expect(fuzzyScore("Unarchive", "uar")).toBeGreaterThan(0);
  expect(fuzzyScore("Thread palette", "tplt")).toBeGreaterThan(0);
  expect(fuzzyScore("rename", "xyz")).toBe(-1);
});
test("thread menu by key and right mouse, fuzzy palette, rename and delete confirmation", async () => {
  const commands: OrchestrationV2Command[] = [];
  let searchDone!: () => void;
  const searched = new Promise<void>((resolve) => {
    searchDone = resolve;
  });
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
      search: (_, query) =>
        Effect.sync(() => {
          searchDone();
          return {
            matches: [
              {
                threadId: shell.id,
                projectId: shell.projectId,
                source: "assistant",
                snippet: `Found ${query}`,
                messageCreatedAt: null,
              },
            ],
          };
        }),
      workspaceRefs: () => Effect.succeed([]),
      dispatch: (_, command) =>
        Effect.sync(() => {
          commands.push(command);
        }),
    },
    false,
  );
  client.start();
  // Connection supervision loads the test token before dispatch.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  client.registry.set(client.snapshot, {
    schemaVersion: 2,
    projects: [
      {
        id: shell.projectId,
        title: "Fixture",
        workspaceRoot: "/fixture",
        defaultModelSelection: shell.modelSelection,
        scripts: [],
        createdAt: "2026-11-08T12:00:00Z",
        updatedAt: "2026-11-08T12:00:00Z",
      },
    ],
    threads: [shell],
    archivedThreads: [],
    snapshotSequence: 0,
  });
  client.openThread(shell.id);
  const view = await testRender(<AppFrame client={client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  async function key(name: string, ctrl = false) {
    await act(async () => view.mockInput.pressKey(name, { ctrl }));
    await view.flush();
  }
  async function type(text: string) {
    await act(async () => {
      await view.mockInput.typeText(text);
    });
    await view.flush();
  }
  try {
    // The new-thread picker owns the keyboard: `.` and `?` do not reach the commands behind it.
    await key("n", true);
    await type("v1.2 fix?");
    expect(view.captureCharFrame()).toContain("j/k project");
    expect(view.captureCharFrame()).not.toContain("Thread actions");
    await key("ESCAPE");
    await key(".");
    expect(view.captureCharFrame()).toContain("Thread actions");
    await type("rename");
    await key("RETURN");
    await type("Changed name");
    await key("RETURN");
    expect(commands.at(-1)).toMatchObject({
      type: "thread.metadata.update",
      title: "Changed name",
    });
    await key("p", true);
    await type("undo");
    await key("RETURN");
    expect(commands.at(-1)).toMatchObject({ type: "thread.metadata.update", title: shell.title });
    await key(".");
    await type("delete");
    await key("RETURN");
    expect(view.captureCharFrame()).toContain("cannot be undone");
    await key("RETURN");
    expect(commands.some((c) => c.type === "thread.delete")).toBe(false);
    await key("ESCAPE");
    await key("p", true);
    await type("lngsrch");
    expect(view.captureCharFrame()).toContain(shell.title);
    await key("RETURN");
    expect(client.registry.get(client.selectedThreadId)).toBe(shell.id);
    await key("/", true);
    expect(view.captureCharFrame()).toContain("Cross-thread search");
    await type("needle");
    await act(async () => {
      await searched;
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Found needle");
    await key("RETURN");
    expect(client.registry.get(client.selectedThreadId)).toBe(shell.id);
    // Locate the actual sidebar row, so wrapping/header changes do not move the target.
    const y = view
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.slice(0, 30).includes("A thread with"));
    await act(async () => {
      await view.mockMouse.click(8, y, 2);
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Thread actions");
    const pinY = view
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => /  Pin /.test(line));
    await act(async () => {
      await view.mockMouse.click(30, pinY);
    });
    await view.flush();
    expect(commands.at(-1)?.type).toBe("thread.pin");
    await key("n", true);
    expect(view.captureCharFrame()).toContain("j/k project");
    await key("RETURN");
    await view.waitForFrame(() => commands.at(-1)?.type === "thread.create");
    expect(commands.at(-1)).toMatchObject({ type: "thread.create", projectId: shell.projectId });
    await view.waitForFrame((frame) => frame.includes("Model · Favorites first"));
    const created = commands.at(-1)!;
    if (created.type !== "thread.create") throw new Error("Expected thread creation");
    await act(async () =>
      client.registry.set(client.providers, [
        {
          ...claude([]),
          models: [{ slug: "opus", name: "Opus", isCustom: false, capabilities: null }],
        },
      ]),
    );
    await key("RETURN");
    expect(commands.slice(-2)).toMatchObject([
      {
        type: "thread.model-selection.set",
        threadId: created.threadId,
        modelSelection: { model: "opus" },
      },
      { type: "thread.runtime-mode.set", threadId: created.threadId, runtimeMode: "full-access" },
    ]);
    await view.waitForFrame((frame) => frame.includes(`● ${paneGlyphs.composer} Composer`));
    await act(async () => {
      client.openThread(shell.id);
    });
    await view.flush();
    // A new thread leaves focus in the composer, where `.` is text.
    await key("ESCAPE");
    await key(".");
    await type("delete");
    await key("RETURN");
    await type("DELETE");
    await key("RETURN");
    expect(commands.at(-1)?.type).toBe("thread.delete");
  } finally {
    await view.dispose();
    await client.dispose();
  }
});

test.skipIf(process.env.TERCET_SANDBOX_TEST !== "1")(
  "sandbox actions and reverses, fork lineage, delete and search",
  async () => {
    const config = await connectionConfig(
      ["--url", sandboxUrl, "--token-file", tokenPath],
      async () => undefined,
      "/unused",
    );
    const client = createClient(platform(config), false);
    client.start();
    await waitForLive(client);
    const actions = createThreadActions(client);
    const source = allThreads(client).find(
      (t) =>
        t.latestRunId &&
        !t.archivedAt &&
        t.modelSelection.instanceId === "opencode" &&
        t.status === "completed",
    );
    const seed = source ?? allThreads(client).find((t) => !t.archivedAt);
    expect(seed).toBeDefined();
    let id: Awaited<ReturnType<typeof actions.run>>;
    const created: NonNullable<typeof id>[] = [];
    try {
      id = await actions.run("new", seed);
      created.push(id!);
      await waitAtom(client, client.snapshot, () => allThreads(client).some((t) => t.id === id));
      const thread = () => allThreads(client).find((t) => t.id === id)!;
      await actions.undo();
      await waitAtom(client, client.snapshot, () => !!thread()?.archivedAt);
      await actions.run("unarchive", thread());
      await waitAtom(client, client.snapshot, () => !!thread() && !thread().archivedAt);
      for (const [action, reverse, check] of [
        ["settle", "unsettle", () => !!thread()?.settledAt],
        ["pin", "unpin", () => !!thread()?.pinnedAt],
        ["archive", "unarchive", () => !!thread()?.archivedAt],
      ] as const) {
        console.log("sandbox action", action);
        await actions.run(action, thread());
        await waitAtom(client, client.snapshot, check);
        expect(check()).toBe(true);
        await actions.run(reverse, thread());
        await waitAtom(client, client.snapshot, () => !check());
        expect(check()).toBe(false);
      }
      await actions.run("rename", thread(), "tercet step11 renamed");
      await waitAtom(client, client.snapshot, () => thread()?.title === "tercet step11 renamed");
      await actions.undo();
      await waitAtom(client, client.snapshot, () => thread()?.title === "New thread");
      await actions.undo(); // no-op when there is nothing to undo
      if (!source)
        throw new Error("Sandbox needs a completed free-model source for fork verification");
      client.openThread(source.id);
      await waitAtom(client, client.transcripts, () => !!client.getThread(source.id).projection);
      const fork = await actions.run("fork", source);
      created.push(fork!);
      await waitAtom(client, client.snapshot, () => allThreads(client).some((t) => t.id === fork));
      const child = allThreads(client).find((t) => t.id === fork)!;
      expect(child.lineage.parentThreadId).toBe(source.id);
      await actions.run("parent", child);
      expect(client.registry.get(client.selectedThreadId)).toBe(source.id);
      await actions.undo();
      await waitAtom(
        client,
        client.snapshot,
        () => !!allThreads(client).find((t) => t.id === fork)?.archivedAt,
      );
      await actions.run(
        "unarchive",
        allThreads(client).find((t) => t.id === fork)!,
      );
      expect((await client.search("composer-sandbox-ok")).matches.length).toBeGreaterThan(0);
      await expect(actions.run("delete", thread())).rejects.toThrow("Confirm");
      await actions.run("delete", thread(), undefined, true);
      await waitAtom(client, client.snapshot, () => !allThreads(client).some((t) => t.id === id));
      expect(allThreads(client).some((t) => t.id === id)).toBe(false);
      console.log(
        "sandbox new, settle/unsettle, pin/unpin, rename/undo, archive/unarchive, fork/parent/archive/unarchive, search, confirmed delete passed",
      );
    } finally {
      for (const threadId of created)
        await client
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId,
          })
          .catch(() => {});
      await client.dispose();
    }
  },
  90000,
);
