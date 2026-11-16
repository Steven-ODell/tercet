import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import type { PendingSubagentRequest } from "@t3tools/client-runtime/state/models";

// Copied from upstream packages/client-runtime/src/state/threadShell.ts (module-private at
// v0.1.9). Keep in step with that file when bumping the pinned tag.

const EMPTY_SUBAGENT_REQUESTS: ReadonlyMap<ThreadId, PendingSubagentRequest> = new Map();

// An async question outlives the subagent's run, but once that run ends the
// parent is no longer waiting on the answer, so it stops counting as input.
// The activity run stays set when a follow-up is queued behind a blocked run;
// older servers omit it, so fall back to the latest run's status.
const isChildRunLive = (
  thread: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status">,
) =>
  thread.activityRunStatus !== undefined
    ? thread.activityRunStatus !== null
    : thread.status === "preparing" ||
      thread.status === "starting" ||
      thread.status === "running" ||
      thread.status === "waiting";

/** What a subagent's live run waits on the user for. Provider-native subagents ask on their
    parent, so they are skipped. */
export function subagentRequest(thread: OrchestrationV2ThreadShell): PendingSubagentRequest | null {
  const kind = thread.pendingRuntimeRequest?.kind;
  if (
    kind === undefined ||
    kind === "auth_refresh" ||
    (thread.lineage.relationshipToParent !== "subagent" && thread.delegatedFrom === undefined) ||
    isProviderNativeSubagentThread(thread) ||
    !isChildRunLive(thread)
  ) {
    return null;
  }
  return kind === "user_input" ? "user_input" : "approval";
}

/** A side chat asks its user directly, so questions roll up to the parent as well as approvals. */
function sideChatRequest(thread: OrchestrationV2ThreadShell): PendingSubagentRequest | null {
  const kind = thread.pendingRuntimeRequest?.kind;
  if (kind === undefined || kind === "auth_refresh" || thread.lineage.sideChat !== true) {
    return null;
  }
  return kind === "user_input" ? "user_input" : "approval";
}

/**
 * The threads to flag for a subagent's live approval, up its subagent chain and through a side
 * chat to its parent. `delegated` are tasks this environment's threads delegated to linked
 * environments, with what each one, or its own subagents, asks.
 */
export function pendingSubagentRequestsByThread(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  delegated: ReadonlyArray<{
    readonly parentThreadId: ThreadId;
    readonly request: PendingSubagentRequest;
  }> = [],
): ReadonlyMap<ThreadId, PendingSubagentRequest> {
  const requests = new Map<ThreadId, PendingSubagentRequest>();
  let byId: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> | undefined;
  const flag = (
    firstParentId: ThreadId | null,
    request: PendingSubagentRequest,
    seen: Set<ThreadId>,
  ) => {
    // The coordinator answers child questions; only approvals need user attention.
    if (request === "user_input") return;
    byId ??= new Map(threads.map((thread) => [thread.id, thread] as const));
    let parentId = firstParentId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      if (requests.get(parentId) !== "approval") requests.set(parentId, request);
      const parent = byId.get(parentId);
      parentId =
        parent?.lineage.relationshipToParent === "subagent" || parent?.lineage.sideChat === true
          ? parent.lineage.parentThreadId
          : null;
    }
  };
  for (const child of threads) {
    const parentId = child.lineage.parentThreadId;
    if (child.lineage.sideChat === true) {
      const request = sideChatRequest(child);
      if (parentId !== null && request !== null && requests.get(parentId) !== "approval") {
        requests.set(parentId, request);
      }
      continue;
    }
    if (child.lineage.relationshipToParent !== "subagent") continue;
    const request = subagentRequest(child);
    if (request !== null) flag(parentId, request, new Set([child.id]));
  }
  for (const task of delegated) flag(task.parentThreadId, task.request, new Set());
  return requests.size === 0 ? EMPTY_SUBAGENT_REQUESTS : requests;
}
