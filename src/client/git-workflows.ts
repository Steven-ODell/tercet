import type * as C from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import { READ_ONLY_ERROR } from "./read-only";

export type GitOperation = keyof typeof import("./connection").gitMethods;
export type GitInput<K extends GitOperation> = Parameters<(typeof import("./connection").gitMethods)[K]>[2];
export type GitOutput<K extends GitOperation> = Effect.Success<ReturnType<(typeof import("./connection").gitMethods)[K]>>;
export type GitBoundary = <K extends GitOperation>(token: string, operation: K, input: GitInput<K>) => Effect.Effect<GitOutput<K>, unknown>;
export type GitRequest = <K extends GitOperation>(operation: K, input: GitInput<K>, signal?: AbortSignal) => Promise<GitOutput<K>>;

/** Exhaustive, independent of host Actions: refreshes are reads; Git and host writes are blocked. */
export const GIT_READ_ONLY_POLICY = {
  prIdentity: "allow", createPR: "block", status: "allow", refs: "allow", createRef: "block", switchRef: "block",
  createWorktree: "block", resolvePR: "allow", preparePR: "block", listPRs: "allow",
  detail: "allow", checks: "allow", activity: "allow", threadComments: "allow",
  diffContents: "allow", diffPreview: "allow", comment: "block", submitReview: "block",
} satisfies Record<GitOperation, "allow" | "block">;

export class GitWorkflowError extends Error {
  constructor(readonly kind: "offline" | "unsupported" | "auth" | "read-only" | "busy" | "cancelled" | "failed", message: string) {
    super(message);
  }
}

/** Do not display raw transport errors: some servers echo credentials in their causes. */
export function gitWorkflowError(error: unknown): GitWorkflowError {
  if (error instanceof GitWorkflowError) return error;
  const e = error as { _tag?: string; reason?: string; name?: string; message?: string } | null;
  if (e?.message === READ_ONLY_ERROR) return new GitWorkflowError("read-only", READ_ONLY_ERROR);
  if (e?.name === "AbortError") return new GitWorkflowError("cancelled", "Request cancelled");
  if (e?._tag === "EnvironmentAuthInvalidError" || e?._tag === "EnvironmentAuthRequiredError" ||
      e?._tag === "EnvironmentAuthorizationError" || e?.reason === "cli-unauthenticated")
    return new GitWorkflowError("auth", "Access denied. Check the server token and Git host credentials in T3 Web.");
  if (e?.reason === "provider-unsupported" || e?.reason === "cli-missing")
    return new GitWorkflowError("unsupported", "This operation needs a supported Git host and its tools configured on the server.");
  return new GitWorkflowError("failed", "Git/PR request failed. Check repository state, permissions and server connectivity; refresh before retrying a write.");
}

export interface GitWorkspace {
  projectId: C.ProjectId;
  threadId?: C.ThreadId;
  projectCwd: string;
  worktreePath: string | null;
}
export function workspaceCwd(workspace: GitWorkspace) {
  return workspace.worktreePath ?? workspace.projectCwd;
}
export function workspaceKey(workspace: GitWorkspace) {
  return JSON.stringify([workspace.projectId, workspace.threadId ?? null, workspaceCwd(workspace)]);
}

export type WorkflowState<A> =
  | { status: "idle" }
  | { status: "loading"; target: string }
  | { status: "ready"; target: string; value: A }
  | { status: "error"; target: string; error: GitWorkflowError };

/** One view's latest read wins. Cancel invalidates results even when I/O ignores abort.
 * Writes remain locked until they settle, including after closing the view. Never auto-retry.
 * A new explicit submission after an ambiguous failure must be a deliberate user decision.
 */
export function createWorkflowResource<A>(changed: (state: WorkflowState<A>) => void) {
  let generation = 0;
  let abort: AbortController | undefined;
  const writes = new Set<string>();
  function cancel() {
    generation++;
    abort?.abort();
    abort = undefined;
    changed({ status: "idle" });
  }
  return {
    cancel,
    async run(target: string, load: (signal: AbortSignal) => Promise<A>, mutation = false) {
      if (writes.has(target)) throw new GitWorkflowError("busy", "An action for this target is still pending");
      abort?.abort();
      const current = ++generation;
      const controller = new AbortController();
      abort = controller;
      if (mutation) writes.add(target);
      changed({ status: "loading", target });
      try {
        const value = await load(controller.signal);
        if (current === generation && !controller.signal.aborted) changed({ status: "ready", target, value });
      } catch (error) {
        if (current === generation && !controller.signal.aborted)
          changed({ status: "error", target, error: gitWorkflowError(error) });
      } finally {
        if (mutation) writes.delete(target);
        if (current === generation) abort = undefined;
      }
    },
  };
}

export function assertGitPolicy(operation: GitOperation, readOnly: boolean) {
  if (readOnly && GIT_READ_ONLY_POLICY[operation] === "block")
    throw new GitWorkflowError("read-only", READ_ONLY_ERROR);
}
