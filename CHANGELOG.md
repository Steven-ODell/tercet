# Changelog

## tercet 0.1.8 (2026-11-21)

Works with T3 Code servers >=0.1.9 <0.2.0, tested on 0.1.9.

- Tool calls the model sent together in one model call now show as one collapsible row, for example `[+] Batch call · 2 web searches`. Enter or a click expands it to the usual per-tool rows; a call with a single tool keeps its own row. This shows at a glance whether an agent batched its tools or called them one after another. A failed tool marks the batch `· FAILED`.
- Batches are exact when the server stamps the model call on each tool item (`nativeItemRef.fingerprint`, `claude-message:<id>`). Otherwise tercet groups tools by timing: the next one started before, or within 800 ms of, the previous one finishing. Timing can miss a batch whose tools ran one after another, but never joins separate calls.

Validation: typecheck, 662 tests passed (20 skipped), bundle freshness passed; live acceptance
matches all snapshots.

## tercet 0.1.7 (2026-11-21)

Works with T3 Code servers >=0.1.9 <0.2.0, tested on 0.1.9.

- Phone layout: under 70 columns or 24 rows tercet switches to a compact layout (one view at a time with tappable tabs, a one-row action bar, a Menu sheet with every command, wrapped thread names, full-screen pickers). Set it with `layout` (`auto`, `compact`, `full`) or `TERCET_LAYOUT`.
- Favorites: `defaults.favorites` entries take an `options` object (for example `effort`), applied when you pick that favorite in the model picker. Right-click a model to edit its favorite and save it to the settings file.
- Local Read aloud keeps one warm Kokoro process (idle-stopped after 2 minutes) and starts with a small first piece, so speech begins in about two seconds instead of six.
- Alt+y selects a screen region (`slurp` + `grim` on Wayland) and attaches the PNG to the draft; over SSH it captures on the machine you type on. Rebind with `keys.screenshot`.
- `messageTag` adds an optional source prefix to sent messages (for example which machine you typed on); off unless `local` or `ssh` is set.
- The context meter's dropdown shows the provider's counts and estimates from the loaded transcript.
- An agent's read-only view shows that agent's model and effort in the model row, not the parent thread's.

tercet's version (0.1.7) and the T3 server version it works with (0.1.9) are separate numbers;
`tercet upgrade` only compares tercet releases.

Validation: typecheck, 655 tests passed (20 skipped), bundle freshness passed; live acceptance
matches all snapshots (02-model rerecorded for the current OpenCode catalog).

## tercet 0.1.6 (2026-11-16)

Works with T3 Code servers >=0.1.9 <0.2.0, tested on 0.1.9.

- Links inside bold text and headings stay clickable, including wrapped links.
- Transcript links are underlined and use a separate color, configurable with `theme.link`.
- `launchers.browser` selects a browser executable and arguments independently of file openers.
- `launchers.browserProfile` selects an existing browser profile through `{profile}`.
- `launchers.browserLocation` opens links on the host or the attached SSH client. Remote
  browser arguments are shell-quoted, and failed launches copy the URL with a notice.
- Stabilized media metadata checks and acceptance snapshots for live provider token counts.

Validation: 531 tests passed, 20 skipped; typecheck, bundle freshness and Linux standalone
binary smoke checks passed. A completed live acceptance run matches all 11 refreshed
snapshots. A subsequent fresh live run was blocked by OpenCode's free usage limit.

## tercet 0.1.5 (2026-11-16)

Works with T3 Code servers >=0.1.9 <0.2.0, tested on 0.1.9.

- Fixed: tercet needed `t3` on PATH to issue its first token, which Windows installs often lack.
  It now looks on PATH, then in the usual npm, bun, pnpm, mise and Homebrew folders, and when it
  still cannot find `t3` it says what it tried instead of "check t3 CLI".
- New setting `server.t3Command`: the full path (or command name) of `t3`, for installs it cannot
  find on its own. On Windows that is `t3.cmd`, usually in `%APPDATA%\npm`.
- `tercet doctor` prints a `t3 command` row before the first token exists.
- Rendered pages (T3's `html_render`) now show as a screenshot by default. Turn it off with
  `"media": { "pageShots": false }` in the settings file, or `TERCET_PAGE_SHOTS=0` for one run.
- README and `docs/settings.md` explain both ways past a missing `t3`: set `server.t3Command`, or
  issue a token yourself with `t3 auth session issue` and set `server.tokenFile`.

## tercet 0.1.4 (2026-11-16)

Works with T3 Code servers >=0.1.9 <0.2.0, tested on 0.1.9.

- T3 support moves to 0.1.9: the supported range is now >=0.1.9 <0.2.0, so a 0.1.8 server shows
  the version warning banner.
- Fixed: after clicking a link, its [open] button could vanish when the screen re-rendered under
  a still pointer. This was also the cause of the flaky clickable test.
- Internal planning docs (docs/plans) are no longer published; spike code and raw logs are gone
  from the tree.

Changes since v0.1.3:

- step 4b: keep a link targeted when opentui resends hover after a render (5435d7c)
- step 5: move the vendored T3 pin from v0.1.8 to v0.1.9 (83de3bd)
- step 4: wait for the label's frame in the clickable test (c992f2b)
- step 2: remove spike code and raw logs from the public tree (c5f06cd)
- step 1: stop publishing internal handoff plans (32447c8)

## tercet 0.1.3 (2026-11-15)

Works with T3 Code servers >=0.1.8 <0.2.0, tested on 0.1.8.

Changes since v0.1.2:

- step 3: add transcript selection copy menu and verify integration (896900b)
- step 2: add composer text context menu and safe selection copying (1df27ad)
- step 1: route clipboard actions to the current terminal machine (c6f2f97)
- docs: plan text clipboard and context menu build loop (27a0ab2)

## tercet 0.1.2 (2026-11-15)

Works with T3 Code servers >=0.1.8 <0.2.0, tested on 0.1.8.

Changes since v0.1.1:

- fix: keep dictated text and caret when keys arrive in bursts (91f5a35)

## tercet 0.1.1 (2026-11-15)

Works with T3 Code servers >=0.1.8 <0.2.0, tested on 0.1.8.

Changes since v0.1.0:

- docs: remove the original demo GIF (d46586c)
- test: drop reference to a private recording from a comment (7df0c26)
- fix: route default remote video playback through client opener (617a4aa)
- themes: 12 presets and auto; rendered page screenshots (opt-in) (645531e)
- step 3: inline image fixes wrap-up (e993975)
- step 2: clear images on session switch (a48a128)
- step 1: inline image scrolling crop (dcaeb0e)
- settings: ignore unknown keys and list them in doctor (f98017d)
- step 5: real verification and final check for read aloud (ed38415)
- step 4: docs, licenses and changelog for read aloud (4ffb649)
- step 3: not-set-up feedback in the app and in doctor (acc22f3)
- step 2: tercet readback setup and status (72e22fa)
- step 1: tercet-owned Kokoro home and readiness check (733d911)
- plan: public Kokoro setup for read aloud (62e0831)
- fix: pass generated PowerShell to the parser over stdin (c3f893f)
- feat: prebuilt binaries, tercet list/attach/tmux, and three install routes (b44a46e)
- test: give the Windows PowerShell tests a cold-start timeout (348187e)
- feat: make the sidebar usage box collapsible (98c8170)
- fix: omit removed workspaces from historical thread bindings (a2c20b9)
- fix: drain captured process output before reporting failures (a623044)
- ci: test shipped Windows bundle before platform-specific rebuild (8523b7d)
- build: report first bundle difference across platforms (1eb999e)
- fix: preserve custom R targets when readback is enabled (26a5cc4)
- readback: show status beside [read] and speak long replies in pieces (d29b7c8)
- windows support, embedded editor, readback over ssh (c665f5e)
- step 4: add PR inspection and review actions (0c42ba0)
- step 3: add worktrees and thread workspace binding (ec2d92c)
- step 2: add branch status and safe branch switching (0ec5edd)
- step 1: establish typed Git and PR RPC boundary (629271d)
- docs: plan PR actions and branch worktree build loop (0379c0b)
- frame: Alt+v from another pane opens the composer first (e91166d)
- install: every run of install.sh installs the newest commit on main (3c59863)
- composer: collapsed dictation shows its message and the draft's start (d3403f9)
- dictation, spell: smaller review fixes and line wrapping (a872458)
- acceptance: record the taller request panel (d0ef698)
- spell, run: survive a failed dictionary save, straight apostrophes, thread-bound [run] (05c208d)
- requests: keep the highlighted option in view and pin the last one (f875ca2)
- settings: server.hideWarning turns the server warning banner off (922babe)
- spell check in the composer: red underlines, right-click or Alt+s corrections, add/ignore (a0cd441)
- docs: lead with "terminal client (TUI) for T3 Code" for search (ddeb320)
- portable: read stderr before reporting a failed run (fa3b2c3)
- dictation: built-in mic recording via the server's speech service (7866642)
- context: top-right meter with Alt+u breakdown (9c7f112)
- keys: hide hints with Alt+i, attach files with Alt+a (1261105)

## Unreleased

- `messageTag` setting: optional tag in front of every message you send (`<from PC>`, `<from laptop SSH to PC>`), so the agent knows which machine you typed it on. Off by default.
- inline images: scrolling a Kitty image no longer leaves holes or flickers (it was re-uploaded on
  every scroll that cropped its top), and inside tmux the image is cleared when you switch to
  another session or window and redrawn when you come back, instead of staying on top of the
  other pane.
- themes: 12 new presets (`dark`, `dusk`, `lagoon`, `sand`, `catppuccin-mocha`, `catppuccin-latte`,
  `tokyo-night`, `gruvbox`, `nord`, `rose-pine`, `dracula`, `one-dark`) and `"preset": "auto"`,
  which picks `light` or `cyberdream` from the terminal's background color. Input placeholders now
  use the muted color instead of a fixed gray.
- rendered pages: with `TERCET_PAGE_SHOTS=1` and a terminal that can draw images, a page the
  agent rendered (T3's `html_render`) shows as a screenshot taken with headless chromium instead
  of only an `[open]` link. Off by default; Enter still opens the page itself in the browser.
- Video and audio opening over SSH follows the active client through the configured SSH-aware
  photo opener instead of launching the server's mpv. Explicit player templates keep their routing.
- settings: a key tercet does not know no longer stops startup. It is ignored and `tercet doctor`
  lists it with its line, so a settings file from a newer build still opens in an older one.
  Wrong types and values still stop startup.
- read aloud: `tercet readback setup` installs Kokoro into tercet's own data directory (asks first,
  about 354 MB, checks SHA-256) and `tercet readback status` reports what is missing. Without it,
  **[read]** says "Read aloud is not set up. Run `tercet readback setup`." and `tercet doctor` has
  a `read aloud` row. New `readback.home` setting; `KOKORO_HOME` and `KOKORO_PYTHON` still work.
  The old default of `~/Projects/Side/kokoro` is gone: set `readback.home` or `KOKORO_HOME` to
  keep using a setup you already have.

## tercet 0.1.0 (2026-11-12)

Works with T3 Code servers >=0.1.8 <0.2.0, tested on 0.1.8.

Changes:

- harden: remote images, token scope, flag errors (f011eb3)
- compat: gate on protocol, warn on version (6207b68)
- p10: gate 2 fixes (793d8bc)
- tercet: a terminal client for T3 Code (97844ef)
