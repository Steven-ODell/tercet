import { expect, test } from "bun:test";
import { parseKeypress, type KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  cheatSheet,
  cheatSheetText,
  commandForKey,
  COMMANDS,
  formatChord,
  parseKey,
  resolveKeymap,
  type Chord,
} from "./keymap";

/** The event a terminal would deliver for a chord, as the kitty keyboard protocol reports it. */
const event = (chord: Chord) =>
  ({
    name: chord.name,
    sequence: chord.name.length === 1 ? chord.name : "",
    ctrl: chord.ctrl,
    meta: chord.alt,
    shift: chord.shift,
  }) as KeyEvent;
const bytes = (sequence: string) => parseKeypress(sequence, { useKittyKeyboard: true }) as KeyEvent;

for (const [name, overrides] of [
  ["defaults", {}],
  ["a rebound file", { palette: "Ctrl+Shift+k", help: "F1", search: "none", leave: "Alt+q" }],
] as const)
  test(`the cheat sheet is the bindings, and each listed key runs its command (${name})`, () => {
    const bindings = resolveKeymap(overrides, { D: "desk" });
    const sheet = cheatSheet(
      bindings,
      { shell: true, dictation: true, notice: true, attach: true },
      { Y: "copy", D: "desk" },
    );
    const anywhere = sheet[0]!.rows;
    // Every command in the table is listed once, in table order, unless unbound.
    expect(anywhere.map((row) => row.label)).toEqual(
      COMMANDS.filter((c) => !(c.id in overrides && overrides[c.id as never] === "none")).map(
        (c) => c.label,
      ),
    );
    for (const row of anywhere) {
      const binding = bindings.find((b) => b.hint === row.keys)!;
      expect(binding.label).toBe(row.label);
      expect(commandForKey(event(parseKey(row.keys.replace(" ×2", "")) as Chord), bindings)).toBe(
        binding.id,
      );
    }
    for (const [id, spec] of Object.entries(overrides))
      expect(bindings.find((b) => b.id === id)!.hint).toBe(
        spec === "none" ? "none" : formatChord(parseKey(spec) as Chord),
      );
    expect(cheatSheetText(sheet)).toContain("  D                   desk block, link or selection");
  });

test("the cheat sheet text can name each command for the keys setting", () => {
  const text = cheatSheetText(cheatSheet(resolveKeymap(), {}, {}), true);
  expect(text).toMatch(/Ctrl\+p +Palette +palette\n/);
  expect(text).toMatch(/Ctrl\+n +New thread +newThread\n/);
  expect(text).toMatch(/Esc +Close overlay \/ next pane +\(fixed\)\n/);
  expect(cheatSheetText(cheatSheet(resolveKeymap(), {}, {}))).not.toContain("newThread");
});

test("optional commands leave the sheet when their action is missing", () => {
  const rows = cheatSheet(resolveKeymap(), {}, {})[0]!.rows.map((row) => row.label);
  expect(rows).not.toContain("Shell");
  expect(rows).not.toContain("Dictation");
  expect(rows).toContain("Terminal");
});

test("key specs parse to one spelling", () => {
  for (const [spec, shown] of [
    ["alt+T", "Alt+T"],
    ["Control+Shift+P", "Ctrl+Shift+p"],
    ["shift+y", "Y"],
    ["esc", "Esc"],
    ["f12", "F12"],
    ["Ctrl++", "Ctrl++"],
    ["Alt+Enter", "Alt+Enter"],
    ["Alt+pageDown", "Alt+PageDown"],
  ])
    expect(formatChord(parseKey(spec) as Chord)).toBe(shown);
  expect(parseKey("Shift+/")).toContain("write the shifted character itself");
  expect(parseKey("Ctrl+left arrow")).toContain("is not a key");
  expect(parseKey("Enter")).toContain("a bare Enter edits text");
});

test("terminal sequences: Alt, Ctrl+Shift and legacy Ctrl+/ reach the right command", () => {
  const bindings = resolveKeymap({ palette: "Ctrl+Shift+p", newThread: "Ctrl+p" });
  // Alt arrives as an ESC prefix (xterm's metaSendsEscape, ghostty, kitty, foot, tmux).
  expect(commandForKey(bytes("\x1bt"), resolveKeymap())).toBe("shell");
  expect(commandForKey(bytes("\x1bb"), bindings)).toBe("sidebar");
  // Legacy terminals send Ctrl+/ as 0x1f, which reads as Ctrl+_; kitty's protocol sends "/".
  expect(commandForKey(bytes("\x1f"), bindings)).toBe("search");
  expect(commandForKey(bytes("\x1b[47;5u"), bindings)).toBe("search");
  // Ctrl+Shift+p is only distinct with the kitty protocol or xterm's modifyOtherKeys; legacy
  // terminals send the same byte as Ctrl+p.
  expect(commandForKey(bytes("\x1b[112;6u"), bindings)).toBe("palette");
  expect(commandForKey(bytes("\x1b[27;6;112~"), bindings)).toBe("palette");
  expect(commandForKey(bytes("\x10"), bindings)).toBe("newThread");
  // Legacy Ctrl+j is a linefeed; only the kitty protocol tells it apart (the frame handles both).
  expect(commandForKey(bytes("\x1b[106;5u"), bindings)).toBe("focusDown");
  expect(commandForKey(bytes("\n"), bindings)).toBeUndefined();
  // Shift reported with ? (kitty) still means ?.
  expect(commandForKey(bytes("\x1b[63;2u"), bindings)).toBe("help");
  expect(commandForKey(bytes("?"), bindings)).toBe("help");
});

test("bracketed paste arrives as one paste, never as key presses", async () => {
  const setup = await createTestRenderer({ width: 20, height: 4 });
  try {
    const keys: string[] = [];
    const pastes: string[] = [];
    setup.renderer.keyInput.on("keypress", (key: KeyEvent) => keys.push(key.name));
    setup.renderer.keyInput.on("paste", (paste: { text?: string; bytes?: Uint8Array }) =>
      pastes.push(paste.text ?? new TextDecoder().decode(paste.bytes)),
    );
    await setup.mockInput.pasteBracketedText("? . Y \x10 done");
    await setup.flush();
    expect(keys).toEqual([]);
    expect(pastes.join("")).toContain("? . Y");
  } finally {
    await setup.dispose();
  }
});
