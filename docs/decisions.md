# Decisions

Each entry: what was decided, and why. Newest last.

## Source of the code (P1, 2026-11-10)

Copied from the `apps/tui` working tree of the `tui` branch in the author's T3 Code fork, HEAD
`71bf0eec137b8d07097f1998a0e29643dd838ac3`, plus its uncommitted and untracked edits, without
`node_modules`. That branch is frozen from here on.
Dropped: the fork's own plan, notes and test list. The maintainer's working plan and notes
for this repo stay out of it (see P10 below).

## Repo shape: vendor the import closure (P0, applied in P1)

`vendor/t3/packages/<name>/` holds only the files tercet reaches from `src/` and `scripts/`
(267 files, 2.5 MB at v0.1.8, 24 packages). Each package keeps its `@t3tools/*` name and export
map, so imports read the same as in the T3 monorepo. Whole packages would be 795 files and
9.1 MB and drag in `three`, `jszip`, the remark stack and native `ffi-rs`; a submodule adds
clone friction for no gain under 400 files. Details: `docs/compat-report.md`.

- Vendored source is never edited. Manifests are trimmed to name, version, type and exports
  because the upstream ones use pnpm `catalog:` versions and list deps tercet never loads.
- `vendor/t3/exports-patch.json` is the one patch: it exports `rpc/session`,
  `state/shell-reducer` and `state/thread-shell`, which upstream ships but does not export.
- Four imports were renamed to upstream's subpaths: `state/projection` to
  `state/orchestration-v2-projection`, `state/history-merge` to `state/thread-history-merge`,
  `state/threadCheckpoints` to `state/thread-checkpoints`, `diffCount` to `diff-count`.
- `scripts/sync-upstream [tag] [--from <checkout>]` recomputes the closure and rewrites
  `vendor/t3/` atomically. Without `--from` it clones the tag into `~/.cache/tercet/`. It prints the
  pinned tag and is idempotent (a second run leaves `git status` clean).
- Bun workspaces (`vendor/t3/packages/*`) with `linker = "hoisted"` in `bunfig.toml`: the trimmed
  manifests declare no dependencies, so packages must resolve `effect` and each other from the
  root `node_modules`.

## Pins

- Upstream T3 Code `v0.1.8` (`bf469bb1966`), the latest non-prerelease tag on 2026-11-10.
- `typescript` 7.0.2: upstream's catalog has none (it moved to `@effect/tsgo`); this is what the
  fork resolved.
- `effect` 4.1.2 and `@noble/hashes` 1.8.0: upstream's catalog versions at v0.1.8.
  `@noble/hashes` is new as a direct dependency only because vendored `shared` imports it.

## Fork-only surface (P1)

- Fork-only types and module-private upstream helpers live in `src/ext/`:
  `host-actions.ts` (dictation, tmux, phone input types; deleted in P4), `secret-request.ts`
  (`secretRequestCopy`), `thread-shell.ts` (`subagentRequest`,
  `pendingSubagentRequestsByThread`, copied from upstream), `usage-limits.ts`
  (`providersWithLimits`, copied from upstream).
- The fork-only RPCs `shell.toggleDictation`, `shell.typeInTmux`, `shell.sendToPhone` are gone.
  `hostAction` always fails with `HostActionUnavailable` ("not available on this server").
  P4 replaces these actions with user command templates.
- `subscribeArchivedShell` became one `getArchivedShellSnapshot` call plus the shell stream's
  `location: "archive"` thread events, which is how upstream reports archive moves.
- `terminal.restart` became `terminal.close` then `terminal.open` with the same size and cwd.
- Context usage moved off the thread shell upstream. The header reads it from the selected
  thread's active provider thread in its projection (`providerThreads[].contextUsage`).
- Secret request cards always say "Save securely", as upstream web does; the fork's askpass
  variant does not exist upstream.

## Not changed

No T3 server or contracts changes. The T3 on port 3773 and `~/.t3/userdata` are never touched;
sandboxes use port 3775 and up.

## Acceptance rig on the vanilla server (P2, 2026-11-10)

- Server: npm `t3@0.1.8`. That package is only a launcher; it downloads the release binary and
  checks it against the release's `SHA256SUMS`. `scripts/sandbox.sh` installs it once into
  `~/.cache/tercet/server` (`T3CODE_HOME` pointed there, never `~/.t3`) and runs the binary
  directly. Not a project dependency: nothing in `package.json` loads it.
- Each acceptance run gets a fresh `mktemp -d /tmp/tercet-sandbox.XXXXXX` that is HOME for both
  server and TUI, with data in `.t3`, a made-up git project `work/demo-app` added with
  `t3 project add`, and a `settings.json` that disables Codex and Claude and enables OpenCode.
  Port 3775; an occupied port is refused before anything starts.
- The server runs with `XDG_RUNTIME_DIR` unset. That turns its systemd agent scopes off, so
  agents never land in user slices (which a desktop T3 may also use) and stay our descendants.
- `scripts/reaper.py` (stdlib only) wraps the server as a child subreaper. OpenCode calls
  setsid, so bgrun's session kill misses it, and a SIGKILLed server orphaned it in testing.
  The reaper stops every descendant when the server exits or on SIGTERM. Teardown signals only
  PIDs from the sandbox's own PID files (checked against `/proc/<pid>/cmdline`), the named
  bgrun jobs and the run's private tmux socket.
- Screens are compared exactly with `acceptance/*.txt` after masking three things that change
  between runs without moving columns: the mktemp suffix, the spinner frame and the sidebar's
  relative age. `--record` rewrites them. The stream screen waits for the completed checkpoint.
- The driver follows the current UI: `/` opens the model filter (j/k/h/l move until it does),
  `G V k k y` yanks the reply, `i` focuses the composer's question card.
- `bun run check` runs typecheck, tests and acceptance, keeps each log under
  `/tmp/tercet-check.XXXXXX`, prints a failing step's tail and ends with one summary line.

## Settings file and doctor (P3, 2026-11-10)

- One file, `$XDG_CONFIG_HOME/tercet/settings.json` (default `~/.config/tercet`), JSON with comments
  and trailing commas. It keeps the name of the small `settings.json` tercet already read for
  `sendShortcut` and favorites; those moved into `defaults`. No dependency: a 100-line parser in
  `src/client/settings.ts` records each key's line so errors name the line and the key. TOML
  would have needed a package. Reference: `docs/settings.md`.
- Unknown keys are ignored and listed by `tercet doctor` (changed 2026-11-14; they used to stop
  startup). A settings file from a newer build, or a laptop and a PC on different builds, kept
  blocking the older one. Wrong types and values still stop startup. `parseSettings` without a
  warnings list stays strict, which the schema tests use.
- Precedence: flags, then the file, then `server-runtime.json`, then defaults. A token file named
  in settings is treated like `--token-file`: read, never reissued or chmodded.
- `defaults.model` beats the current thread's model for new threads, because a user who set a
  default expects it; a model picked for the new thread in the picker still wins.
- `tercet doctor` takes injected probes (env, PATH lookup, commands, file reads, the descriptor
  fetch), so its tests run on a made-up machine. It reports what the current code can do; the
  action list moves to settings with P4. "Supported" means the protocol matches and the server is
  the pinned `0.1.8`; a matching protocol on another version is "untested".

## Portable actions and command templates (P4, 2026-11-10)

- `src/portable.ts` is the one file in `src/` that names desktop tools. It holds the clipboard
  chain (configured `commands.copy`/`paste`, then wl-clipboard, xclip, xsel, pbcopy/pbpaste),
  the opener chain (`launchers.opener`, then `xdg-open`, then `open`), the template engine and
  `hostActions`, which builds every effect from settings plus what is on `PATH`. No dependency.
- Display tools count only while their display is set: wl-clipboard needs `WAYLAND_DISPLAY`,
  xclip and xsel need `DISPLAY`. Over plain SSH a stray wl-copy would write the wrong machine's
  clipboard, so the chain skips it and copy is OSC 52 alone. `open` counts only on macOS,
  because on Linux it is often openvt.
- Templates are argv lists filled per argument; there is no shell anywhere in the engine.
  Validation refuses unknown placeholders and any placeholder in the script after an
  interpreter's `-c` (sh, bash, python, ...), so a user script has to read `"$1"`. tmux's own
  `-c` is a directory and stays allowed. `{{` is a literal brace, which leaves `#{session_id}`
  and `${VAR}` usable.
- An action without a command is absent from `Actions`, and every button, key, hint and palette
  entry checks the action rather than a flag. Read-only mode blocks only the actions that exist.
- `pc`/`laptop` became `targets`: named clipboards with an optional capital key. Y T X F O G V
  and the built-in button names are reserved so a target cannot shadow them.
- [phone] became [send] (`commands.send`, file as `{path}`, text as `{text}` and stdin): the
  action is "send it elsewhere", and a phone is one user's case.
- `{sshHost}` keeps the fork's lookup (the most recently active tmux client's `SSH_CONNECTION`,
  else the process's own), runs only when a template mentions it, and lives in `actions.ts`
  because it reads tmux and `/proc` rather than calling a desktop tool.
- Usage meters stay as they are and are not a command. They draw upstream's
  `providers[].usageLimits`, the same server data web shows, and only when a provider reports
  limits; on the P2 sandbox nothing reports them, so nothing draws.
- The `hostAction` plumbing (`src/ext/host-actions.ts`, the client method and its
  `HostActionUnavailable` stub) is gone; nothing calls the server for host effects.
- Acceptance runs on an empty settings file written into the sandbox HOME, with the display
  variables stripped, so recorded screens show the stranger's defaults and tests never touch
  the real clipboard.

## More themes and `auto` (2026-11-14)

- 15 presets, built by `fromPalette` (`src/client/theme.ts`) from about 12 colors a palette
  author picks; borders, the selected row, selection and the terminal's 16 colors are derived.
  Cyberdream, `light` and `ansi` stay hand-written, so they did not change. Any text color under
  3.6:1 on its canvas is nudged toward the text color, and `muted` also has to clear the selected
  row's background; the preset fixture in `look.test.tsx` still fails under 3:1.
- The fixture caught three hardcoded `#666` placeholders (composer, palette, model picker) that
  failed on every new dark canvas; they use `theme.muted` now.
- `auto` is `light` on a light terminal and `cyberdream` otherwise, decided once at startup by
  an OSC 11 query (`client/appearance.ts`), with DA1 as the end marker, then `COLORFGBG`. It runs
  inside tmux too (tmux answers OSC 11), unlike the Kitty query. No live reload: that needs a
  theme that can change while components hold colors, which nothing asked for yet.

## Themes, keybinds, cheat sheet (P5, 2026-11-10)

- Colors are roles on one `theme` object (`src/client/theme.ts`) that components read while
  rendering; `applyLook` fills it from settings before the first frame. Module-level color
  constants were removed so nothing captures a color at import. Presets: `cyberdream` (the
  fork's hex values, unchanged), `light`, and `ansi`, which uses opentui's indexed colors
  (`RGBA.fromIndex`, drawn as `38;5;n`) and the terminal's default foreground and background.
  `ansi` text uses the bright half: opentui's reference palette, like many terminals, has 0x80
  dark colors that fail contrast on black.
- Unfocused pane titles take `muted` (`titleColor`) while the border keeps its quiet `border`
  color: in Cyberdream the old title was border-colored at 1.4:1. Text with no color of its own
  gets `plain` (white in Cyberdream, as before) instead of opentui's hardcoded white, which
  vanished on the light preset.
- The preset fixture (`src/client/look.test.tsx`) renders the real frame per preset and icon set
  with help, palette and model open, and fails on any text span under 3:1 against its background
  (borders and block characters excepted) or on a label that is cut off.
- Keys: one table (`COMMANDS` in `keymap.ts`) feeds dispatch, the status hints, `?` and
  `tercet keys`. Settings validation resolves it, so a conflict is a settings error at the line that
  caused it (a rebound command, not the default it hit), naming both owners. The P4 capitals,
  vim's G V Ctrl+d Ctrl+u, the composer's own Ctrl/Alt keys and targets' capitals are reserved.
  Esc and Ctrl+c stay fixed: several panes test for them directly. Dictation (Alt+v) moved into
  the table. Legacy Ctrl+_ matches Ctrl+/.
- Icons: `nerd`, `unicode` (default), `ascii`. `ascii` swaps the UI's punctuation, borders,
  arrows and spinner one cell for one in a renderer post-process step (`asciiFrame`), rather than
  threading a glyph table through ~180 string sites; layout cannot shift, and new glyphs are
  caught by the fixture's ASCII check, which applies the same table (`asciiText`) because opentui
  captures test frames before post-processing.
- `doctor` checks `nerd` by signs only (TERM=linux, SSH, `fc-list` for a Nerd Font family): no
  terminal reports its font.
- No new dependency.

## Media ladder (P6, 2026-11-11)

- One module, `src/client/media.ts`, decides the rung once before the first frame, like the
  theme: `decideMedia` takes the setting, the terminal's replies, tmux's state and env names, and
  both the app and `doctor` call it, so they cannot disagree. Replies beat names; names count
  only when nothing answers.
- Detection is tercet's own Kitty query plus DA1, read before opentui owns stdin, stopping at the
  DA1 reply or 300 ms. opentui also probes, but its answer comes later as an event and inside
  tmux it describes tmux. In tmux tercet skips the query and reads `allow-passthrough` and
  `#{client_termname}`; an unknown outer terminal gets blocks, not Kitty, because an unanswered
  Kitty placement draws an empty box.
- Half-block is opentui's `blocks` protocol, which uses the whole Block Elements range (half and
  quadrant blocks, U+2580-259F) with foreground and background colors: twice the detail of `▀`
  alone, same fonts. With `icons: "ascii"`, `auto` skips it for the placeholder; an explicit
  `"blocks"` still draws it.
- Sixel is in, because it was cheap: opentui's `ImageRenderable` already encodes it, so it is a
  rung name and a setting value. It is picked only outside tmux, and opentui falls back to
  blocks when the terminal reports no pixel size. Not yet seen on a real Sixel terminal.
- The placeholder is ASCII only (name, `WxH` or duration, size, the card's `[open]`), so every
  icon set draws it; sizes come from file headers (PNG, GIF, JPEG, WebP), no decoder.
- What T3 0.1.8 attaches: images (screenshots included) and files of any type, on user and
  assistant messages; web shows images inline, plays video files, and opens other files.
  Markdown media is images and video by extension. tercet covers the same set: every attachment
  becomes a card (`tercet-image:` or `tercet-file:` source), video gets a poster and duration, audio
  and other files get a placeholder, and the files panel names video and audio instead of
  reading them as text.
- Video posters come from one `ffmpeg` run (first frame as PNG on stdout, duration and size
  from its banner), with a protocol whitelist of file and http(s). Playback is
  `launchers.player`, then `mpv`, then the opener. `media.video: "terminal"` suspends the
  renderer and runs `mpv --vo=kitty|sixel|tct` in the terminal (tct in tmux). A missing tool
  removes the action; the card stays a placeholder.
- No new dependency.

## Robustness (P7, 2026-11-11)

- Server version: `supportedRange` (`src/client/compat.ts`) is `>=0.1.8 <0.2.0`, checked with
  `Bun.semver` (built in, no dependency). Patch releases of the pinned minor are admitted as
  "untested"; a new minor, another orchestration protocol or a version that does not parse is
  "unsupported". Startup and `tercet doctor` share `checkDescriptor`, so they cannot disagree.
- The check runs once before the client starts. A blocking result gets a full-screen
  `ServerGate` (version found, range, what to do; `q` quits). An unreachable server is checked
  again every 2 s and opens the app once it answers (the local autostart holder gets its wake
  first). `--ignore-version` passes version problems, never an unreachable server.
  `--dump-status` prints the same message to stderr and exits 1, and now exits at once on a
  rejected token instead of after 30 s.
- A version-less server under `--ignore-version` still fails client-runtime's descriptor decode
  (`serverVersion` is required there) and sits on the retry screen. That is upstream's schema;
  not patched.
- Unknown item types: the vendored contracts decode them as `UnknownUnionMember` and drop them
  before tercet sees them, so a newer server's new items disappear rather than draw blank. tercet's
  own fallback covers what reaches the renderer: `work-log.ts` keeps an exhaustive
  `KNOWN_ITEM_TYPES` table (a vendor sync that adds a type fails typecheck) and draws any other
  type as `[?] unknown item: <type> · <status>` with a one-line raw summary of its fields.
- Terminal safety: `terminalLifecycle` handles SIGINT, SIGTERM and SIGHUP as well as crashes, and
  exits after the draft flush with 128+signal or 1 (a 3 s fallback timer, and a second signal
  exits at once). The exit reset adds the Kitty "delete all placements" when the media rung is
  kitty (passthrough-wrapped in tmux). `src/terminal-rig.test.ts` kills the real `--hello` app
  four ways in a private tmux and reads the pane's flags afterwards.
- Read-only: `READ_ONLY_POLICY` (`src/client/read-only.ts`) classifies every `Actions` member as
  block, drop or allow. Its mapped type makes a new action a type error until it is classified.
  Same behavior as the old list in `main.tsx`.
- Tokens: `src/tokens.test.ts` uses a canary token and a fake server that echoes the credential
  into its error bodies, and checks `--dump-status` (rejected, unsupported, version-less,
  unreachable, bad flags), `doctor` (plain and `--json`) and the TUI (pane and every byte written).
- Large threads: see `docs/performance.md`. Work-log entries and group summaries are cached per
  item object, and the row cache has an append path. Production React is left to the P8 build,
  because Bun fixes `NODE_ENV` when it transpiles.
- No new dependency.

## Packaging and CI (P8, 2026-11-12)

- Install: `bun install -g github:Steven-ODell/tercet` (or `install.sh`, which checks for Bun
  first and prints `curl -fsSL https://bun.com/install | bash` if it is missing). Steps and update
  notes: `docs/install.md`. The owner and repo name were placeholders until P9 named the project.
- That install runs a committed bundle, `dist/tercet.js`. Tried first: the repo as is fails
  (`workspace:*` deps do not resolve outside the workspace, even as devDependencies), `file:`
  deps fail the same way, and Bun blocks the package's own `prepare` and `postinstall` scripts
  on a global git install, so it cannot build at install time. `package.json` therefore lists
  `@opentui/core` as the only dependency; everything else is a devDependency and the vendored
  packages are linked by the workspace alone.
- `scripts/build` bundles with `--target bun`, defines `process.env.NODE_ENV` as
  `"production"` (React's production build) and leaves `@opentui/core` external, because it
  loads its platform's native library and parser worker from its own package. 4.2 MB,
  unminified so git deltas stay small, and byte-identical across checkout paths.
  `scripts/build --check` (in `bun run check` and CI) fails on a stale bundle. `.gitattributes`
  marks it generated and `-diff`.
- No `bun build --compile` binary in P8. P0 showed it can work (102 MB, needs the seven non-host
  `@opentui/core-*` packages external); images and the embedded terminal were never tried in it.
  A binary is a second install path (per-OS/arch downloads from GitHub releases, no Bun needed),
  and the documented path needs Bun anyway, so whether to offer one is the maintainer's
  call.
- `TERCET_VERSION` now comes from `package.json` (`resolveJsonModule`), so `scripts/release` bumps
  one place. `--version` prints it, `(development build)` when run from source, and
  `T3 server: <supportedRange>, tested on <PINNED_SERVER_VERSION>`.
- CI (`.github/workflows/ci.yml`): typecheck, `bun test`, the bundle check and
  `dist/tercet.js --version` on `ubuntu-latest` and `macos-latest`. The acceptance run stays local
  (it downloads the T3 server and drives tmux). The canary job runs
  `scripts/sync-upstream main` and typecheck, on pushes, PRs and daily, with
  `continue-on-error` and read-only permissions. It passed against upstream main f03db4f on
  2026-11-12.
- `scripts/release X.Y.Z` (main only, clean tree): version, bundle, `bun run check`, notes from
  the commit subjects since the last `v*` tag prepended to `CHANGELOG.md`, commit
  `release vX.Y.Z` and an annotated tag with the same notes. It never pushes and prints the
  `git push` and `gh release create --notes-from-tag` commands.
- No new dependency. Pins: Bun 1.4.0 in CI (setup-bun), matching the Bun that builds the
  committed bundle; a Bun upgrade means rebuilding the bundle and bumping CI together.

## Name, demo and binaries (P9, 2026-11-12)

- The project is `tercet` (maintainer's pick, from five candidates checked on npm and GitHub). Two
  T3 Code TUIs already use `t3tui`, so a `t3` name would blur with them, and leaving `t3t`
  avoids clashing with the fork's own `t3t` binary. The bin, package, config dir, env vars
  (`TERCET_*`) and the `tercet-image:`/`tercet-file:`/`tercet-page:` link schemes all renamed.
- Migration: at startup, if `<config>/tercet` is missing and `<config>/t3t` exists,
  `migrateLegacyDir` (`src/client/settings.ts`) renames it and leaves a symlink at the old path,
  so an older install that shares the token keeps working. It prints one line on stderr.
- Install stays Bun-only (maintainer's call). No `bun build --compile` binaries for now.
- The demo GIF is recorded from `scripts/demo/app.tsx`, the real frame on a fixture client with
  made-up threads, not from the 3775 sandbox: the sandbox's only model is a free OpenCode model,
  which cannot produce a fixed diff, image and code block on cue. `scripts/demo/record` drives it
  in a private tmux and `scripts/demo/render.py` draws `capture-pane -e` dumps with pyte and
  Pillow (through `uv run --with`, maintainer tooling only, not a dependency of
  tercet). Re-recording gives byte-identical frames. That pipeline remains as a fallback.
- The shipped `docs/media/demo.gif` is now recorded with VHS instead: `vhs scripts/demo/demo.tape`
  from the repo root, same fixture and key order as `record`. VHS draws in a headless browser
  terminal (ttyd + chromium), so nothing shows on screen, but it has no Kitty or Sixel: the image
  card is the block rung, and the alt text says so. It needs `vhs`, `ttyd`, chromium and bun.
  Output is not byte-identical between runs (two runs matched within 0.5% RMSE, 4% at one key
  transition), so look at the frames before committing. The result is 1250x840, about 19 s,
  under 1 MB. The previous tmux-rendered GIF is in git history. `docs/media/demo.gif` itself has
  since been removed from the tree (it is in git history too); the README uses `demo-extended.gif`.
- `bun run check` skips the acceptance step when `bgrun` (the maintainer's background-job
  wrapper) is not installed, and says so in the summary, so a contributor's check can still pass.
  Replacing `bgrun` with an in-repo runner is post-v1 work.
- Model picker bursts: the first printable key commits with `flushSync`, so the rest of the
  burst reaches the focused input. A ref-based queue was tried first; it kept the text but an
  Enter right after the burst still saw the stale render.

## Release checklist (P10, 2026-11-12)

- Privacy scan over every commit (`git grep` per revision for home paths, the maintainer's
  handles and machine names, Tailscale names and 100.64/10 addresses, token shapes; neither
  gitleaks nor trufflehog was installed). Older commits held home paths and machine names, so
  the history was squashed into one initial commit rather than rewritten piece by piece.
- The maintainer's working plan and notes (`PLAN.md`, `NOTES.md`, `NOTES-archive.md`,
  `future_public_plans.md`) stay in the local checkout and out of the repo. Test fixtures use
  documentation addresses (203.0.113.0/24, 198.51.100.0/24) and made-up project names.
- `scripts/tmux-smoke.{sh,py}` deleted: they ran the fork's `apps/tui` path and nothing called
  them; the acceptance rig covers the same ground.
- Clean-account run: empty HOME, Bun only, npm `t3@0.1.8` on a spare port, README steps only.
  `install.sh` (also without Bun), `tercet doctor`, the default token path (`t3 auth session
  issue` on first start, kept at mode 0600 and reused) and quitting all worked. The one dead end
  was a server with no projects: the new-thread dialog said only "No project available". It
  now says to add one in the web app or with `t3 project add <folder>`, and the README says
  tercet uses the projects and providers the server already has. Projects added while tercet
  runs show up live.
- tmux is optional. tercet is a plain terminal app; tmux support is detection (images through
  passthrough, the outer terminal's name, the active client for `{sshHost}`, all only when
  `TMUX` is set) plus one optional command template, `commands.tmux`. The README keeps tmux to
  a troubleshooting note and the terminals table, the settings example and the demo use no tmux
  command, and `tercet doctor` prints a tmux row only inside tmux.

## Gate on protocol, warn on version (2026-11-12)

- Replaces the P7 version gate. tercet is for people on plain upstream T3, which ships often and
  may bump its minor at any time; refusing to start on 0.2.0 locked those users out for no
  proven reason. `checkDescriptor` now has five verdicts: `ok` (inside `supportedRange`,
  `tested` when it is `PINNED_SERVER_VERSION`), `out-of-range` (same protocol, any other version,
  nightlies and unparseable ones included), `protocol` (another orchestration protocol),
  `no-version` and `unreachable`.
- Only `unreachable` and `protocol` stop startup, plus `no-version`, because client-runtime's
  descriptor decode requires `serverVersion` and would sit on the retry screen anyway.
  `--ignore-version` passes `protocol` and `no-version`, never `unreachable`.
- `out-of-range` opens the app with a one-line banner above the header, "Built for T3 0.1.8,
  you're on Y: some things may not work." `ServerGate` passes it to the frame through the
  `ServerNotice` context; `Alt+x` (`dismissNotice` in `COMMANDS`, `needs: "notice"`) or a click
  hides it for the session. The key exists, and `?` lists it, only while the banner shows. An
  ignored protocol mismatch or missing version gets the same banner with its own text.
  `--dump-status` prints the warning on stderr and carries on.
- `tercet doctor`: `yes` for the pinned release, `untested` for any other version on the same
  protocol (the detail says whether it is in range or starts with the banner), `no` for another
  protocol or no version.

### Can a newer server crash tercet?

Read in the vendored v0.1.8 contracts and effect's RPC client, 2026-11-12:

- Unknown thread events and unknown turn-item types are safe. `OrchestrationV2ThreadStreamItem`
  decodes them as `unknown-event` (cursor advanced, payload dropped), and tercet's
  `receiveThread` marks the transcript "Unsupported server item · open this thread in Web".
  Unknown items in history pages and snapshots are filtered out
  (`ForwardCompatibleUnionArray`). `work-log.ts` still draws any type that gets through as
  `[?] unknown item`.
- Unknown provider kinds are safe: `ProviderDriverKind` is an open slug, `ServerProviders` is a
  `ForwardCompatibleArray` (bad entries dropped), and tercet's icon lookup falls back to a robot.
- The risk is a new value inside a known shape: most enums (`RunStatus`, `RuntimeMode`, the
  shell stream's `kind`, `location`) are closed `Schema.Literals`. One such value fails the
  decode of that whole stream chunk, and effect's `RpcClient` turns a chunk decode failure into a
  defect (`Effect.orDie`), not a typed failure. tercet's stream loops used `Effect.catch`, which
  does not see defects, so the thread fiber, or the whole shell reconnect loop, died silently:
  a frozen screen, not a process crash.
- Fixed in tercet's own code (`src/client/runtime.ts`): both loops add `Effect.catchDefect`. The
  shell loop shows "The server sent data this tercet cannot read (a newer T3?)" and keeps
  retrying; the thread shows the same note in the transcript. `client.test.ts` covers both. The
  frame's runtime-mode label also falls back to the raw value. Remaining risk, documented and
  not fixable without vendor changes: a server that sends such a value on every snapshot keeps
  tercet on that message until tercet is updated.

## Built-in T3 dictation (2026-11-12)

- Uses the connected server's local speech model over bearer-auth HTTP. Two small fetch
  requests avoid importing upstream's browser HTTP/DPoP stack; PCM framing comes from its
  vendored shared encoder. Redirects are refused so audio and tokens cannot follow them.
- Local recorder processes produce 16 kHz mono float32 PCM in memory. Stop then transcribe;
  no cloud, post-processing, streaming, auto-send or SSH audio forwarding. Model installation
  remains explicit in the T3 web app, Settings → Voice. External commands retain precedence.
- One controller owns recording and destination across both mic entry points. Mounted editors
  insert at the cursor; absent editors append to the current original draft. Cancellation
  aborts HTTP and invalidates late results even if a transport ignores abort.
- SSH disables automatic recording because it would capture the server machine's microphone.
  An explicit recorder is an intentional override. Read-only blocks capture and speech access.
- Linux pw-record, parecord (with 100 ms latency), arecord and ffmpeg capture yielded valid
  PCM; SoX capture required a longer phrase due to buffering. macOS remains unverified.


## Native Windows support (2026-11-14)

Sao expanded the original POSIX-only platform target to native Windows, including the Git/PR
loop. Keep the existing Bun/OpenTUI stack: the pinned renderer ships Windows builds and Bun
1.4.0 supports ConPTY. Native host adapters live in `src/windows.ts`; user values are encoded
as JSON data, never interpolated into PowerShell code. No Wine dependency or WSL requirement.
Windows CI runs native platform/PTY/installer tests and pinned stock Windows T3 authentication;
Linux/macOS retain their full POSIX rigs. Windows remains experimental until that native job
and a Windows Terminal hands-on trial pass. Git paths remain opaque server values, including
drive letters and UNC shares. See `docs/windows.md` for coverage and remaining limits.
P10 release/publication gates remain paused.

## Inline Kitty images: scrolling and tmux switches (2026-11-14)

- Scrolling holes were a remount, not a bad crop: `ImagePreview` was keyed by the first visible
  row, so every scroll that cropped the top dropped the bytes and re-uploaded the PNG. It is
  keyed by `image.id` now, and `withoutReplacedDeletes` (`src/kitty-output.ts`) drops OpenTUI's
  delete when the same write places that placement again.
- tmux drops passthrough from a hidden pane (`allow-passthrough on`; `all` still drops it for
  another session), so a delete sent after the switch never arrives. On blur,
  `clearKittyWhenHidden` asks tmux which clients still show tercet's window
  (`tmuxClientsShowing`) and writes the delete of tercet's own image ids straight to the tty of
  each client that stopped showing it. Image data is kept; focus-in repaints. A blur while the
  window is still shown (the terminal lost focus) leaves the images alone.
- Needs `focus-events on`. Without it there is no blur and the old behavior stays.
