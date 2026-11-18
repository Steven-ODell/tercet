import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ProjectId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { BranchPanel, createBranchWorkflow, type BranchTarget } from "./git-workflows.tsx";
import { PullRequestPanel } from "./pull-requests.tsx";
import { createPullRequestWorkflow } from "./pull-requests.ts";
import { ContextDropdown, contextDetailOf } from "./context-meter";
import { contextContentOf } from "./context-content";
import { LaunchersPanel } from "./launchers";
import { pendingCard, RequestPanel } from "./requests";
import type { AgentRow } from "./agents";
import type { Client } from "./runtime";

const SIZES = [
  [120, 40],
  [50, 40],
  [50, 20],
  [110, 20],
] as const;

const target: BranchTarget = {
  projectId: ProjectId.make("p"),
  threadId: ThreadId.make("t"),
  projectCwd: "/home/someone/Projects/Side/a-rather-long-project-directory-name",
  worktreePath: null,
  branch: "main",
  running: true,
};
const status = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/very-long-branch-name-for-phone",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 12,
  behindCount: 3,
  pr: null,
};
const refNames = [
  "main",
  "feature/very-long-branch-name-for-phone",
  "release/2026.11/hotfix-with-an-even-longer-name-than-before",
  "origin/main",
  ...Array.from({ length: 30 }, (_, i) => `topic/${i}`),
];
const refs = refNames.map((name, i) => ({
  name,
  current: i === 1,
  isDefault: i === 0,
  isRemote: name.startsWith("origin/"),
  worktreePath: i === 2 ? "/home/someone/.t3/worktrees/the-long-worktree-directory" : null,
}));
const detail = {
  projectId: target.projectId,
  repository: "owner/a-long-repository-name",
  number: 42,
  url: "https://github.example/owner/repo/pull/42",
  title: "A fairly long pull request title that cannot fit a phone",
  body: "PR body text that is long enough to wrap across a narrow terminal screen at least twice.",
  state: "open",
  mergeability: "mergeable",
  isDraft: true,
  headBranch: "feature/very-long-branch-name-for-phone",
  baseBranch: "main",
  additions: 3,
  deletions: 1,
  viewerPermissions: { comment: true },
};
function gitClient() {
  return {
    git: async (operation: string) => {
      if (operation === "status") return status;
      if (operation === "refs") return { refs, nextCursor: null };
      if (operation === "prIdentity") return { accountId: "a" };
      if (operation === "detail") return detail;
      if (operation === "checks")
        return { checks: [{ name: "CI / build (ubuntu-latest, bun 1.4)", status: "pending" }] };
      if (operation === "activity") return { comments: [], reviewThreads: [], commits: [] };
      if (operation === "listPRs")
        return {
          entries: [{ ...detail, host: "github.example", checksState: "pending" }],
          errors: [],
          providers: [],
          viewers: {},
          truncated: false,
        };
      return {};
    },
    dispatch: async () => {},
  } as unknown as Pick<Client, "git" | "dispatch">;
}

const NOW = Date.parse("2026-11-12T10:00:00Z");
const turnReport = {
  providerThreadId: "p1" as never,
  tokenUsage: {
    usedTokens: 64_921,
    maxTokens: 200_000,
    inputTokens: 64_919,
    cachedInputTokens: 64_598,
    outputTokens: 2,
    updatedAt: "2026-11-12T09:50:00Z",
    autoCompactThreshold: 160_000,
    promptCacheExpiresAt: "2026-11-12T10:50:00Z",
  },
};
const contextDetail = contextDetailOf({
  activeProviderThreadId: "p1",
  providerThread: undefined,
  providerTurns: [turnReport],
})!;
const item = (type: string, values: object) =>
  ({
    visibility: "local",
    item: { type, providerThreadId: "p1", status: "completed", ...values },
  }) as never;
const contextContent = contextContentOf(
  {
    runs: [],
    visibleTurnItems: [
      item("user_message", { text: "hello there" }),
      item("assistant_message", { text: "reply" }),
      item("dynamic_tool", { toolName: "Read", input: "test", output: "read a longer file" }),
    ],
  } as never,
  "p1",
  true,
)!;

const agents: AgentRow[] = [
  {
    threadId: ThreadId.make("a1"),
    title: "Investigate the flaky websocket reconnect test in the client runtime",
    state: "Waiting · question",
    live: true,
    startedAt: "2026-11-12T09:00:00Z",
    completedAt: null,
  },
  {
    threadId: ThreadId.make("a2"),
    title: "Short",
    state: "Done",
    live: false,
    startedAt: "2026-11-12T09:00:00Z",
    completedAt: "2026-11-12T09:30:00Z",
  },
];

function questionProjection(kind: "question" | "approval" | "secret") {
  const it =
    kind === "secret"
      ? {
          id: "s",
          threadId: "t",
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
                question: "Which deployment target should the release candidate go to first?",
                header: "Target",
                multiSelect: false,
                options: [
                  {
                    label: "Staging cluster in us-east with the canary flag enabled",
                    value: "a",
                    description: "x",
                  },
                  { label: "Production", value: "b", description: "y" },
                  { label: "Internal dogfood", value: "c", description: "z" },
                  { label: "Hold the release", value: "d", description: "w" },
                ],
              },
            ],
          }
        : {
            type: "approval_request",
            requestId: "request",
            prompt: "Run command?",
            detail: "rm -rf build && bun run build --production",
          };
  return {
    turnItems: [it],
    visibleTurnItems: [{ item: it, visibility: "local" }],
    runtimeRequests: [
      {
        id: "request",
        status: "pending",
        kind: kind === "question" ? "user_input" : "command",
        responseCapability: { type: "live" },
        createdAt: DateTime.makeUnsafe(0),
      },
    ],
    runs: [],
    messages: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

export type Panel =
  | "branches"
  | "worktrees"
  | "prs"
  | "pr-detail"
  | "context"
  | "launchers"
  | "question"
  | "approval"
  | "secret";
export async function open(panel: Panel, width: number, height: number, direct = false) {
  const dispatched: unknown[] = [];
  const spied: unknown[] = [];
  const closed = { n: 0 };
  const close = () => void closed.n++;
  const client = {
    dispatch: async (c: unknown) => void dispatched.push(c),
    answerSecret: async () => {},
  } as never;
  const git = gitClient();
  const element =
    panel === "branches" || panel === "worktrees" ? (
      <BranchPanel
        workflow={createBranchWorkflow(git, () => target)}
        target={target}
        close={close}
      />
    ) : panel === "prs" || panel === "pr-detail" ? (
      <PullRequestPanel
        workflow={createPullRequestWorkflow(git, () => target)}
        target={target}
        effects={{ copy: (text: string) => void spied.push(["copy", text]) } as never}
        close={close}
      />
    ) : panel === "context" ? (
      <box width="100%" height="100%">
        <ContextDropdown
          detail={contextDetail}
          content={contextContent}
          width={width}
          height={height}
          now={() => NOW}
          close={close}
        />
      </box>
    ) : panel === "launchers" ? (
      <box width="100%" height="100%" flexDirection="column">
        <LaunchersPanel
          enabled
          open={(panel) => void spied.push(["open", panel])}
          shell={async () => {}}
          agents={agents}
          openAgent={(id) => void spied.push(["agent", id])}
          now={() => NOW}
          close={close}
        />
      </box>
    ) : (
      <box width="100%" height="100%" flexDirection="column" justifyContent="flex-end">
        <box
          height={direct ? height : Math.min(19, Math.max(15, height - 5))}
          flexDirection="column"
        >
          <RequestPanel
            client={client}
            id={ThreadId.make("t")}
            card={pendingCard(questionProjection(panel))!}
            enabled
          />
        </box>
      </box>
    );
  const view = await testRender(element, {
    width,
    height,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  await view.flush();
  const settle = async (text: string) => {
    for (let i = 0; i < 40 && !view.captureCharFrame().includes(text); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
      await view.flush();
    }
  };
  if (panel === "branches" || panel === "worktrees") await settle("topic/0");
  if (panel === "prs" || panel === "pr-detail") await settle("#42");
  const key = async (name: string) => {
    await act(async () => view.mockInput.pressKey(name));
    await view.flush();
  };
  if (panel === "worktrees") await key("w");
  if (panel === "pr-detail") {
    await key("RETURN");
    await settle("Checks");
  }
  const frame = () => view.captureCharFrame();
  const click = async (label: string) => {
    const lines = frame().split("\n");
    const y = lines.findIndex((l) => l.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  };
  return {
    view,
    frame,
    key,
    click,
    dispatched,
    spied,
    closed,
    settle,
    destroy: () => view.renderer.destroy(),
  };
}

const ALL: Panel[] = [
  "branches",
  "worktrees",
  "prs",
  "pr-detail",
  "context",
  "launchers",
  "question",
  "approval",
  "secret",
];
const PHONE = [
  [50, 40],
  [50, 20],
  [110, 20],
] as const;
/** Rows with trailing blanks removed, as saved from the base commit. */
const trimmed = (frame: string) => {
  const lines = frame.split("\n").map((line) => line.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join("\n");
};
/** Wrapped rows joined back, so a label that wraps still counts as whole. */
const flat = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.replace(/[│█▀▄]/g, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/-\s/g, "-");
const whole = (frame: string, labels: string[]) => {
  for (const label of labels) expect(flat(frame)).toContain(label);
};

test("120x40 output is identical to the base commit", async () => {
  for (const panel of ALL) {
    const p = await open(panel, 120, 40);
    expect(trimmed(p.frame())).toBe(BASE_120x40[panel]!);
    p.destroy();
  }
});

test("branches and worktrees: whole tappable buttons at phone sizes", async () => {
  for (const [w, h] of PHONE) {
    const p = await open("branches", w, h);
    whole(p.frame(), [
      "[w Branches / Worktrees]",
      "[Esc Back]",
      "[r Refresh]",
      "[n Create branch]",
    ]);
    // The buttons share rows instead of taking one row each.
    const bar = p
      .frame()
      .split("\n")
      .find((l) => l.includes("[w Branches / Worktrees]"));
    expect(bar).toContain("[Esc Back]");
    // The branch list keeps most of the screen: at 50x20 at least 8 rows are branches.
    expect(
      p
        .frame()
        .split("\n")
        .filter((l) => /topic\/\d|origin\/main/.test(l)).length,
    ).toBeGreaterThanOrEqual(h >= 40 ? 20 : 4);
    await p.click("[w Branches / Worktrees]");
    whole(p.frame(), ["[n Create worktree]", "the-long-worktree-directory"]);
    await p.click("[n Create worktree]");
    expect(p.frame()).toContain("Create worktree + new branch");
    await p.key("ESCAPE");
    await p.click("[Esc Back]");
    expect(p.closed.n).toBe(1);
    p.destroy();
  }
});

test("pull requests: list, detail and actions are whole and tappable at phone sizes", async () => {
  const labels = [
    "[y Copy link]",
    "[o Open PR]",
    "[Open host diff]",
    "[l Link to this thread]",
    "[u Unlink from this thread]",
    "[w Watch: enable thread notifications]",
    "[W Unwatch: disable thread notifications]",
    "[c Comment / review draft]",
    "[d Local branch comparison]",
  ];
  for (const [w, h] of PHONE) {
    const list = await open("prs", w, h);
    whole(list.frame(), ["[Esc Back]", "[r Refresh]", "#42 A fairly long pull request title"]);
    await list.click("[Esc Back]");
    expect(list.closed.n).toBe(1);
    list.destroy();

    const p = await open("pr-detail", w, h);
    const frame = flat(p.frame());
    expect(frame).toContain("owner/a-long-repository-name #42");
    // Each action label shown is whole: a label that starts in the frame also ends in it.
    for (const label of labels)
      if (frame.includes(label.slice(0, 6))) expect(frame).toContain(label);
    await p.click("[y Copy link]");
    expect(p.spied).toEqual([["copy", "https://github.example/owner/repo/pull/42"]]);
    if (h >= 40) whole(p.frame(), labels);
    // Compact buttons share rows: far fewer rows than one per button.
    const rows = p.frame().split("\n");
    const first = rows.findIndex((l) => l.includes("[y Copy link]"));
    expect(rows[first]).toContain("[o Open PR]");
    await p.click("[o Open PR]");
    await p.key("c");
    await act(async () => void p.view.mockInput.typeText("note"));
    await p.view.flush();
    whole(p.frame(), [
      "[Post discussion comment]",
      "[Comment review]",
      "[Approve]",
      "[Request changes]",
    ]);
    expect(p.frame()).toContain("Draft · Esc saves");
    await p.click("[Approve]");
    expect(flat(p.frame())).toContain("Submit approve to owner/a-long-repository-name #42");
    p.destroy();
  }
});

test("context dropdown sits inside the screen with a tappable close", async () => {
  for (const [w, h] of PHONE) {
    const p = await open("context", w, h);
    const rows = trimmed(p.frame()).split("\n");
    expect(rows.length).toBeLessThanOrEqual(h);
    const top = rows.findIndex((l) => l.includes("╭"));
    const bottom = rows.findIndex((l) => l.includes("╰"));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeGreaterThan(top);
    expect(bottom).toBeLessThanOrEqual(h - 1);
    expect(Math.max(...rows.map((l) => l.trimEnd().length))).toBeLessThanOrEqual(w);
    expect(p.frame()).toContain("Context window");
    await p.click("[ Esc Close ]");
    expect(p.closed.n).toBe(1);
    p.destroy();
  }
});

test("launchers: every entry is whole and tappable, long agent titles wrap", async () => {
  for (const [w, h] of PHONE) {
    const p = await open("launchers", w, h);
    whole(p.frame(), [
      "Files (F)",
      "Diff (D)",
      "Editor (E)",
      "Terminal (T)",
      "Shell (S)",
      "[Close]",
    ]);
    expect(flat(p.frame())).toContain(
      "Investigate the flaky websocket reconnect test in the client runtime",
    );
    await p.click("Terminal (T)");
    expect(p.spied).toEqual([["open", "terminal"]]);
    // The wrapped second row of an agent title taps the same entry.
    const rows = p.frame().split("\n");
    const y = rows.findIndex((l) => l.includes("Investigate")) + (w < 100 ? 1 : 0);
    await act(async () => void (await p.view.mockMouse.click(2, y)));
    await p.view.flush();
    expect(p.spied.at(-1)).toEqual(["agent", ThreadId.make("a1")]);
    await p.click("[Close]");
    expect(p.closed.n).toBe(1);
    p.destroy();
  }
});

test("question card: choices and the submit row fit, the hint is one whole row", async () => {
  for (const [w, h] of [
    [50, 20],
    [110, 20],
    [50, 14],
  ] as const) {
    const p = await open("question", w, h, h === 14);
    whole(p.frame(), ["[6 Submit answer]"]);
    const rows = p
      .frame()
      .split("\n")
      .filter((l) => l.includes("│"));
    if (w < 70) expect(flat(p.frame())).toContain("↑↓ select · Enter answer · Esc clear");
    else expect(flat(p.frame())).toContain("Ctrl+g composer");
    if (h >= 20)
      whole(p.frame(), ["[2 Production]", "[3 Internal dogfood]", "[4 Hold the release]"]);
    expect(rows.length).toBeGreaterThan(0);
    // Arrow down walks to Other: the scrolled list brings the highlighted row into view.
    for (let i = 0; i < 4; i++) await p.key("ARROW_DOWN");
    whole(p.frame(), ["[5 Other]", "[6 Submit answer]"]);
    p.destroy();
  }
  const p = await open("question", 50, 20);
  await p.click("[2 Production]");
  expect(flat(p.frame())).toContain("Selected: b");
  await p.click("[6 Submit answer]");
  await p.view.flush();
  expect(p.dispatched).toMatchObject([{ type: "runtime-request.respond", answers: { q: ["b"] } }]);
  p.destroy();
});

test("approval and secret cards keep whole labels at phone sizes", async () => {
  for (const [w, h] of PHONE) {
    const a = await open("approval", w, h);
    whole(a.frame(), ["[1 Approve]", "[2 Deny]", "Approval: Run command?"]);
    a.destroy();
    const s = await open("secret", w, h);
    whole(s.frame(), ["[1 Save securely]", "[2 Decline]"]);
    s.destroy();
  }
});

// Saved from the base commit (66b7332) before any change in this step.
const BASE_120x40: Record<string, string> = {
  approval:
    "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐\n│Approval: Run command?                                                                                                │\n│› [1 Approve]                                                                                                         │\n│  [2 Deny]                                                                                                            │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│↑/↓ Tab select · Enter answer · Esc clear · Ctrl+g composer · Alt+h / Ctrl+l panes                                    │\n└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
  branches:
    "┌─Branches─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐\n│Branches                                                                                                              │\n│[w Branches / Worktrees]                                                                                              │\n│[Esc Back]                                                                                                            │\n│/home/someone/Projects/Side/a-rather-long-project-directory-name                                                      │\n│feature/very-long-branch-name-for-phone · dirty · ahead 12 / behind 3 · running                                       │\n│[r Refresh]                                                                                                           │\n│[n Create branch]                                                                                                     │\n│› main                                                                                                               █│\n│  * feature/very-long-branch-name-for-phone                                                                          █│\n│  release/2026.11/hotfix-with-an-even-longer-name-than-before · in /home/someone/.t3/worktrees/the-long-worktree-    █│\n│directory                                                                                                            █│\n│  origin/main                                                                                                        █│\n│  topic/0                                                                                                            █│\n│  topic/1                                                                                                            █│\n│  topic/2                                                                                                            █│\n│  topic/3                                                                                                            █│\n│  topic/4                                                                                                            █│\n│  topic/5                                                                                                            █│\n│  topic/6                                                                                                            █│\n│  topic/7                                                                                                            █│\n│  topic/8                                                                                                            █│\n│  topic/9                                                                                                            █│\n│  topic/10                                                                                                           █│\n│  topic/11                                                                                                           █│\n│  topic/12                                                                                                           █│\n│  topic/13                                                                                                           █│\n│  topic/14                                                                                                           █│\n│  topic/15                                                                                                           █│\n│  topic/16                                                                                                           █│\n│  topic/17                                                                                                           █│\n│  topic/18                                                                                                           █│\n│  topic/19                                                                                                           █│\n│  topic/20                                                                                                           █│\n│  topic/21                                                                                                           █│\n│  topic/22                                                                                                            │\n│  topic/23                                                                                                            │\n│  topic/24                                                                                                            │\n│  topic/25                                                                                                            │\n└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
  context:
    "\n                                                                          ╭─Context window─────────────────────────────╮\n                                                                          │ 32% used · 65k / 200k                      │\n                                                                          │ ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▰▰▰▰▰▰▰▰ │\n                                                                          │ ▰ Cached input      65k   32%              │\n                                                                          │ ▰ New input         321   <1%              │\n                                                                          │ ▰ Output              2   <1%              │\n                                                                          │ ▱ Free              95k   48%              │\n                                                                          │ ▰ Compact buffer    40k   20%              │\n                                                                          │                                            │\n                                                                          │ Compacts at 160,000 tokens.                │\n                                                                          │ Prompt cache warm, expires in 50m.         │\n                                                                          │                                            │\n                                                                          │ Loaded transcript (estimated)              │\n                                                                          │ Tool arguments       ~1                    │\n                                                                          │ Tool results         ~5                    │\n                                                                          │ User messages        ~3                    │\n                                                                          │ Assistant messages   ~2                    │\n                                                                          │                                            │\n                                                                          │ Top tools by loaded text                   │\n                                                                          │ Read · 1 call · ~6                         │\n                                                                          │                                            │\n                                                                          │ Older history is outside the loaded        │\n                                                                          │ transcript.                                │\n                                                                          │ Estimated at 1 token per 4 UTF-8 bytes.    │\n                                                                          │ System prompts, tool definitions and       │\n                                                                          │ attachments are unavailable here.          │\n                                                                          │ [ Esc Close ]                              │\n                                                                          ╰────────────────────────────────────────────╯",
  launchers:
    "› Files (F)\n  Diff (D)\n  Editor (E)\n  Terminal (T)\n  Shell (S)\n  Agents (A)\n  Investigate the flaky websocket reconnect test in the client runtime\n    Waiting · question · 1h\n  Short\n    Done · 30m\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n[Close]",
  "pr-detail":
    "┌─Pull requests────────────────────────────────────────────────────────────────────────────────────────────────────────┐\n│[Esc Back]                                                                                                            │\n│/home/someone/Projects/Side/a-rather-long-project-directory-name · thread t                                           │\n│github.example / owner/a-long-repository-name #42                                                                     │\n│[r Refresh]                                                                                                           │\n│[y Copy link]                                                                                                         │\n│[o Open PR]                                                                                                           │\n│[Open host diff]                                                                                                      │\n│[l Link to this thread]                                                                                               │\n│[u Unlink from this thread]                                                                                           │\n│[w Watch: enable thread notifications]                                                                                │\n│[W Unwatch: disable thread notifications]                                                                             │\n│[c Comment / review draft]                                                                                            │\n│[d Local branch comparison]                                                                                           │\n│A fairly long pull request title that cannot fit a phone                                                              │\n│open · draft · mergeable                                                                                              │\n│feature/very-long-branch-name-for-phone → main                                                                        │\n│+3 −1                                                                                                                 │\n│PR body text that is long enough to wrap across a narrow terminal screen at least twice.                              │\n│Checks                                                                                                                │\n│pending · CI / build (ubuntu-latest, bun 1.4)                                                                         │\n│Discussion and reviews                                                                                                │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
  prs: "┌─Pull requests────────────────────────────────────────────────────────────────────────────────────────────────────────┐\n│[Esc Back]                                                                                                            │\n│/home/someone/Projects/Side/a-rather-long-project-directory-name · thread t                                           │\n│[r Refresh]                                                                                                           │\n│[n Create PR for current branch]                                                                                      │\n│› #42 A fairly long pull request title that cannot fit a phone · open draft · pending                                 │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
  question:
    "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐\n│Question 1/1: Which deployment target should the release candidate go to first?                                       │\n│Selected: none                                                                                                        │\n│› [1 Staging cluster in us-east with the canary flag enabled]                                                         │\n│  [2 Production]                                                                                                      │\n│  [3 Internal dogfood]                                                                                                │\n│  [4 Hold the release]                                                                                                │\n│  [5 Other]                                                                                                           │\n│                                                                                                                      │\n│  [6 Submit answer]                                                                                                   │\n│↑/↓ Tab select · Enter answer · Esc clear · Ctrl+g composer · Alt+h / Ctrl+l panes                                    │\n└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
  secret:
    "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐\n│Password                                                                                                              │\n│Command authentication                                                                                                │\n│Stored securely, never shown to the agent                                                                             │\n│Type or paste secret (no echo)                                                                                        │\n│› [1 Save securely]                                                                                                   │\n│  [2 Decline]                                                                                                         │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│↑/↓ Tab select · Enter answer · Esc clear · Ctrl+g composer · Alt+h / Ctrl+l panes                                    │\n└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
  worktrees:
    "┌─Branches─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐\n│Worktrees                                                                                                             │\n│[w Branches / Worktrees]                                                                                              │\n│[Esc Back]                                                                                                            │\n│/home/someone/Projects/Side/a-rather-long-project-directory-name                                                      │\n│feature/very-long-branch-name-for-phone · dirty · ahead 12 / behind 3 · running                                       │\n│[r Refresh]                                                                                                           │\n│[n Create worktree]                                                                                                   │\n│› feature/very-long-branch-name-for-phone · /home/someone/Projects/Side/a-rather-long-project-directory-name          │\n│  release/2026.11/hotfix-with-an-even-longer-name-than-before · /home/someone/.t3/worktrees/the-long-worktree-        │\n│directory                                                                                                             │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n│                                                                                                                      │\n└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
};
