import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProjectId, VcsListRefsResult, PullRequestSubmitReviewInput, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { createWorkflowResource, workspaceCwd, workspaceKey, gitWorkflowError, GIT_READ_ONLY_POLICY, type WorkflowState, type GitOperation, type GitInput } from "./git-workflows";
import { createClient, waitForLive, type Boundary } from "./runtime";
import { platform } from "./platform";
import { connectionConfig } from "./config";

const empty: OrchestrationV2ShellSnapshot = { schemaVersion: 1, snapshotSequence: 0, projects: [], threads: [], archivedThreads: [] };
function fake(overrides: Partial<Boundary> = {}): Boundary {
  return {
    readToken: () => Effect.succeed("test-token"), issueToken: () => Effect.die("unexpected issuance"),
    wake: () => Effect.void, pause: () => Effect.never,
    follow: (_, receive) => Effect.sync(() => receive({ kind: "snapshot", snapshot: empty })).pipe(Effect.andThen(Effect.never)),
    ...overrides,
  };
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("selected worktree supplies cwd; project and thread identities isolate state", () => {
  const root = { projectId: Schema.decodeUnknownSync(ProjectId)("p1"), projectCwd: "/repo", worktreePath: null };
  expect(workspaceCwd(root)).toBe("/repo");
  const worktree = { ...root, worktreePath: "/managed/feature" };
  expect(workspaceCwd(worktree)).toBe("/managed/feature");
  expect(new Set([workspaceKey(root), workspaceKey(worktree), workspaceKey({ ...root, projectId: Schema.decodeUnknownSync(ProjectId)("p2") })]).size).toBe(3);
});

test("pinned codecs preserve branch ownership and exact review target/body", () => {
  const refs = Schema.decodeUnknownSync(VcsListRefsResult)({ isRepo: true, hasPrimaryRemote: false, totalCount: 1, nextCursor: null,
    refs: [{ name: "feature", current: false, isDefault: false, worktreePath: "/managed/feature" }] });
  expect(refs.refs[0]?.worktreePath).toBe("/managed/feature");
  const review = Schema.decodeUnknownSync(PullRequestSubmitReviewInput)({ projectId: "p1", repository: "sample/repo", number: 7,
    verdict: "comment", body: "  keep formatting\n", comments: [] });
  expect(review.body).toBe("  keep formatting\n");
  expect(review.number).toBe(7);
  expect(() => Schema.decodeUnknownSync(PullRequestSubmitReviewInput)({ ...review, number: 0 })).toThrow();
});

test("client sends selected cwd and decodes a meaningful result without host writes", async () => {
  const client = createClient(fake({ git: (_token, operation, input) => {
    expect(String(operation)).toBe("switchRef");
    const target = input as GitInput<"switchRef">;
    return Effect.succeed({ refName: target.cwd === "/managed/feature" ? target.refName : "WRONG WORKSPACE" }) as ReturnType<NonNullable<Boundary["git"]>>;
  } }), false);
  client.start();
  try {
    await waitForLive(client);
    expect(await client.git("switchRef", { cwd: "/managed/feature", refName: "topic" })).toEqual({ refName: "topic" });
  } finally { await client.dispose(); }
});

test("offline and absent capability fail clearly", async () => {
  const client = createClient(fake(), false);
  try {
    await expect(client.git("refs", { cwd: "/repo" })).rejects.toMatchObject({ kind: "offline" });
    client.start(); await waitForLive(client);
    await expect(client.git("refs", { cwd: "/repo" })).rejects.toMatchObject({ kind: "unsupported" });
  } finally { await client.dispose(); }
});

test("structured auth/unsupported and transport errors never echo credentials", async () => {
  for (const [error, kind] of [
    [{ _tag: "EnvironmentAuthRequiredError" }, "auth"],
    [{ _tag: "EnvironmentAuthorizationError" }, "auth"],
    [{ _tag: "PullRequestUnavailableError", reason: "cli-unauthenticated" }, "auth"],
    [{ _tag: "PullRequestUnavailableError", reason: "provider-unsupported" }, "unsupported"],
    [{ reason: "cli-missing" }, "unsupported"],
    [new Error("secret-token"), "failed"],
  ] as const) {
    expect(gitWorkflowError(error).kind).toBe(kind);
    expect(gitWorkflowError(error).message).not.toContain("secret-token");
    const client = createClient(fake({ git: () => Effect.fail(error) }), false);
    client.start();
    try { await waitForLive(client); await expect(client.git("detail", { projectId: Schema.decodeUnknownSync(ProjectId)("p"), repository: "sample/repo", number: 1 })).rejects.toMatchObject({ kind }); }
    finally { await client.dispose(); }
  }
});

test("read-only platform rejects EVERY mutation before network access", async () => {
  const config = await connectionConfig(["--read-only"], async () => undefined, "/fake", {});
  const boundary = platform(config);
  for (const operation of Object.keys(GIT_READ_ONLY_POLICY) as GitOperation[]) {
    if (GIT_READ_ONLY_POLICY[operation] !== "block") continue;
    const result = await Effect.runPromise(boundary.git("canary", operation, {} as GitInput<typeof operation>).pipe(Effect.flip));
    expect(result).toMatchObject({ kind: "read-only", message: "Read-only: action blocked" });
  }
});

test("late success and failure cannot replace a new workspace or cancelled state", async () => {
  const states: WorkflowState<string>[] = [];
  const resource = createWorkflowResource<string>(state => states.push(state));
  const old = deferred<string>(); const newer = deferred<string>();
  const a = resource.run("workspace-A", () => old.promise);
  const b = resource.run("workspace-B", () => newer.promise);
  newer.resolve("B"); await b;
  old.resolve("A"); await a;
  expect(states.at(-1)).toEqual({ status: "ready", target: "workspace-B", value: "B" });
  const late = deferred<string>();
  const c = resource.run("workspace-A", () => late.promise);
  resource.cancel(); late.reject(new Error("late failure")); await c;
  expect(states.at(-1)).toEqual({ status: "idle" });
});

test("write stays locked through cancellation; error is visible without automatic retry", async () => {
  const states: WorkflowState<string>[] = [];
  const resource = createWorkflowResource<string>(state => states.push(state));
  const write = deferred<string>(); let calls = 0;
  const load = () => { calls++; return write.promise; };
  const pending = resource.run("repo#7/comment", load, true);
  resource.cancel();
  await expect(resource.run("repo#7/comment", load, true)).rejects.toMatchObject({ kind: "busy" });
  write.resolve("posted"); await pending;
  expect(states.at(-1)).toEqual({ status: "idle" }); expect(calls).toBe(1);
  await resource.run("repo#7/comment", async () => { throw { reason: "cli-unauthenticated" }; }, true);
  expect(states.at(-1)).toMatchObject({ status: "error", error: { kind: "auth" } });
});

test("cancelling a runtime read interrupts the scoped request", async () => {
  let stopped = false;
  const client = createClient(fake({ git: () => Effect.never.pipe(Effect.ensuring(Effect.sync(() => { stopped = true; }))) }), false);
  client.start();
  try {
    await waitForLive(client);
    const controller = new AbortController();
    const result = client.git("refs", { cwd: "/repo" }, controller.signal);
    await Bun.sleep(5); controller.abort();
    await expect(result).rejects.toBeDefined();
    expect(stopped).toBe(true);
  } finally { await client.dispose(); }
});


test("Windows drive, spaces and UNC workspaces remain opaque server paths", () => {
  for (const path of [String.raw`C:\Users\Sample User\repo`, String.raw`\\server\share\My Repo`]) {
    const workspace = { projectId: Schema.decodeUnknownSync(ProjectId)("windows"), projectCwd: path, worktreePath: null };
    expect(workspaceCwd(workspace)).toBe(path);
    expect(JSON.parse(workspaceKey(workspace))[2]).toBe(path);
    expect(workspaceCwd({ ...workspace, worktreePath: path + String.raw`\feature worktree` })).toBe(path + String.raw`\feature worktree`);
  }
});
