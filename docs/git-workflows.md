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
