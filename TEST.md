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
