# t3t compatibility report: fork `tui` vs pristine upstream

Measured 2026-11-10 (step P0). Source: `apps/tui` from the `tui` worktree working tree
(HEAD `71bf0eec137` plus uncommitted edits), copied into a detached worktree of upstream
`v0.1.8` (`bf469bb1966`, the latest non-prerelease tag). The fork is based on upstream
`81493efb71e` (Oct 15, `v0.0.46-nightly.20261015.3176`), so the gap is about four weeks.

Raw material in `docs/compat-p0/`: both typecheck logs, the closure script and its output.

## Headline

- Typecheck against pristine v0.1.8: 149 errors in 26 of 85 source files (31%). That is over
  the plan's one-fifth line, so it gets flagged. Most of it is one cascade, though: the fork
  added subpath exports to `client-runtime/package.json`, and when those imports fail, their
  types turn into `any` and spread errors into 17 other files.
- With the old subpath names aliased (export map only, no source change): 37 errors in 9 files
  (11%). Those 9 are the real work for P1.
- `bun test`: 24 of 33 test files fail to load pristine; 14 with aliases. Every remaining load
  failure is one of three missing named exports (table row C2).
- At runtime the fork-built binary connected live to an upstream 0.1.8 server and drew the
  thread list. The wire protocol for the basic shell stream still matches.

## Errors by cause

| # | Cause | Symbols | Files | Fix in P1 |
|---|---|---|---|---|
| A1 | Fork-only contract types | `ShellToggleDictationInput`, `ShellToggleDictationResult`, `ShellTypeInTmuxInput`, `ShellSendToPhoneInput` | `actions.ts`, `connection.ts`, `runtime.ts` | Local types in `src/ext/` |
| A2 | Fork-only RPC methods | `WS_METHODS.shellToggleDictation`, `shellTypeInTmux`, `shellSendToPhone` | `connection.ts` | Drop; P4 command templates replace them |
| A3 | Fork-only shell field | `OrchestrationV2ShellContextUsage`; fork's `thread.contextUsage` shape | `usage.ts`, `frame.tsx` | Upstream now has `contextUsage` as `ThreadTokenUsageSnapshot`; read that |
| A4 | Fork-only client-runtime export | `secretRequestCopy` (`secret-request`) | `requests.tsx` (blocks 7 test files) | Copy into `src/ext/` |
| B | `hostAction` | t3t's own `Boundary.hostAction` (`runtime.ts:65`, `main.tsx:147-152`) wraps the A2 RPCs. Not an upstream method | `runtime.ts`, `main.tsx`, `read-only.test.ts` | Make optional; return "not available" |
| C1 | Subpath exports the fork added | `rpc/session`, `state/shell-reducer`, `state/thread-shell` (files exist upstream, not exported); renamed upstream: `state/projection` to `state/orchestration-v2-projection`, `state/history-merge` to `state/thread-history-merge`, `state/threadCheckpoints` to `state/thread-checkpoints`, `diffCount` to `diff-count` | `agents.ts`, `connection.ts`, `diff.tsx`, `runtime.ts`, `sidebar.tsx`, `transcript-state.ts`, `spikes/connect.ts` + 17 cascade files | Rename 4 imports; add the 3 missing entries to the vendored export map (one patch file) |
| C2 | Not exported upstream | `subagentRequest`, `pendingSubagentRequestsByThread` (`threadShell.ts`; the tui worktree's uncommitted edit exports the first), `providersWithLimits` (`shared/usageLimits`, exported in the fork base, local now) | `agents.ts`, `sidebar.tsx`, `usage.ts` | Copy the small functions into `src/ext/` |
| C3 | Removed upstream RPCs | `orchestration.subscribeArchivedShell` + `OrchestrationV2ArchivedShellStreamItem` (now `getArchivedShellSnapshot`); `terminal.restart` (now open/attach/observe/write/resize/clear/close) | `connection.ts`, `runtime.ts` | Port to the snapshot RPC; restart = close + open |
| C4 | Changed upstream shapes | `ShellStreamEvent` union (`runtime.ts:217`); image attachment type (`composer-state.ts:146`); `thread.stop` command (`media-sandbox.test.tsx:33`) | 3 files | Adapt to new types |
| D | Other | Upstream's catalog has no `typescript` (it moved to `@effect/tsgo`), so `vp i` fails on `"typescript": "catalog:"`. `effect` is 4.1.2 on both sides | `package.json` | Pin `typescript` 7.0.2 (what the fork resolves) |

## Closure and repo shape

Transitive closure of files under `packages/*` that `apps/tui/src/**` imports, type-only
imports included, measured with `docs/compat-p0/closure.ts`:

- 269 files, 2,539,364 bytes (2.5 MB), no test files.
- `contracts` 78 files / 1.06 MB, `client-runtime` 101 / 0.93 MB, `shared` 49 / 0.41 MB, plus
  41 files / 0.13 MB from 21 small packages that `contracts` and `client-runtime` pull in
  (`provider-*`, `source-control-*`, `secret-provider-*`).
- Third-party runtime deps the closure needs: `effect`, `@noble/hashes`.

Whole-package vendoring (option 1) for those same 24 packages is 795 non-test files and 9.1 MB,
and it drags in `three`, `jszip`, the remark/rehype stack and the native `ffi-rs`.

**Chosen shape: option 2, vendor the closure.** Option 1 is over the sanity bar and adds
dependencies t3t never runs. The closure sits well under the submodule trigger (400 files,
5 MB), so a submodule would only add clone friction. Layout for P1: `vendor/t3/packages/<name>/`
holding each package's `package.json` (keeping the `@t3tools/*` names and export maps, so imports
don't change) plus its closure files, a `LICENSE` copy, and one export-map patch for the three
C1 entries. `scripts/sync-upstream <tag>` reruns the closure from a checkout of the tag and
copies it in. Vendored source stays unedited; anything not exported goes to `src/ext/`.

## Server version

`GET /.well-known/t3/environment` needs no auth and returns the `ExecutionEnvironmentDescriptor`.
Against 0.1.8:
`{"serverVersion":"0.1.8","orchestrationProtocolVersion":2,"databaseMigration":80,...}`.
t3t already fetches this descriptor in `connection.ts` and runs
`orchestrationProtocolCompatibilityError` on it, so P7 compares `serverVersion` with the pinned
tag there. `userdata/server-runtime.json` also carries an optional `serverVersion` for local
servers, but the descriptor works for any URL.

## Sandbox server (for P2)

The published npm package `t3@0.1.8` works, so no build is needed. Ready in about 20 seconds.

```bash
H=$(mktemp -d)                       # throwaway HOME
npm i --prefix "$H/pkg" --no-audit --no-fund t3@0.1.8
HOME=$H bgrun -t 20m t3t-upstream -- env HOME=$H "$H/pkg/node_modules/.bin/t3" \
  serve --base-dir "$H/.t3" --host 127.0.0.1 --port 3775 --no-browser
until curl -sf http://127.0.0.1:3775/.well-known/t3/environment >/dev/null; do sleep 1; done
HOME=$H "$H/pkg/node_modules/.bin/t3" auth session issue --base-dir "$H/.t3" --token-only \
  --scope orchestration:read --scope orchestration:operate --scope filesystem:read \
  --scope terminal:read --scope terminal:operate --label t3t > "$H/token"
bgrun kill t3t-upstream              # when done
```

The fresh database has no projects or threads, and no provider is configured. P2 has to seed
a project and enable the free OpenCode model the way `scripts/sandbox.sh` does now.

P2 built this into `scripts/sandbox.sh` and `scripts/acceptance.sh`; see `docs/decisions.md`
("Acceptance rig on the vanilla server") for what changed from the block above.

## `bun build --compile`

- Plain `bun build --compile src/main.tsx` fails: OpenTUI's loader dynamically imports every
  platform package (`@opentui/core-linux-x64-musl` and the rest), and only the host's is installed.
- With `--external` for the seven non-host `@opentui/core-*` packages it builds:
  582 modules, a 102 MB binary. `--version` works, and in a private tmux with a throwaway HOME
  the binary drew the full UI and connected live to the 0.1.8 sandbox. So the native library
  loads from the compiled binary.
- Not tested: Kitty images, clipboard and the embedded terminal inside the binary, and
  cross-compiling (`--target bun-darwin-arm64` needs that platform's package installed).
  P8 decides.
