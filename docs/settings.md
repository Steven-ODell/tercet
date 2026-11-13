# Settings

tercet reads one file: `$XDG_CONFIG_HOME/tercet/settings.json`, or
`~/.config/tercet/settings.json` when `XDG_CONFIG_HOME` is unset. Without the file tercet runs on
defaults and prints one line pointing here and to `tercet doctor`.

The file is JSON with comments: `//` and `/* */` comments and trailing commas are allowed. Every
key is optional. An unknown key or a wrong type stops startup with one line that names the file,
the line and the key (wrapped here, one line on screen):

```
tercet: settings error in /home/you/.config/tercet/settings.json:3: theme.colour: unknown key;
theme takes preset, accent
```

Command-line flags (`--url`, `--base-dir`, `--token-file`) win over the file. See
[Flags](#flags).

## Example

```jsonc
{
  "server": {
    // The T3 server. Without it tercet reads <baseDir>/userdata/server-runtime.json,
    // then falls back to http://127.0.0.1:3773.
    "url": "http://127.0.0.1:3773",
    // "~/" is your home; other relative paths are relative to this directory.
    "tokenFile": "~/.config/tercet/token",
    "baseDir": "~/.t3",
    // Start on a server with another protocol or no version (same as --ignore-version).
    "ignoreVersion": false,
  },
  "defaults": {
    // New threads start with this model when an enabled provider offers it.
    "provider": "codex",
    "model": "gpt-5.5",
    "mode": "full-access",
    "sendShortcut": "enter",
    "favorites": [{ "provider": "codex", "model": "gpt-5.5" }],
    "sidebarWorkingShelf": false,
  },
  "theme": { "preset": "cyberdream", "accent": "#b07cf5" },
  // Rebind commands by name; "none" unbinds. `tercet keys` prints the result.
  "keys": { "palette": "Ctrl+k", "focusUp": "Alt+k" },
  // "nerd" needs a Nerd Font; "ascii" draws nothing outside ASCII.
  "icons": "unicode",
  "launchers": {
    "terminal": ["foot", "-D", "{cwd}"],
    "editor": "nvim",
    "player": ["mpv"],
  },
  "media": { "protocol": "auto", "video": "player" },
  // Optional actions. A command that is not here has no button, key or palette entry.
  "commands": {
    "tmux": ["tmux", "send-keys", "-t", "work", "-l", "{text}"],
    "send": ["kdeconnect-cli", "--share", "{path}"],
  },
  // More clipboards, each with a button and an optional capital key.
  "targets": {
    "desk": {
      "copy": ["ssh", "desk", "wl-copy", "--type", "{mime}"],
      "key": "D",
    },
  },
}
```

## Setting keys

| Key                                                   | Type                                                            | Default                                    | Read from |
| ----------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ | --------- |
| `server.url`                                          | http(s) origin                                                  | runtime file, then `http://127.0.0.1:3773` | now       |
| `server.tokenFile`                                    | path                                                            | `<settings dir>/token`                     | now       |
| `server.baseDir`                                      | path                                                            | `~/.t3`                                    | now       |
| `server.ignoreVersion`                                | true or false                                                   | `false`                                    | now       |
| `defaults.provider`                                   | provider instance id                                            | any                                        | now       |
| `defaults.model`                                      | model slug                                                      | the thread's or project's model            | now       |
| `defaults.mode`                                       | `approval-required`, `auto-accept-edits`, `auto`, `full-access` | per provider                               | now       |
| `defaults.sendShortcut`                               | `enter`, `mod-enter`, `mod-enter-multiline`                     | `enter`                                    | now       |
| `defaults.favorites`                                  | list of `{ provider, model }`                                   | `[]`                                       | now       |
| `defaults.sidebarWorkingShelf`                        | boolean                                                         | `false`                                    | now       |
| `theme.preset`, `theme.accent`                        | `cyberdream`, `light`, `ansi`; `#rrggbb`                        | `cyberdream`, its own accent               | now       |
| `keys`                                                | command name to key                                             | built-in keys                              | now       |
| `icons`                                               | `nerd`, `unicode`, `ascii`                                      | `unicode`                                  | now       |
| `launchers.terminal`, `.editor`, `.opener`, `.player` | command template                                                | see below                                  | now       |
| `media.protocol`                                      | `auto`, `kitty`, `sixel`, `blocks`, `none`                      | `auto`                                     | now       |
| `media.video`                                         | `player`, `terminal`                                            | `player`                                   | now       |
| `commands.<name>`                                     | command template                                                | none                                       | now       |
| `targets.<name>`                                      | `{ copy, key? }`                                                | none                                       | now       |

"Read from" is the build step that starts using a key. Keys for later steps are already checked,
so a typo shows up now rather than later.

A token file you name in `server.tokenFile` or `--token-file` is yours: tercet reads it but never
issues a new token into it or changes its permissions.

The default token file holds the credential for the T3 server on this machine, so it is only
used for loopback addresses (`localhost`, `127.x.x.x`, `[::1]`). A server anywhere else needs
`https://` and a token file you name; tercet refuses to start otherwise.

## Theme

| Preset       | What it is                                                                          |
| ------------ | ----------------------------------------------------------------------------------- |
| `cyberdream` | the default: dark, 24-bit color, purple `#b07cf5` accent                            |
| `light`      | the same roles on white, darkened until text reads                                  |
| `ansi`       | the terminal's own 16 colors and default text and background; for a dark background |

`theme.accent` replaces the preset's accent (focus, titles, buttons). Presets and the accent
apply at startup.

## Keys

`tercet keys` prints the cheat sheet for your settings file, the same one `?` shows inside tercet. Each
entry in `keys` names a command and the key for it:

```jsonc
"keys": { "palette": "Ctrl+k", "focusUp": "Alt+k", "dictation": "F2", "search": "none" }
```

A key is modifiers and one key joined by `+`: `Ctrl`, `Alt` and `Shift`, then a character or one
of `Esc`, `Enter`, `Tab`, `Space`, `Backspace`, `Delete`, `Insert`, `Up`, `Down`, `Left`,
`Right`, `Home`, `End`, `PageUp`, `PageDown`, `F1` to `F12`. A capital letter means Shift
(`"Y"` is `Shift+y`); for other shifted characters write the character (`"?"`). A bare letter,
digit, Enter, Tab, Space or Backspace is refused, because it types. `"none"` unbinds.

Commands: `shell`, `terminal`, `web`, `launchers`, `sidebar`, `model`, `effort`, `files`,
`diff`, `dictation`, `palette`, `newThread`, `search`, `threadMenu`, `help`, `focusLeft`,
`focusDown`, `focusUp`, `focusRight`, `leave`, `dismissNotice` (the server-version banner,
listed only while it shows). `close` (Esc) and `quit` (Ctrl+c twice) are fixed.
Keys without Ctrl or Alt (`?`, `.`, capitals) are typed text while the composer has focus.

Two commands on one key is an error naming both, and so is a key a pane already uses: the
transcript's Y T X F O, vim's G, V, Ctrl+d and Ctrl+u, each target's capital, and the composer's
Ctrl+s, Ctrl+x, Ctrl+g, Ctrl+v, Alt+p and Alt+Backspace:

```
tercet: settings error in /home/you/.config/tercet/settings.json:3: keys.palette: Ctrl+k is bound to both palette and focusUp; rebind one of them
```

Pane keys (vim motions, list movement) are not rebindable.

### Keys that depend on the terminal

- **Alt** reaches tercet as Esc followed by the key. Most Linux terminals do this by default. On
  macOS turn it on: Terminal "Use Option as Meta key", iTerm2 "Left Option key: Esc+", ghostty
  `macos-option-as-alt = true`, kitty `macos_option_as_alt yes`. Steer (Alt+Enter) needs it too.
- **Ctrl+Shift+letter** is only distinct from Ctrl+letter with the kitty keyboard protocol, which
  tercet asks for at startup (kitty, ghostty, foot, WezTerm, recent Alacritty and iTerm2 with CSI u
  reporting on), or xterm's `modifyOtherKeys`. Elsewhere Ctrl+Shift+p arrives as Ctrl+p. Inside
  tmux it also needs `set -s extended-keys on`. Some terminals keep Ctrl+Shift combinations for
  themselves (ghostty takes Ctrl+Shift+Enter, which is why steer is Alt+Enter).
- **Ctrl+/** is sent as Ctrl+_ by terminals without the kitty protocol; tercet treats the two as
  one key.
- **Ctrl+j, Ctrl+h, Ctrl+i, Ctrl+m** are the same bytes as Linefeed, Backspace, Tab and Enter
  without the kitty protocol. Ctrl+j (pane down) then only works from the transcript, where a
  linefeed moves to the composer.
- **Cmd and Super** never reach programs in a terminal, so they can't be bound.
- **Paste** uses bracketed paste: pasted text arrives as one paste, never as key presses, so a
  pasted `?` or capital runs no command. A terminal without bracketed paste delivers it as typing.

## Icons

`icons` picks the glyphs in pane titles, the sidebar, files and the model picker:

- `unicode` (default): single-cell symbols most fonts have; color tells file types apart.
- `nerd`: Nerd Font icons per file type and model. The font must be in the terminal that draws
  them, which over SSH is the machine you type on. `tercet doctor` warns when it finds no Nerd Font.
- `ascii`: no character outside ASCII anywhere in the UI. Borders, arrows, separators and the
  spinner turn into `+ - | > v ^ *` and the like, cell for cell, so the layout is unchanged.
  Text from threads is left alone except for those same characters.

## Media

Images, screenshots, video, audio and other attachments show as cards in the transcript. How an
image draws is the first rung that works:

| Rung     | What you see                                                    | When `auto` picks it                                                 |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `kitty`  | the real image (Kitty graphics)                                 | the terminal answers the Kitty query; in tmux, a Kitty-type terminal |
| `sixel`  | the real image (Sixel)                                          | the terminal lists Sixel in its device attributes (not in tmux)      |
| `blocks` | the image drawn in colored block characters                     | anything else                                                        |
| `none`   | a placeholder: name, dimensions or duration, size, and `[open]` | never with `auto`, except with `"icons": "ascii"`                    |

At startup tercet asks the terminal (a Kitty graphics query and Device Attributes, 300 ms at most).
`TERM_PROGRAM`, `KITTY_WINDOW_ID` and `TERM` count only when the terminal does not answer. Inside
tmux the answer would be tmux's own, so tercet reads tmux's `allow-passthrough` and the outer
terminal's name instead. With passthrough off images fall back to blocks, and the first image
puts the fix on the status line once (`tercet doctor` shows it too):

```
set -g allow-passthrough on
```

`media.protocol` other than `auto` skips detection and uses that rung; `"none"` gives placeholders
everywhere.

Video shows its first frame and duration when `ffmpeg` is installed, and name and size when it
is not. Enter or `[open]` plays it with `launchers.player`, else `mpv`, else the opener. With
`"video": "terminal"` and `mpv` installed, tercet steps aside and mpv plays inside the terminal
(`--vo=kitty`, `sixel`, or `tct` in tmux and on the blocks rung) until you quit it. Audio works
the same way without a frame; other files open with the opener.

## Command templates

Every launcher, command and target is a program name (`"nvim"`) or an argument list
(`["tmux", "new-window", "-c", "{cwd}"]`). tercet runs it directly, without a shell, and fills each
placeholder inside the one argument it appears in. Text from a thread therefore stays a single
argument, whatever quotes or semicolons it holds.

| Placeholder | Value                                                                       |
| ----------- | --------------------------------------------------------------------------- |
| `{cwd}`     | the thread's working directory                                              |
| `{text}`    | the code block or selection (also sent on stdin)                            |
| `{path}`    | the file to open, edit or send                                              |
| `{url}`     | the link to open (for `opener` on a file, the file's path)                  |
| `{mime}`    | the clipboard type, `text/plain` or an image type                           |
| `{sshHost}` | the address you type from when tercet runs over SSH, else empty (see below) |

`{{` is a literal `{`. Each template takes only its own placeholders, and any other name is an
error at startup. A template with no placeholders gets its target appended, so `"nvim"` opens
`nvim <path>`.

A placeholder may not appear in the script that follows `-c` for `sh`, `bash`, `python` and
similar interpreters, because that would splice thread text into code. Pass it as its own
argument and read it as `"$1"`:

```jsonc
"run": ["bash", "-c", "cd \"$1\" && eval \"$2\"", "run", "{cwd}", "{text}"]
```

`{sshHost}` is looked up only when a template mentions it. Inside tmux it comes from the most
recently active client's `SSH_CONNECTION` (so a session shared between two machines follows the
one you typed on last), otherwise from tercet's own `SSH_CONNECTION`.

### Commands

| Command     | Placeholders      | What it does                                                        |
| ----------- | ----------------- | ------------------------------------------------------------------- |
| `copy`      | `{mime}`          | clipboard write, data on stdin; replaces the built-in tool          |
| `paste`     | `{mime}`          | clipboard read, prints the data; replaces the built-in tool         |
| `shell`     | `{cwd}`           | opens a shell (`Alt+t`); `launchers.terminal` is used when absent   |
| `editor`    | `{cwd}` `{path}`  | opens a file; else `launchers.editor`, inside `launchers.terminal`  |
| `tmux`      | `{cwd}` `{text}`  | types a code block into a terminal without running it (`T`, [tmux]) |
| `run`       | `{cwd}` `{text}`  | runs a closed shell code block (`X`, [run])                         |
| `send`      | `{text}` `{path}` | sends text or a file somewhere else (`F`, [send])                   |
| `dictation` | none              | toggles dictation (`Alt+v`, [mic]); may print `recording` or `idle` |
| `mapUrl`    | `{url}`           | prints the link to open instead, for example a tunnel's address     |

Every command also takes `{sshHost}`. If `mapUrl` fails, or the opener does, the link goes to
the clipboard and the status line says so.

### Targets

Each entry in `targets` is another clipboard: `copy` is a template that takes the data on stdin
and `{mime}`, and `key` is an optional capital letter for the transcript. The target's name is
its button label. Y, T, X, F, O, G and V are taken, and a target may not be called `copy`,
`open`, `tmux`, `run`, `send` or `path`.

### Clipboard and opener

Without `commands.copy` and `commands.paste` tercet uses the first tool it finds:

1. `wl-copy`/`wl-paste` when `WAYLAND_DISPLAY` is set (text and images)
2. `xclip` when `DISPLAY` is set (text and images), then `xsel` (text only)
3. `pbcopy`/`pbpaste` on macOS (text only)

Copying text always writes OSC 52 too, so it reaches your local clipboard over SSH when the
terminal allows it. Image copy and image paste appear only when the tool handles images.

Links and files open with `launchers.opener`, then `xdg-open`, then `open` on macOS. With none
of them there is no open button.

## Flags

| Flag                | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `--url ORIGIN`      | The T3 server, e.g. `http://127.0.0.1:3773`. Wins over `server.url`.  |
| `--base-dir DIR`    | The server's data directory (default `~/.t3`).                        |
| `--token-file PATH` | Read the token from this file. tercet never rewrites or chmods it.    |
| `--read-only`       | No writes: sending, shell, run, open and copy-to actions are blocked. |
| `--ignore-version`  | Start on a server with another protocol, or without a version.        |
| `--dump-status`     | Connect, print `live threads=N` and exit, with no TUI.                |
| `--hello`           | A server-free demo screen for checking the terminal.                  |
| `--version`         | Print tercet's version and the T3 server versions it supports.        |
| `--help`, `-h`      | Print the flags and exit.                                             |

tercet checks the server before it opens. Only two things stop it: a server it cannot reach (it
checks again every 2 s) and a server on another orchestration protocol, which client-runtime would
refuse anyway. A server that reports no version also stops, because client-runtime cannot read
its descriptor. A version outside the tested range (now `>=0.1.8 <0.2.0`, tested on 0.1.8) starts
normally under a one-line banner, "Built for T3 0.1.8, you're on 0.2.0: some things may not
work." `Alt+x` (the `dismissNotice` key) or a click hides it for the session. `--ignore-version`,
or `"ignoreVersion": true` under `server`, gets past a protocol mismatch or a missing version at
your own risk.

## tercet doctor

`tercet doctor` prints what tercet found on this machine: OS, terminal, tmux and whether
`allow-passthrough` is on, image support, clipboard tools, the opener, `ffmpeg` and `mpv`, the
server, its version and whether tercet supports it, the token file, and which optional actions work.
`tercet doctor --json` prints the same as JSON. It takes the same `--url`, `--base-dir` and
`--token-file` flags as tercet, reads but never changes anything, and always exits 0.

Each line starts with `ok`, `!!` (worth a look) or `-` (just information). The action rows
follow the same chains tercet runs with, and a command that is not set up is `-`.
