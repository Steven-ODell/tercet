import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { RunId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { AppFrame } from "./frame";
import { createClient } from "./runtime";
import { claude } from "./usage-fixture";
import { baseThread } from "./sidebar-fixture";
import {
  canOneClick,
  limitNotice,
  limitText,
  updateCandidates,
  updateKey,
  updateOutcome,
} from "./notice-logic";

const outdated = (extra: Partial<ServerProvider> = {}): ServerProvider => ({
  ...claude([]),
  version: "2.1.0",
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "2.1.0",
    latestVersion: "2.2.0",
    updateCommand: "npm i -g @anthropic-ai/claude-code@latest",
    canUpdate: true,
    checkedAt: null,
    message: null,
  },
  ...extra,
});

test("an outdated provider is offered once per release, one-click when the server can run it", () => {
  const provider = outdated();
  const [candidate] = updateCandidates([provider]);
  expect(candidate).toBeDefined();
  expect(updateKey([candidate!])).toBe("claudeAgent:2.2.0");
  expect(canOneClick(candidate!, [provider])).toBe(true);
  const manual = outdated({
    versionAdvisory: { ...provider.versionAdvisory!, canUpdate: false },
  });
  expect(canOneClick(updateCandidates([manual])[0]!, [manual])).toBe(false);
  expect(updateCandidates([claude([])])).toEqual([]);
  expect(updateCandidates([outdated({ enabled: false })])).toEqual([]);
});

test("an update run reads running, failed and succeeded from the request and updateState", () => {
  const ids = ["claudeAgent"];
  const running = { ids, errors: [], settled: false };
  expect(updateOutcome(running, [outdated()]).phase).toBe("running");
  expect(
    updateOutcome({ ids, errors: ["npm exited 1"], settled: true }, [outdated()]).text,
  ).toContain("update failed: npm exited 1");
  const done = outdated({
    version: "2.2.0",
    versionAdvisory: { ...outdated().versionAdvisory!, status: "current" },
    updateState: { status: "succeeded", startedAt: null, finishedAt: null, message: null, output: null },
  });
  const outcome = updateOutcome({ ids, errors: [], settled: true }, [done]);
  expect(outcome.phase).toBe("succeeded");
  expect(outcome.text).toContain("v2.2.0");
});

const limited = (autoResume?: boolean) => ({
  ...baseThread,
  lastErrorClass: "usage_limit" as const,
  latestRunId: RunId.make("run-1"),
  latestRunCompletedAt: DateTime.makeUnsafe("2026-11-08T12:00:00Z"),
  usageLimitResetAt: "2026-11-08T15:00:00.000Z",
  ...(autoResume === undefined
    ? {}
    : {
        limitRecovery: {
          runId: RunId.make("run-1"),
          resetAt: "2026-11-08T15:00:00.000Z",
          autoResume,
        },
      }),
});

test("a usage-limited thread offers auto-continue and shows whether it is on", () => {
  expect(limitNotice(baseThread)).toBeNull();
  const off = limitNotice(limited())!;
  expect(off.canSchedule).toBe(true);
  expect(off.scheduled).toBe(false);
  expect(limitText(off, Date.parse("2026-11-08T12:00:00Z"))).toContain("auto-continue off");
  expect(limitNotice(limited(true))!.scheduled).toBe(true);
  expect(limitNotice({ ...limited(), usageLimitResetAt: null })!.canSchedule).toBe(false);
});

function liveClient(input: {
  providers?: ServerProvider[];
  thread?: typeof baseThread;
  updates?: unknown[];
  commands?: unknown[];
  dismissed?: string[];
}) {
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: (_token, receive, receiveConfig) =>
        Effect.sync(() => {
          receive({
            kind: "snapshot",
            snapshot: {
              schemaVersion: 1,
              snapshotSequence: 1,
              archivedThreads: [],
              projects: [],
              threads: input.thread ? [input.thread] : [],
            },
          } as never);
          receiveConfig({
            type: "providerStatuses",
            payload: { providers: input.providers ?? [] },
          } as never);
        }).pipe(Effect.andThen(Effect.never)),
      updateProvider: (_token, update) =>
        Effect.sync(() => void input.updates?.push(update)),
      dispatch: (_token, command) => Effect.sync(() => void input.commands?.push(command)),
      noticeDismissals: {
        read: async () => input.dismissed ?? [],
        write: async (keys) => {
          input.dismissed = keys;
        },
      },
    },
    false,
  );
  client.start();
  if (input.thread) client.registry.set(client.selectedThreadId, input.thread.id);
  return client;
}

const settle = async (view: Awaited<ReturnType<typeof testRender>>) => {
  for (let i = 0; i < 5; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await view.flush();
  }
};

test("the provider banner updates with Alt+n and dismisses with Alt+x for good", async () => {
  const updates: unknown[] = [];
  const state = { providers: [outdated()], updates, dismissed: [] as string[] };
  const view = await testRender(<AppFrame client={liveClient(state)} />, {
    width: 140,
    height: 30,
    kittyKeyboard: true,
  });
  try {
    await settle(view);
    let frame = view.captureCharFrame();
    expect(frame).toContain("Provider update available: Claude");
    expect(frame).toContain("[ Update (Alt+n) ]");
    expect(frame).toContain("[ Dismiss (Alt+x) ]");
    await act(async () => view.mockInput.pressKey("n", { meta: true }));
    await settle(view);
    expect(updates).toEqual([{ provider: "claudeAgent", instanceId: "claudeAgent" }]);
    await act(async () => view.mockInput.pressKey("x", { meta: true }));
    await settle(view);
    frame = view.captureCharFrame();
    expect(frame).not.toContain("Provider update available");
    expect(frame).not.toContain("update failed");
  } finally {
    await act(async () => view.dispose());
  }

  // Dismissed offers stay dismissed on the next start.
  const again = await testRender(<AppFrame client={liveClient({ ...state, dismissed: ["claudeAgent:2.2.0"] })} />, {
    width: 140,
    height: 30,
  });
  try {
    await settle(again);
    expect(again.captureCharFrame()).not.toContain("Provider update available");
  } finally {
    await act(async () => again.dispose());
  }
});

test("a usage-limited thread's banner toggles auto-continue with Alt+z", async () => {
  const commands: unknown[] = [];
  const thread = { ...limited(), id: ThreadId.make("one") };
  const view = await testRender(<AppFrame client={liveClient({ thread, commands })} />, {
    width: 140,
    height: 30,
    kittyKeyboard: true,
  });
  try {
    await settle(view);
    const frame = view.captureCharFrame();
    expect(frame).toContain("Usage limit reached");
    expect(frame).toContain("[ Auto-continue at reset (Alt+z) ]");
    await act(async () => view.mockInput.pressKey("z", { meta: true }));
    await settle(view);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.metadata.update",
      threadId: "one",
      limitRecovery: { runId: "run-1", resetAt: "2026-11-08T15:00:00.000Z", autoResume: true },
    });
  } finally {
    await act(async () => view.dispose());
  }
});
