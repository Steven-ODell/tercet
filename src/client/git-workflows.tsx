import { CommandId, type VcsRef } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useKeyboard } from "@opentui/react";
import type { Client } from "./runtime";
import { theme } from "./theme";
import { createWorkflowResource, GitWorkflowError, workspaceCwd, workspaceKey, type GitWorkspace, type GitOutput, type WorkflowState } from "./git-workflows.ts";

export interface BranchTarget extends GitWorkspace {
  branch: string | null;
  running: boolean;
}
export interface BranchData { status: GitOutput<"status">; refs: readonly VcsRef[] }

/** Owned by the frame, so closing/reopening a view cannot unlock an in-flight write. */
export function createBranchWorkflow(client: Pick<Client, "git" | "dispatch">, current: () => BranchTarget | undefined) {
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
    return { status, refs };
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    cancel: resource.cancel,
    refresh(target: BranchTarget) { if (pending) return Promise.resolve(); return resource.run(workspaceKey(target), (signal) => load(target, signal)); },
    async change(target: BranchTarget, refName: string, create = false) {
      if (pending) return;
      pending = true;
      try {
        await resource.run(workspaceKey(target), async () => {
          const assertTarget = () => {
            const now = current();
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
  const [name, setName] = useState("");
  const key = target && workspaceKey(target);
  useEffect(() => {
    setCursor(0); setCreating(false); setName("");
    if (target) void workflow.refresh(target);
    return workflow.cancel;
  }, [workflow, key]);
  const data = state.status === "ready" && state.target === key ? state.value : undefined;
  const choose = (index: number) => {
    if (target && data?.refs[index]) void workflow.change(target, data.refs[index]!.name);
  };
  useKeyboard((event) => {
    if (event.defaultPrevented) return;
    if (event.name === "escape") { event.preventDefault(); if (creating) setCreating(false); else close(); return; }
    if (creating || event.ctrl || event.meta) return;
    if (event.name === "n") { event.preventDefault(); setCreating(true); }
    if (event.name === "r" && target) { event.preventDefault(); void workflow.refresh(target); }
    if (event.name === "return") { event.preventDefault(); choose(cursor); }
    const step = event.name === "up" || event.name === "k" ? -1 : event.name === "down" || event.name === "j" ? 1 : 0;
    if (step) { event.preventDefault(); setCursor((n) => Math.max(0, Math.min((data?.refs.length ?? 1) - 1, n + step))); }
  });
  return <box position="absolute" left={0} top={0} width="100%" height="100%" border borderColor={theme.accent} backgroundColor={theme.canvas} flexDirection="column" title="Branches">
    <text fg={theme.accent}>Branches</text>
    <text fg={theme.muted} onMouseUp={() => close()}>[Esc Back]</text>
    <text fg={theme.plain}>{target ? workspaceCwd(target) : "Select a thread first"}</text>
    {data && <text fg={theme.plain}>{`${data.status.refName ?? "Detached HEAD"} · ${data.status.hasWorkingTreeChanges ? "dirty" : "clean"} · ahead ${data.status.aheadCount} / behind ${data.status.behindCount}${target?.running ? " · running" : ""}`}</text>}
    <text fg={theme.accent} onMouseUp={() => { if (target) void workflow.refresh(target); }}>[r Refresh]</text>
    {state.status === "loading" && <text fg={theme.muted}>Loading / action pending… Closing cannot undo a server write.</text>}
    {state.status === "error" && <text fg={theme.accent}>{state.error.message}</text>}
    {creating ? <box flexDirection="column">
      <text fg={theme.plain}>Create and switch to branch (Enter confirms, Esc cancels)</text>
      <input focused value={name} onInput={setName} onSubmit={() => { if (target && name.trim()) { setCreating(false); void workflow.change(target, name.trim(), true); } }} />
    </box> : <text fg={theme.accent} onMouseUp={() => setCreating(true)}>[n Create branch]</text>}
    <scrollbox flexGrow={1} scrollY scrollX={false}>
      {data?.refs.map((ref, index) => <text key={`${ref.isRemote}:${ref.name}`} fg={index === cursor ? theme.strong : theme.plain} bg={index === cursor ? theme.highlight : undefined} onMouseUp={(event) => { if (event.button === 0) choose(index); }}>{`${index === cursor ? "› " : "  "}${ref.current ? "* " : ""}${ref.name}${ref.worktreePath && ref.worktreePath !== (target && workspaceCwd(target)) ? ` · in ${ref.worktreePath}` : ""}`}</text>)}
    </scrollbox>
  </box>;
}
