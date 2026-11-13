import { useMemo } from "react";
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
  orderWebThreadLineageRows,
  threadRelationshipRowStatus,
} from "@t3tools/client-runtime/state/thread-relationships";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { subagentRequest } from "../ext/thread-shell";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { allThreads } from "./thread-actions";
import type { Client } from "./runtime";
import { useClientAtom } from "./screen";

export interface AgentRow {
  threadId: ThreadId;
  title: string;
  /** "Running", "Done", "Waiting · question" and so on. */
  state: string;
  live: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

// Statuses web's Lineage panel files under "Previous agents"; everything else is still working.
const FINISHED = new Set(["completed", "failed", "error", "cancelled", "interrupted", "idle"]);
const WORKING = new Set(["preparing", "starting", "running", "waiting", "pending", "queued"]);

/** Same words as web's `threadRelationshipStatusLabel`, which is stuck in apps/web. */
export function agentStatusLabel(status: string | null): string {
  switch (status) {
    case "preparing":
    case "starting":
      return "Starting";
    case "running":
    case "in_progress":
      return "Running";
    case "pending":
    case "queued":
      return "Queued";
    case "waiting":
    case "blocked":
      return "Waiting";
    case "completed":
      return "Done";
    case "failed":
    case "error":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
    case "rolled_back":
      return "Reverted";
    default:
      return status ? status.replaceAll("_", " ") : "Idle";
  }
}

/** Short elapsed form from web's `formatCompactElapsedSeconds`: 45s, 12m, 1.5h, 14h. */
export function formatAgentElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  if (minutes >= 600) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 6) / 10}h`;
}

/** Empty when the agent never started, or finished without a recorded end. */
export function agentElapsed(row: AgentRow, now: number): string {
  const ms = deriveSubagentElapsedMs(
    {
      status: row.live ? "running" : "completed",
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    },
    now,
  );
  return ms === null ? "" : formatAgentElapsed(ms / 1000);
}

const iso = (value: DateTime.Utc | null | undefined) => (value ? DateTime.formatIso(value) : null);

/**
 * The thread's subagent children: the graph web's Lineage panel draws, cut to the rows below
 * `parentId`. Running agents come first, then finished ones, each newest first as in web.
 * Children with no shell cannot be opened, so they are skipped.
 */
export function deriveAgentRows(input: {
  threads: readonly OrchestrationV2ThreadShell[];
  parentId: ThreadId | null;
  projection: OrchestrationV2ThreadProjection | null;
}): AgentRow[] {
  const { parentId } = input;
  if (!parentId) return [];
  // A projection still loading, or a fixture, may not carry the arrays the graph reads.
  const projection =
    input.projection?.thread?.id === parentId &&
    Array.isArray(input.projection.subagents) &&
    Array.isArray(input.projection.contextTransfers)
      ? input.projection
      : null;
  const graph = deriveThreadRelationshipGraph({ threads: input.threads, projection });
  const rows = orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, parentId),
    currentThreadId: parentId,
    mergeTargetThreadId: null,
  }).filter(
    (row) => row.edge.kind === "subagent" && !isParentThreadRelationship(row.edge, parentId),
  );
  const agents = rows.flatMap((row) => {
    const thread = graph.nodes.get(row.threadId)?.thread;
    if (!thread) return [];
    const status = threadRelationshipRowStatus(graph, row);
    const live = !FINISHED.has(status ?? "") && (status === null || WORKING.has(status));
    const record = projection?.subagents.find((agent) => agent.childThreadId === thread.id);
    const request = subagentRequest(thread);
    return [
      {
        threadId: thread.id,
        title: formatSubagentDisplayTitle(thread.title) || record?.title || "Agent",
        state:
          request && live
            ? `Waiting · ${request === "approval" ? "approval" : "question"}`
            : agentStatusLabel(status),
        live,
        startedAt: iso(
          (live ? thread.activityRunStartedAt : thread.latestRunStartedAt) ?? record?.startedAt,
        ),
        completedAt: live ? null : iso(thread.latestRunCompletedAt ?? record?.completedAt),
      },
    ];
  });
  return [...agents.filter((agent) => agent.live), ...agents.filter((agent) => !agent.live)];
}

/** Agents of `parentId`, recomputed only when the shells or the parent's subagent list change. */
export function useAgentRows(client: Client, parentId: ThreadId | null): AgentRow[] {
  const snapshot = useClientAtom(client, client.snapshot);
  const archives = useClientAtom(client, client.archives);
  const states = useClientAtom(client, client.transcripts);
  const projection = parentId ? (states.get(parentId)?.projection ?? null) : null;
  const subagents = projection?.subagents;
  return useMemo(
    () => deriveAgentRows({ threads: allThreads(client), parentId, projection }),
    [client, snapshot, archives, parentId, subagents],
  );
}
