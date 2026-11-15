# Changelog

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
