# Plan: text context menus and the current machine's clipboard

Active build-loop, requested by Sao on 2026-11-15. All steps use Codex
`gpt-6.1-sol`, provider instance `codex`, same root checkout on `main`.
This loop is separate from paused P10/release work. No rename or marketing work.

## Goal and agreed scope

Sao wants a normal text right-click menu in the composer (copy, cut, paste,
select all and undo/redo where supported), and drag-select then right-click Copy
in the transcript. Copy must reach the clipboard of the machine he is typing
on, including SSH/tmux, rather than always the server PC. Preserve spell-check
suggestions alongside text actions. Do not make right-click erase selection.
Prevent selected-text copy from accidentally arming quit; preserve intentional
quit and embedded-terminal Ctrl+C interrupt behavior. Use selections to resolve
Ctrl+C conflicts, rather than globally disabling quit.

Final user steering: "make sure at the end I can test it with some kind of bun
build or something". End with a fresh committed bundle and concrete commands
`bun run build` then `bun dist/tercet.js`, plus a short manual test checklist.
Do not install, push, tag, release, rename, or change Sao's desktop configuration.

## Constraints and context

- Read /home/sao/CLAUDE.md and /home/sao/CLAUDE/preferences.md. Use build-loop
  skill /home/sao/.codex/skills/build-loop/SKILL.md (shared with Claude).
- Root AGENTS.md, CLAUDE.md and matching Claude project MEMORY.md were absent.
  README.md and NOTES.md Gotchas/Decisions remain applicable. Recheck rules if added.
- Never touch the daily server on 3773 or ~/.t3/userdata for automated testing.
  Headless testRender tests are preferred; any visual/live rig must use the
  quiet-test skill and sandbox. No subagents requested.
- Respect custom clipboard targets. Default Copy means the user's terminal
  machine; named PC/laptop actions remain explicit destinations. Do not silently
  read the server PC's clipboard for a remote Paste.
- OSC 52 already writes text via terminal. Investigate tmux passthrough and SSH
  sessions inherited inside tmux; do not assume SSH env vars always suffice.
  Remote paste may require terminal clipboard query support or explicit configured
  command. Detect/report unsupported paths and show a usable terminal paste shortcut
  rather than claim universal clipboard reading. Avoid unbounded queries.
- Terminal keyboard protocols may not distinguish Ctrl+Shift+C; choose only reliable
  shortcuts and document constraints. Preserve existing shortcuts where practical.
- Bun 1.4.0 installed and required for bundle byte consistency. dist/tercet.js is
  tracked and must be rebuilt after source changes. Save verbose checks to unique
  /tmp logs and report actual exit status. Full baseline: `bun run check`.
- PLAN.md and NOTES*.md are intentionally excluded. Never force-add them. Keep
  this tracked step plan authoritative and append brief pointers/state to local
  PLAN.md/NOTES.md without replacing their existing history. Commit this plan
  and code/bundle changes, not excluded notes. Historical log:
  /home/sao/.cache/handoffs/2026-11-15-tercet-text-clipboard-log.md.

## Initial findings (read-only investigation, no implementation yet)

- Start commit 6b40e78, branch main; working tree initially clean. No baseline
  tests run in the source thread. No background jobs started.
- src/client/composer.tsx Editor owns TextareaRenderable ref, draft publication,
  paste media path, useKeyboard and useSpellCheck. Right-click currently calls
  spell.onMouseUp only. Ctrl+v uses effects.pasteClipboard.
- src/client/spell-ui.tsx useSpellCheck right-click moves the caret and resets
  local selection before looking for a misspelled word. Its menu already has
  keyboard/mouse selection and screen anchoring; reuse or extract this carefully.
- src/client/transcript-viewport.tsx useSelectionHandler immediately copies
  completed transcript drags. Row ids begin transcript-row-. Native Shift selection
  and Vim visual selection are separate paths; neither should regress.
- src/portable.ts hostActions copy writes OSC52 and also a local clipboard tool;
  clipboardChain checks DISPLAY/WAYLAND_DISPLAY but Linux/macOS builtin clipboard
  tools lack the SSH guard used by Windows. This can hit the server desktop.
- src/main.tsx passes process.stdout.write to hostActions writeTerminal.
  src/actions.ts has active tmux-client / SSH host helpers worth inspecting.
- src/client/frame.tsx handles quit (around line 290) and arms on first Ctrl+C.
  Inspect handler order/defaultPrevented before adding selection copy handling.
- OpenTUI 0.8.3 local declarations: editor-view.d.ts getSelectedText,
  deleteSelectedText; TextareaRenderable/TextBufferRenderable selection methods.
  Inspect local implementation/types for actual selection/undo APIs, not guesses.
- Failed exploratory shell globs were zsh unmatched globs; use rg over directories.

## Steps

- [x] 1. Route default clipboard actions to the current terminal machine.
  Files: src/portable.ts clipboardChain/hostActions, src/portable.test.ts,
  src/actions.ts SSH/tmux helpers, src/main.tsx hostActions initialization,
  src/client/media.ts tmux capability handling, docs/settings.md clipboard sections,
  src/actions.test.ts, src/doctor.ts and src/doctor.test.ts clipboard reporting,
  src/hello.test.tsx copy callback type, acceptance/*.txt Paste affordance.
  Implement and test local vs SSH/tmux routing, OSC52 transport and remote-paste
  behavior. Honor configured commands/targets intentionally; avoid server fallback
  on remote clipboard reads. Expand these Files if discovery requires it.
  Verify: `bun test src/portable.test.ts src/actions.test.ts`; exit 0.
  Baseline: `bun run build` then `bun run check`; both exit 0. Save logs.
  Result (2026-11-15): OSC52 with tmux passthrough; desktop tools gated by the
  active client's environment per action; explicit commands/targets own routing.
  Remote paste gives terminal shortcut/configuration guidance without a query.
  Scoped tests 31 pass; full check 519 pass/20 skip, typecheck/bundle/acceptance 0.
  Logs: /tmp/tercet-step1-tests-final.hnBFcv.log,
  /tmp/tercet-step1-build-final.d9vXWH.log, /tmp/tercet-step1-check-final.kv2Uw0.log.
  Physical PC/laptop clipboard delivery remains a manual check.
  Done when routing has regression tests, supported remote path is concrete,
  unsupported paste is honest/actionable, bundle is current, changes committed.

- [ ] 2. Add composer text context menu and safe selection copying.
  Files: src/client/composer.tsx Editor, src/client/spell-ui.tsx,
  src/client/spell-ui.test.tsx, src/client/composer.test.tsx,
  src/client/media.test.tsx, src/client/frame.tsx quit dispatch,
  src/client/frame.test.tsx, node_modules/@opentui/core/editor-view.d.ts and
  renderables/Textarea.d.ts (read only), src/client/theme.ts.
  Right-click any composer text opens normal editing actions; selection survives
  right-click. Combine spelling actions without regressing Alt+s. Cut changes draft
  only after copy succeeds as supported by Actions contract. Disable unavailable
  actions; keep keyboard menu navigation, Escape, mouse dismissal, and bounds sane.
  Ctrl+C with selection copies without arming quit; no selection retains quit.
  Do not steal Ctrl+C from embedded terminal. Test actual mouse drags/right-click,
  selected text copy/cut/paste, draft preservation, spell actions and quit behavior.
  Verify: `bun test src/client/composer.test.tsx src/client/spell-ui.test.tsx src/client/media.test.tsx src/client/frame.test.tsx src/client/terminal.test.tsx`; exit 0.
  Baseline: `bun run build` then `bun run check`; both exit 0. Save logs.
  Done when integrated behavior is covered with headless UI tests and committed.

- [ ] 3. Add transcript selection menu, verify integration, leave user-testable build.
  Files: src/client/transcript-viewport.tsx selection and Row mouse handling,
  src/client/transcript.test.tsx, src/client/vim.test.tsx,
  shared context-menu code from step 2, src/client/frame.tsx,
  README.md Keys, docs/settings.md clipboard sections, dist/tercet.js.
  Support drag-highlight then right-click Copy with exact selected text; preserve
  selection across menu opening, viewport scrolling as applicable, Vim selection,
  links/code buttons and Shift native selection. Reuse menu implementation.
  Test selection copying does not arm quit in the full frame and use step 1's
  clipboard route everywhere. Document shortcuts and SSH/tmux paste limitations.
  Verify: `bun test src/client/transcript.test.tsx src/client/vim.test.tsx src/client/frame.test.tsx src/client/terminal.test.tsx`; exit 0.
  Baseline: `bun run build` then `bun run check`; both exit 0. Save logs.
  Done when bundle is built and committed, checks pass, manual trial commands and
  checklist are supplied to Sao (composer copy/cut/paste/select all, transcript
  drag/right-click, no-selection quit, PC vs SSH laptop clipboard). State which
  machine/terminal behavior was actually tested vs simulated; do not claim physical
  laptop clipboard verification from mocks. No automatic install or release.

## Loop operation and stop conditions

Do one step per fresh T3 thread, in order. Mark completed step, save 3-6 lines
in the historical log, update local NOTES.md current pointer, commit source +
bundle + this plan, and launch the exact next step with modelSelection
{instanceId:"codex",model:"gpt-6.1-sol",options:[{id:"reasoningEffort",value:"high"}]} and
workspaceStrategy {type:"root",branch:"main"}. Use the live tool schema if it
requires a different model options shape. Retain launch threadId; no duplicate
launch on uncertain result. Include precise files/checks/current state in packets.
Settle completed step threads after launching their successor as build-loop directs.
Leave the originating discussion open. Last step reports completion and stops.

Stop on stale/inactive step, interfering concurrent edits, required user decision,
or a check still failing after two fix attempts. Write blocker and actual errors;
do not launch another step or broaden to paused release work. Baseline failures
must be diagnosed and identified honestly, not silently waived.
