import type { KeyEvent } from "@opentui/core";

/** One key with its modifiers. `name` is a lowercase letter, a character, or a named key. */
export interface Chord {
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Every global command and its default key. Dispatch, the clickable status hints, the `?` overlay
 * and `tercet keys` all read this table (through `resolveKeymap`). `fixed` ones cannot be rebound;
 * `needs` names the optional action without which the binding is not drawn or dispatched.
 */
export const COMMANDS = [
  { id: "shell", keys: "Alt+t", label: "Shell", needs: "shell" },
  { id: "terminal", keys: "Alt+j", label: "Terminal" },
  { id: "web", keys: "Alt+o", label: "Web" },
  { id: "launchers", keys: "Alt+l", label: "Launchers" },
  { id: "sidebar", keys: "Alt+b", label: "Sidebar" },
  { id: "model", keys: "Alt+m", label: "Model" },
  { id: "effort", keys: "Alt+e", label: "Effort / Permissions" },
  { id: "files", keys: "Alt+f", label: "Files" },
  { id: "diff", keys: "Alt+d", label: "Diff" },
  { id: "dictation", keys: "Alt+v", label: "Dictation", needs: "dictation" },
  { id: "palette", keys: "Ctrl+p", label: "Palette" },
  { id: "newThread", keys: "Ctrl+n", label: "New thread" },
  { id: "search", keys: "Ctrl+/", label: "Search threads" },
  { id: "threadMenu", keys: ".", label: "Thread actions" },
  { id: "help", keys: "?", label: "Help" },
  { id: "focusLeft", keys: "Alt+h", label: "Pane left" },
  { id: "focusDown", keys: "Ctrl+j", label: "Pane down" },
  { id: "focusUp", keys: "Ctrl+k", label: "Pane up" },
  { id: "focusRight", keys: "Ctrl+l", label: "Pane right" },
  { id: "leave", keys: "Alt+c", label: "Close side panel" },
  { id: "close", keys: "Esc", label: "Close overlay / next pane", fixed: true },
  { id: "quit", keys: "Ctrl+c", label: "Quit", fixed: true, twice: true },
] as const satisfies readonly {
  id: string;
  keys: string;
  label: string;
  needs?: string;
  fixed?: boolean;
  twice?: boolean;
}[];
export type Command = (typeof COMMANDS)[number]["id"];
export const COMMAND_IDS: readonly string[] = COMMANDS.map((c) => c.id);

export interface Binding {
  id: Command;
  label: string;
  /** Undefined when unbound with `"none"`. */
  chord?: Chord;
  /** How the key is written in hints and help, e.g. "Alt+t" or "Ctrl+c ×2". */
  hint: string;
  needs?: "shell" | "dictation";
}

/**
 * Keys the panes handle themselves, which a global binding may not take: the transcript's target
 * capitals and vim's G, V, Ctrl+d and Ctrl+u. Targets' own capitals are added per settings file.
 */
export const PANE_KEYS: Readonly<Record<string, string>> = {
  Y: "copy",
  T: "tmux",
  X: "run",
  F: "send",
  O: "open",
  G: "vim G (last line)",
  V: "vim V (line select)",
  "Ctrl+d": "vim Ctrl+d (half page down)",
  "Ctrl+u": "vim Ctrl+u (half page up)",
  "Ctrl+s": "composer stop",
  "Ctrl+x": "composer cancel queued",
  "Ctrl+g": "composer leave edit",
  "Ctrl+v": "composer paste",
  "Alt+p": "composer paste image",
  "Alt+Backspace": "composer remove image",
};

const NAMED: Readonly<Record<string, string>> = {
  esc: "escape",
  escape: "escape",
  enter: "return",
  return: "return",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  insert: "insert",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `f${i + 1}`])),
};
const SHOWN: Readonly<Record<string, string>> = {
  escape: "Esc",
  return: "Enter",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** Parses "Alt+t", "Ctrl+Shift+p", "?", "F2" or "Y"; returns the problem as a string. */
export function parseKey(spec: string): Chord | string {
  const parts = spec.endsWith("++") ? [...spec.slice(0, -2).split("+"), "+"] : spec.split("+");
  const key = parts.pop() ?? "";
  const chord: Chord = { name: "", ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    const mod = part.trim().toLowerCase();
    if (mod === "ctrl" || mod === "control") chord.ctrl = true;
    else if (mod === "alt" || mod === "meta" || mod === "option") chord.alt = true;
    else if (mod === "shift") chord.shift = true;
    else if (["cmd", "command", "super", "win", "hyper"].includes(mod))
      return `${part} is not sent to terminal programs; use Ctrl or Alt`;
    else return `unknown modifier "${part}"; use Ctrl, Alt or Shift`;
  }
  const named = NAMED[key.toLowerCase()];
  if (named) chord.name = named;
  else if ([...key].length !== 1 || !/^[\x21-\x7e]$/.test(key))
    return `"${key}" is not a key; write one character or a name like Esc, Enter, Tab, F1`;
  else if (/^[A-Z]$/.test(key)) {
    chord.name = key.toLowerCase();
    chord.shift = true;
  } else chord.name = key;
  const letter = /^[a-z]$/.test(chord.name);
  if (chord.shift && !letter && !named)
    return `Shift+${key}: write the shifted character itself, like ? for Shift+/`;
  if (!chord.ctrl && !chord.alt && /^[a-z0-9]$/.test(chord.name) && !chord.shift)
    return `a bare ${chord.name} types text; add Ctrl or Alt, or use a capital`;
  if (!chord.ctrl && !chord.alt && ["return", "tab", "space", "backspace"].includes(chord.name))
    return `a bare ${SHOWN[chord.name] ?? chord.name} edits text; add Ctrl or Alt`;
  return chord;
}

/** The canonical spelling, e.g. "Ctrl+Shift+p", "Alt+t", "Y", "Esc". */
export function formatChord(chord: Chord) {
  const name = SHOWN[chord.name] ?? (/^f\d+$/.test(chord.name) ? chord.name.toUpperCase() : null);
  const shown =
    name ??
    (chord.name.length > 1 ? chord.name[0]!.toUpperCase() + chord.name.slice(1) : chord.name);
  const capital = chord.shift && !chord.ctrl && /^[a-z]$/.test(chord.name);
  return [
    chord.ctrl && "Ctrl",
    chord.alt && "Alt",
    chord.shift && !capital && "Shift",
    capital ? chord.name.toUpperCase() : shown,
  ]
    .filter(Boolean)
    .join("+");
}

/** Two chords that a terminal delivers as the same key. Legacy terminals send Ctrl+/ as Ctrl+_. */
const same = (chord: Chord) =>
  formatChord(chord.ctrl && chord.name === "_" ? { ...chord, name: "/" } : chord);

export class KeyConflict extends Error {
  constructor(
    readonly action: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The bindings after the settings file's `keys`, checked against each other, the panes' keys and
 * the targets' capitals. Throws KeyConflict naming the action (`keys.<action>`) and both owners.
 */
export function resolveKeymap(
  overrides: Readonly<Record<string, string>> = {},
  targetKeys: Readonly<Record<string, string>> = {},
): Binding[] {
  for (const action of Object.keys(overrides))
    if (!COMMAND_IDS.includes(action))
      throw new KeyConflict(action, `unknown action; actions are ${COMMAND_IDS.join(", ")}`);
  const taken = new Map<string, string>();
  for (const [key, owner] of Object.entries(PANE_KEYS))
    taken.set(same(parseKey(key) as Chord), owner);
  for (const [key, name] of Object.entries(targetKeys)) taken.set(key, `target ${name}`);
  const bindings: Binding[] = [];
  // Rebound commands claim their keys first, so a conflict is reported at the line that caused it.
  const order = [...COMMANDS].sort((a, b) => +(b.id in overrides) - +(a.id in overrides));
  for (const command of order) {
    const spec = overrides[command.id] ?? command.keys;
    if ("fixed" in command && command.id in overrides)
      throw new KeyConflict(command.id, `${command.keys} is fixed for ${command.id}`);
    const binding: Binding = {
      id: command.id,
      label: command.label,
      hint: "none",
      ...("needs" in command ? { needs: command.needs } : {}),
    };
    if (spec.toLowerCase() !== "none") {
      const chord = parseKey(spec);
      if (typeof chord === "string") throw new KeyConflict(command.id, chord);
      const key = same(chord);
      const owner = taken.get(key);
      if (owner) {
        // Report it where the file caused it: a rebound command, not the default it ran into.
        const blame = !(command.id in overrides) && owner in overrides ? owner : command.id;
        const other = blame === command.id ? owner : command.id;
        throw new KeyConflict(
          blame,
          `${formatChord(chord)} is bound to both ${blame} and ${other}; rebind one of them`,
        );
      }
      taken.set(key, command.id);
      binding.chord = chord;
      binding.hint = formatChord(chord) + ("twice" in command ? " ×2" : "");
    }
    bindings.push(binding);
  }
  return COMMANDS.map((command) => bindings.find((b) => b.id === command.id)!);
}

let active = resolveKeymap();
/** The bindings in effect; `setKeymap` replaces them at startup. */
export const keymap = () => active;
export const setKeymap = (bindings: Binding[]) => {
  active = bindings;
};
export const hintFor = (id: Command, bindings = active) =>
  bindings.find((binding) => binding.id === id)!.hint;

export function chordMatches(chord: Chord, key: KeyEvent) {
  if (key.ctrl !== chord.ctrl || key.meta !== chord.alt) return false;
  if (/^[a-z]$/.test(chord.name))
    return key.name.toLowerCase() === chord.name && key.shift === chord.shift;
  if (chord.name.length === 1)
    return (
      key.sequence === chord.name ||
      key.name === chord.name ||
      (chord.ctrl && chord.name === "/" && key.name === "_")
    );
  return key.name === chord.name && key.shift === chord.shift;
}

export function commandForKey(key: KeyEvent, bindings = active): Command | undefined {
  return bindings.find((binding) => binding.chord && chordMatches(binding.chord, key))?.id;
}

export interface CheatSheet {
  title: string;
  /** `id` is the command's name in the `keys` setting; `fixed` ones cannot be rebound. */
  rows: { keys: string; label: string; id?: string; fixed?: boolean }[];
}

/**
 * The cheat sheet: the global bindings, then the transcript's keys. `available` says which
 * optional actions exist, and `targets` maps each transcript capital to its action.
 */
export function cheatSheet(
  bindings: readonly Binding[],
  available: { shell?: boolean; dictation?: boolean },
  targets: Readonly<Record<string, string>>,
): CheatSheet[] {
  return [
    {
      title: "Anywhere",
      rows: bindings
        .filter((b) => b.chord && (!b.needs || available[b.needs]))
        .map((b) => ({
          keys: b.hint,
          label: b.label,
          id: b.id,
          fixed: COMMANDS.some((c) => c.id === b.id && "fixed" in c),
        })),
    },
    {
      title: "Transcript",
      rows: [
        { keys: "h j k l w b e", label: "Move" },
        { keys: "gg G Ctrl+d Ctrl+u", label: "Top, bottom, half page" },
        { keys: "v V", label: "Select, select lines" },
        { keys: "y yy", label: "Yank selection, yank line" },
        { keys: "i a o", label: "Write in the composer" },
        ...Object.entries(targets).map(([key, action]) => ({
          keys: key,
          label: `${action} block, link or selection`,
        })),
      ],
    },
  ];
}

/** With `names`, a last column gives each command's name for the `keys` setting. */
export const cheatSheetText = (sheet: readonly CheatSheet[], names = false) =>
  sheet
    .map((part) =>
      [
        part.title,
        ...part.rows.map((r) => {
          const line = `  ${r.keys.padEnd(20)}${r.label}`;
          if (!names || !r.id) return line;
          return `${line.padEnd(52)}${r.fixed ? "(fixed)" : r.id}`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
