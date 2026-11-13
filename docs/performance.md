# Performance

Measured 2026-11-11 (P7) on the author's PC (Arch Linux, Bun 1.4.0). The fixture is a generated thread:
every ten items are one turn (a user message, three commands, reasoning, a file change, a tool
call, a todo list, an assistant reply with a list and a code block, a notice), so the transcript
holds about 2.2 rows per item at 160 columns.

The bound: memory stays under about 500 MB and scrolling never stalls.

## How to measure

- Headless, latency: `bun scripts/perf-large-thread.tsx 20000` prints one JSON line. It draws
  the real frame with opentui's test renderer (layout and drawing, no terminal writes), presses
  keys with the transcript focused and appends items one at a time. React runs its development
  build here, because the test renderer needs `act()`.
- Real terminal, memory: `bun scripts/perf-large-thread.tsx --live 20000 OUT` in a private
  `tmux -L` server. It writes RSS to `OUT` after the first frame and on `!`; `+` streams 100
  items at 30 Hz and then writes again.
- `src/perf.test.ts` runs a small headless copy at 5,000 items in `bun run check` with loose
  bounds (p99 under 100 ms per key, 150 ms per streamed item), and checks that the row cache's
  append path draws the same rows as a full rebuild.

## Numbers

Scrolling, headless (ms per key, press to drawn frame):

| Items  | `j` p50 / p99 | `k` p50 / p99 | Ctrl+u p50 / p99 | `gg` / `G` p99 | First frame |
| ------ | ------------- | ------------- | ---------------- | -------------- | ----------- |
| 5,000  | 1.5 / 2.7     | 1.7 / 3.5     | 3.0 / 3.8        | 3.7            | 191 ms      |
| 20,000 | 2.8 / 5.9     | 3.1 / 6.9     | 5.3 / 7.8        | 6.2            | 455 ms      |

Streaming, headless (ms per appended item, p50 / p99):

| Items  | Before P7     | After P7    |
| ------ | ------------- | ----------- |
| 5,000  | 19.6 / 34.7   | 8.7 / 14.5  |
| 20,000 | 74.3 / 100.9  | 22.7 / 35.7 |

Memory, real renderer in tmux (RSS in MB):

| Items  | React       | First frame | After scrolling | After streaming 100 items |
| ------ | ----------- | ----------- | --------------- | ------------------------- |
| 5,000  | production  | 190         | 219             | 245                       |
| 20,000 | production  | 259         | 279             | 379                       |
| 20,000 | development | 261         | 281             | 535                       |

Headless RSS reads higher (547 MB at 20,000 after streaming) while the JS heap after a full GC is
106 MB. The gap is allocator headroom from the test renderer and `act()`, so the tmux run is the
number to trust for memory.

## What P7 changed

- `workMessages` (`src/client/work-log.ts`) rebuilt every work entry and group summary on each
  projection update, about 50 ms at 20,000 items. It now remembers both per item object (a
  `WeakMap`; projection updates keep unchanged items by identity), so a new item costs its own
  work: 5.6 ms for the whole call at 20,000.
- `MarkdownCache.rows` (`src/client/markdown.ts`) rebuilt the whole row list whenever the message
  count changed. Appended messages now keep the measured rows before the old tail and measure only
  the tail and the new messages: 11 ms to 4.6 ms at 20,000.
- React's development build holds much more memory while a huge thread streams (535 MB against
  379 MB). Bun fixes `process.env.NODE_ENV` when it transpiles, so tercet cannot switch builds at
  runtime. Since P8 the installed bundle (`dist/tercet.js`, built by `scripts/build`) defines
  `NODE_ENV=production`. A checkout run with `bun src/main.tsx` stays on the development build.

Still O(n) per update: building the work-log message list (one pass, cheap per item) and the
row-list copy. At 20,000 items that is about 23 ms per streamed item headless, under a 30 Hz
frame. Not fixed in P7.
