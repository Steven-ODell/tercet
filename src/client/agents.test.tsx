import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { agentElapsed, deriveAgentRows, formatAgentElapsed } from "./agents";
import { AppFrame } from "./frame";
import { createClient, waitForLive } from "./runtime";
import { baseThread } from "./sidebar-fixture";
import { emptyTranscript } from "./transcript-state";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const at = (secondsAgo: number) => DateTime.makeUnsafe(NOW - secondsAgo * 1000);
const parentId = ThreadId.make("parent");
const nativeId = ThreadId.make("native-child");
const mcpId = ThreadId.make("mcp-child");

function shell(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    ...baseThread,
    id,
    projectId: "p",
    title,
    ...extra,
  } as unknown as OrchestrationV2ThreadShell;
}
function child(
  id: string,
  title: string,
  parent: string,
  relationship: "subagent" | "fork",
  extra: Record<string, unknown> = {},
) {
  return shell(id, title, {
    lineage: { parentThreadId: parent, relationshipToParent: relationship, rootThreadId: parent },
    ...extra,
  });
}
const threads = [
  shell("parent", "Parent thread"),
  // Provider-native agent that never ran an app turn: its state comes from the parent's record.
  child("native-child", "Subagent: Review files", "parent", "subagent", {
    creationSource: "provider",
    createdAt: at(200),
  }),
  // A delegated child that is blocked on a question for the user.
  child("mcp-child", "Fix tests", "parent", "subagent", {
    creationSource: "mcp",
    createdAt: at(300),
    activityRunStatus: "waiting",
    activityRunStartedAt: at(125),
    status: "waiting",
    latestRunId: "run-1",
    pendingRuntimeRequest: { id: "rq", kind: "user_input", createdAt: at(10) },
    // No subagent record on the parent, so the view falls back to the child shell's model.
    modelSelection: {
      instanceId: "codex",
      model: "gpt-6.1-mini",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
  }),
  child("done-child", "Finished helper", "parent", "subagent", {
    createdAt: at(900),
    status: "completed",
    latestRunId: "run-2",
    latestRunStartedAt: at(600),
    latestRunCompletedAt: at(540),
  }),
  child("fork-child", "A fork, not an agent", "parent", "fork"),
  child("other-child", "Someone else's agent", "elsewhere", "subagent"),
];
const parentProjection = {
  thread: { id: "parent" },
  contextTransfers: [],
  subagents: [
    {
      id: "sa-1",
      childThreadId: "native-child",
      title: "Review files",
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
      status: "running",
      startedAt: at(65),
      completedAt: null,
    },
  ],
} as unknown as OrchestrationV2ThreadProjection;

test("agent rows are the subagent children of the thread, running first, with state and time", () => {
  const rows = deriveAgentRows({ threads, parentId, projection: parentProjection });
  expect(rows.map((row) => [row.title, row.state, row.live])).toEqual([
    // The native agent has no app run, so the parent's record says it is running.
    ["Review files", "Running", true],
    ["Fix tests", "Waiting · question", true],
    ["Finished helper", "Done", false],
  ]);
  expect(rows.map((row) => agentElapsed(row, NOW))).toEqual(["1m", "2m", "1m"]);
  expect(deriveAgentRows({ threads, parentId: ThreadId.make("nobody"), projection: null })).toEqual(
    [],
  );
  expect(deriveAgentRows({ threads, parentId: null, projection: null })).toEqual([]);
  expect(formatAgentElapsed(45)).toBe("45s");
  expect(formatAgentElapsed(12 * 60)).toBe("12m");
  expect(formatAgentElapsed(90 * 60)).toBe("1.5h");
  expect(formatAgentElapsed(14 * 3600)).toBe("14h");
});

test("a provider-native agent that asks is not marked as waiting on its own thread", () => {
  const rows = deriveAgentRows({
    threads: [
      shell("parent", "Parent"),
      child("native", "Subagent: Asker", "parent", "subagent", {
        creationSource: "provider",
        activityRunStatus: "waiting",
        status: "waiting",
        pendingRuntimeRequest: { id: "rq", kind: "user_input", createdAt: at(1) },
      }),
    ],
    parentId,
    projection: null,
  });
  // Provider-native agents ask on their parent, so only the plain status shows here.
  expect(rows.map((row) => row.state)).toEqual(["Waiting"]);
});

function projectionOf(id: string, items: unknown[] = [], extra: object = {}) {
  return {
    thread: { id },
    visibleTurnItems: items,
    turnItems: [],
    runtimeRequests: [],
    runs: [],
    messages: [],
    checkpoints: [],
    subagents: [],
    contextTransfers: [],
    ...extra,
  } as unknown as OrchestrationV2ThreadProjection;
}
const subagentItem = {
  sourceThreadId: "parent",
  sourceItemId: "item-agent",
  visibility: "local",
  item: {
    id: "item-agent",
    type: "subagent",
    status: "running",
    runId: "run",
    subagentId: "sa-1",
    childThreadId: "native-child",
    prompt: "Review the changed files",
    result: null,
  },
};
const questionItem = {
  type: "user_input_request",
  requestId: "rq",
  questions: [
    { id: "q", question: "Pick a runner", options: [{ label: "Vitest" }], multiSelect: false },
  ],
};
const childProjection = (id: string, text: string) =>
  projectionOf(id, [
    {
      sourceThreadId: id,
      sourceItemId: `${id}-message`,
      visibility: "local",
      item: {
        id: `${id}-message`,
        type: "assistant_message",
        status: "completed",
        runId: "r",
        text,
      },
    },
  ]);

async function fixture() {
  const commands: OrchestrationV2Command[] = [];
  const followed: string[] = [];
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: (_, receive) =>
        Effect.sync(() =>
          receive({
            kind: "snapshot",
            snapshot: {
              schemaVersion: 1,
              snapshotSequence: 0,
              projects: [{ id: "p", title: "p", workspaceRoot: "/fixture" }],
              threads,
              archivedThreads: [],
            } as unknown as OrchestrationV2ShellSnapshot,
          }),
        ).pipe(Effect.andThen(Effect.never)),
      followThread: (_, id) => {
        followed.push(id);
        return Effect.never;
      },
      dispatch: (_, command) =>
        Effect.sync(() => {
          commands.push(command);
        }),
    },
    false,
    () => NOW,
  );
  client.start();
  await waitForLive(client);
  client.registry.set(client.selectedThreadId, parentId);
  const publish = (mcpAsks = true) =>
    client.registry.set(
      client.transcripts,
      new Map([
        [
          "parent",
          {
            ...emptyTranscript,
            projection: { ...projectionOf("parent", [subagentItem]), ...parentProjection },
          },
        ],
        [
          "native-child",
          {
            ...emptyTranscript,
            projection: childProjection("native-child", "Native agent says hi"),
          },
        ],
        [
          "mcp-child",
          {
            ...emptyTranscript,
            projection: {
              ...childProjection("mcp-child", "Delegated agent says hi"),
              turnItems: mcpAsks ? [questionItem] : [],
              visibleTurnItems: mcpAsks
                ? [{ item: questionItem, visibility: "local" }]
                : childProjection("mcp-child", "x").visibleTurnItems,
              runtimeRequests: mcpAsks
                ? [
                    {
                      id: "rq",
                      status: "pending",
                      kind: "user_input",
                      responseCapability: { type: "live" },
                      createdAt: at(10),
                    },
                  ]
                : [],
            } as unknown as OrchestrationV2ThreadProjection,
          },
        ],
      ]),
    );
  publish();
  const view = await testRender(<AppFrame client={client} />, {
    width: 160,
    height: 44,
    kittyKeyboard: true,
  });
  const key = async (name: string, meta = false) => {
    await act(async () => {
      view.mockInput.pressKey(name, { meta });
    });
    await view.flush();
  };
  const click = async (label: string) => {
    const rows = view.captureCharFrame().split("\n");
    const y = rows.findIndex((row) => row.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await view.mockMouse.click(rows[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  };
  const frame = () => view.captureCharFrame();
  const sidebar = () =>
    frame()
      .split("\n")
      .map((row) => row.slice(0, 30))
      .join("\n");
  return {
    client,
    view,
    key,
    click,
    frame,
    sidebar,
    commands,
    followed,
    async close() {
      await act(async () => view.renderer.destroy());
      await client.dispose();
    },
  };
}

test("launcher lists agents; A then Enter opens one read-only and Esc returns, selection never moves", async () => {
  const h = await fixture();
  try {
    await h.view.waitForFrame((f) => f.includes("Alt+l Launchers"));
    // Running agents are advertised in the header and never as sidebar rows.
    expect(h.frame()).toContain("2 agents running");
    expect(h.sidebar()).not.toContain("Review files");
    await h.key("l", true);
    await h.view.waitForFrame((f) => f.includes("Agents (A)"));
    for (const text of [
      "Review files",
      "Running · 1m",
      "Fix tests",
      "Waiting · question · 2m",
      "Done · 1m",
    ])
      expect(h.frame()).toContain(text);
    await h.key("a");
    await h.key("RETURN");
    await h.view.waitForFrame((f) => f.includes("Agent · Review files · read-only"));
    expect(h.frame()).toContain("Native agent says hi");
    expect(h.frame()).toContain("Read-only agent view");
    // The model row shows the agent's model from the parent's record, not the parent's model.
    expect(h.frame()).toContain("agent · claude-sonnet-5-5 · effort default");
    expect(h.frame()).not.toContain("gpt-6.1-sol");
    expect(h.client.registry.get(h.client.selectedThreadId)).toBe(parentId);
    expect(h.client.registry.get(h.client.viewedThreadId)).toBe(nativeId);
    expect(h.followed).toEqual(["parent", "native-child"]);
    expect(h.sidebar()).not.toContain("Review files");
    await h.key("ESCAPE");
    expect(h.frame()).not.toContain("read-only");
    expect(h.frame()).toContain("gpt-6.1-sol");
    expect(h.frame()).not.toContain("claude-sonnet-5-5");
    expect(h.client.registry.get(h.client.viewedThreadId)).toBeNull();
    expect(h.client.registry.get(h.client.selectedThreadId)).toBe(parentId);
    // Nothing was sent to any thread by looking.
    expect(h.commands).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a subagent item in the work log opens its thread; clicking Back returns", async () => {
  const h = await fixture();
  try {
    await h.view.waitForFrame((f) => f.includes("[open] subagent"));
    await h.click("[open] subagent");
    await h.view.waitForFrame((f) => f.includes("Agent · Review files · read-only"));
    expect(h.frame()).toContain("Native agent says hi");
    await h.click("[Esc Back]");
    expect(h.frame()).not.toContain("read-only");
  } finally {
    await h.close();
  }
});

test("a delegated agent's pending question is answered in place and goes to that thread", async () => {
  const h = await fixture();
  try {
    await h.view.waitForFrame((f) => f.includes("Alt+l Launchers"));
    await h.key("l", true);
    await h.key("a");
    await h.key("j");
    await h.key("RETURN");
    await h.view.waitForFrame((f) => f.includes("Pick a runner"));
    expect(h.frame()).toContain("Agent · Fix tests · read-only");
    expect(h.frame()).toContain("agent · gpt-6.1-mini · effort high");
    await h.key("1"); // Vitest
    await h.key("3"); // Submit answer (2 is Other)
    expect(h.commands).toMatchObject([
      {
        type: "runtime-request.respond",
        threadId: mcpId,
        requestId: "rq",
        answers: { q: ["Vitest"] },
      },
    ]);
  } finally {
    await h.close();
  }
});

test("with no agents the launcher says so and Enter on it does nothing; no badge shows", async () => {
  const h = await fixture();
  try {
    h.client.registry.set(h.client.selectedThreadId, ThreadId.make("fork-child"));
    await h.key("l", true);
    await h.view.waitForFrame((f) => f.includes("No agents (A)"));
    expect(h.frame()).not.toContain("agents running");
    for (let i = 0; i < 4; i++) await h.key("j");
    await h.key("RETURN");
    await h.key("a");
    expect(h.client.registry.get(h.client.viewedThreadId)).toBeNull();
    expect(h.frame()).not.toContain("read-only");
  } finally {
    await h.close();
  }
});
