# Native Windows (experimental)

Tercet now has native Windows integrations; WSL is not required. Use Windows 10/11 with
Windows Terminal, Bun 1.4.0 or newer, and the supported T3 server on the same machine.
Install/configure T3 and at least one provider first, as on Linux and macOS.

This implementation has Linux regression coverage. A native Windows CI job is prepared,
but has not been run during development on the Linux workstation. Windows Terminal mouse,
keyboard, resizing and exit restoration still need a hands-on trial. Do not describe Windows
as fully verified until both checks pass. Wine is not a substitute for that trial.

## Installation and updates

Install Bun using its official Windows instructions: https://bun.com/docs/installation.
Then run `bun install -g github:Steven-ODell/tercet` in PowerShell. For updates, download
`install.ps1` from the repository and run it in PowerShell; it resolves the newest commit
before installing, avoiding Bun's cached GitHub revision. It requires no administrator rights
and does not change your execution policy or PATH. `TERCET_SOURCE` can select a tag/commit.
Open a new terminal if Bun's global bin directory was just added to PATH.

Run `tercet doctor`, then `tercet`. The local `t3` command must also be on PATH for automatic
authentication. Settings are in `%USERPROFILE%\.config\tercet\settings.json`, unless an
absolute `XDG_CONFIG_HOME` overrides that location. Use forward slashes in JSON paths to
avoid escaping each backslash.

## Platform behavior

- Clipboard text and images, file dialogs and the default URL/file opener use Windows
  PowerShell and Windows APIs. No Unix clipboard tools or extra PowerShell installation.
- External terminal editors open in a separate PowerShell console. GUI editors launch
  directly; configure their real `.exe`, including an absolute path if needed.
- The embedded editor uses Bun's native ConPTY support. Install Neovim or configure
  `commands.embeddedEditor`; Windows does not include `vi` by default.
- Images fall back to colored blocks when a terminal does not advertise Kitty/Sixel support.
- A configured `commands.run` must use a Windows executable/script. Linux examples using
  `foot`, `bash` or `tmux` are not Windows commands. Templates never interpolate transcript
  text into PowerShell or cmd source.
- Built-in automatic microphone discovery currently supports Linux/macOS. On Windows,
  `dictation.recorder` can configure a local recorder producing 16 kHz mono float32 PCM;
  `commands.dictation` remains available. Automatic Windows microphone setup is unverified.
- Read aloud: `tercet readback setup` keeps the Kokoro files in `%LOCALAPPDATA%\tercet\kokoro`
  (the venv's Python is `.venv\Scripts\python.exe`). Set `readback.home` or `KOKORO_HOME` to use
  another folder; forward slashes are fine in settings. Setup and playback are tested with
  Windows paths only, not on a real Windows machine.
- Branch/PR/worktree operations use T3 server RPCs. Workspace paths are server paths, and must
  remain intact, including drive letters, spaces and UNC shares. Windows does not add GitHub
  credentials; set those up through T3 as usual.

## Automated coverage

`.github/workflows/windows.yml` runs on an actual Windows GitHub runner:

1. Install dependencies and typecheck the shared source.
2. Test native PowerShell data handling, clipboard text/PNG, drive-letter attachment paths,
   embedded PTY input/resize/save/exit and shared keyboard/mouse renderer behavior.
3. Run Git workflow tests present in the checkout, including Windows/UNC workspace fixtures.
4. Check the committed bundle and install a local staged package through `install.ps1`,
   then invoke the globally installed `tercet` executable.
5. Download pinned stock T3 0.1.8, start it against a disposable repository/data directory,
   issue a test token and reach a live authenticated snapshot. No provider turns, PR posts
   or real repository changes are involved.

Linux/macOS CI retain their full suite, including POSIX shell stubs. Windows runs the native
suite and selected shared tests; it does not claim coverage of those POSIX-only rigs.

Manual acceptance still needs Windows Terminal: start Tercet; navigate/click panes; paste
multiline text and an image; attach a file from a directory with spaces/Unicode; resize; edit
and save; open a URL; quit and confirm the prompt and cursor recover. Test branch/worktree
switches and PR views once the Git workflow loop is integrated. Use a disposable repository;
posting a GitHub review is not required for this trial.
