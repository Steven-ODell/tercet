import { theme, type Color } from "./theme";
/**
 * What a code block's buttons can do: "copy", a settings target's name (copy onto that
 * clipboard), "tmux", "run" or "send". Only actions the user has set up are offered.
 */
export type BlockAction = string;
export interface Target {
  kind: "message" | "code" | "inline" | "file" | "url" | "page" | "image";
  text: string;
  /** Set on code blocks only: the actions this block allows. */
  actions?: readonly BlockAction[];
}
export interface Span {
  target?: Target;
  /** This span is a button that performs the action on its target. */
  action?: BlockAction;
  text: string;
  color?: Color;
  /** Background, set only while the cursor or a selection covers the text. */
  bg?: Color;
  bold?: boolean;
}
export interface MarkdownRow {
  id: string;
  image?: {
    source: string;
    alt: string;
    offset: number;
    height: number;
    id: string;
    right: boolean;
  };
  target?: Target;
  spans: readonly Span[];
  /** Blank or rule row between speakers: drawn, but never selected, clicked or focused. */
  separator?: boolean;
  /** A code block's top, button or bottom row: clickable, but stays out of copied text. */
  chrome?: boolean;
  /** A line of code inside a block. The viewport draws its side borders outside the text. */
  framed?: boolean;
}
export interface Message {
  compact?: boolean;
  action?: boolean;
  id: string | number;
  kind: string;
  text: string;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Border columns on each side of a code line. */
export const FRAME_SIDE = 2;
const SHELL_LANGUAGE = /^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/;
/** Same rule as web: hidden characters can make a command differ from what it shows. */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;
/**
 * Mirrors web's code block toolbar. Nothing can reach a terminal until the fence closes, so a
 * half-streamed command never runs, and only a shell block can run at all.
 */
export function blockActions(
  language: string,
  text: string,
  closed: boolean,
  offered: readonly string[] = [],
): BlockAction[] {
  if (!text.trim()) return [];
  if (!closed) return ["copy"];
  const visible = !HIDDEN_CHARACTER.test(text.replace(/\n/g, ""));
  const runnable = visible && SHELL_LANGUAGE.test(language) && !text.trimEnd().endsWith("\\");
  return [
    "copy",
    ...offered.filter((action) => (action !== "tmux" || visible) && (action !== "run" || runnable)),
  ];
}
function fit(text: string, cells: number) {
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    used += Bun.stringWidth(segment);
    if (used > cells) break;
    result += segment;
  }
  return result;
}
const button = (action: BlockAction, target: Target): Span => ({
  text: `[${action}]`,
  action,
  target,
  color: action === "run" ? theme.green : theme.accent,
  bold: true,
});
/** The top border, with the buttons in it, or on rows of their own when they do not fit. */
function blockTop(language: string, block: Target, width: number, id: string): MarkdownRow[] {
  const buttons = (block.actions ?? []).map((action) => button(action, block));
  const label = fit(language, Math.max(1, width - 6));
  const row = (index: number, spans: Span[]): MarkdownRow => ({
    id: `${id}:${index}`,
    target: block,
    chrome: true,
    spans,
  });
  const line = (cells: number) => ({ text: "─".repeat(Math.max(0, cells)), color: theme.muted });
  const used = 4 + Bun.stringWidth(label);
  const gap: Span = { text: " ", color: theme.muted };
  const buttonCells = buttons.reduce((sum, b) => sum + b.text.length + 1, 0);
  const top = [
    { text: "╭─ ", color: theme.muted },
    { text: label, color: theme.accent, bold: true },
    gap,
  ];
  const close = { text: "─╮", color: theme.muted };
  if (used + 1 + buttonCells + 2 <= width)
    return [
      row(0, [
        ...top,
        line(width - used - 1 - buttonCells - 2),
        gap,
        ...buttons.flatMap((b) => [b, gap]),
        close,
      ]),
    ];
  const rows = [row(0, [...top, line(width - used - 2), close])];
  const inner = Math.max(2, width - FRAME_SIDE * 2);
  let spans: Span[] = [];
  let cells = 0;
  const flush = () => {
    if (!spans.length) return;
    rows.push(
      row(rows.length, [
        { text: "│ ", color: theme.muted },
        ...spans,
        { text: " ".repeat(Math.max(0, inner - cells)) },
        { text: " │", color: theme.muted },
      ]),
    );
    spans = [];
    cells = 0;
  };
  for (const b of buttons) {
    const size = b.text.length + (cells ? 1 : 0);
    if (cells && cells + size > inner) flush();
    if (cells) {
      spans.push(gap);
      cells += 1;
    }
    spans.push(b);
    cells += b.text.length;
  }
  flush();
  return rows;
}
function inline(text: string): Span[] {
  return text
    .split(/(`[^`]*`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>`]+)/g)
    .filter(Boolean)
    .flatMap(bareUrl)
    .map((part) =>
      typeof part !== "string"
        ? part
        : part.startsWith("`")
          ? { text: part.slice(1, -1), color: theme.cyan, target: inlineTarget(part.slice(1, -1)) }
          : part.startsWith("**")
            ? { text: part.slice(2, -2), bold: true }
            : part.startsWith("[")
              ? {
                  text: part.replace(/^\[([^\]]+)\]\(([^)]+)\)$/, "$1 ($2)"),
                  color: theme.cyan,
                  target: linkTarget(part.slice(part.indexOf("](") + 2, -1)),
                }
              : { text: part },
    );
}
/** A bare http(s) URL in prose becomes a link span; trailing punctuation stays plain text. */
function bareUrl(part: string): (string | Span)[] {
  if (!/^https?:\/\//.test(part)) return [part];
  const url = part.replace(/[.,;:!?'"\])}]+$/, "");
  const link: Span = { text: url, color: theme.cyan, target: linkTarget(url) };
  return url.length < part.length ? [link, { text: part.slice(url.length) }] : [link];
}
export function inlineTarget(text: string): Target {
  return /^(?:\.?\.?\/|~\/|[\w.-]+\/)[^\s]+$/.test(text) ||
    /^[\w.-]+\.[a-zA-Z]+(?::\d+(?::\d+)?)?$/.test(text)
    ? { kind: "file", text }
    : { kind: "inline", text };
}
export function linkTarget(text: string): Target {
  if (text.startsWith("tercet-image:")) return { kind: "url", text };
  if (text.startsWith("tercet-page:"))
    return { kind: "page", text: decodeURIComponent(text.slice("tercet-page:".length)) };
  return { kind: /^https?:\/\//.test(text) ? "url" : "file", text };
}
export function code(text: string): Span[] {
  // A small synchronous lexer keeps streaming independent of asynchronous parser workers.
  return text
    .split(
      /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/.*$|#.*$|\b(?:const|let|var|function|return|if|else|class|import|from|export|async|await|def|True|False|true|false|null|None|\d+)\b)/g,
    )
    .filter(Boolean)
    .map((part) => ({
      text: part,
      color: /^(\/\/|#)/.test(part)
        ? theme.muted
        : /^["']/.test(part)
          ? theme.green
          : /^(const|let|var|function|return|if|else|class|import|from|export|async|await|def|True|False|true|false|null|None|\d+)$/.test(
                part,
              )
            ? theme.accent
            : theme.bright,
    }));
}
interface WrappedLine {
  spans: Span[];
  cells: number;
}
/** Break spans into lines of at most `limit` cells; always returns at least one (maybe empty) line. */
function wrap(spans: readonly Span[], limit: number, color: Color | undefined): WrappedLine[] {
  const lines: WrappedLine[] = [];
  let current: Span[] = [],
    cells = 0;
  const flush = () => {
    lines.push({ spans: current, cells });
    cells = 0;
    current = [];
  };
  const graphemes = spans.flatMap((raw) =>
    Array.from(segmenter.segment(raw.text), ({ segment }) => ({
      segment,
      size: Bun.stringWidth(segment),
      span: { ...raw, color: raw.color ?? color },
    })),
  );
  for (let i = 0; i < graphemes.length; i++) {
    const { segment, size, span } = graphemes[i]!;
    // Look across style boundaries: a word can contain bold or clickable spans.
    if (!/\s/u.test(segment) && (i === 0 || /\s/u.test(graphemes[i - 1]!.segment))) {
      let wordCells = 0;
      for (let j = i; j < graphemes.length && !/\s/u.test(graphemes[j]!.segment); j++) {
        wordCells += graphemes[j]!.size;
      }
      if (cells && cells + wordCells > limit) flush();
    }
    if (cells + size > limit && cells) flush();
    const last = current.at(-1);
    if (last && last.color === span.color && last.bold === span.bold && last.target === span.target)
      last.text += segment;
    else current.push({ ...span, text: segment });
    cells += size;
  }
  flush();
  return lines;
}
type Align = "left" | "right" | "center";
interface Table {
  header: string[];
  aligns: Align[];
  body: string[][];
  /** Source lines the table covers: header, delimiter and body rows. */
  lineCount: number;
}
/** Split a table line on unescaped pipes, dropping the optional outer ones. */
function splitCells(line: string): string[] {
  const text = line.trim();
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      current += "|";
      i++;
    } else if (text[i] === "|") {
      cells.push(current);
      current = "";
    } else current += text[i];
  }
  cells.push(current);
  if (text.startsWith("|")) cells.shift();
  if (text.endsWith("|") && !text.endsWith("\\|")) cells.pop();
  return cells;
}
const FENCE_LINE = /^\s*(?:`{3,}|~{3,})/;
/**
 * A table is a pipe line followed by a delimiter row (`---|:-:`) with as many cells. Anything
 * short of that, including a half-streamed header, stays prose and joins the table once it arrives.
 */
function readTable(lines: readonly string[], start: number): Table | undefined {
  const head = lines[start]!;
  const delimiter = lines[start + 1];
  if (delimiter === undefined || !head.includes("|") || !delimiter.includes("|")) return;
  const marks = splitCells(delimiter).map((cell) => cell.trim());
  const header = splitCells(head);
  if (!header.length || marks.length !== header.length || !marks.every((m) => /^:?-+:?$/.test(m)))
    return;
  const body: string[][] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("|") || !line.trim() || FENCE_LINE.test(line)) break;
    body.push(splitCells(line));
  }
  return {
    header,
    aligns: marks.map((m) =>
      m.startsWith(":") && m.endsWith(":") ? "center" : m.endsWith(":") ? "right" : "left",
    ),
    body,
    lineCount: 2 + body.length,
  };
}
/**
 * Rows for one table with every column padded to a shared width. A table wider than the pane
 * shrinks its widest columns and wraps inside the cells; undefined when even that cannot fit.
 * Row ids keep the `<message>:<source line>:<n>` shape, with n counting wrapped lines.
 */
function tableRows(
  item: Message,
  start: number,
  table: Table,
  width: number,
  color: Color | undefined,
): MarkdownRow[] | undefined {
  const columns = table.header.length;
  const grid = [table.header, ...table.body].map((cells, r) =>
    Array.from({ length: columns }, (_, c) =>
      inline((cells[c] ?? "").trim()).map((span) => (r === 0 ? { ...span, bold: true } : span)),
    ),
  );
  const widths = Array.from({ length: columns }, (_, c) =>
    Math.max(1, ...grid.map((cells) => wrap(cells[c]!, Infinity, color)[0]!.cells)),
  );
  // Borders and padding take " │ " per column plus the final "│".
  let excess = widths.reduce((sum, w) => sum + w, 0) + 3 * columns + 1 - width;
  for (; excess > 0; excess--) {
    const widest = widths.indexOf(Math.max(...widths));
    // Two cells is the least that still holds a wide grapheme.
    if (widths[widest]! <= 2) return;
    widths[widest]!--;
  }
  const target: Target = { kind: "message", text: item.text };
  const edge = (text: string): Span => ({ text, color: theme.muted });
  const rows: MarkdownRow[] = [];
  grid.forEach((cells, r) => {
    const wrapped = cells.map((spans, c) => wrap(spans, widths[c]!, color));
    const source = r === 0 ? start : start + 1 + r;
    for (let k = 0; k < Math.max(...wrapped.map((lines) => lines.length)); k++) {
      const spans: Span[] = [edge("│ ")];
      wrapped.forEach((lines, c) => {
        const line = lines[k] ?? { spans: [], cells: 0 };
        const pad = widths[c]! - line.cells;
        const align = table.aligns[c];
        const before = align === "right" ? pad : align === "center" ? Math.floor(pad / 2) : 0;
        if (before) spans.push({ text: " ".repeat(before) });
        spans.push(...line.spans);
        if (pad - before) spans.push({ text: " ".repeat(pad - before) });
        spans.push(edge(c < columns - 1 ? " │ " : " │"));
      });
      rows.push({ id: `${item.id}:${source}:${k}`, target, spans });
    }
    if (r === 0)
      rows.push({
        id: `${item.id}:${start + 1}:0`,
        target,
        spans: [edge(`├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`)],
      });
  });
  return rows;
}
export function measureMarkdown(
  item: Message,
  width: number,
  imageHeight = 12,
  offered: readonly string[] = [],
): MarkdownRow[] {
  const rows: MarkdownRow[] = [];
  const messageColor =
    item.kind === "assistant" ? theme.assistant : item.kind === "user" ? theme.user : undefined;
  let fence: string | null = null;
  let block: Target | undefined;
  // Strip terminal controls from provider text before measuring or displaying it.
  /* oxlint-disable no-control-regex */
  const lines = [
    item.kind.replace(/\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x1f\x7f]/g, " "),
    ...(item.compact && !item.text
      ? []
      : item.text
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g, "")
          .replaceAll("\t", "    ")
          .split("\n")),
  ];
  let tableEnd = 0;
  lines.forEach((line, lineIndex) => {
    if (lineIndex < tableEnd) return;
    if (!fence && lineIndex > 0 && !FENCE_LINE.test(line)) {
      const table = readTable(lines, lineIndex);
      const laidOut = table && tableRows(item, lineIndex, table, width, messageColor);
      if (table && laidOut) {
        tableEnd = lineIndex + table.lineCount;
        rows.push(...laidOut);
        return;
      }
    }
    const image =
      !fence &&
      lineIndex > 0 &&
      /^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^\s]+))(?:\s+"[^"]*")?\)\s*$/.exec(line);
    if (image) {
      const source = image[2] ?? image[3]!;
      const alt = image[1] || "image";
      const target: Target = { kind: "image", text: source };
      const height = Math.max(1, Math.min(12, imageHeight));
      for (let offset = 0; offset < height; offset++)
        rows.push({
          id: `${item.id}:${lineIndex}:${offset}`,
          image: {
            source,
            alt,
            offset,
            height,
            right: item.kind === "user",
            id: `${item.id}:${lineIndex}`,
          },
          chrome: offset !== 0,
          target,
          spans: offset === 0 ? [{ text: `[image ${alt}]`, color: theme.accent, target }] : [],
        });
      return;
    }
    let spans: Span[];
    let target: Target = { kind: "message", text: item.text };
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (match && (!fence || (match[1]![0] === fence[0] && !match[2]!.trim()))) {
      if (fence) {
        fence = null;
        rows.push({
          id: `${item.id}:${lineIndex}:0`,
          target: block,
          chrome: true,
          spans: [{ text: `╰${"─".repeat(Math.max(0, width - 2))}╯`, color: theme.muted }],
        });
      } else {
        const end = lines.findIndex(
          (candidate, i) => i > lineIndex && new RegExp(`^\\s*${match[1]}\\s*$`).test(candidate),
        );
        const text = lines.slice(lineIndex + 1, end < 0 ? undefined : end).join("\n");
        const language = match[2]!.trim().split(/\s+/)[0] ?? "";
        block = { kind: "code", text, actions: blockActions(language, text, end >= 0, offered) };
        fence = match[1]!;
        rows.push(...blockTop(language || "code", block, width, `${item.id}:${lineIndex}`));
      }
      return;
    } else if (fence) {
      spans = code(line);
      target = block ?? target;
    } else if (lineIndex === 0)
      spans = [{ text: line, color: messageColor ?? theme.accent, bold: true }];
    else if (/^#{1,6}\s/.test(line))
      spans = [{ text: line.replace(/^#{1,6}\s+/, ""), color: theme.accent, bold: true }];
    else spans = inline(line.replace(/^(\s*)[-*+]\s+/, "$1• "));
    let offset = 0;
    const framed = fence !== null;
    const limit = Math.max(2, framed ? width - FRAME_SIDE * 2 : width);
    for (const wrapped of wrap(spans, limit, messageColor)) {
      rows.push({
        id: `${item.id}:${lineIndex}:${offset}`,
        spans: wrapped.spans,
        target,
        ...(framed ? { framed } : {}),
      });
      offset += wrapped.cells;
    }
  });
  return rows;
}
const rulePrefix = "rule/";
/**
 * The blank and rule rows drawn above a message that changes speaker. The prefixed id keeps
 * them out of the viewport's per-message lookups: it never equals a message id.
 */
function separatorRows(id: string | number, width: number): MarkdownRow[] {
  return [
    { id: `${rulePrefix}${id}:0:0`, separator: true, spans: [] },
    {
      id: `${rulePrefix}${id}:1:0`,
      separator: true,
      // Cyberdream's muted foreground, dimmer than either speaker color and neither of them.
      spans: [{ text: "─".repeat(Math.max(1, width)), color: theme.muted }],
    },
  ];
}
/** Every user message is set apart, and so is whatever follows one. Agent items run together. */
function changesSpeaker(previous: Message | undefined, item: Message) {
  return previous !== undefined && (previous.kind === "user" || item.kind === "user");
}
/** Reuse measured history; only changed messages are parsed and wrapped again. */
export class MarkdownCache {
  private previous: readonly Message[] = [];
  private previousWidth = 0;
  private measured: MarkdownRow[] = [];
  private tailStart = 0;
  private cache = new Map<
    string | number,
    { text: string; kind: string; width: number; rows: MarkdownRow[]; separator: MarkdownRow[] }
  >();
  private imageHeight = 12;
  private offered = "";
  /** `offered` is the code block actions to draw besides copy, see `blockActions`. */
  rows(
    items: readonly Message[],
    width: number,
    imageHeight = 12,
    offered: readonly string[] = [],
  ) {
    if (imageHeight !== this.imageHeight || offered.join("\n") !== this.offered) {
      this.previous = [];
      this.cache.clear();
      this.imageHeight = imageHeight;
      this.offered = offered.join("\n");
    }
    if (
      width === this.previousWidth &&
      items.length === this.previous.length &&
      items.length > 0 &&
      items.every((item, i) =>
        i === items.length - 1
          ? item.id === this.previous[i]?.id && item.kind === this.previous[i]?.kind
          : item.id === this.previous[i]?.id &&
            item.kind === this.previous[i]?.kind &&
            item.text === this.previous[i]?.text,
      )
    ) {
      const last = items.at(-1)!;
      if (last.text !== this.previous.at(-1)!.text)
        this.measured = [
          ...this.measured.slice(0, this.tailStart),
          ...measureMarkdown(last, width, imageHeight, offered),
        ];
      this.previous = items;
      return this.measured;
    }
    const same = (a: Message | undefined, b: Message | undefined) =>
      a?.id === b?.id && a?.kind === b?.kind && a?.text === b?.text;
    const kept = this.previous.length - 1;
    if (
      width === this.previousWidth &&
      kept >= 0 &&
      items.length > this.previous.length &&
      items.slice(0, kept).every((item, i) => same(item, this.previous[i]))
    ) {
      // Appended messages (a live run): keep every measured row before the old tail and measure
      // the old tail and the new messages only, instead of rebuilding the whole list (P7).
      // tailStart keeps the old tail's separator, so only its own rows are measured again.
      const result = this.measured.slice(0, this.tailStart);
      for (let index = kept; index < items.length; index++)
        for (const row of this.itemRows(items, index, width, imageHeight, offered, index > kept))
          result.push(row);
      return this.finish(items, width, result);
    }
    const live = new Set(items.map((item) => item.id));
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
    const result = items.flatMap((_, index) =>
      this.itemRows(items, index, width, imageHeight, offered),
    );
    return this.finish(items, width, result);
  }
  private itemRows(
    items: readonly Message[],
    index: number,
    width: number,
    imageHeight: number,
    offered: readonly string[],
    separator = true,
  ) {
    const item = items[index]!;
    let cached = this.cache.get(item.id);
    if (
      !cached ||
      cached.text !== item.text ||
      cached.kind !== item.kind ||
      cached.width !== width
    ) {
      cached = {
        ...item,
        width,
        rows: measureMarkdown(item, width, imageHeight, offered),
        separator: cached?.width === width ? cached.separator : separatorRows(item.id, width),
      };
      this.cache.set(item.id, cached);
    }
    return separator && changesSpeaker(items[index - 1], item)
      ? [...cached.separator, ...cached.rows]
      : cached.rows;
  }
  private finish(items: readonly Message[], width: number, result: MarkdownRow[]) {
    this.previous = items;
    this.previousWidth = width;
    this.measured = result;
    this.tailStart = result.length - (this.cache.get(items.at(-1)?.id ?? "")?.rows.length ?? 0);
    return result;
  }
}
export function anchorIndex(rows: readonly MarkdownRow[], anchor: string | null, height: number) {
  if (anchor === null) return Math.max(0, rows.length - height);
  const exact = rows.findIndex((row) => row.id === anchor);
  if (exact >= 0) return exact;
  const colon = anchor.lastIndexOf(":");
  if (anchor.startsWith(rulePrefix)) {
    // The rule's neighbor changed and it is gone; stay on the message it sat above.
    const message = anchor.slice(rulePrefix.length, anchor.lastIndexOf(":", colon - 1) + 1);
    return Math.max(
      0,
      rows.findIndex((row) => row.id.startsWith(message)),
    );
  }
  // A width change may move the anchor cell into a different wrapped row.
  const prefix = anchor.slice(0, colon + 1),
    cell = Number(anchor.slice(colon + 1));
  let index = 0;
  rows.forEach((row, i) => {
    if (row.id.startsWith(prefix) && Number(row.id.slice(prefix.length)) <= cell) index = i;
  });
  return index;
}
