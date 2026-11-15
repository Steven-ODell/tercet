# README demo recordings

`docs/media/demo.gif` (the original demo) has been removed from the tree; `demo.tape` remains.
To run `record-extended`, first restore the original opening GIF from git history, e.g.
`git show 7df0c26:docs/media/demo.gif > docs/media/demo.gif`, and delete it again afterwards.
The README uses `docs/media/demo-extended.gif`: the original animation followed by
real integrated-terminal, embedded-Neovim and external-tmux-editor operations.

Record the appended segment and assemble a candidate off-screen:

```bash
bgrun -t 8m -C /path/to/tercet tercet-demo -- scripts/demo/record-extended
```

The log prints a fresh output directory under /tmp. Requires VHS, ttyd, Chromium,
Bun, Neovim, tmux and Python 3. No T3 server, provider, token, network turn or real
workspace is used. The fixture enables real I/O only when TERCET_DEMO_WORKSPACE
is supplied by editor-session. Each take has a private tmux socket and a disposable
forecast.ts; the recorder checks that both Neovim edits were saved.

editor.tape invisibly replays the original tape's key sequence to reach its final
reply, then records only the new terminal/editor section. append-gif.py preserves
the original GIF's bytes through its last frame and gives appended frames their
own color palettes. It does not re-encode, change or speed up the original opening.

Before replacing demo-extended.gif, inspect the candidate, confirm the file saves
and check that every decoded opening frame and delay matches demo.gif. Keep the
old GIF. Copy the verified candidate to docs/media/demo-extended.gif. Neither
recording command publishes or uploads anything.

The older demo.tape and tmux/pyte record + render.py workflow are retained for the
original demo; running the old VHS tape writes docs/media/demo.gif, so do not use it to
regenerate this extended recording.
