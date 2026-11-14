# Appended feature segment. The archived demo.gif supplies the unchanged opening sequence.
# Use scripts/demo/record-extended; do not overwrite the original demo.tape or demo.gif.
Output "/tmp/tercet-editor-segment.gif"

Set Shell bash
Set FontSize 16
Set Width 1250
Set Height 840
Set Padding 8
Set TypingSpeed 100ms
Set Framerate 20
Set Theme { "background": "#16181a", "foreground": "#ffffff" }

Hide
Type "scripts/demo/editor-session"
Enter
Sleep 3s

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

Show
Sleep 500ms

# Read the disposable file in the integrated shell.
Alt+j
Sleep 700ms
Type "cat forecast.ts"
Enter
Sleep 1.5s

# Open the same file and save a real change in the embedded editor.
Alt+h
Alt+f
Sleep 500ms
Enter
Sleep 600ms
Type "e"
Sleep 900ms
Type "/metric"
Enter
Type "ciwimperial"
Escape
Sleep 600ms
Type ":wq"
Enter
Sleep 700ms
Enter
Sleep 700ms

# External Neovim opens in a separate tmux session and returns on quit.
Enter
Sleep 700ms
Type "o"
Sleep 1s
Type "/Phoenix"
Enter
Type "ciwLondon"
Escape
Sleep 600ms
Type ":wq"
Enter
Sleep 1s

# Show both saved edits in the integrated terminal, then regain chat focus.
Alt+h
Alt+j
Sleep 700ms
Type "cat forecast.ts"
Enter
Sleep 2s
Alt+h
Sleep 1s
