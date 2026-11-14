import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  type OrchestrationV2ThreadProjection,
  type SecretRequestAnswerInput,
  ThreadId,
} from "@t3tools/contracts";
import { createClient } from "./runtime";
import { emptyTranscript } from "./transcript-state";
import { pendingCard } from "./requests";
import { AppFrame } from "./frame";
import { ThreadComposer } from "./composer";
import { threadBadge } from "./sidebar";

const id = ThreadId.make("request-thread");
function projection(
  kind: "question" | "approval" | "secret",
  capability = "live",
  visibility = "local",
) {
  const item =
    kind === "secret"
      ? {
          id: "askpass:password",
          threadId: id,
          type: "secret_request",
          label: "Password",
          reason: "Command authentication",
          secretStatus: "pending",
        }
      : kind === "question"
        ? {
            type: "user_input_request",
            requestId: "request",
            questions: [
              {
                id: "q",
                question: "Choose colors",
                header: "Colors",
                multiSelect: true,
                options: [
                  { label: "Blue", value: "blue", description: "Cool" },
                  { label: "Purple", description: "Accent" },
                ],
              },
              {
                id: "q2",
                question: "Anything else?",
                header: "Notes",
                options: [],
              },
            ],
          }
        : {
            type: "approval_request",
            requestId: "request",
            prompt: "Run command?",
          };
  return {
    turnItems: [item],
    visibleTurnItems: [{ item, visibility }],
    runtimeRequests: [
      {
        id: "request",
        status: "pending",
        kind: kind === "question" ? "user_input" : "command",
        responseCapability: { type: capability },
        createdAt: DateTime.makeUnsafe(0),
      },
    ],
    runs: [],
    messages: [],
  } as unknown as OrchestrationV2ThreadProjection;
}
async function fixture(
  kind: "question" | "approval" | "secret",
  fail = false,
  integrated = false,
  capability = "live",
) {
  const commands: unknown[] = [];
  const secrets: SecretRequestAnswerInput[] = [];
  const logs: string[] = [];
  const drafts: string[] = [];
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no"),
      wake: () => Effect.void,
      follow: () => Effect.never,
      pause: () => Effect.never,
      drafts: {
        read: async () => ({}),
        write: async (value) => {
          drafts.push(JSON.stringify(value));
        },
      },
      dispatch: (_, command) =>
        Effect.sync(() => {
          commands.push(command);
          logs.push(JSON.stringify(command));
        }),
      answerSecret: (_, input) => {
        secrets.push(input);
        return fail ? Effect.fail(new Error(JSON.stringify(input))) : Effect.void;
      },
    },
    false,
  );
  client.start();
  await new Promise<void>((r) => queueMicrotask(r));
  client.registry.set(client.selectedThreadId, id);
  client.registry.set(
    client.transcripts,
    new Map([[id, { ...emptyTranscript, projection: projection(kind, capability) }]]),
  );
  const view = await testRender(
    integrated ? (
      <AppFrame
        client={client}
        content={{
          transcript: <text>Transcript</text>,
          sidebar: <text>Threads</text>,
        }}
      />
    ) : (
      <box height="100%" flexDirection="column">
        <ThreadComposer client={client} enabled />
      </box>
    ),
    { width: 100, height: 22, kittyKeyboard: true, exitOnCtrlC: false },
  );
  await view.flush();
  async function key(name: string) {
    await act(async () => {
      view.mockInput.pressKey(name);
    });
    await view.flush();
  }
  async function type(text: string) {
    await act(async () => {
      await view.mockInput.typeText(text);
    });
    await view.flush();
  }
  async function click(label: string) {
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(label));
    expect(y).toBeGreaterThan(-1);
    await act(async () => {
      await view.mockMouse.click(lines[y]!.indexOf(label) + 2, y);
    });
    await view.flush();
  }
  return {
    client,
    view,
    key,
    type,
    click,
    commands,
    secrets,
    logs,
    drafts,
    async close() {
      await act(async () => view.renderer.destroy());
      await client.dispose();
    },
  };
}
test("questions: keyboard multiselect and mouse Other advance, exact answers and routing", async () => {
  const h = await fixture("question");
  try {
    await h.key("RETURN");
    await h.key("ARROW_DOWN");
    await h.key("RETURN");
    await h.click("Submit answer");
    expect(h.view.captureCharFrame()).toContain("Anything else?");
    await h.click("Other");
    await h.type("custom notes");
    await h.key("RETURN");
    expect(h.commands).toMatchObject([
      {
        type: "runtime-request.respond",
        threadId: id,
        requestId: "request",
        answers: { q: ["blue", "Purple"], q2: "custom notes" },
      },
    ]);
  } finally {
    await h.close();
  }
});
test("approval and denial work by key and pointer, duplicate submission prevented", async () => {
  for (const deny of [false, true]) {
    const h = await fixture("approval");
    try {
      if (deny) await h.click("Deny");
      else await h.key("RETURN");
      await h.key("RETURN");
      expect(h.commands).toMatchObject([
        {
          threadId: id,
          requestId: "request",
          decision: deny ? "decline" : "accept",
        },
      ]);
      expect(h.commands.length).toBe(1);
    } finally {
      await h.close();
    }
  }
});
test("secret key/paste input never reaches frame, logs, drafts or command dispatch, even on echoed failure", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tercet-secret-"));
  try {
    for (const fail of [false, true]) {
      const h = await fixture("secret", fail, true);
      await h.key("ESCAPE");
      await h.key("ESCAPE"); // launch focus is the sidebar
      const secret = "private-P@ss.word?123";
      try {
        if (fail) await h.type(secret);
        else {
          await act(async () => {
            await h.view.mockInput.pasteBracketedText(secret);
          });
          await h.view.flush();
        }
        const frames = [h.view.captureCharFrame()];
        if (fail) await h.key("RETURN");
        else await h.click("Save securely");
        frames.push(h.view.captureCharFrame());
        expect(h.secrets).toMatchObject([{ threadId: id, answer: { type: "save", secret } }]);
        expect(h.commands).toEqual([]);
        expect(JSON.stringify(frames)).not.toContain(secret);
        expect(JSON.stringify(h.drafts)).not.toContain(secret);
        expect(
          JSON.stringify([...h.client.registry.get(h.client.transcripts).values()]),
        ).not.toContain(secret);
        await NodeFSP.writeFile(
          NodePath.join(directory, "client.log"),
          h.logs.join("\n") + frames.join("\n"),
        );
        expect(
          await NodeFSP.readFile(NodePath.join(directory, "client.log"), "utf8"),
        ).not.toContain(secret);
        if (fail) expect(h.view.captureCharFrame()).toContain("Could not answer");
      } finally {
        await h.close();
      }
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true });
  }
});
test("secret decline by keyboard and pending requests exclude inherited secrets and resolved requests", async () => {
  const h = await fixture("secret");
  try {
    await h.key("ARROW_DOWN");
    await h.key("RETURN");
    expect(h.secrets).toMatchObject([{ answer: { type: "decline" } }]);
  } finally {
    await h.close();
  }
  const p = projection("secret", "live", "inherited"); // inherited secret has no original-thread response here
  expect(pendingCard({ ...p, runtimeRequests: [] })).toBeUndefined();
  expect(pendingCard(projection("approval", "not_resumable"))?.kind).toBe("approval");
  expect(threadBadge({ status: "waiting" } as Parameters<typeof threadBadge>[0])).toBe("? waiting");
});

test("non-resumable approval stays visible and refuses submission", async () => {
  const h = await fixture("approval", false, false, "not_resumable");
  try {
    expect(h.view.captureCharFrame()).toContain("Request cannot be resumed");
    await h.key("RETURN");
    await h.click("Approve");
    expect(h.commands).toEqual([]);
  } finally {
    await h.close();
  }
});

test("switching threads clears secret input instead of restoring it as a draft", async () => {
  const h = await fixture("secret");
  try {
    await h.type("discard-on-switch");
    await act(async () =>
      h.client.registry.set(h.client.selectedThreadId, ThreadId.make("elsewhere")),
    );
    await h.view.flush();
    await act(async () => h.client.registry.set(h.client.selectedThreadId, id));
    await h.view.flush();
    await h.key("RETURN");
    expect(h.secrets).toEqual([]);
    expect(h.view.captureCharFrame()).toContain("Type or paste secret");
    expect(JSON.stringify(h.drafts)).not.toContain("discard-on-switch");
  } finally {
    await h.close();
  }
});

test("four options with an unsent draft: Submit answer stays visible and sends the pick", async () => {
  const h = await fixture("question");
  try {
    const base = h.client.registry.get(h.client.transcripts).get(id)!;
    const p = base.projection as any;
    const item = {
      type: "user_input_request",
      requestId: "request",
      questions: [
        {
          id: "q",
          question:
            "Which of these four approaches should I take for the fix, given the tradeoffs?",
          header: "Approach",
          options: ["One", "Two", "Three", "Four"].map((label) => ({
            label,
            description: "-",
          })),
        },
      ],
    };
    const set = (patch: object) =>
      h.client.registry.set(
        h.client.transcripts,
        new Map([[id, { ...base, projection: { ...p, ...patch } }]]),
      );
    set({ turnItems: [], visibleTurnItems: [], runtimeRequests: [] });
    await h.view.flush();
    await h.type("half typed reply");
    set({
      turnItems: [item],
      visibleTurnItems: [{ item, visibility: "local" }],
    });
    await h.view.flush();
    const frame = h.view.captureCharFrame();
    for (const label of ["5 Other", "6 Submit answer"]) expect(frame).toContain(label);
    await h.click("Two");
    expect(h.view.captureCharFrame()).toContain("Selected: Two");
    await h.click("Submit answer");
    expect(h.commands).toMatchObject([{ requestId: "request", answers: { q: ["Two"] } }]);
  } finally {
    await h.close();
  }
});
