import { CommandId, type VcsRef } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useKeyboard } from "@opentui/react";
import type { Client } from "./runtime";
import { workspaceChoices, verifiedWorkspaceChoices, type WorkspaceChoice } from "./workspace";
import { theme } from "./theme";
import { createWorkflowResource, GitWorkflowError, workspaceCwd, workspaceKey, type GitWorkspace, type GitOutput, type WorkflowState } from "./git-workflows.ts";

export interface BranchTarget extends GitWorkspace {
  branch: string | null;
  running: boolean;
  knownWorkspaces?: readonly WorkspaceChoice[];
}
export interface BranchData { status: GitOutput<"status">; refs: readonly VcsRef[]; workspaces?: WorkspaceChoice[] }

/** Owned by the frame, so closing/reopening a view cannot unlock an in-flight write. */
export function createBranchWorkflow(client: Pick<Client, "git" | "dispatch"> & Partial<Pick<Client, "getThread">>, current: () => BranchTarget | undefined, busyWorkspace: (cwd: string) => boolean = () => false) {
  let state: WorkflowState<BranchData> = { status: "idle" };
  let pending = false;
  const listeners = new Set<() => void>();
  const resource = createWorkflowResource<BranchData>((next) => {
    state = next;
    listeners.forEach((listener) => listener());
  });
  const load = async (target: BranchTarget, signal?: AbortSignal): Promise<BranchData> => {
    const cwd = workspaceCwd(target);
    const status = await client.git("status", { cwd, localOnly: true }, signal);
    const refs: VcsRef[] = [];
    let cursor: number | undefined;
    do {
      const page = await client.git("refs", { cwd, refKind: "all", limit: 200, ...(cursor === undefined ? {} : { cursor }) }, signal);
      refs.push(...page.refs);
      if (page.nextCursor !== null && page.nextCursor === cursor) throw new GitWorkflowError("failed", "Branch pagination did not advance");
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const workspaces = await verifiedWorkspaceChoices(target.projectCwd, refs, target.knownWorkspaces ?? [],
      (cwd) => client.git("status", { cwd, localOnly: true }, signal));
    return { status, refs, workspaces };
  };
  async function bind(target: BranchTarget, choice: WorkspaceChoice) {
    if (target.threadId && choice.worktreePath !== target.worktreePath && client.getThread) {
      const projection = client.getThread(target.threadId).projection;
      if (!projection) throw new GitWorkflowError("busy", "Wait for thread history before changing its workspace.");
      if (projection.providerSessions.some((session) => ["starting", "running", "waiting"].includes(session.status)))
        throw new GitWorkflowError("busy", "Stop the provider session before changing its workspace.");
      // Match stock stopThreadSession: detach idle sessions so the next turn starts at its new cwd.
      for (const session of projection.providerSessions) await client.dispatch({
        type: "provider-session.detach", commandId: CommandId.make(crypto.randomUUID()),
        threadId: target.threadId, providerSessionId: session.id, reason: "client-requested",
      });
    }
    if (target.threadId) await client.dispatch({
      type: "thread.metadata.update", commandId: CommandId.make(crypto.randomUUID()),
      threadId: target.threadId, ...choice,
      expectedBranch: target.branch, expectedWorktreePath: target.worktreePath,
    });
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    cancel: resource.cancel,
    refresh(target: BranchTarget) { if (pending) return Promise.resolve(); return resource.run(workspaceKey(target), (signal) => load(target, signal)); },
    async workspace(target: BranchTarget, choice: WorkspaceChoice, newBranch?: string) {
      if (pending) return;
      pending = true;
      try {
        await resource.run(workspaceKey(target), async () => {
          const assertTarget = () => {
            const now = current();
            const sessions = target.threadId && client.getThread?.(target.threadId).projection?.providerSessions;
            if (sessions?.some((session) => ["starting", "running", "waiting"].includes(session.status)))
              throw new GitWorkflowError("busy", "Stop the provider session before changing its workspace.");
            if (!now || workspaceKey(now) !== workspaceKey(target) || now.branch !== target.branch || now.running || busyWorkspace(choice.worktreePath ?? target.projectCwd))
              throw new GitWorkflowError("busy", "Workspace changed or has running/queued turns. Refresh after turns stop.");
          };
          assertTarget();
          const before = await load(target);
          assertTarget();
          if (!before.status.isRepo) throw new GitWorkflowError("failed", "This workspace is not a Git repository.");
          let selected = choice;
          if (newBranch) {
            const result = await client.git("createWorktree", { cwd: workspaceCwd(target), refName: before.status.refName ?? "HEAD", newRefName: newBranch, path: null });
            selected = { branch: result.worktree.refName, worktreePath: result.worktree.path };
          } else {
            const choices = before.workspaces!;
            if (!choices.some((row) => row.worktreePath === choice.worktreePath && row.branch === choice.branch))
              throw new GitWorkflowError("busy", "Workspace list changed. Refresh before selecting.");
            const status = await client.git("status", { cwd: choice.worktreePath ?? target.projectCwd, localOnly: true });
            if (!status.isRepo || status.refName !== choice.branch) throw new GitWorkflowError("busy", "Workspace branch changed. Refresh before selecting.");
          }
          // A completed server write cannot be undone on close. Keep its binding bookkeeping alive.
          if (!newBranch) assertTarget();
          if (busyWorkspace(workspaceCwd(target))) throw new GitWorkflowError("busy", "Source workspace has running turns. Worktree retained; refresh before selecting.");
          if (busyWorkspace(selected.worktreePath ?? target.projectCwd)) throw new GitWorkflowError("busy", "Destination has running turns. Worktree retained; refresh before selecting.");
          await bind(target, selected);
          return load({ ...target, ...selected });
        }, true);
      } finally { pending = false; }
    },
    async change(target: BranchTarget, refName: string, create = false) {
      if (pending) return;
      pending = true;
      try {
        await resource.run(workspaceKey(target), async () => {
          const assertTarget = () => {
            const now = current();
            const sessions = target.threadId && client.getThread?.(target.threadId).projection?.providerSessions;
            if (sessions?.some((session) => ["starting", "running", "waiting"].includes(session.status)))
              throw new GitWorkflowError("busy", "Stop the provider session before changing its workspace.");
            if (!now || workspaceKey(now) !== workspaceKey(target) || now.branch !== target.branch)
              throw new GitWorkflowError("busy", "Workspace changed. Refresh before choosing a branch.");
            if (now.running) throw new GitWorkflowError("busy", "Stop running or queued turns in this workspace before changing branches.");
          };
          assertTarget();
          const before = await load(target);
          assertTarget();
          if (!before.status.isRepo) throw new GitWorkflowError("failed", "This workspace is not a Git repository.");
          if (before.status.hasWorkingTreeChanges) throw new GitWorkflowError("busy", "Working tree has edits. Commit or preserve them before changing branches.");
          const ref = before.refs.find((item) => item.name === refName);
          if (!create && ref?.worktreePath && ref.worktreePath !== workspaceCwd(target))
            throw new GitWorkflowError("busy", "Branch is checked out in another worktree. Select that workspace instead.");
          const result = create
            ? await client.git("createRef", { cwd: workspaceCwd(target), refName, switchRef: true })
            : await client.git("switchRef", { cwd: workspaceCwd(target), refName });
          // Do not abort bookkeeping when the dialog closes: the server write already happened.
          if (target.threadId) await client.dispatch({
            type: "thread.metadata.update", commandId: CommandId.make(crypto.randomUUID()),
            threadId: target.threadId, branch: result.refName, worktreePath: target.worktreePath,
            expectedBranch: target.branch, expectedWorktreePath: target.worktreePath,
          });
          return load(target);
        }, true);
      } finally { pending = false; }
    },
  };
}
export type BranchWorkflow = ReturnType<typeof createBranchWorkflow>;

export function BranchPanel({ workflow, target, close }: { workflow: BranchWorkflow; target?: BranchTarget; close: () => void }) {
  const state = useSyncExternalStore(workflow.subscribe, workflow.snapshot);
  const [cursor, setCursor] = useState(0);
  const [creating, setCreating] = useState(false);
  const [worktrees, setWorktrees] = useState(false);
  const [name, setName] = useState("");
  const key = target && workspaceKey(target);
  useEffect(() => {
    setCursor(0); setCreating(false); setName("");
    if (target) void workflow.refresh(target);
    return workflow.cancel;
  }, [workflow, key]);
  const data = state.status === "ready" && state.target === key ? state.value : undefined;
  const rows = data && target ? data.workspaces ?? workspaceChoices(target.projectCwd, data.refs) : [];
  const choose = (index: number) => {
    if (worktrees) { if (target && rows[index]) void workflow.workspace(target, rows[index]!); return; }
    if (target && data?.refs[index]) void workflow.change(target, data.refs[index]!.name);
  };
  useKeyboard((event) => {
    if (event.defaultPrevented) return;
    if (event.name === "escape") { event.preventDefault(); if (creating) setCreating(false); else close(); return; }
    if (creating || event.ctrl || event.meta) return;
    if (event.name === "w") { event.preventDefault(); setWorktrees((value) => !value); setCursor(0); }
    if (event.name === "n") { event.preventDefault(); setCreating(true); }
    if (event.name === "r" && target) { event.preventDefault(); void workflow.refresh(target); }
    if (event.name === "return") { event.preventDefault(); choose(cursor); }
    const step = event.name === "up" || event.name === "k" ? -1 : event.name === "down" || event.name === "j" ? 1 : 0;
    if (step) { event.preventDefault(); setCursor((n) => Math.max(0, Math.min((worktrees ? rows.length : data?.refs.length ?? 1) - 1, n + step))); }
  });
  return <box position="absolute" left={0} top={0} width="100%" height="100%" border borderColor={theme.accent} backgroundColor={theme.canvas} flexDirection="column" title="Branches">
    <text flexShrink={0} fg={theme.accent}>{worktrees ? "Worktrees" : "Branches"}</text>
    <text flexShrink={0} fg={theme.accent} onMouseUp={() => { setWorktrees((value) => !value); setCursor(0); setCreating(false); }}>[w Branches / Worktrees]</text>
    <text flexShrink={0} fg={theme.muted} onMouseUp={() => close()}>[Esc Back]</text>
    <text flexShrink={0} fg={theme.plain}>{target ? workspaceCwd(target) : "Select a thread first"}</text>
    {data && <text flexShrink={0} fg={theme.plain}>{`${data.status.refName ?? "Detached HEAD"} · ${data.status.hasWorkingTreeChanges ? "dirty" : "clean"} · ahead ${data.status.aheadCount} / behind ${data.status.behindCount}${target?.running ? " · running" : ""}`}</text>}
    <text flexShrink={0} fg={theme.accent} onMouseUp={() => { if (target) void workflow.refresh(target); }}>[r Refresh]</text>
    {state.status === "loading" && <text flexShrink={0} fg={theme.muted}>Loading / action pending… Closing cannot undo a server write.</text>}
    {state.status === "error" && <text flexShrink={0} fg={theme.accent}>{state.error.message}</text>}
    {creating ? <box flexShrink={0} flexDirection="column">
      <text flexShrink={0} fg={theme.plain}>{worktrees ? "Create worktree + new branch (Enter confirms)" : "Create and switch to branch (Enter confirms, Esc cancels)"}</text>
      <input flexShrink={0} focused value={name} onInput={setName} onSubmit={() => { if (target && name.trim()) { setCreating(false); if (worktrees) void workflow.workspace(target, { branch: null, worktreePath: null }, name.trim()); else void workflow.change(target, name.trim(), true); } }} />
    </box> : <text flexShrink={0} fg={theme.accent} onMouseUp={() => setCreating(true)}>{worktrees ? "[n Create worktree]" : "[n Create branch]"}</text>}
    <scrollbox minHeight={0} flexGrow={1} scrollY scrollX={false}>
      {worktrees && rows.map((row, index) => <text flexShrink={0} key={row.worktreePath ?? "root"} fg={index === cursor ? theme.strong : theme.plain} bg={index === cursor ? theme.highlight : undefined} onMouseUp={(event) => { if (event.button === 0) choose(index); }}>{`${index === cursor ? "› " : "  "}${row.branch ?? "Detached HEAD"} · ${row.worktreePath ?? target?.projectCwd}`}</text>)}
      {!worktrees && data?.refs.map((ref, index) => <text flexShrink={0} key={`${ref.isRemote}:${ref.name}`} fg={index === cursor ? theme.strong : theme.plain} bg={index === cursor ? theme.highlight : undefined} onMouseUp={(event) => { if (event.button === 0) choose(index); }}>{`${index === cursor ? "› " : "  "}${ref.current ? "* " : ""}${ref.name}${ref.worktreePath && ref.worktreePath !== (target && workspaceCwd(target)) ? ` · in ${ref.worktreePath}` : ""}`}</text>)}
    </scrollbox>
  </box>;
}
