# Installing tercet

tercet talks to a T3 Code server you already run. There are three ways to get it, and they end
up in the same place: a `tercet` command. It is tested on Linux and macOS (Bun 1.4.0); native
Windows support is experimental, see [Windows setup and verification](windows.md).

| Way                      | Needs         | Best when                                          |
| ------------------------ | ------------- | -------------------------------------------------- |
| 1. Prebuilt binary       | nothing       | you want it working in a minute, no Bun            |
| 2. Bun                   | Bun 1.4.0+    | you already have Bun, or want the newest `main`    |
| 3. Build it from a clone | Bun 1.4.0+, git | you want to read, patch or package it yourself   |

Then check the install, whichever way you took:

```bash
tercet --version   # tercet's version and the T3 server versions it supports
tercet doctor      # server, token, settings, terminal, images and host commands
```

`tercet --version` prints two lines, for example:

```
tercet 0.1.0
T3 server: >=0.1.8 <0.2.0, tested on 0.1.8
```

## 1. Prebuilt binary (no Bun)

One file holding tercet, the Bun runtime and the terminal renderer. Releases carry a binary for
Linux and macOS (x64 and arm64) and Windows (x64), with a `SHA256SUMS` file.

```bash
curl -fsSL https://raw.githubusercontent.com/Steven-ODell/tercet/main/install.sh | sh
```

The script picks the file for your machine, downloads it, checks it against `SHA256SUMS` and
refuses to install on a mismatch, then puts `tercet` in `~/.local/bin` and prints its version.
It changes nothing else. Options (pass them after `sh -s --` when piping):

```bash
curl -fsSL https://raw.githubusercontent.com/Steven-ODell/tercet/main/install.sh | sh -s -- --version v0.1.0 --dir ~/bin
```

On Windows, in PowerShell (installs to `%LOCALAPPDATA%\Programs\tercet` and adds it to your user PATH):

```powershell
irm https://raw.githubusercontent.com/Steven-ODell/tercet/main/install.ps1 | iex
```

Or download the file for your platform from the
[releases page](https://github.com/Steven-ODell/tercet/releases), check it against `SHA256SUMS`
yourself, `chmod +x` it and put it on your PATH. Update with `tercet upgrade` (`--check` only says
whether a newer release exists). The binary ignores `.env` and `bunfig.toml` in the folder you
run it from.

## 2. With Bun

```bash
curl -fsSL https://raw.githubusercontent.com/Steven-ODell/tercet/main/install.sh | sh -s -- --bun
```

The script checks that `bun` is on PATH, and if it isn't it prints how to get it and stops. It
looks up the newest commit on main and runs `bun install -g github:Steven-ODell/tercet#<that
commit>`, then prints the version and tells you if Bun's global bin directory (`~/.bun/bin` by
default) is missing from PATH. You can run Bun yourself instead of the script:

```bash
bun install -g github:Steven-ODell/tercet          # the latest commit on main
bun install -g github:Steven-ODell/tercet#v0.1.0   # a release tag
```

On Windows: `.\install.ps1 -Method bun`, or the `bun install -g` line above.

## 3. Build it from a clone

```bash
git clone https://github.com/Steven-ODell/tercet && cd tercet
bun install
bun run build                 # writes dist/tercet.js, the bundle the Bun install runs
bun link                      # puts `tercet` on your PATH, pointing at this checkout
```

Or compile your own standalone binary, the same way the releases are made:

```bash
bun scripts/build-binary      # writes dist/bin/tercet-<os>-<arch>
cp dist/bin/tercet-* ~/.local/bin/tercet
```

To only try it without installing anything, `bun src/main.tsx` (or `bun run dev`) runs the
source. A checkout runs on React's development build, and `tercet --version` says `(development
build)`. That build is slower and holds more memory on very large threads (see
`docs/performance.md`); tests need it, because `act()` only exists there.

## Update and remove

| Installed with | Update                                           | Remove                                      |
| -------------- | ------------------------------------------------ | ------------------------------------------- |
| Binary         | `tercet upgrade`, or run the install script again | delete `~/.local/bin/tercet`                |
| Bun            | run the install script again with `--bun`        | `bun remove -g tercet`                      |
| A clone        | `git pull && bun install && bun run build`       | `bun unlink` in the clone, then delete it   |

Running `bun install -g github:Steven-ODell/tercet` again does not update: Bun remembers the
commit that spec first resolved to and keeps the old version. Name a commit or a tag instead,
which Bun always fetches:

```bash
bun install -g github:Steven-ODell/tercet#$(git ls-remote https://github.com/Steven-ODell/tercet.git refs/heads/main | cut -f1)
bun install -g github:Steven-ODell/tercet#v0.1.0   # or a release tag
```

Your settings in `~/.config/tercet` stay through any of these.

## What gets installed

The binary is the whole program in one file (about 110 MB, most of it the Bun runtime).

The Bun install is `dist/tercet.js`, one bundled file with tercet, the vendored T3 packages,
React (production build), `effect` and `@xterm/headless` inlined, plus a single runtime dependency,
`@opentui/core`. That package brings the native renderer for your platform as an optional
dependency (`@opentui/core-linux-x64`, `@opentui/core-darwin-arm64` and so on). The install is
14 packages and about 74 MB, most of it TypeScript, which OpenTUI's `bun-ffi-structs` lists as a
peer dependency. Nothing is compiled and Bun runs no install scripts for it.

## For maintainers

- `bun run build` (`scripts/build`) rewrites `dist/tercet.js`. It is committed, because a global
  install from GitHub cannot build anything itself. Rebuild and commit it with every change
  under `src/` or `vendor/`; `bun run check` and CI fail on a stale bundle.
- `scripts/release X.Y.Z` sets the version in `package.json`, rebuilds the bundle, runs
  `bun run check`, prepends the notes to `CHANGELOG.md`, commits `release vX.Y.Z` and tags it.
  It pushes nothing and prints the `git push` command to run. `--dry-run` prints the notes only.
- Pushing the tag starts `.github/workflows/release.yml`: it builds `scripts/build-binary` on a
  native runner for each platform, starts every binary, writes `SHA256SUMS` and publishes the
  GitHub release with the tag's message (the changes and the T3 versions it was tested on) as
  its notes.
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
