# Plan: tercet read-aloud that works for people who are not Sao

Authorized by Sao on 2026-11-14. Workspace: /home/sao/Projects/Side/t3t-public, main, same
root checkout throughout. Run each numbered step in a fresh top-level T3 thread on
claudeAgent / claude-sonnet-5-5 (all threads, no exceptions). No parallel agents. Make routine
decisions yourself; stop only for the conditions in "Stop".

Test baseline: `bun run typecheck && bun test` from the repo root, expect 0 fail.
Every step that changes `src/` also runs `bun run build` (Bun 1.4.0, matches CI) and
`scripts/build --check`, and commits `dist/tercet.js` with the change.

## Goal and decisions

Read aloud (the [read] button) currently tells users to match "the Phone Assist hub" and
defaults to `~/Projects/Side/kokoro`. That is Sao's private setup. Public users cannot have
it. Replace it with a setup tercet owns, shaped like T3 dictation: explicit install, never
automatic, a clear not-set-up message.

- **Own home.** Default Kokoro home is `$XDG_DATA_HOME/tercet/kokoro` (`~/.local/share/tercet/kokoro`),
  `%LOCALAPPDATA%\tercet\kokoro` on Windows, `~/Library/Application Support/tercet/kokoro` on
  macOS. It holds `kokoro-v1.0.onnx`, `voices-v1.0.bin` and `.venv`.
- **Overrides stay.** `KOKORO_HOME` and `KOKORO_PYTHON` keep working. Add one settings key,
  `readback.home` (path, empty means the default), so Sao can point at his existing
  `~/Projects/Side/kokoro` from his settings file without env vars. Precedence: `KOKORO_HOME`
  env, then `readback.home`, then the default.
- **No Phone Assist anywhere public.** README, docs, error text, code comments, tests. The
  history files (NOTES*.md, PLAN.md, docs/plans/, docs/decisions.md history) are not touched.
- **Setup is explicit.** `tercet readback setup` creates the venv (`uv` if installed, else
  `python3 -m venv` plus pip) and installs `kokoro-onnx` and numpy at pinned versions. It
  downloads the two model files from the kokoro-onnx GitHub release `model-files-v1.0`, to a
  temp name, verifies SHA-256, then renames. It prints what and how big (about 340 MB)
  and asks y/N first; `--yes` skips the prompt, `--dry-run` prints the plan only,
  `--home DIR` picks the location. Re-running with everything present does nothing.
  `tercet readback status` prints ready or what is missing. Nothing downloads at startup,
  install time or first Read.
- **Not-set-up state.** [read] stays visible when `readback.enabled` (default true). Clicking
  it without a ready local setup shows: "Read aloud is not set up. Run `tercet readback
  setup`." `tercet doctor` gets one readback line with the same hint. Do not hide the button.
- **Keep `engine: "http"`** (Kokoro-FastAPI, no Python) as the documented alternative.
- No push, tag, release, install, launcher change, daily settings edit or T3 restart.
  `~/Projects/Side/kokoro` is read-only reference (hash the files, `pip show` its venv);
  never modify it. Tests never download models or play sound. Anything that could make
  sound or open a window follows the quiet-test skill (bgrun).
- Prose follows the unslop skill: no em dashes, no AI vocabulary, sentence-case headings.

## Steps

- [ ] 1. Home resolution, readiness check, `readback.home` setting
  Files: src/readback.ts (localReadbackCommand, synthesizeLocalReadback, error strings),
  src/readback.test.ts, src/client/settings.ts (readback struct, defaults near line 126,
  merge near line 572), src/client/settings.test.ts.
  Do: add `readbackHome(env, settingsHome, platform, home)` with the precedence and per-OS
  default above, and `readbackStatus(...)` returning `{ ready, home, python, missing[] }`
  by checking the venv python and both model files exist. Make `localReadbackCommand` and
  `synthesizeLocalReadback` use them (the home must come from settings.readback.home).
  Remove the `~/Projects/Side/kokoro` default. Rewrite the three error messages and the
  comments that mention Phone Assist or the hub. Add the settings key with validation
  (string, may be empty) and default "". Expand a leading `~` (reuse whatever other path
  settings in settings.ts do).
  Done when: `bun test src/readback.test.ts src/client/settings.test.ts` passes with new
  tests for each OS default, each precedence level, Windows paths with spaces, and
  `readbackStatus` on a temp dir with none, some and all files; `rg -i 'phone.?assist|hub' src/readback.ts` prints nothing.

- [ ] 2. `tercet readback setup` and `status`
  Files: src/main.tsx (subcommand dispatch near line 60), src/cli.ts (usage text style),
  src/upgrade.ts and src/doctor.ts (how existing subcommands are structured and tested),
  src/readback.ts (new helpers from step 1).
  Do: new `src/readback-setup.ts` with injected deps (spawn, download, prompt, filesystem)
  so tests run offline. Behavior as in the decisions above. Pin values: SHA-256 of
  `kokoro-v1.0.onnx` and `voices-v1.0.bin` come from hashing the copies in
  `~/Projects/Side/kokoro` (read-only); confirm the byte sizes against a HEAD request to the
  release URLs. Pin `kokoro-onnx` to the version in his venv (`pip show`, read-only) and
  numpy to a compatible range. Refuse to overwrite a mismatched existing file without
  `--force`. Ctrl+C leaves no half files. Add help text and a usage line to `tercet --help`.
  Done when: `bun test src/readback-setup.test.ts` passes (dry-run output, y/N refusal,
  hash mismatch rejected, partial download cleaned, uv and venv paths, already-ready no-op,
  Windows Scripts path); `bun src/main.tsx readback setup --dry-run --home /tmp/tercet-kokoro-dry`
  prints the plan and creates nothing; `bun src/main.tsx readback status --home /tmp/tercet-kokoro-dry` exits nonzero listing the missing pieces.

- [ ] 3. Not-set-up feedback in the app and in doctor
  Files: src/portable.ts (readback block near line 896), src/readback.ts, src/doctor.ts,
  src/doctor.test.ts, src/client/readback.test.tsx, src/client/transcript-viewport.tsx
  (line 183 onward, how errors reach the transcript).
  Do: `engine: "local"` with a not-ready status makes a Read click fail fast with the
  message from the decisions (no spawn). Re-check readiness on each click, so a setup run
  while tercet is open works without a restart. `tercet doctor` prints one readback line:
  ready with home path, or the hint; `engine: "http"` reports the endpoint instead, without
  making a request.
  Done when: new tests pass for not-ready click, ready-after-setup without restart, and the
  doctor lines; `bun run typecheck && bun test` passes.

- [ ] 4. Docs, licenses and changelog
  Files: README.md (the "Read responses aloud" section), docs/settings.md (the "Response
  readback (Kokoro)" section), docs/install.md, docs/windows.md, THIRD_PARTY.md, CHANGELOG.md.
  Do: rewrite the README and settings sections around `tercet readback setup`, the data
  directories per OS, `readback.home`, the env overrides, the http alternative and the
  not-set-up message. Add Kokoro (model, Apache-2.0) and kokoro-onnx (MIT) to THIRD_PARTY.md
  as downloaded at the user's request, not bundled; check both licenses against their
  upstream repos before writing. Add a short note to docs/install.md next to the dictation
  capture section and to windows.md. CHANGELOG gets one entry under the unreleased heading
  (create it in the existing style if absent).
  Done when: `rg -i 'phone.?assist' README.md docs/settings.md docs/install.md docs/windows.md THIRD_PARTY.md src --glob '!*.md.bak'` prints nothing
  (docs/plans and docs/decisions.md history excluded from this check); every command in the
  docs matches `tercet readback --help` output; `bun test` passes.

- [ ] 5. Real verification and final check
  Files: scripts/check, scripts/build, this plan.
  Do: quietly (bgrun, no sound) run a real `tercet readback setup --yes --home /tmp/tercet-kokoro-real`
  with the real download (one time, about 340 MB), confirm `status` reports ready, then
  synthesize one short sentence through `synthesizeLocalReadback` (a bun -e one-liner is
  fine) and check the output is a RIFF/WAVE file; do not play it. Also confirm Sao's
  existing setup resolves through `readback.home` pointing at `~/Projects/Side/kokoro`
  (status only). Delete /tmp/tercet-kokoro-real afterward. Run `bun run build`, then the
  full `bun run check`. Commit; do not push.
  Done when: `bun run check` last line shows exit 0; the WAV check passes; the final reply
  lists the one-line change Sao makes to keep his own setup working
  (`"readback": { "home": "~/Projects/Side/kokoro" }` or `KOKORO_HOME`).

## Stop

Stop and write `## Blocked` in NOTES.md (what was tried, exact error), notify-send, and
leave the thread open when: a step fails its check after two fix attempts; the pinned
hashes or release URLs do not match what is actually served; or a decision only Sao can
make comes up. Do not weaken an assertion to get green.
