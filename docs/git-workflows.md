# Git and PR boundary (stock T3 v0.1.8)

The server owns Git, worktree setup and thread bookkeeping. No local Git subprocesses,
path normalization, POSIX splitting or shell interpolation belong in this boundary.
Drive-letter paths, spaces and UNC paths remain opaque strings from server snapshots.
`workspaceCwd` chooses `thread.worktreePath ?? project.cwd`; `workspaceKey` includes project,
thread and cwd. PR identity additionally includes host/account/repository/number.

## Transport map

`src/client/connection.ts:gitMethods` uses the existing scoped `withConnection` and
`RpcSessionFactory` (descriptor/protocol checks, bearer tickets and pinned response codecs).
`platform.ts:platform` provides `GitBoundary` with URL/token and read-only enforcement.
`runtime.ts:Boundary.git`, `createClient().git(operation,input,signal?)` expose typed promises.
`GitInput<K>`/`GitOutput<K>` derive from transport methods, rather than handwritten wire shapes.
Inputs/results below are exported by `@t3tools/contracts`; exact fields remain authoritative
in `vendor/t3/packages/contracts/src/{rpc,git,pullRequest,review}.ts`.

- `status`: `vcs.refreshStatus(VcsStatusInput & {localOnly?:boolean}) -> VcsStatusResult`.
  Includes repo/ref, dirty files, upstream ahead/behind, optional PR. Local-only avoids remote refresh.
- `refs`: `vcs.listRefs(VcsListRefsInput) -> VcsListRefsResult`. `cwd`, optional query,
  refKind all/local/remote, includeMatchingRemoteRefs, refresh, cursor and limit (max 200).
  Iterate nextCursor until null. Each ref includes current/isDefault and worktreePath;
  refs checked out elsewhere must select that workspace or explain refusal.
- `createRef`: `vcs.createRef(VcsCreateRefInput) -> VcsCreateRefResult`.
  cwd/refName/optional switchRef. Web creates with switchRef:true.
- `switchRef`: `vcs.switchRef(VcsSwitchRefInput) -> VcsSwitchRefResult` (cwd/refName).
  No force flag; preserve edits and report server refusal. Update metadata only on success.
- `createWorktree`: `vcs.createWorktree(cwd,refName,newRefName?,baseRefName?,path:null)
  -> VcsCreateWorktreeResult`. RPC requires null path despite broader exported input schema:
  the server chooses its managed folder. Result is worktree.path/refName.
- `resolvePR`: `git.resolvePullRequest(GitPullRequestRefInput) -> GitResolvePullRequestResult`.
- `preparePR`: `git.preparePullRequestThread(GitPreparePullRequestThreadInput)
  -> GitPreparePullRequestThreadResult`. cwd/reference/mode local|worktree/threadId?;
  branch/worktreePath/isOnPullRequestHead returned. This mutates workspace and is blocked read-only.
- `listPRs`: `pullRequests.list(PullRequestListInput) -> PullRequestListResult`.
- `detail`: `pullRequests.detail(PullRequestRef) -> PullRequestDetail`.
- `checks`: `pullRequests.checks(PullRequestRef) -> PullRequestChecks | null`.
- `activity`: `pullRequests.activity(PullRequestRef) -> PullRequestActivity`.
- `threadComments`: `pullRequests.threadComments(PullRequestThreadCommentsInput)
  -> PullRequestThreadCommentsResult` (cursor/threadId pagination).
- `diffContents`: `pullRequests.diffFileContents(PullRequestDiffFileContentsInput)
  -> PullRequestDiffFileContentsResult`.
- `diffPreview`: `review.getDiffPreview(ReviewDiffPreviewInput) -> ReviewDiffPreviewResult`.
- `comment`: `pullRequests.comment(PullRequestCommentInput) -> void` (ref plus body).
- `submitReview`: `pullRequests.submitReview(PullRequestSubmitReviewInput) -> void`
  (ref plus verdict/body/comments, including typed line positions).

`PullRequestRef` is projectId/repository/number, optional host/expectedAccountId/allowStale.
Preserve target and Markdown whitespace through errors; body max 65536 characters. Request a
fresh detail before submission; check host capabilities. Null checks mean unknown, not passing.

## Other pinned workflows (integrate in later steps)

`dispatchCommand` already carries `OrchestrationV2Command` with commandId/threadId:
`thread.metadata.update` has branch/worktreePath, expectedBranch/expectedWorktreePath and
expectedEmpty. Use these preconditions to avoid moving another session's workspace.
`thread.pull-request.link`, `.unlink`, `.watch` carry the PR key; watch adds watching:boolean.
These are orchestration mutations, so the existing platform read-only dispatch gate applies.
Web stops a provider session when moving workspaces; later steps must protect active/running
threads and bind workspace before launching a new thread. Do not silently relocate a run.

There is no standalone worktree-list RPC in this surface. Derive checked-out worktrees from
paginated refs (worktreePath) and known thread bindings. Worktree setup has
`subscribeWorktreeSetup` and `worktreeSetup.cancel` RPCs for progress/cancel.
PR creation uses streaming `git.runStackedAction(GitRunStackedActionInput)` with action
`create_pr` (or compound actions), actionId and optional threadId/projectId; events include
progress and completion. Wire this only with explicit confirmation of the repository/action;
never replay on reconnect. Not yet included in unary gitMethods. Removal, force, merge,
delete and push are outside this loop's default UI scope.

## Upstream UI reference points

Bounded inspection of the clean local v0.1.8 `upstream-probe/apps/web/src`:

- `components/BranchToolbarBranchSelector.tsx`: branchCwd (worktree first),
  setThreadBranch (session stop and metadata update), selectBranch / createRef actions,
  switchRef/createRefMutation success/refusal handling and worktree reuse.
- `state/pullRequests.ts`: pullRequestEnvironment, detail/checks observations. Fresh detail
  seeds snapshots only with allowStale:false; late cached results must not replace fresh data.
- `state/sourceControlActions.ts`: PR resolution/preparation path; see also
  `components/pullRequest/LinkPullRequestDialog.tsx` for explicit linking.

## State, errors and verification

`createWorkflowResource<A>` drives idle/loading/ready/error and invalidates old loads with
an AbortController plus generation. Cancel is safe even if the transport ignores abort.
Keep resource ownership outside a transient dialog for writes; it locks duplicate targets
until settlement even after cancel. It never retries. Closing a view cannot undo a remote write;
a failed response can be ambiguous, so refresh before any explicit resubmission.
Use different resources for independent reads, keys including workspace plus PR identity.

`gitWorkflowError` distinguishes auth/unsupported/offline/read-only/busy/cancelled/failed.
Only fixed messages reach the UI: raw causes may contain credentials. PR unavailable reasons
cli-missing/cli-unauthenticated/provider-unsupported get setup/auth guidance. The exhaustive
`GIT_READ_ONLY_POLICY` complements host `READ_ONLY_POLICY`; platform checks before I/O.

`bun test src/client/git-workflows.test.ts` covers pinned codecs, workspace selection,
Windows paths, runtime auth/offline/unavailable, all mutation gates, scoped cancellation,
stale result rejection and write locking. These are server-free tests with simulated writes;
actual branch/worktree side effects on disposable server repositories belong to steps 2–3.
No live GitHub writes are tested.

Next: create `src/client/git-workflows.tsx` branch dialog using `client.git`,
`workspaceCwd`/`workspaceKey`, `createWorkflowResource`, `GitWorkflowError.kind`, and
`GIT_READ_ONLY_POLICY`; integrate frame/keymap without replacing editor changes.

## Branches

Alt+g or clicking the branch header opens Branches (also in Help). Select a row with arrows/j/k and Enter or click it.
`n` / Create branch asks for a name; Enter creates and switches. `r` / Refresh reloads
local status and all paginated refs. Esc / Back leaves the view. Status includes dirty/clean
and ahead/behind. Branches held in another worktree show their path and refuse switching.
Dirty trees and active/queued runs in the same workspace refuse mutations. No force or retry.
A successful write updates thread metadata with expected branch/path preconditions and reloads.
Closing a view invalidates its UI result, but cannot undo Git or cancel its bookkeeping.
The frame owns the controller across view lifetimes. Paths are passed verbatim to the server.

`bun test src/client/git-workflows.test.ts src/client/git-workflows.test.tsx` runs portable
boundary/controller/renderer tests. `bash scripts/test-git-workflows.sh` is the opt-in POSIX
actual pinned-server rig on 3776, with disposable data and an explicitly scoped test token.
It proves create-and-switch, switching back, conflicting dirty checkout refusal and edit
preservation through both raw RPC and the workflow controller. Never uses daily data or
live GitHub writes. Windows CI runs the portable tests; this process rig skips Windows.

## Worktrees

In Branches (Alt+g), `w` or Branches / Worktrees toggles the workspace list. Select with
j/k, arrows, Enter or mouse; `n` / Create worktree asks for a new branch name. The server
chooses its managed directory (`path:null`). Creation preserves source edits; they are
not copied into the new worktree. No worktree removal, force checkout or automatic retry.
Refs are paginated; known thread bindings supplement and deduplicate their worktree paths.
Root branch detection uses its checked-out ref, even when reading from another worktree.
The new-thread workspace picker includes those same known bindings.

Selection verifies current branch/path against fresh status before metadata binding, with
expectedBranch/expectedWorktreePath preconditions. Running/queued source and destination
workspaces refuse changes. Idle provider sessions detach via the same pinned command used
by stock stopThreadSession before moving, so the next turn uses the new cwd. Editors keep
their existing pinned session. Files/diff/shell continue using the selected thread's path.
Closing during creation cannot undo setup or release the controller's write lock; metadata
bookkeeping continues. A failed binding leaves the worktree available for explicit selection.

The POSIX rig below also proves real server-managed worktree setup, durable thread metadata,
new-thread workspace choice, correct Git cwd and preservation of dirty source files. All
server data, managed worktrees and Git effects stay inside its disposable /tmp directory;
no provider turns or GitHub writes run. Native Windows CI still needs a native execution.
