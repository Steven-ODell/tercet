# Contributing

Bug reports with `tercet doctor` output (it prints no tokens) are the most useful thing you can
send. For code, open an issue first if the change is bigger than a fix.

## Set up

```bash
git clone https://github.com/Steven-ODell/tercet && cd tercet
bun install
bun run dev        # run from source against your local T3 server
```

## Before a pull request

```bash
bun run check      # typecheck, tests, bundle, acceptance; the last line has the exit status
bun run build      # after any change under src/ or vendor/: rewrites dist/tercet.js
```

`dist/tercet.js` is committed, because a global install from GitHub cannot build anything.
Commit it with your change; CI fails on a stale bundle. CI builds with Bun 1.4.0, and another
Bun can produce different bytes.

The acceptance run (`scripts/acceptance.sh`) starts a throwaway upstream T3 server on port 3775
with a free model, drives tercet in a private tmux server and compares the screens with
`acceptance/*.txt`. It needs tmux and Python 3, and runs its jobs through `bgrun`, the
maintainer's background-job wrapper; `bun run check` skips it when `bgrun` is missing. After an
intended UI change, `scripts/acceptance.sh --record` rewrites the screens: read the diff before
committing it.

## Style

- Code is formatted with Prettier at width 100. Format only the lines you touch:
  `bun x prettier --print-width 100 --object-wrap collapse --write FILE`.
- No new dependency without a one-line reason in `docs/decisions.md`.
- Nothing personal in `src/`: machine names, paths and tools belong in a settings template.
- Docs use plain words and sentence-case headings.

## Vendored T3 code

`vendor/t3/` is a copy of the parts of T3 Code tercet imports, pinned to the tag in
`vendor/t3/UPSTREAM`. Don't edit it by hand: `scripts/sync-upstream` refreshes it, and importing
a new `@t3tools/*` file means running it again.

## Demo

`scripts/demo/record-extended` records the README GIF (`docs/media/demo-extended.gif`) from
`scripts/demo/app.tsx`, which shows made-up threads with no server; `scripts/demo/README.md` has the
steps. It needs `vhs`, `ttyd`, chromium and bun, and shows nothing on screen. VHS's terminal has no Kitty or
Sixel, so images render as blocks. `scripts/demo/record` is the older tmux pipeline (needs tmux and
`uv`). Look at every frame before committing a new GIF.
