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
  /** Clickable transcript links, independent of prose and inline code. */
  link?: Color;
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

// ---- Presets built from a base palette -------------------------------------------------------

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** `amount` of `b` mixed into `a`. */
const mix = (a: string, b: string, amount: number) => {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex(x.map((v, i) => v + (y[i]! - v) * amount) as Rgb);
};
const relativeLuminance = (hex: string) => {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrastOf = (a: string, b: string) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** `color`, nudged toward `toward` just far enough to reach `minimum` contrast on `bg`. */
const legible = (color: string, bg: string, toward: string, minimum = 3.6) => {
  for (let amount = 0; amount <= 1; amount += 0.04) {
    const candidate = mix(color, toward, amount);
    if (contrastOf(candidate, bg) >= minimum) return candidate;
  }
  return toward;
};

/**
 * What a preset author picks. Everything else in `Theme` (borders, the selected row, the vim
 * selection, the terminal's 16 colors) is derived from these. A text color that would fall under
 * 3.6:1 on the canvas is nudged toward the text color until it clears it, so a faithful palette
 * (Catppuccin Latte's yellow, say) still reads.
 */
interface Palette {
  dark: boolean;
  bg: string;
  /** Overlays and the connection screen. Default: the canvas, nudged toward the text. */
  surface?: string;
  fg: string;
  /** Hints, timestamps, unfocused titles. */
  muted: string;
  accent: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  cyan: string;
  /** Used for `pink`, and for ANSI magenta unless `purple` is given. */
  pink: string;
  purple?: string;
  /** Overrides for any role a palette wants to set itself. */
  roles?: Partial<Omit<Theme, "ansi" | "project">>;
}

function fromPalette(p: Palette): Theme {
  const extreme = p.dark ? "#ffffff" : "#000000";
  const ink = (color: string) => legible(color, p.bg, p.fg);
  const [red, green, yellow, blue, cyan, pink] = [p.red, p.green, p.yellow, p.blue, p.cyan, p.pink].map(ink) as [
    string, string, string, string, string, string,
  ];
  const purple = ink(p.purple ?? p.pink);
  const accent = ink(p.accent);
  const highlight = mix(p.bg, p.accent, p.dark ? 0.2 : 0.16);
  // Muted text also shows on the selected row, so it has to clear that background too.
  const muted = legible(ink(p.muted), highlight, p.fg, 3.1);
  const bright = mix(p.fg, extreme, 0.3);
  const dark = p.dark;
  return {
    canvas: p.bg,
    surface: p.surface ?? mix(p.bg, p.fg, dark ? 0.05 : 0.04),
    text: p.fg,
    bright,
    strong: mix(p.fg, extreme, 0.75),
    plain: bright,
    muted,
    accent,
    border: mix(p.bg, p.fg, 0.2),
    highlight,
    rule: mix(p.bg, p.fg, 0.3),
    selection: mix(p.bg, p.accent, 0.34),
    cursorText: p.bg,
    red,
    green,
    yellow,
    blue,
    cyan,
    pink,
    assistant: cyan,
    user: green,
    input: green,
    ansi: [
      dark ? mix(p.bg, p.fg, 0.08) : p.fg,
      red,
      green,
      yellow,
      blue,
      purple,
      cyan,
      dark ? p.fg : muted,
      dark ? muted : mix(p.bg, p.fg, 0.55),
      red,
      green,
      yellow,
      blue,
      purple,
      cyan,
      dark ? extreme : p.fg,
    ],
    terminalText: p.fg,
    project: dark ? webDark : webLight,
    ...p.roles,
  };
}

// A neutral dark: grays with one muted steel-blue accent, and colors only where a status needs one.
const dark = fromPalette({
  dark: true,
  bg: "#141414",
  surface: "#1b1b1b",
  fg: "#bdbdbd",
  muted: "#858585",
  accent: "#8fa8c4",
  red: "#d18585",
  green: "#8fb59a",
  yellow: "#c9b87a",
  blue: "#7f9bbd",
  cyan: "#7fb0b5",
  pink: "#b88fa8",
  purple: "#a597bd",
  roles: { assistant: "#d6d6d6", user: "#8fb59a", input: "#d6d6d6", text: "#bdbdbd" },
});

// Three of our own, in the Cyberdream spirit: solid, slightly pastel colors with room between them.
const dusk = fromPalette({
  dark: true,
  bg: "#1b1721",
  fg: "#e4d8ea",
  muted: "#9a8aa8",
  accent: "#f2a07b",
  red: "#ef7d8a",
  green: "#a8d28f",
  yellow: "#f3cf7e",
  blue: "#82b2ea",
  cyan: "#7fd3d0",
  pink: "#f08fba",
  purple: "#bb9cea",
});
const lagoon = fromPalette({
  dark: true,
  bg: "#0c1a1f",
  fg: "#cfe6e4",
  muted: "#78a0a0",
  accent: "#52d4c4",
  red: "#f0786f",
  green: "#80dc9c",
  yellow: "#e9d06c",
  blue: "#70b6f2",
  cyan: "#62d6ea",
  pink: "#e68cb7",
  purple: "#a98ff2",
});
const sand = fromPalette({
  dark: false,
  bg: "#faf4e8",
  surface: "#f1e9d8",
  fg: "#3b3228",
  muted: "#7d6f5e",
  accent: "#b5541c",
  red: "#b3261e",
  green: "#4a7a24",
  yellow: "#8a6200",
  blue: "#2b5fa8",
  cyan: "#0f7a7a",
  pink: "#b0356f",
  purple: "#6f42b0",
});

// Popular palettes, from their published colors.
const catppuccinMocha = fromPalette({
  dark: true,
  bg: "#1e1e2e",
  surface: "#181825",
  fg: "#cdd6f4",
  muted: "#8087a2",
  accent: "#cba6f7",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  cyan: "#94e2d5",
  pink: "#f5c2e7",
  purple: "#cba6f7",
});
const catppuccinLatte = fromPalette({
  dark: false,
  bg: "#eff1f5",
  surface: "#e6e9ef",
  fg: "#4c4f69",
  muted: "#6c6f85",
  accent: "#8839ef",
  red: "#d20f39",
  green: "#40a02b",
  yellow: "#df8e1d",
  blue: "#1e66f5",
  cyan: "#179299",
  pink: "#ea76cb",
  purple: "#8839ef",
});
const tokyoNight = fromPalette({
  dark: true,
  bg: "#1a1b26",
  surface: "#16161e",
  fg: "#c0caf5",
  muted: "#737aa2",
  accent: "#7aa2f7",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  pink: "#ff8fb1",
  purple: "#bb9af7",
});
const gruvbox = fromPalette({
  dark: true,
  bg: "#282828",
  surface: "#1d2021",
  fg: "#ebdbb2",
  muted: "#a89984",
  accent: "#fe8019",
  red: "#fb4934",
  green: "#b8bb26",
  yellow: "#fabd2f",
  blue: "#83a598",
  cyan: "#8ec07c",
  pink: "#d3869b",
});
const nord = fromPalette({
  dark: true,
  bg: "#2e3440",
  surface: "#3b4252",
  fg: "#d8dee9",
  muted: "#8892a6",
  accent: "#88c0d0",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  cyan: "#8fbcbb",
  pink: "#b48ead",
});
const rosePine = fromPalette({
  dark: true,
  bg: "#191724",
  surface: "#1f1d2e",
  fg: "#e0def4",
  muted: "#908caa",
  accent: "#c4a7e7",
  red: "#eb6f92",
  green: "#7fbfa5",
  yellow: "#f6c177",
  blue: "#3e8fb0",
  cyan: "#9ccfd8",
  pink: "#ebbcba",
  purple: "#c4a7e7",
});
const dracula = fromPalette({
  dark: true,
  bg: "#282a36",
  surface: "#21222c",
  fg: "#f8f8f2",
  muted: "#8d98c4",
  accent: "#bd93f9",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#8ba4ff",
  cyan: "#8be9fd",
  pink: "#ff79c6",
  purple: "#bd93f9",
});
const oneDark = fromPalette({
  dark: true,
  bg: "#282c34",
  surface: "#21252b",
  fg: "#abb2bf",
  muted: "#7f8798",
  accent: "#61afef",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  cyan: "#56b6c2",
  pink: "#c678dd",
});

export const PRESETS = {
  cyberdream,
  light,
  ansi,
  dark,
  dusk,
  lagoon,
  sand,
  "catppuccin-mocha": catppuccinMocha,
  "catppuccin-latte": catppuccinLatte,
  "tokyo-night": tokyoNight,
  gruvbox,
  nord,
  "rose-pine": rosePine,
  dracula,
  "one-dark": oneDark,
} as const;
export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

/** What `theme.preset` accepts: a preset, or `auto` to pick one from the terminal's background. */
export const THEME_CHOICES = [...PRESET_NAMES, "auto"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** The presets `auto` picks between. */
export const AUTO_PRESETS = { dark: "cyberdream", light: "light" } as const satisfies Record<
  "dark" | "light",
  PresetName
>;

/** The preset a setting means; `appearance` is what the terminal looks like, when it is known. */
export function resolvePreset(
  choice: string | undefined,
  appearance?: "dark" | "light" | null,
): PresetName {
  if (choice === "auto") return AUTO_PRESETS[appearance ?? "dark"];
  return choice && choice in PRESETS ? (choice as PresetName) : "cyberdream";
}

export const theme: Theme = { ...cyberdream };

/** Applies a preset and an optional accent override. Call before the first render. */
export function setTheme(
  settings: { preset?: string; accent?: string; link?: string } = {},
  appearance?: "dark" | "light" | null,
) {
  Object.assign(theme, PRESETS[resolvePreset(settings.preset, appearance)]);
  if (settings.accent) theme.accent = settings.accent;
  theme.link = settings.link ?? theme.blue;
}

/** The color as 0-255 RGB, resolving palette indexes through xterm's default palette. */
export function rgbOf(color: Color): [number, number, number] {
  const rgba = typeof color === "string" ? RGBA.fromHex(color) : color;
  const [r, g, b] = rgba.toInts();
  return [r, g, b];
}
