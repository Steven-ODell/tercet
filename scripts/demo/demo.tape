# README demo, recorded with VHS (https://github.com/charmbracelet/vhs). Drives scripts/demo/app.tsx
# (made-up threads, no server, no token) with the same key order as scripts/demo/record.
# Regenerate from the repo root: vhs scripts/demo/demo.tape   (needs vhs, ttyd, chromium, bun)
# Output paths are relative to the cwd, so run it from the repo root. This overwrites the shipped
# docs/media/demo.gif (about 48 s). Images are the block rung: VHS's terminal has no Kitty/Sixel.
# Look at the frames before committing. The older tmux + pyte pipeline (scripts/demo/record) still works.
Output docs/media/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1250
Set Height 840
Set Padding 8
Set TypingSpeed 100ms
Set Framerate 20
Set Theme { "background": "#16181a", "foreground": "#ffffff" }

Hide
Type "cd $PWD && COLORTERM=truecolor XDG_CONFIG_HOME=$(mktemp -d) bun scripts/demo/app.tsx 2>/dev/null"
Enter
Sleep 3s
Show

# pick a thread and open it
Sleep 600ms
Type "j"
Sleep 300ms
Type "j"
Sleep 300ms
Enter
Sleep 2.2s

# move through the transcript
Ctrl+l
Sleep 400ms
Type "]"
Sleep 1.2s

# another thread: image, then the diff overlay
Alt+h
Sleep 300ms
Type "j"
Sleep 300ms
Enter
Sleep 2.3s
Type "j"
Sleep 300ms
Enter
Sleep 600ms
Alt+d
Sleep 800ms
Enter
Sleep 2.2s
Alt+c
Sleep 400ms

# palette
Ctrl+p
Sleep 500ms
Type "retry"
Sleep 800ms
Enter
Sleep 800ms

# reply
Ctrl+j
Sleep 300ms
Type "Looks good, ship it"
Sleep 1.2s
