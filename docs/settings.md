# Settings

tercet reads one file: `$XDG_CONFIG_HOME/tercet/settings.json`, or
`~/.config/tercet/settings.json` when `XDG_CONFIG_HOME` is unset. Without the file tercet runs on
defaults and prints one line pointing here and to `tercet doctor`.

The file is JSON with comments: `//` and `/* */` comments and trailing commas are allowed. Every
key is optional. A key tercet does not know is ignored, so a file written for a newer tercet
still starts an older one; `tercet doctor` lists each ignored key with its line, which is how
you find a typo. A wrong type or value stops startup with one line that names the file, the line
and the key (wrapped here, one line on screen):

```
tercet: settings error in /home/you/.config/tercet/settings.json:3: theme.accent: expected a
"#rrggbb" color, got "purple"
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
    // The t3 command tercet runs to issue the first token. Only needed when it is not on PATH;
    // on Windows this is t3.cmd, often %APPDATA%\npm\t3.cmd.
    "t3Command": "t3",
    "baseDir": "~/.t3",
    // Start on a server with another protocol or no version (same as --ignore-version).
    "ignoreVersion": false,
    // Never draw the server warning banner (default false).
    "hideWarning": false,
  },
  "defaults": {
    // New threads start with this model when an enabled provider offers it.
    "provider": "codex",
    "model": "gpt-5.5",
    "mode": "full-access",
    "sendShortcut": "enter",
    "favorites": [
      { "provider": "codex", "model": "gpt-5.5" },
      { "provider": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "medium" } },
    ],
    "sidebarWorkingShelf": false,
    // The key hint rows at the bottom; Alt+i (the hints key) toggles them.
    "hints": true,
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
  "media": { "protocol": "auto", "video": "player", "pageShots": true },
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
| `server.t3Command`                                    | path or command name                                            | `t3` from PATH, then usual folders         | now       |
| `server.baseDir`                                      | path                                                            | `~/.t3`                                    | now       |
| `server.ignoreVersion`                                | true or false                                                   | `false`                                    | now       |
| `server.hideWarning`                                  | true or false                                                   | `false`                                    | now       |
| `defaults.provider`                                   | provider instance id                                            | any                                        | now       |
| `defaults.model`                                      | model slug                                                      | the thread's or project's model            | now       |
| `defaults.mode`                                       | `approval-required`, `auto-accept-edits`, `auto`, `full-access` | per provider                               | now       |
| `defaults.sendShortcut`                               | `enter`, `mod-enter`, `mod-enter-multiline`                     | `enter`                                    | now       |
| `defaults.favorites`                                  | list of `{ provider, model, options? }`                         | `[]`                                       | now       |
| `defaults.sidebarWorkingShelf`                        | boolean                                                         | `false`                                    | now       |
| `defaults.hints`                                      | boolean                                                         | `true`                                     | now       |
| `theme.preset`, `theme.accent`, `theme.link`                        | a preset name or `auto` (see Theme); `#rrggbb`                  | `cyberdream`, its own accent               | now       |
| `keys`                                                | command name to key                                             | built-in keys                              | now       |
| `icons`                                               | `nerd`, `unicode`, `ascii`                                      | `unicode`                                  | now       |
| `launchers.terminal`, `.editor`, `.opener`, `.browser`, `.player`, `.picker` | command template                                                | see below                                  | now       |
| `launchers.browserLocation` | `host` or `client` | `host` | now |
| `launchers.browserProfile` | existing browser profile name/directory | browser default | now |
| `media.protocol`                                      | `auto`, `kitty`, `sixel`, `blocks`, `none`                      | `auto`                                     | now       |
| `media.video`                                         | `player`, `terminal`                                            | `player`                                   | now       |
| `media.pageShots`                                     | boolean                                                         | `true`                                     | now       |
| `spell.enabled`                                       | boolean                                                         | `true`                                     | now       |
| `spell.dictionary`                                    | path                                                            | `<settings dir>/dictionary.txt`            | now       |
| `commands.<name>`                                     | command template                                                | none                                       | now       |
| `targets.<name>`                                      | `{ copy, key? }`                                                | none                                       | now       |

"Read from" is the build step that starts using a key. Keys for later steps are already checked,
so a wrong value shows up now rather than later.

If tercet says it cannot find `t3`, set `server.t3Command` to its full path (`npm root -g` shows where
npm puts it; on Windows look for `t3.cmd` in `%APPDATA%\npm`). Without the setting tercet looks on PATH,
then in the usual npm, bun, pnpm, mise and Homebrew folders. In the settings file write Windows paths with forward slashes
(`C:/Users/you/AppData/Roaming/npm/t3.cmd`) or doubled backslashes. `tercet doctor` prints a `t3 command`
row before the first token exists.

A token file you name in `server.tokenFile` or `--token-file` is yours: tercet reads it but never
issues a new token into it or changes its permissions.

The default token file holds the credential for the T3 server on this machine, so it is only
used for loopback addresses (`localhost`, `127.x.x.x`, `[::1]`). A server anywhere else needs
`https://` and a token file you name; tercet refuses to start otherwise.

## Favorites

Each `defaults.favorites` entry is `{ "provider": "...", "model": "..." }` plus an optional
`options` object of model option defaults, as in the example above. Option ids come from the
model's option list: `effort` and `fastMode` for Claude, `reasoningEffort` and `serviceTier` for
Codex, `variant` for OpenCode. Values are a string or `true`/`false`. An option the model does not
have, or a value it does not offer, is ignored.

Choosing a favorite in the model picker (or its Effort page) starts from its `options`; options not
listed keep the built-in defaults (High where supported, Fast off).

Right-click a model in the model picker to edit its favorite: toggle the favorite, cycle its
options, and "Save as favorite defaults" writes the entry to the settings file. Saving keeps the
rest of the file (comments and other keys) as is; comments inside the favorites list itself are
lost on a save.

When `defaults.favorites` is non-empty it is the favorites list for tercet. When it is empty or
absent, tercet shows the T3 server's favorites; the first favorite saved from tercet copies the
list already shown into the file.

## Theme

| Preset             | What it is                                                                          |
| ------------------ | ----------------------------------------------------------------------------------- |
| `cyberdream`       | the default: dark, 24-bit color, purple `#b07cf5` accent                            |
| `light`            | the same roles on white, darkened until text reads                                  |
| `ansi`             | the terminal's own 16 colors and default text and background; for a dark background |
| `dark`             | neutral grays with one muted steel-blue accent; color only where a status needs it  |
| `dusk`             | dark plum with a peach accent; solid, slightly pastel colors                        |
| `lagoon`           | dark teal with a mint-teal accent                                                   |
| `sand`             | light, warm paper with a burnt-orange accent                                        |
| `catppuccin-mocha` | [Catppuccin](https://catppuccin.com) Mocha, dark, mauve accent                      |
| `catppuccin-latte` | Catppuccin Latte, light, mauve accent                                               |
| `tokyo-night`      | Tokyo Night, dark, blue accent                                                      |
| `gruvbox`          | Gruvbox dark, orange accent                                                         |
| `nord`             | Nord, dark, frost-blue accent                                                       |
| `rose-pine`        | Rosé Pine, dark, iris accent                                                        |
| `dracula`          | Dracula, dark, purple accent                                                        |
| `one-dark`         | Atom's One Dark, blue accent                                                        |
| `auto`             | asks the terminal for its background color: `light` on a light one, else `cyberdream` |

The named palettes use their published colors. Where one would put text under 3.6:1 contrast on
its own background (Catppuccin Latte's yellow, for example), tercet darkens or lightens just that
color until it reads.

`auto` sends the terminal an OSC 11 background query at startup. Most terminals answer, and so
does tmux. When nothing answers, tercet reads `COLORFGBG`, and when that is missing too it picks
`cyberdream`. `tercet doctor` shows what `auto` chose and why. The choice is made once at startup;
it does not follow a terminal that switches between light and dark while tercet runs.

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

Commands: `shell`, `terminal`, `editor`, `web`, `launchers`, `sidebar`, `model`, `effort`, `files`,
`diff`, `dictation`, `attach` (the file picker), `spell` (spelling suggestions), `palette`, `newThread`, `search`, `threadMenu`, `help`, `hints` (shows
or hides the key hint rows at the bottom), `focusLeft`,
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
is not. Enter or `[open]` plays it with `launchers.player`, else `mpv`, else the opener. Over
SSH, when no player is explicitly configured, it instead uses your SSH-aware
`launchers.opener` (a template taking `{sshHost}`), just like opening a photo: files are passed
as `{path}` and URLs as `{url}` with an empty `{path}`. URL playback also applies `commands.mapUrl`
so a loopback URL can be rewritten to an address the client can reach. The destination is
looked up on each click, including when switching between local and SSH tmux clients. Without
an SSH-aware opener, remote playback reports an error; it never falls back to the server's
desktop. An explicit `launchers.player` keeps control of its own routing, with the file or URL
in `{path}` as before. The opener controls file transfer; this adds no streaming server. With
`"video": "terminal"` and `mpv` installed, tercet steps aside and mpv plays inside the terminal
(`--vo=kitty`, `sixel`, or `tct` in tmux and on the blocks rung) until you quit it. Audio works
the same way without a frame; other files open with the opener.

A page the agent rendered (T3's `html_render`) shows as a screenshot, taken off-screen with
headless `chromium`, instead of only an `[open]` link. Enter still opens the page itself in the
browser. Shots are on by default and need an image rung other than `none`. `"pageShots": false`
under `media` turns them off. The environment wins over the file: `TERCET_PAGE_SHOTS=0` turns
them off for one run, `TERCET_PAGE_SHOTS=1` turns them on.

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
| `run`       | `{cwd}` `{text}`  | runs a closed shell code block (`X`, [run]); else the side terminal |
| `send`      | `{text}` `{path}` | sends text or a file somewhere else (`F`, [send])                   |
| `dictation` | built-in T3 speech | overrides built-in dictation (`Alt+v`, [mic]); may print `recording` or `idle` |
| `mapUrl`    | `{url}`           | prints the link to open instead, for example a tunnel's address     |

Every command also takes `{sshHost}`. If `mapUrl` fails, or the opener does, the link goes to
the clipboard and the status line says so.

### Targets

Each entry in `targets` is another clipboard: `copy` is a template that takes the data on stdin
and `{mime}`, and `key` is an optional capital letter for the transcript. The target's name is
its button label. Y, T, X, F, O, G and V are taken, and a target may not be called `copy`,
`open`, `tmux`, `run`, `send` or `path`.

### Clipboard and opener

For a local terminal, without `commands.copy` and `commands.paste`, tercet uses the first tool it finds:

1. `wl-copy`/`wl-paste` when `WAYLAND_DISPLAY` is set (text and images)
2. `xclip` when `DISPLAY` is set (text and images), then `xsel` (text only)
3. `pbcopy`/`pbpaste` on macOS (text only)
4. Windows PowerShell with the native Windows clipboard (text and images)

Composer right-click offers editing actions and spelling suggestions; transcript drag-selection
and right-click offers Copy of exactly the highlighted text. Drag completion still auto-copies.
Right-click preserves selection, including Vim visual selections. The transcript pauses wheel
scrolling while its menu is open so its selected rows stay mounted; dismiss with Escape or a
click outside the menu before scrolling. Shift mouse selection belongs to the terminal.
Ctrl+C copies a mouse-selected transcript or composer selection without arming quit; without
selection, two presses quit. Vim `y`/`yy` remain selection/line yank. The embedded terminal
retains Ctrl+C interrupt. Copy errors are reported; OSC 52 success means emitted, with no
terminal acknowledgement of clipboard delivery.

Default text Copy writes OSC 52 to the terminal, including over SSH, when the terminal
allows clipboard writes. A local desktop tool is also used only when the active client is
confirmed local. Inside tmux this is checked on every action using the most recently active
client's environment (Linux /proc); an unknown client never falls back to the server clipboard.
When tmux allows passthrough, OSC 52 is wrapped for the outer terminal. Otherwise tmux must
support OSC 52 forwarding (`set-clipboard` on and the terminal's `Ms` capability);
a blocked terminal write cannot be acknowledged or detected by tercet.

Remote Paste does not query the terminal clipboard: many terminals prohibit those reads.
It reports a hint to use the terminal's Paste shortcut (usually Ctrl+Shift+V on Linux/Windows,
Cmd+V on macOS), which delivers text through terminal paste input. No server clipboard is read.
For programmatic paste, configure `commands.paste` to read from the intended machine, e.g.
an SSH-aware command using `{sshHost}`. Such commands have a 15-second timeout.

Explicit `commands.copy` owns the destination and replaces OSC 52 and the built-in writer.
Named targets likewise write only to the named destination. Image clipboard operations require
a suitable local tool or an explicit command; remote operations never fall back to a server tool.

Links and files open with `launchers.opener`, then `xdg-open`, then `open` on macOS. With none
of them there is no open button.

### File picker

`Alt+a` (the `attach` key) or the composer's `[Attach]` button opens a file dialog:
`launchers.picker`, then `zenity` or `kdialog` when a desktop session is running, then
`osascript` on macOS. A picker template gets `{cwd}` (the thread's project) and prints the chosen
paths one per line; exit status 1 means Cancel. Picked files upload to the server like pasted
images, at most 8 per message and 50 MB each: a PNG up to 2000 px goes as an image the model sees,
anything else as a file the agent can open. Without a picker there is no button or key.

Over SSH (the `{sshHost}` lookup finds the machine you type from), the dialog opens on that
machine instead, over `ssh -o BatchMode=yes`, and the files are copied from there: the server gets
the file itself, never a path on the wrong machine. It needs key login from here to there, and
zenity or kdialog there (osascript on a Mac). A `launchers.picker` template replaces this and its
paths are read on this machine.

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
its descriptor. A version outside the tested range (now `>=0.1.9 <0.2.0`, tested on 0.1.9) starts
normally under a one-line banner, "Built for T3 0.1.9, you're on 0.2.0: some things may not
work." `Alt+x` (the `dismissNotice` key) or a click hides it for the session. `--ignore-version`,
or `"ignoreVersion": true` under `server`, gets past a protocol mismatch or a missing version at
your own risk. `"hideWarning": true` under `server` never draws the banner; a server tercet
refuses to open on still shows its full-screen message.

## tercet doctor

`tercet doctor` prints what tercet found on this machine: OS, terminal, tmux and whether
`allow-passthrough` is on, image support, clipboard tools, the opener, `ffmpeg` and `mpv`, the
server, its version and whether tercet supports it, the token file, and which optional actions work.
`tercet doctor --json` prints the same as JSON. It takes the same `--url`, `--base-dir` and
`--token-file` flags as tercet, reads but never changes anything, and always exits 0.

Each line starts with `ok`, `!!` (worth a look) or `-` (just information). The action rows
follow the same chains tercet runs with, and a command that is not set up is `-`.

## Spell check

The composer underlines misspelled words in red as you type. The word under the caret is left
alone until you move on, so nothing flashes while you are mid-word. Right-click an underlined
word, or press `Alt+s` (the `spell` key) to jump to the word at the caret or the next flagged
one, and a menu offers up to five corrections, `Add to dictionary` and `Ignore`. Click a choice,
or use Up/Down with Enter, or press its number. Esc closes the menu.

The English (US) dictionary is built in, so there is nothing to install, and it loads the first
time the composer draws. Code spans and fences, URLs, paths, `@file` and `/skill` mentions,
flags, `snake_case`, `camelCase` and ALL CAPS are never checked. `Add to dictionary` appends the
word to `spell.dictionary` (one word per line, edit it by hand if you like); `Ignore` lasts until
you quit.

```jsonc
"spell": { "enabled": true, "dictionary": "~/.config/tercet/dictionary.txt" }
```

Set `"enabled": false` to turn it all off. Other languages are not supported yet.

## Dictation

Without `commands.dictation`, tercet captures local audio and uses the connected T3 server's
speech model. In T3's web app, open Settings → Voice to install/select a model first. The
upstream default is Parakeet Unified English 0.6B (731 MB, English only).

```jsonc
"dictation": {
  "language": "auto", // a language hint supported by the selected model
  // Optional override: raw 16 kHz mono float32 little-endian PCM on stdout.
  "recorder": ["pw-record", "--rate", "16000", "--channels", "1", "--format", "f32", "--raw", "-"]
}
```

Recording stops at five minutes. Audio is held in memory, discarded on cancellation, and
uploaded only after stopping. Press mic while transcribing to abort and discard the result.
Late text goes to the original thread's draft, preserving edits made during transcription.
Esc cancels built-in dictation from the composer. Closing tercet terminates its recorder.

Only the server's local speech model is supported: no cloud providers, post-processing,
streaming or SSH audio forwarding. In SSH sessions automatic capture is disabled; an explicit
`dictation.recorder` opts into capture on that host. `commands.dictation` takes precedence,
keeps the external recording/idle protocol, and its output is never inserted as a transcript.

### Embedded terminal editor

The Files panel's `e` / **Edit here** uses a separate local PTY. Default:
`nvim --clean -- {path}`, or `vi -- {path}` if Neovim is absent. Neovim's clean configuration
avoids loading plugins; to use your own configuration, set:

```jsonc
{ "commands": { "embeddedEditor": ["nvim", "--", "{path}"] } }
```

This argv template accepts `{cwd}` and `{path}`; paths with spaces remain one argument.
A bare program name gets the absolute file path appended. This command must stay in the
foreground and use a terminal UI. `commands.editor` and `launchers.editor` still control
only the external launcher (`o`). Settings apply on the next Tercet start.

One editor session stays pinned to its launch workspace until its process exits. Hiding it,
changing panels or switching threads preserves its buffers. `Alt+r` resumes it; `Alt+h` leaves
focus and `Alt+c` hides it. App quit is blocked until the editor exits. Forced termination,
crash or machine shutdown can still interrupt it; use the editor's own swap/recovery support.
There is no persistent editor session after Tercet exits. Local loopback connections only:
run Tercet through SSH on the server host. A forwarded loopback port is not supported.
Read-only mode blocks launch before any PTY or file access.

### External editor: system default, windows and tmux

The Files panel's **o External editor** selects `commands.editor` first, then
`launchers.editor`, then the environment's `VISUAL`, then `EDITOR`. There is no automatic
Neovim fallback for external editing. With no editor set, Tercet asks you to set VISUAL/EDITOR
in your shell profile or set launchers.editor in this file. Restart Tercet after changing it.

Terminal editors normally open in a separate terminal window. On Linux, Tercet detects
Ghostty, foot, kitty, WezTerm, Alacritty, GNOME Terminal, Konsole or xterm, in that order;
a display must be available. On macOS it uses Terminal through osascript (not yet tested
on hardware). Set launchers.terminal to override the terminal argv.

Known GUI commands such as code, codium, zed and subl launch directly. An explicit
launchers.editor for another GUI program also launches directly unless editorMode says
otherwise. To link VS Code without putting it on PATH, set its executable's full path:

```jsonc
{
  "launchers": {
    "editor": ["/full/path/to/code", "{path}"],
    "editorMode": "direct"
  }
}
```

For a macOS app bundle, the executable is typically
`/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`.
Command arrays preserve spaces in executable names and selected file paths.
VISUAL/EDITOR accept quoted program paths and flags; they are split into argv without shell
evaluation. Shell substitutions and environment expansion inside those values are not run.
A missing executable produces an error with instructions to link its full path.

To opt into tmux sessions (the maintainer's setup):

```jsonc
{
  "launchers": {
    "editor": "nvim",
    "editorMode": "tmux"
  }
}
```

Run Tercet inside an attached tmux session. Each external edit opens a separate session in the
selected file's workspace. Quitting the editor returns the same client to its original session.
There are no new tmux windows. This mode works over SSH; it reports a clear error outside tmux.
The editor uses its normal user configuration. External sessions belong to tmux and are not
killed when Tercet exits. Tercet refreshes file previews on return/focus; r also refreshes.

editorMode accepts terminal, tmux or direct. With terminal explicitly selected, even an editor
command in launchers.editor gets wrapped in a terminal window. commands.editor remains a
complete custom launch command and overrides these defaults. Read-only mode blocks external
launches. Automatic launching rejects direct remote-server paths; run Tercet on the server host.

## Windows

Native Windows uses the same settings location, `%USERPROFILE%\.config\tercet\settings.json`,
or `$XDG_CONFIG_HOME/tercet/settings.json` when set to an absolute path. Use forward slashes
in JSON paths, such as `C:/Program Files/Neovim/bin/nvim.exe`, or double each backslash.
Windows clipboard (text and images), file dialogs and opening links/files use built-in Windows
PowerShell. An unconfigured shell action opens PowerShell in a separate console.
Terminal editors open in a separate console; GUI executables launch directly. Point at the
actual `.exe` for a GUI editor, rather than its `.cmd` wrapper. `tmux` mode is for Unix hosts.

Placeholders in PowerShell `-Command`/`-EncodedCommand` or cmd `/c`/`/k` source are rejected.
Use an executable argv template or a fixed script that reads data from stdin.
More details: [Windows setup](windows.md).


## Response readback (Kokoro)

Click **[read]** below an assistant response to generate and play speech locally. Stop reading
or Esc cancels. Nothing is read automatically. Voice and speed are configurable:

```jsonc
"readback": {
  "enabled": true,
  "engine": "local",
  "voice": "af_heart",
  "speed": 1.0,
  "home": "" // where Kokoro lives; empty means tercet's own data directory
}
```

### Setting it up

Local generation needs the Kokoro model files and a Python venv with `kokoro-onnx` and numpy.
tercet installs them only when you ask:

```sh
tercet readback setup                # shows the plan, asks y/N
tercet readback setup --yes          # no question
tercet readback setup --dry-run      # print the plan, change nothing
tercet readback setup --force        # replace a model file that differs from the release
tercet readback setup --home DIR     # use DIR instead of the default location
tercet readback status               # ready, or what is missing (exit 1 when not ready)
```

Setup uses `uv` when it is installed and `python3 -m venv` with pip otherwise. It downloads
`kokoro-v1.0.onnx` and `voices-v1.0.bin` (about 354 MB together) from the kokoro-onnx GitHub
release `model-files-v1.0`, to a temporary name, checks size and SHA-256, and only then renames
them. A model file that is already there but differs from the release is refused unless you pass
`--force`. Running setup again when everything is present does nothing. Ctrl+C leaves no half
files behind. Nothing downloads at startup, at install time or on the first Read.

The files live in the Kokoro home (`kokoro-v1.0.onnx`, `voices-v1.0.bin` and `.venv`):

| System  | Default Kokoro home                                  |
| ------- | ---------------------------------------------------- |
| Linux   | `$XDG_DATA_HOME/tercet/kokoro`, else `~/.local/share/tercet/kokoro` |
| macOS   | `~/Library/Application Support/tercet/kokoro`        |
| Windows | `%LOCALAPPDATA%\tercet\kokoro`                       |

To use a setup you already have somewhere else, point at it. The order is the `KOKORO_HOME`
environment variable, then `readback.home` in settings (a leading `~` is expanded), then the
default above. `--home DIR` on `setup` and `status` overrides all three for that run only; if it
differs from what tercet reads, setup says so and tells you to set `readback.home` or
`KOKORO_HOME` to match. `KOKORO_PYTHON` replaces the venv's Python interpreter; it must be able to import `kokoro_onnx`
and numpy.

Until the setup is ready, clicking **[read]** shows "Read aloud is not set up. Run `tercet
readback setup`." and nothing is spawned. tercet checks again on every click, so a setup run in
another terminal works without restarting tercet. `tercet doctor` shows a `read aloud` row:
the Kokoro home when ready, the same hint when not, the endpoint (without calling it) for
`engine: "http"`, or `off` when `readback.enabled` is false.

British voices use en-gb phonemes, American voices en-us. A cancellable worker loads the model
per Read and exits after generation. Voice IDs include af_heart, am_michael and bf_emma. Speed
accepts 0.25 to 4. Restart after settings changes.

### Kokoro-FastAPI instead

`engine: "http"` uses `endpoint` (default `http://127.0.0.1:8880/v1/audio/speech`) for
OpenAI-compatible [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) WAV synthesis. It
needs no Python setup in tercet and no `tercet readback setup`. Only explicitly requested
response text is sent there, never T3 credentials; redirects are refused. Local generation makes
no HTTP requests.

### Playback

Speech is generated on the machine running tercet but plays where you click. Run locally, it
plays there with mpv, ffplay or afplay and no window. Over SSH it plays on the machine you type
from (the same `{sshHost}` lookup as the opener and clipboard commands, so inside tmux it
follows the most recently active client): the WAV is sent through `ssh` to that machine and
played with mpv, ffplay, afplay or paplay, with `XDG_RUNTIME_DIR` set so PipeWire/PulseAudio
is found. That needs passwordless ssh back to the client, which the opener already requires.
Stop or Esc ends the remote player too. Read-only sessions block Read; Stop stays available. Temporary audio is removed after play
or cancellation. Long responses are spoken sentence by sentence: the first piece starts as soon
as it is made while the next is generated. Beside **[read]** a spinner shows speech is being
prepared and a play icon shows it is playing; clicking **[read]** again stops it. Limits: 30,000 characters, 64 MB audio per piece and two minutes to make any one piece.
Generation errors appear beneath the transcript.


## Transcript links and browser

Markdown links, including links inside bold text and headings, and bare HTTP(S) URLs
are clickable and underlined. Dragging selects text without opening a link; Shift-click
also leaves it unopened. Set `theme.link` to a `#rrggbb` color to change their color.
The default is the theme's blue, separate from assistant text and inline code.

Configure these keys in your usual `settings.json`, then restart Tercet:

```jsonc
{
  "theme": { "link": "#5ea1ff" },
  "launchers": {
    "browser": ["zen", "-P", "{profile}", "{url}"],
    "browserProfile": "default",
    "browserLocation": "host"
  }
}
```

`browser` is a command name, an executable's full path, or an argument array.
For Firefox and Zen, `-P` selects an existing named profile; use the profile name you
created in that browser. For Chromium, use
`["chromium", "--profile-directory={profile}", "{url}"]` with a directory name such
as `Default` or `Profile 1`. Omit the profile argument and `browserProfile` to let the
browser choose its usual profile. Tercet does not enumerate browser profiles.

`browserLocation` is `host` (default, the machine running Tercet) or `client`
(the currently attached SSH/tmux client). `client` requires SSH access from the host
back to that client, with an existing login setup and a working graphical session.
The executable path and profile must exist on that destination machine. Tercet
quotes each argument before passing it to the remote shell. No SSH client found or a
failed launch leaves the URL on the clipboard with a notice; it does not silently
open a browser on another machine. Without `browser`, client mode runs `xdg-open`;
set `browser` to `open` for a macOS client.

Browser templates accept `{url}`, `{profile}` and `{sshHost}`. A bare program name
gets the URL appended. With placeholders, include `{url}` explicitly. Commands run
without a local shell, so paths and profile names containing spaces stay one argument.

If `browser` is unset in host mode, links use the existing `launchers.opener` and
system opener fallback. File and image openers stay independent of `browser`.

To try a local build without replacing your installed Tercet:

```bash
bun run build
bun ./dist/tercet.js
```
