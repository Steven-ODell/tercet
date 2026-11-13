import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";
import type { Terminal } from "@xterm/headless";
import { theme, type Color } from "./theme";

/** True when the theme draws with the terminal's own palette; 16-255 then stay indexes too. */
const indexed = () => typeof theme.ansi[0] !== "string";
const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("");

// The theme's 16 ANSI colors; 16-255 follow the standard xterm cube and gray ramp.
export function paletteColor(index: number): Color {
  if (index < 16) return theme.ansi[index]!;
  if (indexed()) return RGBA.fromIndex(index);
  if (index >= 232) {
    const gray = 8 + 10 * (index - 232);
    return hex(gray, gray, gray);
  }
  const level = (value: number) => (value ? 55 + 40 * value : 0);
  const n = index - 16;
  return hex(level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6));
}

const rgbaCache = new Map<string, RGBA>();
function rgba(color: Color) {
  if (typeof color !== "string") return color;
  let value = rgbaCache.get(color);
  if (!value) rgbaCache.set(color, (value = RGBA.fromHex(color)));
  return value;
}

const colorKey = (color: Color | undefined) =>
  color === undefined || typeof color === "string" ? color : `${color.intent}${color.slot}${color}`;

/**
 * The visible screen as one styled text, a row per line. Rows are padded to full width so cell
 * backgrounds and the cursor block draw where the shell put them.
 */
export function screenText(term: Terminal, showCursor: boolean) {
  const buffer = term.buffer.active;
  const chunks: TextChunk[] = [];
  const cursorRow = buffer.viewportY === buffer.baseY ? buffer.cursorY : -1;
  const cursorCol = Math.min(buffer.cursorX, term.cols - 1);
  let cell = buffer.getNullCell();
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    let text = "";
    let style = "";
    let fg: Color | undefined;
    let bg: Color | undefined;
    let attributes = 0;
    const flush = () => {
      if (text)
        chunks.push({
          __isChunk: true,
          text,
          fg: rgba(fg ?? theme.terminalText),
          ...(bg ? { bg: rgba(bg) } : {}),
          attributes,
        });
      text = "";
    };
    for (let x = 0; x < term.cols; x++) {
      cell = line?.getCell(x, cell) ?? buffer.getNullCell();
      if (cell.getWidth() === 0) continue;
      let cellFg = cell.isFgDefault()
        ? undefined
        : cell.isFgRGB()
          ? "#" + cell.getFgColor().toString(16).padStart(6, "0")
          : paletteColor(cell.getFgColor());
      let cellBg = cell.isBgDefault()
        ? undefined
        : cell.isBgRGB()
          ? "#" + cell.getBgColor().toString(16).padStart(6, "0")
          : paletteColor(cell.getBgColor());
      if (!!cell.isInverse() !== (showCursor && y === cursorRow && x === cursorCol))
        [cellFg, cellBg] = [cellBg ?? theme.canvas, cellFg ?? theme.terminalText];
      const cellAttributes =
        (cell.isBold() ? TextAttributes.BOLD : 0) |
        (cell.isDim() ? TextAttributes.DIM : 0) |
        (cell.isItalic() ? TextAttributes.ITALIC : 0) |
        (cell.isUnderline() ? TextAttributes.UNDERLINE : 0) |
        (cell.isStrikethrough() ? TextAttributes.STRIKETHROUGH : 0);
      const cellStyle = `${colorKey(cellFg)}|${colorKey(cellBg)}|${cellAttributes}`;
      if (cellStyle !== style) {
        flush();
        style = cellStyle;
        fg = cellFg;
        bg = cellBg;
        attributes = cellAttributes;
      }
      text += cell.isInvisible() ? " " : cell.getChars() || " ";
    }
    flush();
    if (y < term.rows - 1) chunks.push({ __isChunk: true, text: "\n" });
  }
  return new StyledText(chunks);
}

type Key = {
  name: string;
  ctrl: boolean;
  shift: boolean;
  sequence: string;
  raw: string;
  source: "raw" | "kitty";
};
const cursorKeys: Record<string, string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
};
const tildeKeys: Record<string, number> = {
  insert: 2,
  delete: 3,
  pageup: 5,
  pagedown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
};
const functionKeys: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };

/**
 * The bytes a shell expects for a key. Named keys are re-encoded rather than forwarded because
 * the outer terminal may speak the kitty protocol, which the shell inside did not ask for.
 */
export function encodeKey(key: Key, applicationCursor: boolean) {
  const modifier = 1 + (key.shift ? 1 : 0) + (key.ctrl ? 4 : 0);
  const cursor = cursorKeys[key.name];
  if (cursor)
    return modifier > 1
      ? `\x1b[1;${modifier}${cursor}`
      : `\x1b${applicationCursor ? "O" : "["}${cursor}`;
  const tilde = tildeKeys[key.name];
  if (tilde) return modifier > 1 ? `\x1b[${tilde};${modifier}~` : `\x1b[${tilde}~`;
  const fn = functionKeys[key.name];
  if (fn) return `\x1bO${fn}`;
  if (key.name === "return" || key.name === "enter") return "\r";
  if (key.name === "linefeed") return "\n";
  if (key.name === "tab") return key.shift ? "\x1b[Z" : "\t";
  if (key.name === "backspace") return key.ctrl ? "\b" : "\x7f";
  if (key.name === "escape") return "\x1b";
  if (key.name === "space") return key.ctrl ? "\0" : " ";
  if (key.ctrl && /^[a-z[\\\]^_]$/.test(key.name))
    return String.fromCharCode(key.name.toUpperCase().charCodeAt(0) - 64);
  if (key.source === "raw" && key.raw) return key.raw;
  if (key.sequence && !key.sequence.startsWith("\x1b") && key.sequence.charCodeAt(0) >= 32)
    return key.sequence;
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name;
  return undefined;
}
