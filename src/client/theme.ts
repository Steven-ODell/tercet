import { RGBA, type ColorInput } from "@opentui/core";
import type { ProjectIconColor } from "@t3tools/contracts";

/** A color opentui can draw: "#rrggbb", or an RGBA that may carry an ANSI palette index. */
export type Color = ColorInput;

/**
 * Every color the UI draws, by role. Components read `theme.<role>` while rendering; `setTheme`
 * fills it once at startup from settings, before the first frame.
 */
export interface Theme {
  /** Panels, overlays and the frame behind them. */
  canvas: Color;
  /** Connection and hello screens. */
  surface: Color;
  /** List rows and ordinary UI text. */
  text: Color;
  /** File names, diff context, code. */
  bright: Color;
  /** The selected row's text. */
  strong: Color;
  /** Text that names no color of its own (opentui would draw it white). */
  plain: Color;
  /** Hints, timestamps, frames around code. */
  muted: Color;
  /** Focus, titles, buttons. */
  accent: Color;
  /** Unfocused pane borders. */
  border: Color;
  /** The selected row's background. */
  highlight: Color;
  /** Sidebar rules between groups. */
  rule: Color;
  /** Vim visual selection background. */
  selection: Color;
  /** Text under the vim cursor, which is drawn in the accent. */
  cursorText: Color;
  red: Color;
  green: Color;
  yellow: Color;
  blue: Color;
  cyan: Color;
  pink: Color;
  /** The assistant's and the user's message text. */
  assistant: Color;
  user: Color;
  /** Text typed in the composer. */
  input: Color;
  /** The embedded terminal's 16 ANSI colors and its default text. */
  ansi: readonly Color[];
  terminalText: Color;
  /** Web's project icon colors. */
  project: Readonly<Record<ProjectIconColor, Color>>;
}

// Web's dark `text-<color>-400` classes (apps/web/src/projectIconColors.ts), as Tailwind 4 renders them.
const webDark: Theme["project"] = {
  gray: "#99a1af",
  red: "#ff6467",
  orange: "#ff8904",
  amber: "#ffb900",
  yellow: "#fdc700",
  lime: "#9ae600",
  green: "#05df72",
  emerald: "#00d492",
  teal: "#00d5be",
  cyan: "#00d3f2",
  sky: "#00bcff",
  blue: "#51a2ff",
  indigo: "#7c86ff",
  violet: "#a684ff",
  purple: "#c27aff",
  fuchsia: "#ed6aff",
  pink: "#fb64b6",
  rose: "#ff637e",
};

// The same colors one step darker (`-600`), readable on white.
const webLight: Theme["project"] = {
  gray: "#4a5565",
  red: "#e7000b",
  orange: "#f54900",
  amber: "#e17100",
  yellow: "#a65f00",
  lime: "#497d00",
  green: "#008236",
  emerald: "#007a55",
  teal: "#00786f",
  cyan: "#007595",
  sky: "#0069a8",
  blue: "#155dfc",
  indigo: "#4f39f6",
  violet: "#7f22fe",
  purple: "#9810fa",
  fuchsia: "#c800de",
  pink: "#e60076",
  rose: "#ec003f",
};

/** Hex equivalents of the fork's Cyberdream palette (themePalettes.ts), without its orange. */
const cyberdream: Theme = {
  canvas: "#0d0d12",
  surface: "#16181a",
  text: "#c29cf8",
  bright: "#dae0ef",
  strong: "#ffffff",
  plain: "#ffffff",
  muted: "#9180ad",
  accent: "#b07cf5",
  border: "#302944",
  highlight: "#302944",
  rule: "#4a3f63",
  selection: "#4a3a7a",
  cursorText: "#0d0d12",
  red: "#ff6e5e",
  green: "#5eff6c",
  yellow: "#f1ff5e",
  blue: "#5ea1ff",
  cyan: "#5ef1ff",
  pink: "#ff5ea0",
  assistant: "#9ef3ff",
  user: "#5eff6c",
  input: "#5eff6c",
  ansi: [
    "#16181a",
    "#ff6e5e",
    "#5eff6c",
    "#f1ff5e",
    "#5ea1ff",
    "#bd5eff",
    "#5ef1ff",
    "#ffffff",
    "#3c4048",
    "#ff6e5e",
    "#5eff6c",
    "#f1ff5e",
    "#5ea1ff",
    "#bd5eff",
    "#5ef1ff",
    "#ffffff",
  ],
  terminalText: "#c29cf8",
  project: webDark,
};

/** Cyberdream's light variant, purple accent kept, darkened until text reads on white. */
const light: Theme = {
  canvas: "#ffffff",
  surface: "#f4f4f6",
  text: "#5a2d9c",
  bright: "#16181a",
  strong: "#000000",
  plain: "#16181a",
  muted: "#6b6480",
  accent: "#7c3aed",
  border: "#d9d0ea",
  highlight: "#e9e0f8",
  rule: "#c9bfdc",
  selection: "#d7c4f7",
  cursorText: "#ffffff",
  red: "#c01400",
  green: "#00720a",
  yellow: "#7a6200",
  blue: "#0050c0",
  cyan: "#006f7a",
  pink: "#c8005a",
  assistant: "#00586b",
  user: "#00720a",
  input: "#00720a",
  ansi: [
    "#16181a",
    "#c01400",
    "#00720a",
    "#7a6200",
    "#0050c0",
    "#a400a0",
    "#006f7a",
    "#6b6480",
    "#7b8496",
    "#d11500",
    "#008b0c",
    "#997b00",
    "#0057d1",
    "#d100bf",
    "#008c99",
    "#16181a",
  ],
  terminalText: "#16181a",
  project: webLight,
};

const index = (n: number) => RGBA.fromIndex(n);

/**
 * The terminal's own 16 colors and its default text and background, so it follows whatever palette
 * the terminal has. Text uses the bright half (9-15): the dark half's 0x80 levels in many default
 * palettes are too dim on a dark background. Nothing here is a 24-bit color.
 */
const ansi: Theme = {
  canvas: RGBA.defaultBackground(),
  surface: RGBA.defaultBackground(),
  text: RGBA.defaultForeground(),
  bright: RGBA.defaultForeground(),
  strong: index(15),
  plain: RGBA.defaultForeground(),
  muted: index(8),
  accent: index(13),
  border: index(8),
  highlight: index(4),
  rule: index(8),
  selection: index(4),
  cursorText: index(0),
  red: index(9),
  green: index(10),
  yellow: index(11),
  blue: index(12),
  cyan: index(14),
  pink: index(13),
  assistant: index(14),
  user: index(10),
  input: index(10),
  ansi: Array.from({ length: 16 }, (_, n) => index(n)),
  terminalText: RGBA.defaultForeground(),
  project: {
    gray: index(8),
    red: index(9),
    orange: index(11),
    amber: index(11),
    yellow: index(11),
    lime: index(10),
    green: index(10),
    emerald: index(10),
    teal: index(14),
    cyan: index(14),
    sky: index(14),
    blue: index(12),
    indigo: index(12),
    violet: index(13),
    purple: index(13),
    fuchsia: index(13),
    pink: index(13),
    rose: index(9),
  },
};

export const PRESETS = { cyberdream, light, ansi } as const;
export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export const theme: Theme = { ...cyberdream };

/** Applies a preset and an optional accent override. Call before the first render. */
export function setTheme(settings: { preset?: string; accent?: string } = {}) {
  const preset = PRESETS[(settings.preset ?? "cyberdream") as PresetName] ?? cyberdream;
  Object.assign(theme, preset);
  if (settings.accent) theme.accent = settings.accent;
}

/** The color as 0-255 RGB, resolving palette indexes through xterm's default palette. */
export function rgbOf(color: Color): [number, number, number] {
  const rgba = typeof color === "string" ? RGBA.fromHex(color) : color;
  const [r, g, b] = rgba.toInts();
  return [r, g, b];
}
