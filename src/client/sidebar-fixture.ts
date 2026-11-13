// Two-project snapshot for the sidebar test and the private tmux capture.
import {
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const projectId = Schema.decodeUnknownSync(ProjectId);
const threadId = Schema.decodeUnknownSync(ThreadId);
const at = DateTime.makeUnsafe("2026-11-08T12:00:00Z");
export const fixtureNow = "2026-11-08T12:00:00.000Z";

export const baseThread = Schema.decodeUnknownSync(OrchestrationV2ThreadShell)({
  id: "one",
  projectId: "project-a",
  title: "Pinned older thread",
  providerInstanceId: "codex",
  modelSelection: { provider: "codex", model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
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

const thread = (
  id: string,
  project: "a" | "b",
  minutesAgo: number,
  title: string,
  extra: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...baseThread,
  id: threadId(id),
  projectId: projectId(`project-${project}`),
  title,
  createdAt: DateTime.subtract(at, { minutes: minutesAgo }),
  updatedAt: DateTime.subtract(at, { minutes: minutesAgo }),
  ...extra,
});

/** Active threads alternate projects, so per-project grouping would visibly reorder them. */
export function flatFixture(): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    archivedThreads: [],
    projects: ["a", "b"].map((id) => ({
      id: projectId(`project-${id}`),
      title: id === "a" ? "Alpha repo" : "Beta repo",
      workspaceRoot: `/fixture/${id}`,
      // Alpha has a saved icon; Beta takes the color generated from its title.
      projectIcon: id === "a" ? ({ kind: "lucide", name: "monitor", color: "red" } as const) : null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-08T12:00:00Z",
      updatedAt: "2026-11-08T12:00:00Z",
    })),
    threads: [
      thread("active-b-old", "b", 40, "Beta oldest active thread"),
      thread("active-a-new", "a", 10, "Alpha newest active thread"),
      thread("active-a-old", "a", 30, "Alpha older active thread with a long name that wraps"),
      thread("active-b-new", "b", 20, "Beta newer active thread", { status: "running" }),
      thread("pin-b", "b", 50, "Beta pinned second", { pinnedAt: at, pinOrderKey: "b" }),
      thread("pin-a", "a", 60, "Alpha pinned first", { pinnedAt: at, pinOrderKey: "a" }),
      thread("snooze-late", "a", 70, "Alpha snoozed for a day", {
        snoozedAt: at,
        snoozedUntil: DateTime.add(at, { days: 1 }),
      }),
      thread("snooze-soon", "b", 80, "Beta snoozed for an hour", {
        snoozedAt: at,
        snoozedUntil: DateTime.add(at, { hours: 1 }),
      }),
      thread("snooze-woken", "a", 5, "Alpha woke from snooze", {
        snoozedAt: DateTime.subtract(at, { hours: 2 }),
        snoozedUntil: DateTime.subtract(at, { hours: 1 }),
      }),
      thread("subagent", "a", 1, "Hidden subagent", {
        lineage: {
          parentThreadId: threadId("active-a-new"),
          relationshipToParent: "subagent",
          rootThreadId: threadId("active-a-new"),
        },
      }),
      thread("archived", "a", 2, "Hidden archived", { archivedAt: at }),
      thread("deleted", "b", 3, "Hidden deleted", { deletedAt: at }),
      thread("machine", "b", 4, "Machine launched thread", { creationSource: "mcp" }),
      ...Array.from({ length: 12 }, (_, i) =>
        thread(
          `settled-${String(i).padStart(2, "0")}`,
          i % 2 ? "a" : "b",
          100 + i,
          `Settled history ${String(i).padStart(2, "0")}`,
          {
            settledOverride: "settled",
            settledAt: DateTime.subtract(at, { minutes: 100 + i }),
            pinnedAt: i === 0 ? at : null,
          },
        ),
      ),
    ],
  };
}
