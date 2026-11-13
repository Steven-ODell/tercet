# Images and video

Attachments on a message (screenshots, images, video, audio, any other file) and images or
video linked in markdown show as cards in the transcript. tercet draws each card with the first
method that works in your terminal, so a terminal without graphics still gets something useful.

## How an image is drawn

| Method   | What you see                                               | Picked by `auto` when                                           |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `kitty`  | the real image, through the Kitty graphics protocol        | the terminal answers the Kitty query; in tmux, a Kitty-type one |
| `sixel`  | the real image, as Sixel                                   | the terminal lists Sixel in its device attributes, outside tmux |
| `blocks` | the image in colored block characters                      | nothing better answered                                         |
| `none`   | a placeholder: name, size in pixels or duration, file size | only by hand, or with `"icons": "ascii"`                        |

Every card has `[open]`, which opens the file with your opener or player.

Terminals with Kitty graphics include kitty, Ghostty and WezTerm; foot is one with Sixel.
Everything else gets blocks, which work in any terminal with 256 colors or true color.

## Detection

At startup, before the screen is drawn, tercet sends the terminal a Kitty graphics query and a
Device Attributes request and waits for the answer, 300 ms at most. Answers win. `TERM_PROGRAM`,
`KITTY_WINDOW_ID` and `TERM` count only when the terminal says nothing.

Inside tmux the answer would come from tmux, not your terminal. tercet asks tmux instead: is
`allow-passthrough` on, and what is the outer terminal's name. With passthrough on and a Kitty
type terminal outside, images go through. With it off they fall back to blocks, and the first
image puts the fix on the status line once:

```
set -g allow-passthrough on
```

Sixel is never picked inside tmux. An outer terminal tercet does not recognize gets blocks,
because a Kitty image that nobody draws leaves an empty box.

`tercet doctor` prints the result on its `images` line, with the reason.

## Choosing by hand

```jsonc
{ "media": { "protocol": "blocks" } } // "auto" (default), "kitty", "sixel", "blocks" or "none"
```

Any value but `auto` skips detection. Use it when a terminal answers the queries but then draws
nothing or garbage. `"none"` gives placeholders everywhere.

## Video and audio

With `ffmpeg` installed, a video card shows the first frame and the duration. Without it, the
card is a placeholder with the name and size. Enter or `[open]` plays it with
`launchers.player`, else `mpv`, else the opener.

```jsonc
{ "launchers": { "player": ["mpv", "--loop"] }, "media": { "video": "terminal" } }
```

With `"video": "terminal"` and `mpv` installed, tercet steps aside and mpv plays inside the
terminal (`--vo=kitty`, `sixel`, or `tct` in tmux and on the blocks method) until you quit it.

Audio works like video without a frame. Other files show a placeholder and open with the opener.
A tool that is missing removes its action; it never shows an error on the card.

## Limits

- Sixel output comes from OpenTUI and has not been checked on a real Sixel terminal yet.
- Over SSH, images draw in the terminal you type on, so that terminal decides the method.
