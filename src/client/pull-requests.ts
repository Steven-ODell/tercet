import { CommandId, type PullRequestRef, type PullRequestListEntry, type PullRequestReviewVerdict } from "@t3tools/contracts";
import type { Client } from "./runtime";
import type { BranchTarget } from "./git-workflows.tsx";
import { createWorkflowResource, GitWorkflowError, workspaceCwd, workspaceKey, type GitOutput, type WorkflowState } from "./git-workflows.ts";

export type PRSelection = { ref: PullRequestRef; url: string };
export type PRData = { detail: GitOutput<"detail">; checks: GitOutput<"checks">; activity: GitOutput<"activity"> };
export function prKey(target: BranchTarget, selection?: PRSelection) {
  return JSON.stringify([workspaceKey(target), selection?.ref.host, selection?.ref.expectedAccountId, selection?.ref.repository, selection?.ref.number]);
}
export function createPullRequestWorkflow(client: Pick<Client, "git" | "dispatch">, current: () => BranchTarget | undefined) {
  const listeners = new Set<() => void>();
  type Value = GitOutput<"listPRs"> | PRData | GitOutput<"diffPreview">;
  let state: WorkflowState<Value> = { status: "idle" };
  let pending = false;
  const drafts = new Map<string, string>();
  // An ambiguous failure requires a successful refresh before an explicit resubmission.
  const uncertain = new Set<string>();
  const resource = createWorkflowResource<Value>((value) => { state = value; listeners.forEach((f) => f()); });
  function assertCurrent(target: BranchTarget) {
    const now = current();
    if (!now || workspaceKey(now) !== workspaceKey(target) || now.branch !== target.branch)
      throw new GitWorkflowError("busy", "Workspace changed. Reopen Pull requests before acting.");
  }
  async function detail(selection: PRSelection, signal?: AbortSignal) {
    const result = await client.git("detail", { ...selection.ref, allowStale: false }, signal);
    if (result.repository !== selection.ref.repository || result.number !== selection.ref.number || result.projectId !== selection.ref.projectId || result.url !== selection.url)
      throw new GitWorkflowError("busy", "PR identity changed. Refresh before acting.");
    return result;
  }
  const load = async (selection: PRSelection, signal?: AbortSignal): Promise<PRData> => {
    const [value, checks, activity] = await Promise.all([detail(selection, signal), client.git("checks", { ...selection.ref, allowStale: false }, signal), client.git("activity", { ...selection.ref, allowStale: false }, signal)]);
    return { detail: value, checks, activity };
  };
  async function write(target: BranchTarget, selection: PRSelection | undefined, action: () => Promise<PRData | GitOutput<"listPRs">>) {
    if (pending) return;
    pending = true;
    const key = prKey(target, selection);
    try {
      await resource.run(key, async () => {
        assertCurrent(target);
        if (selection && selection.ref.projectId !== target.projectId) throw new GitWorkflowError("busy", "PR belongs to another project. Reopen Pull requests.");
        if (uncertain.has(key)) throw new GitWorkflowError("busy", "Previous result is uncertain. Refresh and inspect the host before submitting again.");
        try { return await action(); }
        catch (error) { uncertain.add(key); throw error; }
      }, true);
    } finally { pending = false; }
  }
  return {
    subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    snapshot: () => state,
    cancel: resource.cancel,
    draft: (key: string) => drafts.get(key) ?? "",
    setDraft: (key: string, body: string) => { drafts.set(key, body); },
    async refresh(target: BranchTarget, selection?: PRSelection) {
      if (pending) return;
      await resource.run(prKey(target, selection), async (signal) => {
        const value = selection ? await load(selection, signal) : await client.git("listPRs", { projectId: target.projectId, state: "all", limit: 100 }, signal);
        uncertain.delete(prKey(target, selection));
        return value;
      });
    },
    async selection(target: BranchTarget, entry: PullRequestListEntry): Promise<PRSelection> {
      const identity = await client.git("prIdentity", { host: entry.host });
      assertCurrent(target);
      return { ref: { projectId: target.projectId, host: entry.host, repository: entry.repository, number: entry.number, expectedAccountId: identity.accountId }, url: entry.url };
    },
    submit(target: BranchTarget, selection: PRSelection, verdict: "discussion" | PullRequestReviewVerdict) {
      const key = prKey(target, selection);
      const body = drafts.get(key) ?? "";
      return write(target, selection, async () => {
        const fresh = await detail(selection);
        assertCurrent(target);
        if ((verdict !== "approve" && !body.trim()) || body.length > 65536) throw new GitWorkflowError("failed", "Enter a body up to 65536 characters (required except for approval).");
        if (verdict === "discussion") {
          if (!fresh.capabilities.comment || !fresh.viewerPermissions.comment) throw new GitWorkflowError("unsupported", "This account cannot comment on this PR.");
          await client.git("comment", { ...selection.ref, allowStale: false, body });
        } else {
          if (!fresh.capabilities.review.verdicts.includes(verdict) || !fresh.viewerPermissions.verdicts.includes(verdict)) throw new GitWorkflowError("unsupported", "This account cannot submit this review verdict.");
          await client.git("submitReview", { ...selection.ref, allowStale: false, verdict, body, comments: [] });
        }
        // Clear only after confirmed write, never after an ambiguous transport failure.
        if (drafts.get(key) === body) drafts.delete(key);
        return load(selection);
      });
    },
    link(target: BranchTarget, selection: PRSelection, action: "link" | "unlink" | "watch" | "unwatch") {
      return write(target, selection, async () => {
        if (!target.threadId || !selection.ref.host) throw new GitWorkflowError("unsupported", "Select a thread and host before linking.");
        await detail(selection); assertCurrent(target);
        const base = { commandId: CommandId.make(crypto.randomUUID()), threadId: target.threadId, host: selection.ref.host, repository: selection.ref.repository, number: selection.ref.number };
        if (action === "link") await client.dispatch({ ...base, type: "thread.pull-request.link", source: "manual", url: selection.url });
        else if (action === "unlink") await client.dispatch({ ...base, type: "thread.pull-request.unlink" });
        else await client.dispatch({ ...base, type: "thread.pull-request.watch", watching: action === "watch", link: { source: "manual", url: selection.url } });
        return load(selection);
      });
    },
    create(target: BranchTarget) {
      return write(target, undefined, async () => {
        const before = await client.git("status", { cwd: workspaceCwd(target), localOnly: true });
        assertCurrent(target);
        if (current()?.running || !before.isRepo || before.hasWorkingTreeChanges || !before.hasPrimaryRemote || before.refName !== target.branch || before.isDefaultRef)
          throw new GitWorkflowError("busy", "Create PR needs an idle, clean feature branch with a remote. Refresh Branches first.");
        const events = await client.git("createPR", { cwd: workspaceCwd(target), action: "create_pr", actionId: crypto.randomUUID(), projectId: target.projectId, ...(target.threadId ? { threadId: target.threadId } : {}) });
        if (!events.some((event) => event.kind === "action_finished") || events.some((event) => event.kind === "action_failed"))
          throw new GitWorkflowError("failed", "PR creation did not confirm success. Inspect the host before retrying.");
        return client.git("listPRs", { projectId: target.projectId, state: "all", limit: 100 });
      });
    },
    async diff(target: BranchTarget, selection: PRSelection) {
      if (pending) return;
      await resource.run(prKey(target, selection), async (signal) => {
        const fresh = await detail(selection, signal);
        const status = await client.git("status", { cwd: workspaceCwd(target), localOnly: true }, signal);
        if (status.refName !== fresh.headBranch) throw new GitWorkflowError("busy", "Local branch differs from PR head. Open the host diff or select its workspace in Branches.");
        return client.git("diffPreview", { cwd: workspaceCwd(target), baseRef: fresh.baseBranch, sourceKind: "branch-range", ignoreWhitespace: false }, signal);
      });
    },
  };
}
export type PullRequestWorkflow = ReturnType<typeof createPullRequestWorkflow>;
