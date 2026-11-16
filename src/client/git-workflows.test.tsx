import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { BranchPanel, createBranchWorkflow, type BranchTarget, type BranchData } from "./git-workflows.tsx";
import { workspaceChoices, verifiedWorkspaceChoices } from "./workspace";
import type { Client } from "./runtime";

const target: BranchTarget = { projectId: ProjectId.make("p"), threadId: ThreadId.make("t"), projectCwd: "C:\\project with spaces", worktreePath: null, branch: "main", running: false };
const status: BranchData["status"] = { isRepo: true, hasPrimaryRemote: false, isDefaultRef: true, refName: "main", hasWorkingTreeChanges: false, workingTree: { files: [], insertions: 0, deletions: 0 }, hasUpstream: false, aheadCount: 0, behindCount: 0, pr: null };
const refs = [{ name: "main", current: true, isDefault: true, worktreePath: target.projectCwd }, { name: "feature", current: false, isDefault: false, worktreePath: null }];
function fixture() {
  const calls: { operation: string; input: any }[] = [];
  let now = { ...target };
  let dirty = false;
  let other = false;
  let release: (() => void) | undefined;
  let hold = false;
  const client = {
    git: async (operation: string, input: any) => {
      calls.push({ operation, input });
      if (operation === "status") return { ...status, hasWorkingTreeChanges: dirty };
      if (operation === "refs") return { refs: refs.map((r) => r.name === "feature" && other ? { ...r, worktreePath: "\\\\server\\other workspace" } : r), nextCursor: null };
      if (hold) await new Promise<void>((done) => { release = done; });
      if (operation === "createWorktree") return { worktree: { refName: input.newRefName, path: String.raw`\\server\managed worktree` } };
      return { refName: input.refName };
    },
    dispatch: async (input: any) => { calls.push({ operation: "dispatch", input }); },
  } as unknown as Pick<Client, "git" | "dispatch">;
  const workflow = createBranchWorkflow(client, () => now);
  return { workflow, calls, setNow: (value: BranchTarget) => { now = value; }, dirty: () => { dirty = true; }, other: () => { other = true; }, hold: () => { hold = true; }, release: () => release?.() };
}

test("branch switch targets opaque cwd, binds with preconditions and refreshes after success", async () => {
  const f = fixture();
  await f.workflow.change(target, "feature");
  expect(f.calls.find((c) => c.operation === "switchRef")?.input).toEqual({ cwd: target.projectCwd, refName: "feature" });
  expect(f.calls.find((c) => c.operation === "dispatch")?.input).toEqual({ type: "thread.metadata.update", commandId: expect.any(String), threadId: target.threadId, branch: "feature", worktreePath: null, expectedBranch: "main", expectedWorktreePath: null });
  expect(f.calls.filter((c) => c.operation === "status")).toHaveLength(2);
});

test("dirty, occupied, running and changed targets refuse writes and metadata updates", async () => {
  for (const kind of ["dirty", "other", "running", "changed"] as const) {
    const f = fixture();
    if (kind === "dirty") f.dirty();
    if (kind === "other") f.other();
    if (kind === "running") f.setNow({ ...target, running: true });
    if (kind === "changed") f.setNow({ ...target, worktreePath: "/new" });
    await f.workflow.change(target, "feature");
    expect(f.workflow.snapshot().status).toBe("error");
    expect(f.calls.some((c) => ["switchRef", "createRef", "dispatch"].includes(c.operation))).toBe(false);
  }
});

test("closing cannot unlock or cancel a pending create or its metadata update", async () => {
  const f = fixture(); f.hold();
  const pending = f.workflow.change(target, "new branch", true);
  for (let i = 0; i < 20 && !f.calls.some((c) => c.operation === "createRef"); i++) await Promise.resolve();
  f.workflow.cancel();
  await f.workflow.change(target, "duplicate", true);
  f.release(); await pending;
  expect(f.calls.filter((c) => c.operation === "createRef")).toEqual([{ operation: "createRef", input: { cwd: target.projectCwd, refName: "new branch", switchRef: true } }]);
  expect(f.calls.filter((c) => c.operation === "dispatch")).toHaveLength(1);
  expect(f.workflow.snapshot().status).toBe("idle");
});

test("narrow branch panel supports keyboard selection, mouse create, refresh, errors and back", async () => {
  const f = fixture(); let closed = 0;
  const view = await testRender(<BranchPanel workflow={f.workflow} target={target} close={() => closed++} />, { width: 48, height: 20, kittyKeyboard: true, exitOnCtrlC: false });
  const key = async (name: string) => { await act(async () => { view.mockInput.pressKey(name); }); await view.flush(); };
  const click = async (label: string) => {
    const lines = view.captureCharFrame().split("\n"); const y = lines.findIndex((l) => l.includes(label)); expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => { await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y); }); await view.flush();
  };
  try {
    await view.waitForFrame((frame) => frame.includes("feature"));
    expect(view.captureCharFrame()).toContain("clean");
    await key("ARROW_DOWN"); await key("RETURN");
    await view.waitForFrame((frame) => frame.includes("feature"));
    expect(f.calls.some((c) => c.operation === "switchRef" && c.input.refName === "feature")).toBe(true);
    await click("[n Create branch]");
    await act(async () => { await view.mockInput.typeText("topic"); }); await key("RETURN");
    await view.waitForFrame((frame) => frame.includes("feature"));
    expect(f.calls.some((c) => c.operation === "createRef" && c.input.refName === "topic")).toBe(true);
    f.dirty(); await click("[r Refresh]");
    await view.waitForFrame((frame) => frame.includes("dirty"));
    await key("RETURN"); await view.waitForFrame((frame) => frame.includes("Working tree has edits"));
    await key("ESCAPE"); expect(closed).toBe(1);
  } finally { view.renderer.destroy(); }
});

// This opt-in fixture uses POSIX Git/server processes; renderer/controller tests above are portable.
test.skipIf(process.platform === "win32" || process.env.TERCET_GIT_LIVE !== "1")("actual pinned server creates/switches branches and refuses a destructive dirty checkout", async () => {
  const { gitMethods } = await import("./connection");
  const Effect = await import("effect/Effect");
  const fs = await import("node:fs/promises");
  const dir = process.env.TERCET_SANDBOX_DIR!;
  const cwd = `${dir}/work/demo-app`;
  const token = (await fs.readFile(`${dir}/token`, "utf8")).trim();
  const url = "http://127.0.0.1:3776";
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  const request = async (op: "createRef" | "switchRef" | "status", input: any) =>
    Effect.runPromise(gitMethods[op](url, token, input));
  await request("createRef", { cwd, refName: "feature", switchRef: true });
  expect(git("branch", "--show-current")).toBe("feature");
  await fs.writeFile(`${cwd}/README.md`, "feature committed content\n");
  git("add", "README.md"); git("commit", "-qm", "feature conflict");
  await request("switchRef", { cwd, refName: "main" });
  expect(git("branch", "--show-current")).toBe("main");
  const edits = "unsaved main edits must survive\n";
  await fs.writeFile(`${cwd}/README.md`, edits);
  let refused = false;
  try { await request("switchRef", { cwd, refName: "feature" }); } catch { refused = true; }
  expect(refused).toBe(true);
  expect(git("branch", "--show-current")).toBe("main");
  expect(await fs.readFile(`${cwd}/README.md`, "utf8")).toBe(edits);
  const liveTarget = { ...target, projectCwd: cwd, threadId: undefined };
  const workflow = createBranchWorkflow({ git: ((op: any, input: any) => Effect.runPromise((gitMethods as any)[op](url, token, input))) as Client["git"], dispatch: async () => { throw new Error("unexpected metadata write"); } }, () => liveTarget);
  await workflow.change(liveTarget, "feature");
  expect(workflow.snapshot().status).toBe("error");
  expect(await fs.readFile(`${cwd}/README.md`, "utf8")).toBe(edits);
});

test("worktree creation preserves dirty source, binds managed opaque path and refreshes destination", async () => {
  const f = fixture(); f.dirty();
  await f.workflow.workspace(target, { branch: null, worktreePath: null }, "topic");
  expect(f.calls.find((c) => c.operation === "createWorktree")?.input).toEqual({ cwd: target.projectCwd, refName: "main", newRefName: "topic", path: null });
  expect(f.calls.find((c) => c.operation === "dispatch")?.input).toMatchObject({ branch: "topic", worktreePath: String.raw`\\server\managed worktree`, expectedBranch: "main", expectedWorktreePath: null });
  expect(f.calls.at(-2)?.input.cwd).toBe(String.raw`\\server\managed worktree`);
});

test("workspaces deduplicate paths and find root branch even when read from a worktree", () => {
  expect(workspaceChoices("/root", [
    { name: "topic", current: true, isDefault: false, worktreePath: "/tree" },
    { name: "main", current: false, isDefault: true, worktreePath: "/root" },
  ], [{ branch: "topic", worktreePath: "/tree" }, { branch: null, worktreePath: "/detached" }])).toEqual([
    { branch: "main", worktreePath: null }, { branch: "topic", worktreePath: "/tree" }, { branch: null, worktreePath: "/detached" },
  ]);
});

test("workspace choices exclude deleted thread bindings but retain live detached workspaces", async () => {
  const checked: string[] = [];
  const choices = await verifiedWorkspaceChoices("/root", [
    { name: "main", current: true, isDefault: true, worktreePath: "/root" },
  ], [
    { branch: "feat/kokoro-readback", worktreePath: "/deleted" },
    { branch: "old", worktreePath: "/not-repo" },
    { branch: "old", worktreePath: "/detached" },
    { branch: "old", worktreePath: "/detached" },
  ], async (cwd) => {
    checked.push(cwd);
    if (cwd === "/deleted") throw new Error("Directory removed");
    return { isRepo: cwd !== "/not-repo", refName: null };
  });
  expect(checked).toEqual(["/deleted", "/not-repo", "/detached"]);
  expect(choices).toEqual([{ branch: "main", worktreePath: null }, { branch: null, worktreePath: "/detached" }]);
  expect(await verifiedWorkspaceChoices("/root", [], [{ branch: "topic", worktreePath: "/deleted" }], async () => { throw new Error("removed"); })).toEqual([{ branch: null, worktreePath: null }]);
});

test("worktree selection only binds verified branch/path, and source/destination runs refuse writes", async () => {
  const calls: any[] = [];
  let busy = false;
  const path = String.raw`C:\managed tree`;
  const workflow = createBranchWorkflow({
    git: (async (op: string, input: any) => {
      calls.push([op, input]);
      if (op === "refs") return { refs: [...refs, { name: "topic", worktreePath: path }], nextCursor: null };
      return { ...status, refName: input.cwd === path ? "topic" : "main" };
    }) as Client["git"],
    dispatch: async (command) => { calls.push(["dispatch", command]); },
  }, () => target, (cwd) => busy && cwd === path);
  await workflow.workspace(target, { branch: "topic", worktreePath: path });
  expect(calls.filter(([op]) => op === "dispatch")[0][1]).toMatchObject({ branch: "topic", worktreePath: path, expectedWorktreePath: null });
  busy = true; calls.length = 0;
  await workflow.workspace(target, { branch: "topic", worktreePath: path });
  expect(calls).toHaveLength(0);
  expect(workflow.snapshot().status).toBe("error");
  const f = fixture(); f.setNow({ ...target, running: true });
  await f.workflow.workspace(target, { branch: null, worktreePath: null }, "blocked");
  expect(f.calls).toHaveLength(0);
});

test("closing a pending worktree creation keeps write lock and binding alive", async () => {
  const f = fixture(); f.hold();
  const write = f.workflow.workspace(target, { branch: null, worktreePath: null }, "topic");
  for (let i = 0; i < 30 && !f.calls.some((c) => c.operation === "createWorktree"); i++) await Promise.resolve();
  f.workflow.cancel();
  await f.workflow.workspace(target, { branch: null, worktreePath: null }, "duplicate");
  f.release(); await write;
  expect(f.calls.filter((c) => c.operation === "createWorktree")).toHaveLength(1);
  expect(f.calls.filter((c) => c.operation === "dispatch")).toHaveLength(1);
  expect(f.workflow.snapshot().status).toBe("idle");
});

test("narrow worktree panel keyboard and mouse expose selection and creation", async () => {
  const f = fixture();
  const view = await testRender(<BranchPanel workflow={f.workflow} target={target} close={() => {}} />, { width: 48, height: 20, kittyKeyboard: true });
  try {
    await view.waitForFrame((frame) => frame.includes("feature"));
    await act(async () => { view.mockInput.pressKey("w"); }); await view.flush();
    expect(view.captureCharFrame()).toContain("[n Create worktree]");
    const lines = view.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes("[n Create worktree]"));
    await act(async () => { await view.mockMouse.click(lines[y]!.indexOf("[n Create") + 2, y); }); await view.flush();
    await act(async () => { await view.mockInput.typeText("topic"); }); await view.flush();
    await act(async () => { view.mockInput.pressKey("RETURN"); }); await view.flush();
    expect(f.calls.some((c) => c.operation === "createWorktree")).toBe(true);
  } finally { view.renderer.destroy(); }
});

test.skipIf(process.platform === "win32" || process.env.TERCET_GIT_LIVE !== "1")("actual server worktree setup, metadata binding and new-thread workspace are durable", async () => {
  const { connectionConfig } = await import("./config");
  const { platform } = await import("./platform");
  const { createClient, waitForLive } = await import("./runtime");
  const { createThreadActions } = await import("./thread-actions");
  const { withSandbox } = await import("../sandbox");
  const { ORCHESTRATION_V2_WS_METHODS: RPC, ProviderInstanceId } = await import("@t3tools/contracts");
  const Effect = await import("effect/Effect");
  const Stream = await import("effect/Stream");
  const fs = await import("node:fs/promises");
  const dir = process.env.TERCET_SANDBOX_DIR!;
  const cwd = `${dir}/work/demo-app`;
  const config = await connectionConfig(["--url", "http://127.0.0.1:3776", "--token-file", `${dir}/token`], async () => undefined, "/unused", {});
  const client = createClient({ ...platform(config), drafts: undefined }, false);
  client.start();
  try {
    await waitForLive(client);
    const project = client.registry.get(client.snapshot)!.projects.find((p) => p.workspaceRoot === cwd)!;
    expect(project).toBeDefined();
    client.registry.set(client.newModelSelection, { instanceId: ProviderInstanceId.make("opencode"), model: "opencode/flint-40b-free" });
    const actions = createThreadActions(client);
    const id = await actions.run("new", undefined, "worktree rig source", false, { branch: "main", worktreePath: null }, project.id);
    for (let i = 0; i < 150 && !client.getThread(id!).projection; i++) await Bun.sleep(20);
    const liveTarget = { ...target, projectId: project.id, threadId: id!, projectCwd: cwd };
    const workflow = createBranchWorkflow(client, () => liveTarget);
    const edits = await fs.readFile(`${cwd}/README.md`, "utf8");
    await workflow.workspace(liveTarget, { branch: null, worktreePath: null }, "worktree-rig");
    const state = workflow.snapshot();
    expect(state.status).toBe("ready");
    const readThread = (threadId: typeof id) => Effect.runPromise(withSandbox((session) => session.client[RPC.subscribeThread]({ threadId: threadId! }).pipe(
      Stream.filter((item) => item.kind === "snapshot"), Stream.take(1), Stream.runCollect,
      Effect.map((items) => { const item = items[0]; if (!item || item.kind !== "snapshot") throw new Error("No durable thread"); return item.projection; }),
    )));
    const bound = (await readThread(id)).thread;
    expect(bound.branch).toBe("worktree-rig");
    expect(bound.worktreePath?.startsWith(dir + "/")).toBe(true);
    expect(await fs.readFile(`${cwd}/README.md`, "utf8")).toBe(edits);
    expect((await client.git("status", { cwd: bound.worktreePath!, localOnly: true })).refName).toBe("worktree-rig");
    const choices = workspaceChoices(cwd, await client.workspaceRefs(cwd));
    const choice = choices.find((row) => row.worktreePath === bound.worktreePath)!;
    expect(choice).toBeDefined();
    const next = await actions.run("new", undefined, "worktree rig new thread", false, choice, project.id);
    const durable = await readThread(next);
    expect(durable.thread).toMatchObject(choice);
    expect(durable.runs).toHaveLength(0);
    const { workspaceCwd } = await import("./git-workflows.ts");
    expect(workspaceCwd({ ...liveTarget, ...durable.thread })).toBe(bound.worktreePath!);
    const tree = Bun.spawnSync(["git", "-C", bound.worktreePath!, "branch", "--show-current"]);
    expect(tree.exitCode).toBe(0);
    expect(tree.stdout.toString().trim()).toBe("worktree-rig");
  } finally { await client.dispose(); }
}, 60_000);

test("moving a thread detaches idle provider sessions before binding and refuses active sessions", async () => {
  const { ProviderSessionId } = await import("@t3tools/contracts");
  for (const sessionStatus of ["ready", "running"] as const) {
    const commands: any[] = [];
    const workflow = createBranchWorkflow({
      git: (async (op: string) => op === "refs" ? { refs, nextCursor: null } : status) as Client["git"],
      dispatch: async (command) => { commands.push(command); },
      getThread: (() => ({ projection: { providerSessions: [{ id: ProviderSessionId.make("session"), status: sessionStatus }] } })) as Client["getThread"],
    }, () => ({ ...target, worktreePath: "/old" }));
    await workflow.workspace({ ...target, worktreePath: "/old" }, { branch: "main", worktreePath: null });
    expect(commands.map((c) => c.type)).toEqual(sessionStatus === "ready" ? ["provider-session.detach", "thread.metadata.update"] : []);
  }
});

// GitHub effects below are simulated only; no host or server is contacted.
import { createPullRequestWorkflow, prKey, type PRSelection } from "./pull-requests.ts";
import { PullRequestPanel } from "./pull-requests.tsx";
const pr: PRSelection = { ref: { projectId: target.projectId, host: "github.example", expectedAccountId: "account-1", repository: "owner/repo", number: 42 }, url: "https://github.example/owner/repo/pull/42" };
function prFixture() {
  const calls: { operation: string; input: any }[] = [];
  let now = { ...target };
  let fail = false;
  let hold = false;
  let release: (() => void) | undefined;
  let commentAllowed = true;
  const detail = { projectId: target.projectId, repository: "owner/repo", number: 42, url: pr.url, title: "Review me", body: "PR body", state: "open", mergeability: "conflicting", isDraft: false, headBranch: "main", baseBranch: "base", additions: 3, deletions: 1, capabilities: { comment: true, review: { verdicts: ["comment", "approve", "request-changes"] } }, viewerPermissions: { comment: true, verdicts: ["comment", "approve", "request-changes"] } };
  const client = {
    git: async (operation: string, input: any) => {
      calls.push({ operation, input });
      if (operation === "prIdentity") return { accountId: "account-1" };
      if (operation === "detail") return { ...detail, viewerPermissions: { ...detail.viewerPermissions, comment: commentAllowed } };
      if (operation === "checks") return { checks: [{ name: "CI", status: "pending" }] };
      if (operation === "activity") return { comments: [{ id: "c", author: { login: "reviewer" }, body: "Please fix", kind: "issue-comment" }], reviewThreads: [], commits: [] };
      if (operation === "listPRs") return { entries: [{ ...detail, host: pr.ref.host }], errors: [], providers: [], viewers: {}, truncated: false };
      if (operation === "status") return { ...status, isDefaultRef: false, hasPrimaryRemote: true };
      if (operation === "createPR") return [{ kind: "action_finished" }];
      if (operation === "diffPreview") return { sources: [{ diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new" }] };
      if (hold) await new Promise<void>((done) => { release = done; });
      if (fail) throw new Error("ambiguous credential secret");
    },
    dispatch: async (input: any) => { calls.push({ operation: "dispatch", input }); },
  } as unknown as Pick<Client, "git" | "dispatch">;
  const workflow = createPullRequestWorkflow(client, () => now);
  return { workflow, calls, client, setNow: (value: BranchTarget) => { now = value; }, fail: (value = true) => { fail = value; }, hold: () => { hold = true; }, release: () => release?.(), deny: () => { commentAllowed = false; } };
}

test("PR writes preserve exact target/account/body and distinct review verdicts", async () => {
  for (const verdict of ["discussion", "comment", "approve", "request-changes"] as const) {
    const f = prFixture(); const body = "  Markdown\n\n**keep whitespace**  \n";
    f.workflow.setDraft(prKey(target, pr), body);
    await f.workflow.submit(target, pr, verdict);
    const write = f.calls.find((c) => c.operation === (verdict === "discussion" ? "comment" : "submitReview"));
    expect(write?.input).toEqual({ ...pr.ref, allowStale: false, body, ...(verdict === "discussion" ? {} : { verdict, comments: [] }) });
    expect(f.calls.findIndex((c) => c.operation === "detail")).toBeLessThan(f.calls.indexOf(write!));
    expect(f.workflow.draft(prKey(target, pr))).toBe("");
  }
});

test("ambiguous PR failure preserves draft and requires refresh; no automatic or duplicate retry", async () => {
  const f = prFixture(); const key = prKey(target, pr); f.workflow.setDraft(key, "body"); f.fail();
  await f.workflow.submit(target, pr, "discussion");
  expect(f.workflow.snapshot()).toMatchObject({ status: "error" });
  expect(JSON.stringify(f.workflow.snapshot())).not.toContain("secret");
  expect(f.workflow.draft(key)).toBe("body");
  await f.workflow.submit(target, pr, "discussion");
  expect(f.calls.filter((c) => c.operation === "comment")).toHaveLength(1);
  f.fail(false); await f.workflow.refresh(target, pr); await f.workflow.submit(target, pr, "discussion");
  expect(f.calls.filter((c) => c.operation === "comment")).toHaveLength(2);
  expect(f.workflow.draft(key)).toBe("");
});

test("closing a PR action retains write lock until settlement and cannot clear another draft", async () => {
  const f = prFixture(); const key = prKey(target, pr); f.workflow.setDraft(key, "original"); f.hold();
  const pending = f.workflow.submit(target, pr, "approve");
  for (let i = 0; i < 20 && !f.calls.some((c) => c.operation === "submitReview"); i++) await Promise.resolve();
  f.workflow.cancel(); f.workflow.setDraft(key, "next draft");
  await f.workflow.submit(target, pr, "approve");
  f.release(); await pending;
  expect(f.calls.filter((c) => c.operation === "submitReview")).toHaveLength(1);
  expect(f.workflow.snapshot().status).toBe("idle");
  expect(f.workflow.draft(key)).toBe("next draft");
});

test("PR identity, permissions and changed workspace guard writes", async () => {
  for (const reason of ["identity", "permissions", "workspace"] as const) {
    const f = prFixture(); f.workflow.setDraft(prKey(target, pr), "body");
    if (reason === "permissions") f.deny();
    if (reason === "workspace") f.setNow({ ...target, worktreePath: "\\\\server\\different" });
    await f.workflow.submit(target, reason === "identity" ? { ...pr, url: "https://wrong.example" } : pr, "discussion");
    expect(f.workflow.snapshot().status).toBe("error");
    expect(f.calls.some((c) => c.operation === "comment")).toBe(false);
  }
});

test("PR link/unlink/watch/unwatch dispatch exact host/repository/thread and intent", async () => {
  for (const action of ["link", "unlink", "watch", "unwatch"] as const) {
    const f = prFixture(); await f.workflow.link(target, pr, action);
    const command = f.calls.find((c) => c.operation === "dispatch")?.input;
    expect(command).toMatchObject({ commandId: expect.any(String), threadId: target.threadId, host: pr.ref.host, repository: pr.ref.repository, number: 42, type: `thread.pull-request.${action === "unwatch" ? "watch" : action}` });
    if (action === "watch" || action === "unwatch") expect(command.watching).toBe(action === "watch");
    if (action === "link") expect(command).toMatchObject({ source: "manual", url: pr.url });
  }
});

test("create PR uses only explicit stock create_pr action at opaque workspace and guards running threads", async () => {
  const f = prFixture(); await f.workflow.create(target);
  expect(f.calls.find((c) => c.operation === "createPR")?.input).toEqual({ action: "create_pr", actionId: expect.any(String), cwd: target.projectCwd, projectId: target.projectId, threadId: target.threadId });
  const running = prFixture(); running.setNow({ ...target, running: true }); await running.workflow.create(target);
  expect(running.calls.some((c) => c.operation === "createPR")).toBe(false);
});

test("PR panel keyboard and mouse show checks/discussion/diff, preserve drafts and confirm exact action", async () => {
  const f = prFixture(); let closed = 0;
  const view = await testRender(<PullRequestPanel workflow={f.workflow} target={target} close={() => closed++} />, { width: 70, height: 40, kittyKeyboard: true, exitOnCtrlC: false });
  const key = async (name: string) => { await act(async () => { view.mockInput.pressKey(name); }); await view.flush(); };
  const click = async (label: string) => {
    const lines = view.captureCharFrame().split("\n"); const y = lines.findIndex((l) => l.includes(label)); expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => { await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y); }); await view.flush();
  };
  try {
    await view.waitForFrame((frame) => frame.includes("#42"));
    await key("RETURN");
    expect(view.captureCharFrame()).toContain("owner/repo #42");
    expect(view.captureCharFrame()).toContain("pending · CI");
    expect(view.captureCharFrame()).toContain("Please fix");
    await key("d"); expect(view.captureCharFrame()).toContain("Local branch comparison");
    await key("RETURN"); expect(view.captureCharFrame()).toContain("+new");
    await key("ESCAPE"); await key("ESCAPE");
    await key("c");
    await act(async () => { view.mockInput.typeText("my review"); }); await view.flush();
    await click("Approve"); expect(view.captureCharFrame()).toContain("Submit approve to owner/repo #42");
    expect(f.calls.some((c) => c.operation === "submitReview")).toBe(false);
    await key("RETURN"); expect(f.calls.find((c) => c.operation === "submitReview")?.input.body).toBe("my review");
    await key("ESCAPE"); await key("ESCAPE"); expect(closed).toBe(1);
  } finally { view.renderer.destroy(); }
});

test("read-only PR writes and linkage fail before I/O and retain review draft", async () => {
  const { platform } = await import("./platform");
  const { connectionConfig } = await import("./config");
  const Effect = await import("effect/Effect");
  const config = await connectionConfig(["--read-only"], async () => undefined, "/fake", {});
  const boundary = platform(config);
  for (const action of ["discussion", "approve", "link", "watch", "create"] as const) {
    const f = prFixture();
    const client = {
      git: (operation: any, input: any) => ["comment", "submitReview", "createPR"].includes(operation)
        ? Effect.runPromise(boundary.git("canary", operation, input)) : f.client.git(operation, input),
      dispatch: (command: any) => Effect.runPromise(boundary.dispatch!("canary", command)),
    } as Pick<Client, "git" | "dispatch">;
    const workflow = createPullRequestWorkflow(client, () => target);
    const key = prKey(target, pr); workflow.setDraft(key, "retained");
    if (action === "create") await workflow.create(target);
    else if (action === "link" || action === "watch") await workflow.link(target, pr, action);
    else await workflow.submit(target, pr, action);
    expect(workflow.snapshot()).toMatchObject({ status: "error" });
    expect(workflow.draft(key)).toBe("retained");
    expect(f.calls.some((c) => ["comment", "submitReview", "dispatch", "createPR"].includes(c.operation))).toBe(false);
  }
});
