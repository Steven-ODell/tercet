# Trying tercet by hand

A checklist for checking a tercet install against your own T3 Code server, or a throwaway one.
Each item says what should happen. If one doesn't, open an issue with the item and the output of
`tercet doctor`.

## A throwaway server

To try tercet without touching your real T3 data, start the sandbox from a checkout. It installs
the pinned `t3` release from npm into a temporary home, with one made-up project and a free model,
on port 3775:

```bash
scripts/sandbox.sh up        # prints export TERCET_SANDBOX_DIR=...; run that line
scripts/sandbox.sh token
bun src/main.tsx --url http://127.0.0.1:3775 --token-file "$TERCET_SANDBOX_DIR/token"
scripts/sandbox.sh down
```

`sandbox.sh` uses `bgrun` to run the server; without it, start `t3 serve` yourself with a
temporary `HOME`, `--base-dir` and `--port`, as the script does.

## Checklist

1. `tercet --version` prints a version and the T3 versions it supports.
2. `tercet doctor` finds the server, says `ok` on the server and token lines, and its `images`
   line names a method your terminal can draw.
3. `tercet` opens on the thread list. `j`/`k` move, Enter opens a thread, the mouse can click
   rows.
4. `Ctrl+n` makes a new thread; typing a message and Enter sends it, and the answer streams in.
5. `Alt+m` opens the model picker. Typing filters it at once, even fast; Enter picks.
6. `Ctrl+p` jumps to another thread by name, and the thread list highlights that thread.
7. A message with a code block shows `[copy]` on the block. Copy puts the block on your
   clipboard (or, over SSH, on the clipboard of the computer you type on, if your terminal
   allows OSC 52).
8. An image attachment draws as an image, colored blocks or a placeholder, never as an empty
   box. `"media": { "protocol": "none" }` in settings turns every image into a placeholder.
9. `Alt+d` shows the thread's diff, `Alt+f` its files.
10. `?` shows the keys, and they match `tercet keys`.
11. A setting with a typo (for example `"theme": { "colour": "red" }`) stops startup with one
    line naming the file, line and key.
12. `Ctrl+c` twice quits, and the terminal is back to normal: cursor visible, no mouse escape
    codes when you click, no leftover images.
13. With `"icons": "ascii"`, no character outside ASCII shows in the frame.
14. With no `commands` in settings there is no [tmux], [run] or [send] button anywhere.

## Built-in dictation

Use an isolated server with a speech model installed explicitly through Settings → Voice.
With `commands.dictation` absent, press Alt+v, speak a phrase, then press again. Recording
changes to Transcribing, followed by editable text at the cursor; nothing sends automatically.
Repeat while switching threads and while editing the original draft during transcription:
text must land only in the originating draft and preserve those edits. Press mic during
transcription or Esc in the composer to cancel; quitting must release the microphone.

Check missing model, no recorder, denied microphone, disconnected server and read-only mode.
Over SSH automatic capture must be unavailable with an explanation that no mic is forwarded.
An explicit external command must retain its previous state-only behavior.

Automated coverage uses fake capture/transport plus a real child process for recorder cleanup.
A synthetic spoken phrase was transcribed successfully by the isolated v0.1.8 server's local
Parakeet model on Linux. No speaker playback was used. macOS capture is untested.

## Embedded editor

Run the server-free fixture on a disposable directory (never your real source files):

```bash
trial=$(mktemp -d /tmp/tercet-editor-trial.XXXXXX)
printf 'before\n' > "$trial/trial file.txt"
bun scripts/files-preview-fixture.tsx "$trial"
```

Enter opens the file, `e` embeds Neovim. `i` inserts text; Esc, `:wq`, Enter saves and quits;
Enter returns to Files and should show the saved text. `:q` with unsaved edits must show the
editor's native warning. `:q!` discards them. This fixture quits with Ctrl+c.

In the full app against the throwaway server, also verify `Alt+h` returns to chat,
`Alt+c` hides, `Alt+r` resumes the same buffer, and changing threads never moves the session
to another workspace. Quit Tercet from chat while the editor runs: it must ask you to quit
the editor first. Resize while editing. Test `Ctrl+p`, `Ctrl+c`, Esc and bracketed paste:
none may trigger chat actions. Clicking Edit here and Back must work.
The existing `o` external command must retain its configuration.

Automated tests cover path quoting, real Neovim save/quit, resize, original workspace pinning,
focus/input, hide/resume, quit protection, remote rejection and read-only blocking.
The Neovim test skips when Neovim is absent; macOS PTY behavior still needs hands-on validation.

For the full conversation/files/editor flow from this checkout, use an isolated server and
settings directory (no installed launcher or daily settings change):

```bash
export TERCET_SANDBOX_DIR=$(mktemp -d /tmp/tercet-editor-server.XXXXXX)
scripts/sandbox.sh up
scripts/sandbox.sh token > /dev/null
printf 'before\n' > "$TERCET_SANDBOX_DIR/work/demo-app/trial.txt"
XDG_CONFIG_HOME="$TERCET_SANDBOX_DIR/config" bun dist/tercet.js --url http://127.0.0.1:3775 --token-file "$TERCET_SANDBOX_DIR/token"
```

Create a thread with Ctrl+n in demo-app, then Alt+f → trial.txt → Enter → e. No agent turn is
needed. After quitting both editor and Tercet, stop this server with `scripts/sandbox.sh down`.

External editor follow-up: with VISUAL/EDITOR unset and no editor setting, o must explain setup.
Set VISUAL to a terminal editor: o should launch a separate terminal window. Set it to code or
configure an absolute VS Code executable with editorMode direct: o should open the selected
file in that GUI. A nonexistent executable must show full-path linking guidance.
Set launchers.editor to nvim and editorMode to tmux: from an attached tmux client, o opens a
new session (not a window), :wq saves and returns to the original Tercet session. A focused
Tercet Files preview must refresh after an external save. Custom commands.editor still wins.
The private-socket external-editor-rig.test.ts verifies real Neovim save and client return.

If your hands-on sandbox is using 3775, run the full check on the second reserved test port:
`TERCET_SANDBOX_PORT=3776 bun run check`. Only 3775 and 3776 are accepted; the daily port
is never a sandbox target. This leaves the interactive sandbox and its editor sessions alone.

## README recording

The README now uses docs/media/demo-extended.gif; docs/media/demo.gif was preserved unchanged then (it has since been removed).
See scripts/demo/README.md for the off-screen VHS workflow. The new segment demonstrates real
shell output, an embedded Neovim save, an external tmux Neovim save and return to chat, using
only a disposable file. The original animation is appended without decoding or re-encoding it.
Final verification compared every decoded frame and delay against both source GIFs: all
474 original frames and 551 appended frames match exactly (41 seconds total).

### Git worktree workflow rig (step 3)

`bash scripts/test-git-workflows.sh` starts an off-screen/muted stock 0.1.8 server on
3776 with disposable HOME/data/repositories and a scoped token. It tests branch refusal
and source edit preservation, then creates a managed worktree through the workflow,
reads durable branch/path binding from the server, and creates a new thread using that
workspace with no provider runs. It verifies the real Git branch at the returned cwd and
that the managed path stays under its disposable root. Server stops on exit; 3775 and daily
3773/data remain untouched. POSIX-only process rig; portable controller/renderer tests:
`bun test src/client/git-workflows.test.ts src/client/git-workflows.test.tsx`.

## PR inspection and review (Git workflow step 4)

`bun test src/client/git-workflows.test.ts src/client/git-workflows.test.tsx` includes
simulated PR detail/check/discussion, exact host/account/repository/number/body/verdict,
link/watch commands, creation intent, failure recovery/draft retention, duplicate write
locking through close, read-only mutation gates and keyboard/mouse confirmation/diff tests.
No live GitHub writes. Alt+w opens Pull requests; Alt+g opens Branches/Worktrees.
Full validation remains `bun run build` then `TERCET_SANDBOX_PORT=3776 bun run check`.
Local comparison is explicitly labeled; remote full diff/history use the host URL.


## Transcript links

1. Start the local bundle with `bun ./dist/tercet.js`. Open a response containing
   `**[Textual](https://github.com/Textualize/textual)**`, a heading containing a link,
   and a bare URL. Each link should be blue and underlined; click its label or wrapped
   continuation to open it. Drag over it to select without launching anything.
2. Set `theme.link`, `launchers.browser`, `launchers.browserProfile` and
   `launchers.browserLocation` as described in [settings](docs/settings.md#transcript-links-and-browser),
   restart and click again. Confirm the chosen browser and profile receive the exact URL.
3. Over SSH, choose `client` and confirm it launches on the attached client with reverse
   SSH access configured. With no reachable client, confirm a copy notice appears. File
   opening should continue using the ordinary opener.

## Phone layout

Run a sandbox (`scripts/acceptance.sh --keep`) and start tercet in a private tmux sized like
the phone, for example `tmux -L phone new -x 50 -y 40`, then `-x 110 -y 20`
(`TERCET_LAYOUT` unset).

1. At 50x40 tercet opens on Threads full width with `[Threads] [Chat]` tabs; long thread names
   wrap whole and no label is cut. Tapping a thread opens Chat.
2. Tap the composer, type, send: the reply streams above the composer.
3. Tabs switch views by tap; Esc walks Threads, Chat, then the side panel.
4. `[Model]` opens the picker full screen; type to filter and tap a model to apply it.
5. `[Menu]` lists every command; Files, Diff and Terminal are reachable (at 20 rows the sheet
   scrolls).
6. `tmux resize-window -y 20` (the keyboard coming up): the composer, its draft and `[send]`
   stay visible, and the view does not change.
7. At 110x20 the columns stay, the header rows are gone and one action bar row remains.
8. `TERCET_LAYOUT=full` at 50x40 gives the desktop frame; `TERCET_LAYOUT=compact` at 120x40
   gives the compact one, pickers included.

