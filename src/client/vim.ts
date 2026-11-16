import { theme } from "./theme";
import type { MarkdownRow, Span } from "./markdown";

/** A place in the transcript: a measured row and a grapheme index inside it. */
export interface Pos {
  row: number;
  col: number;
}
export type VisualMode = "char" | "line";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = new WeakMap<MarkdownRow, string[]>();
/** The row's text, one entry per grapheme. Rows are immutable, so this is computed once. */
export function cellsOf(row: MarkdownRow): string[] {
  let cells = graphemes.get(row);
  if (!cells) {
    cells = [...segmenter.segment(row.spans.map((s) => s.text).join(""))].map((s) => s.segment);
    graphemes.set(row, cells);
  }
  return cells;
}
/** Separators and code block chrome hold no text, so the cursor never lands on them. */
export const isText = (row: MarkdownRow | undefined): row is MarkdownRow =>
  !!row && !row.separator && !row.chrome;
/** Wrapped pieces of one source line share this key (`<message>:<line>`). */
const lineKey = (row: MarkdownRow) => row.id.slice(0, row.id.lastIndexOf(":"));

export function firstText(rows: readonly MarkdownRow[]) {
  return rows.findIndex(isText);
}
export function lastText(rows: readonly MarkdownRow[]) {
  return rows.findLastIndex(isText);
}
/** The grapheme under a terminal cell, for placing the cursor with a click. */
export function colAt(row: MarkdownRow, cell: number) {
  let left = Math.max(0, cell);
  const cells = cellsOf(row);
  for (let i = 0; i < cells.length; i++) {
    left -= Bun.stringWidth(cells[i]!);
    if (left < 0) return i;
  }
  return Math.max(0, cells.length - 1);
}
const clampCol = (rows: readonly MarkdownRow[], pos: Pos): Pos => ({
  row: pos.row,
  col: Math.max(0, Math.min(Math.max(0, cellsOf(rows[pos.row]!).length - 1), pos.col)),
});
/** Move `count` text rows up (negative) or down, keeping the column as close as `want`. */
export function moveRows(rows: readonly MarkdownRow[], pos: Pos, count: number, want: number): Pos {
  const step = count < 0 ? -1 : 1;
  let row = pos.row;
  for (let left = Math.abs(count); left > 0; left--) {
    let next = row + step;
    while (rows[next] && !isText(rows[next])) next += step;
    if (!isText(rows[next])) break;
    row = next;
  }
  return clampCol(rows, { row, col: want });
}
export function moveCols(rows: readonly MarkdownRow[], pos: Pos, count: number): Pos {
  return clampCol(rows, { row: pos.row, col: pos.col + count });
}
export function lineStart(rows: readonly MarkdownRow[], pos: Pos, firstNonBlank: boolean): Pos {
  const cells = cellsOf(rows[pos.row]!);
  const col = firstNonBlank ? cells.findIndex((c) => c.trim() !== "") : 0;
  return { row: pos.row, col: Math.max(0, col) };
}
export function lineEnd(rows: readonly MarkdownRow[], pos: Pos): Pos {
  return clampCol(rows, { row: pos.row, col: Infinity });
}

// Words. Each line also has a virtual blank cell after its last grapheme, so a word never runs
// across a row boundary and `w` / `b` / `e` step from line to line like in an editor.
const kind = (cell: string | undefined) =>
  cell === undefined || cell.trim() === "" ? 0 : /[\p{L}\p{N}_]/u.test(cell) ? 1 : 2;
const kindAt = (rows: readonly MarkdownRow[], pos: Pos) => kind(cellsOf(rows[pos.row]!)[pos.col]);
function forward(rows: readonly MarkdownRow[], pos: Pos): Pos | undefined {
  if (pos.col < cellsOf(rows[pos.row]!).length) return { row: pos.row, col: pos.col + 1 };
  let row = pos.row + 1;
  while (rows[row] && !isText(rows[row])) row++;
  return rows[row] ? { row, col: 0 } : undefined;
}
function backward(rows: readonly MarkdownRow[], pos: Pos): Pos | undefined {
  if (pos.col > 0) return { row: pos.row, col: pos.col - 1 };
  let row = pos.row - 1;
  while (rows[row] && !isText(rows[row])) row--;
  return rows[row] ? { row, col: cellsOf(rows[row]!).length } : undefined;
}
export function wordForward(rows: readonly MarkdownRow[], from: Pos): Pos {
  let pos: Pos | undefined = from;
  const start = kindAt(rows, from);
  while (pos && start !== 0 && kindAt(rows, pos) === start) pos = forward(rows, pos);
  while (pos && kindAt(rows, pos) === 0) pos = forward(rows, pos);
  return pos ?? lineEnd(rows, { row: lastText(rows), col: 0 });
}
export function wordBack(rows: readonly MarkdownRow[], from: Pos): Pos {
  let pos = backward(rows, from);
  while (pos && kindAt(rows, pos) === 0) pos = backward(rows, pos);
  if (!pos) return from;
  const group = kindAt(rows, pos);
  for (let before = backward(rows, pos); before && kindAt(rows, before) === group;) {
    pos = before;
    before = backward(rows, pos);
  }
  return pos;
}
export function wordEnd(rows: readonly MarkdownRow[], from: Pos): Pos {
  let pos = forward(rows, from);
  while (pos && kindAt(rows, pos) === 0) pos = forward(rows, pos);
  if (!pos) return from;
  const group = kindAt(rows, pos);
  for (let after = forward(rows, pos); after && kindAt(rows, after) === group;) {
    pos = after;
    after = forward(rows, pos);
  }
  return pos;
}

const before = (a: Pos, b: Pos) => a.row < b.row || (a.row === b.row && a.col <= b.col);
/**
 * What a selection covers. Line mode takes every wrapped piece of the first and last source
 * lines, because a wrapped paragraph is one line to the person reading it.
 */
export function selectionRange(
  rows: readonly MarkdownRow[],
  anchor: Pos,
  cursor: Pos,
  mode: VisualMode,
) {
  let [start, end] = before(anchor, cursor) ? [anchor, cursor] : [cursor, anchor];
  if (mode === "line") {
    let first = start.row;
    while (isText(rows[first - 1]) && lineKey(rows[first - 1]!) === lineKey(rows[start.row]!))
      first--;
    let last = end.row;
    while (isText(rows[last + 1]) && lineKey(rows[last + 1]!) === lineKey(rows[end.row]!)) last++;
    start = { row: first, col: 0 };
    end = { row: last, col: Infinity };
  }
  return { start, end };
}
/** The columns of one row inside the selection, as `[from, to)`; undefined when outside it. */
export function selectedColumns(
  rows: readonly MarkdownRow[],
  range: ReturnType<typeof selectionRange>,
  index: number,
): [number, number] | undefined {
  const row = rows[index];
  if (!isText(row) || index < range.start.row || index > range.end.row) return;
  const size = cellsOf(row).length;
  return [
    index === range.start.row ? range.start.col : 0,
    index === range.end.row ? Math.min(size, range.end.col + 1) : size,
  ];
}
/** The selected text. Wrapped pieces of one source line rejoin; other lines are split by newlines. */
export function selectionText(
  rows: readonly MarkdownRow[],
  anchor: Pos,
  cursor: Pos,
  mode: VisualMode,
) {
  const range = selectionRange(rows, anchor, cursor, mode);
  let text = "";
  let previous: MarkdownRow | undefined;
  for (let i = range.start.row; i <= range.end.row; i++) {
    const columns = selectedColumns(rows, range, i);
    if (!columns || rows[i]?.image) continue;
    const row = rows[i]!;
    if (previous) text += lineKey(previous) === lineKey(row) ? "" : "\n";
    text += cellsOf(row).slice(columns[0], columns[1]).join("");
    previous = row;
  }
  return text;
}

/**
 * The row's spans with the selected columns and the cursor cell painted. Spans keep their
 * targets, so hover and click behave the same inside a selection.
 */
export function paint(
  spans: readonly Span[],
  selected: [number, number] | undefined,
  cursor: number | undefined,
): readonly Span[] {
  if (!selected && cursor === undefined) return spans;
  const out: Span[] = [];
  let index = 0;
  for (const span of spans) {
    for (const { segment } of segmenter.segment(span.text)) {
      const style: Partial<Span> =
        index === cursor
          ? { color: theme.cursorText, bg: theme.accent }
          : selected && index >= selected[0] && index < selected[1]
            ? { bg: theme.selection }
            : {};
      const last = out.at(-1);
      if (
        last &&
        last.target === span.target &&
        last.action === span.action &&
        last.bold === span.bold &&
        last.underline === span.underline &&
        last.bg === style.bg &&
        last.color === (style.color ?? span.color)
      )
        last.text += segment;
      else out.push({ ...span, ...style, color: style.color ?? span.color, text: segment });
      index++;
    }
  }
  // An empty line still shows where the cursor is.
  if (cursor !== undefined && cursor >= index)
    out.push({ text: " ", color: theme.cursorText, bg: theme.accent });
  return out;
}
