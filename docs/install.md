# Installing tercet

tercet runs on [Bun](https://bun.com) and talks to a T3 Code server you already run. It is tested
on Linux and macOS with Bun 1.4.0. Windows is untested.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Steven-ODell/tercet/main/install.sh | sh
```

The script checks that `bun` is on PATH, and if it isn't it prints how to get it and stops. It
then runs `bun install -g github:Steven-ODell/tercet`, prints `tercet --version` and tells you if
Bun's global bin directory (`~/.bun/bin` by default) is missing from PATH. You can run that
command yourself instead of the script:

```bash
bun install -g github:Steven-ODell/tercet          # the latest commit on main
bun install -g github:Steven-ODell/tercet#v0.1.0   # a release tag
```

Then check the install:

```bash
tercet --version   # tercet's version and the T3 server versions it supports
tercet doctor      # server, token, settings, terminal, images and host commands
```

`tercet --version` prints two lines, for example:

```
tercet 0.1.0
T3 server: >=0.1.8 <0.2.0, tested on 0.1.8
```

## Update and remove

Bun remembers the commit a spec first resolved to, so running the same install again keeps the
old version. To update, install the new release's tag:

```bash
bun install -g github:Steven-ODell/tercet#v0.2.0
```

To move to the newest commit on main instead, clear Bun's cache in between (this clears the
whole cache, which Bun refills as needed):

```bash
bun remove -g tercet && bun pm cache rm && bun install -g github:Steven-ODell/tercet
```

`bun remove -g tercet` on its own uninstalls tercet. Your settings in `~/.config/tercet` stay.

## What gets installed

The global install is `dist/tercet.js`, one bundled file with tercet, the vendored T3 packages,
React (production build), `effect` and `@xterm/headless` inlined, plus a single runtime dependency,
`@opentui/core`. That package brings the native renderer for your platform as an optional
dependency (`@opentui/core-linux-x64`, `@opentui/core-darwin-arm64` and so on). The install is
14 packages and about 74 MB, most of it TypeScript, which OpenTUI's `bun-ffi-structs` lists as a
peer dependency. Nothing is compiled and Bun runs no install scripts for it.

## From a checkout

```bash
git clone https://github.com/Steven-ODell/tercet && cd tercet
bun install
bun src/main.tsx            # or: bun run dev
```

A checkout runs on React's development build, and `tercet --version` says `(development build)`.
That build is slower and holds more memory on very large threads (see `docs/performance.md`);
tests need it, because `act()` only exists there.

## For maintainers

- `bun run build` (`scripts/build`) rewrites `dist/tercet.js`. It is committed, because a global
  install from GitHub cannot build anything itself. Rebuild and commit it with every change
  under `src/` or `vendor/`; `bun run check` and CI fail on a stale bundle.
- `scripts/release X.Y.Z` sets the version in `package.json`, rebuilds the bundle, runs
  `bun run check`, prepends the notes to `CHANGELOG.md`, commits `release vX.Y.Z` and tags it.
  It pushes nothing and prints the `git push` and `gh release create` commands to run.
  `--dry-run` prints the notes only.
- CI (`.github/workflows/ci.yml`) runs typecheck, tests and the bundle check on Ubuntu and
  macOS. Its canary job re-vendors upstream T3 Code's `main` and typechecks against it, daily
  and on every push; it may fail without failing the run.

## Dictation capture

On Linux tercet picks the first installed recorder: `pw-record` (PipeWire), `parecord`
(PulseAudio), `arecord` (ALSA), `ffmpeg` with PulseAudio input, then SoX `rec`. On macOS it
tries ffmpeg with AVFoundation input, then SoX `rec`; microphone permission is required.
Install a tool with your system's package manager. `tercet doctor` reports the selected tool.
The first installed tool must have access to a working default microphone; capture failures
are reported without silently switching devices. Very short recordings can contain no audio,
particularly with buffered SoX capture; retry with a longer phrase.

T3's server must also have a speech model configured through its web app, Settings → Voice.
This is a separate prerequisite from the recorder. No Voxtype or cloud API key is needed.
Linux capture and sandbox transcription have been verified; macOS capture remains untested.
