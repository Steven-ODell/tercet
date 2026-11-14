# Plan: Tercet PR actions, branches and worktrees

Authorized by Sao on 2026-11-14 in thread bb7f8c3e-db03-46e1-ac3c-529bb2c918b3.
Workspace: /home/sao/Projects/Side/t3t-public, main, same root checkout throughout.
Run each numbered step in a fresh top-level T3 thread using codex / gpt-6.1-sol,
high reasoning, standard service tier. No parallel agents. Make routine implementation
decisions autonomously and continue until Sao can test the finished result.

## Goal and decisions

Add usable PR review actions and branch/worktree management to Tercet, following the T3
web app's behavior and existing terminal panels. Both keyboard and mouse must work.
Use the pinned stock v0.1.8 server RPCs, not fork-only calls, a server upgrade, or local
Git operations that bypass the server's thread/workspace bookkeeping.

Scope: list/create/switch branches, show branch status; list/create/select worktrees and
correctly bind threads to their workspace; inspect PR details/checks/review discussion and
diffs, open/copy links, submit comments and reviews, and watch/unwatch where supported by
the pinned server. Include PR creation/linking if exposed by its existing workflows.
Adapt the web UI's supported operations rather than inventing endpoints. Missing capability
or GitHub authentication must give clear feedback, not crash or require Sao mid-build.
Do not expand into a server update or unrelated feature work. Defer merge/delete/force-push
workflows unless essential to the existing upstream flow; never execute them against real
repositories during development. Product mutations such as posting a review require an
explicit user action, show their target, and must not duplicate on retry.

Sao asked for no input until the final trial. This instruction authorizes the full five-step
loop and supersedes the earlier editor-only stopping point specifically for these features.
Historical P10/release gates stay paused. No push, publish, install, launcher replacement,
daily config edit, T3 restart, or production Git/GitHub mutation is required for this task.
No review comments, PRs or messages may be posted to a live service as tests.

## Existing state and preservation

Starting HEAD: e91166d (main). The working tree already contains the accepted embedded and
external editor changes plus extended demo, all uncommitted. Treat them as the baseline;
preserve every tracked and untracked file and do not reset/stash/clean them away. Preparation
saves a status, diff and file-hash manifest under the cache prefix below. Commit only this
loop's own changes. If a file mixes earlier edits and new work, stage only attributable hunks
or leave it explicitly documented as uncommitted. Do not sweep the entire checkout into a
commit. Rebuild dist/tercet.js without losing those editor features. Do not alter the GIF.

PLAN.md, NOTES.md and NOTES-archive.md are locally excluded on purpose. Do not force-add
them. This tracked plan is the active checklist linked from PLAN.md. Append concise loop
state to NOTES.md without rewriting earlier decisions. Put completed detail in NOTES-archive.md.
Cache prefix: /home/sao/.cache/handoffs/2026-11-14-tercet-git-workflows
One-line-per-step log: that prefix plus -log.md. Stop for a genuine blocker or a check still
failing after two fixes, not for ordinary design choices. Record the exact error and attempts
in NOTES.md and notify Sao. Never weaken tests to pass.

## Baseline and final trial

From the workspace: `bun run build`, then `TERCET_SANDBOX_PORT=3776 bun run check`.
Expected: typecheck/test/bundle/vanilla acceptance all exit 0. Save verbose logs to unique
files and report actual exit codes. Read /home/sao/.claude/skills/quiet-test/SKILL.md before
any terminal/UI trial. Test off-screen, muted, using bgrun and private tmux sessions, never
extra desktop windows or tmux windows. Preserve the user's interactive sandbox on 3775.
Do not touch the daily server on 3773 or its userdata for automated tests. Use disposable
repositories and isolated server data on 3776. Fake GitHub effects at the boundary for review
submission/check states; verify actual pinned RPC decoding and local Git/worktree effects in
the sandbox. Clearly distinguish simulated GitHub writes from real end-to-end coverage.

Final user command, from any directory:
`bun /home/sao/Projects/Side/t3t-public/dist/tercet.js`
It must use normal existing settings discovery, token and server selection, with no temporary
HOME/XDG override, setup/reset, reinstall or edits to settings. Inspect config loading without
printing tokens. Verify existing settings still parse and read-only flags still block all new
mutations. Only the user's eventual trial connects this new UI to their daily setup.

## Steps

- [x] 1. Establish baseline and implement the typed Git/PR RPC boundary.
  Read first: src/client/connection.ts (fileMethods, diffMethods, workspaceRefs), runtime.ts
  (Boundary/createClient), platform.ts (platform), read-only.ts (READ_ONLY_POLICY), and pinned
  vendor/t3/packages/contracts/src/{rpc,git,pullRequest}.ts. Inspect corresponding v0.1.8 web
  implementations in the local upstream-probe checkout through bounded reads. Document the
  supported operations, signatures and relevant UI symbols in docs/git-workflows.md. Add
  transport/state primitives and meaningful error/read-only/cancellation tests. Preserve the
  pin and vendor policy; missing closure imports go through scripts/sync-upstream at v0.1.8.
  Done when: `bun test src/client/git-workflows.test.ts` and baseline exit 0; tests cover
  workspace targeting, unsupported/auth errors and policy, not only mock function invocation.
  Write exact next-step symbols and artifacts in NOTES.md.

- [x] 2. Add branch status, listing, creation and switching.
  Files: new Git workflow primitives from step 1; src/client/{frame,keymap,read-only}.tsx/ts,
  new src/client/git-workflows.tsx and tests. Use the actual file names recorded by step 1.
  Respect dirty trees and branches checked out elsewhere. Never force checkout. Keep selected
  thread, server workspace and displayed status consistent and refresh on success. Clear
  loading/errors, Esc/back, narrow-screen layout and keyboard/mouse access.
  Done when: `bun test src/client/git-workflows.test.ts src/client/git-workflows.test.tsx`
  plus baseline exit 0; disposable repo verifies create/switch/refusal preserves edits.

- [x] 3. Add worktree creation, listing, selection and thread workspace binding.
  Files: same workflow UI/boundary, src/client/{new-thread,frame,runtime}.tsx/ts as applicable;
  pinned orchestration command and worktree schemas. Follow upstream thread-binding behavior,
  protect running threads and retain correct cwd for Files, diff, shell and editors.
  No forced removal or silent relocation of an active thread. Show busy/error outcomes.
  Done when: step 2 focused test command and baseline exit 0; isolated actual server/repo
  test verifies worktree setup, branch/path binding and new thread operations use the selected
  workspace, with no changes outside sandbox. Record verification script in docs/TEST.

- [x] 4. Add PR inspection and review actions.
  Files: workflow RPC boundary/state, src/client/{frame,diff,read-only,keymap}.tsx/ts; pinned
  pullRequest schemas and v0.1.8 web implementations mapped in step 1. Add PR status/checks,
  details and discussion, diff navigation, comments/review submission, link/open/copy,
  watch/unwatch and creation/linking where supported. Preserve drafts on errors and prevent
  accidental duplicate writes. Clearly label pending/failed/conflicting states. Do not submit
  anything live. No agent-created PR is needed; if one is actually worked on, register it
  through T3 link_pull_request as required by runtime instructions.
  Done when: step 2 focused tests and baseline exit 0; simulated GitHub writes prove exact
  target/body/action, failure recovery, no duplicate submission and read-only enforcement.

- [ ] 5. Verify the complete workflow and prepare Sao's final trial.
  Files: all new workflow code/tests, README.md, docs/git-workflows.md, TEST.md, dist/tercet.js.
  Exercise keyboard and mouse in off-screen private terminal; inspect captured frames for
  overflow, focus and readable names. Test reconnect/thread switching so stale PR/branch
  results cannot affect another workspace. Verify editor/demo regression coverage. Rebuild
  bundle; step 2 focused tests and baseline must pass with real exit statuses recorded.
  Check built CLI help/version and existing settings parse without modifying config or
  starting real provider turns. Document exact tests and limitations, action locations and
  the single absolute bun command above. Notify Sao, leave the final thread open for his test,
  and STOP. No launch of another step or advancement of P10.

## Windows coordination (2026-11-14)

Sao also authorized Windows support, being implemented independently in
`/home/sao/Projects/Side/t3t-windows-support`. Keep Git paths opaque, including drive letters,
spaces and UNC paths; all Git/worktree actions remain pinned server RPCs. Step 1 adds these
fixtures in `src/client/git-workflows.test.ts` for Windows CI. Windows work owns windows.ts,
portable/settings/doctor adapters, build/installer/CI/docs; coordinate before overlapping edits.
Do not commit the Windows thread's changes or bundle. Carry coordination into every packet
and verify convergence in step 5 before the final trial. Windows source was integrated into root by its owner during step 2 before the combined
build/check (369 pass/19 skip). Preserve these uncommitted changes; no stale worktree bundle.
Native CI/manual Windows Terminal trial remain pending; keep experimental status. Final
step 5 includes src/windows.test.ts/native Git tests. Windows owner plans no further edits.
Step 1 finished files are
src/client/{connection,runtime,platform,git-workflows,git-workflows.test}.ts and docs/git-workflows.md.

## Handoff mechanics

Read handoff and build-loop skills. Every completed step ticks only its checkbox here,
updates compact NOTES current/next, appends historical detail and one cache log line, commits
only its work, then launches the exact next numbered step as an ordinary top-level thread.
Project ID mcp:37cf902c-1931-4e6f-b3ee-d640c65c5fc2; workspaceStrategy {type:"root"};
modelSelection {provider:"codex",instanceId:"codex",model:"gpt-6.1-sol",
options:{reasoningEffort:"high",serviceTier:"default"}}. Include the goal, plan path and step,
actual files/symbols, prior check and logs, baseline command, stop conditions and preservation
constraints. Retain launch ID; inspect before retrying a failed launch. Settle successful
intermediate threads only after launching their successor, using t3-thread settle current
--after-turn as the last shell command. Keep a blocked or final thread open.

## Combined Kokoro trial (Sao steering during step 4)

Sao explicitly requested one command for all outstanding changes, then instructed this thread
to inspect and integrate "Add Kokoro Voice Readbacks" (29112898-fb18-4cb4-bae2-054762c1654c).
Its terminal source was integrated from /home/sao/.t3/worktrees/t3t-public/feat-kokoro-readback,
without copying dist or its sandbox port changes. Delta saved at
~/.cache/handoffs/2026-11-14-tercet-kokoro-only.patch; root pre-integration diff saved beside it.
Readback source/tests/docs and its seven intentional acceptance snapshots remain UNCOMMITTED
with the editor/Windows baseline. Preserve all; do not sweep them into the step 4/5 Git commit.
Step 5 convergence includes src/readback.test.ts and src/client/readback.test.tsx, plus editors,
Windows and Git tests. Bundle must contain all of these changes. T3 web readback remains in
/home/sao/Projects/Side/t3code-wt/kokoro-readback and is outside this terminal bundle.
Default Kokoro endpoint http://127.0.0.1:8880 was unavailable (curl exit 7, HTTP 000); mpv exists.
Actual natural voice playback has NOT been verified. Preserve no settings edit/install/restart
boundary; report service requirement honestly, do not silently install/start a model/service.
Kokoro readback is explicit only; tests use simulated synthesis/player and remain muted.

## Local Kokoro steering and loop block

Sao clarified generation should work the same way as the hub: direct local kokoro_onnx,
not an HTTP endpoint. Root readback defaults to local engine using existing KOKORO_HOME/
venv/model/voice files; optional HTTP engine remains. This supersedes the service requirement
above for terminal use. Actual quiet generation produced /tmp/tercet-kokoro-local.wav
(203786 bytes, 24kHz PCM WAV), and rebuilt combined bundle=0
(/tmp/tercet-git-step4-local-kokoro-build.log). No settings edits or installation needed.
Step 4 commit 0c42ba0 remains complete. Step 5 NOT launched: added local cancellation test
timed out after two fixes (10 pass/1 fail, /tmp/tercet-kokoro-local-focused3.log).
Follow NOTES.md Blocked exact attempts and likely Bun matcher ordering diagnosis. Resolve,
then rerun Git/voice focused tests, root build and full :3776 check before launching Step 5.
Keep this thread open. Preserve all editor/Windows/readback changes and latest combined dist
UNCOMMITTED. Windows native CI/manual trial still pending, paths opaque, P10 paused.
