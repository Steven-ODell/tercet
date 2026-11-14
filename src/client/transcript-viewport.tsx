import { theme } from "./theme";
import { ImagePreview } from "./image-preview";
import { mediaKind } from "./media";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { HintsShown } from "./keymap";
import {
  failureText,
  keyHints,
  mediaActions,
  offeredActions,
  targetKeys,
  targetNames,
  type Actions,
} from "../actions";
import type { BlockAction, Span, Target } from "./markdown";
import { useSelectionHandler, useKeyboard } from "@opentui/react";
import { FRAME_SIDE, MarkdownCache, anchorIndex, type MarkdownRow, type Message } from "./markdown";
import {
  colAt,
  firstText,
  isText,
  lastText,
  lineEnd,
  lineStart,
  moveCols,
  moveRows,
  paint,
  selectedColumns,
  selectionRange,
  selectionText,
  wordBack,
  wordEnd,
  wordForward,
  type Pos,
  type VisualMode,
} from "./vim";
/** The span under a terminal cell of this row. */
function spanAt(row: MarkdownRow, cell: number): Span | undefined {
  let left = cell;
  for (const span of row.spans) {
    const size = Bun.stringWidth(span.text);
    if (left < size) return span;
    left -= size;
  }
  return undefined;
}
const Row = memo(function Row({
  row,
  activate,
  focused,
  point,
  press,
  width,
  from,
  to,
  cursor,
  place,
}: {
  /** Selected columns of this row, `[from, to)`. */
  from?: number;
  to?: number;
  /** Grapheme the vim cursor sits on, when it is on this row. */
  cursor?: number;
  place?: (col: number) => void;
  point?: (target: Target, click: boolean) => void;
  press?: (action: BlockAction, target: Target) => void;
  row: MarkdownRow;
  activate?: () => void;
  focused?: boolean;
  width?: number;
}) {
  const down = useRef<{ x: number; y: number } | undefined>(undefined);
  const painted = paint(
    row.spans,
    from === undefined || to === undefined ? undefined : [from, to],
    cursor,
  );
  // Span positions are stable within each immutable measured row.
  /* oxlint-disable react/no-array-index-key */
  return (
    <text
      fg={theme.plain}
      id={`transcript-row-${row.id}`}
      selectable={!row.chrome}
      width={width}
      onMouseDown={(e) => {
        down.current = { x: e.x, y: e.y };
      }}
      onMouseMove={(e) => {
        if (e.modifiers.shift) return;
        const value = spanAt(row, e.x - (e.currentTarget?.x ?? 0))?.target ?? row.target;
        if (value) point?.(value, false);
      }}
      onMouseOver={() => {
        if (row.target) point?.(row.target, false);
      }}
      onMouseUp={(event) => {
        if (
          event.button !== 0 ||
          event.modifiers.shift ||
          !down.current ||
          down.current.x !== event.x ||
          down.current.y !== event.y
        )
          return;
        const span = spanAt(row, event.x - (event.currentTarget?.x ?? 0));
        if (span?.action && span.target) {
          press?.(span.action, span.target);
          return;
        }
        if (isText(row)) place?.(colAt(row, event.x - (event.currentTarget?.x ?? 0)));
        const target = span?.target ?? row.target;
        if (target) point?.(target, true);
        activate?.();
      }}
      height={1}
      flexShrink={0}
      wrapMode="none"
      bg={focused ? theme.highlight : undefined}
    >
      {painted.map((span, index) => (
        <span key={index} fg={span.color} bg={span.bg} attributes={span.bold ? 1 : 0}>
          {span.text}
        </span>
      ))}
    </text>
  );
});
/** Not selectable and has no handlers, so it stays out of clicks, hover and copied text. */
const SeparatorRow = memo(function SeparatorRow({ row }: { row: MarkdownRow }) {
  return (
    <text fg={theme.plain} selectable={false} height={1} flexShrink={0} wrapMode="none">
      {row.spans[0] && <span fg={row.spans[0].color}>{row.spans[0].text}</span>}
    </text>
  );
});
export function TranscriptViewport({
  items,
  width,
  height,
  enabled = true,
  keyboardEnabled = true,
  history,
  loadEarlier,
  anchorState,
  measuredCache,
  activate,
  effects,
  cwd,
  openFile,
}: {
  effects?: Actions;
  cwd?: string;
  openFile?: (path: string) => void;
  activate?: (id: string) => void;
  items: readonly Message[];
  width: number;
  height: number;
  enabled?: boolean;
  keyboardEnabled?: boolean;
  history?: { hasMoreHistory: boolean; loading: boolean; error: string | null };
  loadEarlier?: () => void;
  measuredCache?: MarkdownCache;
  anchorState?: { value: string | null; set: (value: string | null) => void };
}) {
  const [target, setTarget] = useState<Target>();
  const [hoveredImage, setHoveredImage] = useState<Target>();
  const [feedback, setFeedback] = useState("");
  const [reading, setReading] = useState(false);
  const readGeneration = useRef(0);
  useEffect(() => () => { readGeneration.current++; effects?.stopReadback?.(); }, [effects]);
  const stopReading = () => {
    readGeneration.current++;
    effects?.stopReadback?.();
    setReading(false);
    setFeedback("Readback stopped");
  };
  const read = (text: string) => {
    if (!effects?.readback) return;
    const generation = ++readGeneration.current;
    setReading(true);
    setFeedback("Preparing / reading response…");
    void effects.readback(text).then(
      () => { if (generation === readGeneration.current) setFeedback("Readback finished"); },
      (error) => { if (generation === readGeneration.current) setFeedback(`X ${error instanceof Error ? error.message : "Readback failed"}`); },
    ).finally(() => { if (generation === readGeneration.current) setReading(false); });
  };
  const busy = useRef(false);
  const nativeSelection = useRef(false);
  const run = (label: string, task: () => unknown) => {
    if (busy.current) return;
    busy.current = true;
    setFeedback(`◌ ${label}`);
    void Promise.resolve()
      .then(task)
      .then(
        (result) => setFeedback(`✓ ${typeof result === "string" ? result : label}`),
        (error) =>
          setFeedback(
            `X ${failureText(error, ["launch image viewer", "play", "open file"].includes(label) && error instanceof Error ? error.message : `${label} failed; retry`)}`,
          ),
      )
      .finally(() => {
        busy.current = false;
      });
  };
  const targets = targetNames(effects);
  const perform = (action: string, value = target) => {
    if (!effects || !value) return;
    if (action === "read" && value.kind === "message") { read(value.text); return; }
    if (
      value.kind === "code" ? !value.actions?.includes(action as BlockAction) : action === "run"
    ) {
      setFeedback(`X ${action} is not available here`);
      return;
    }
    const kind = value.kind === "image" ? mediaKind(value.text) : undefined;
    if (kind && !mediaActions(effects, kind).includes(action)) {
      setFeedback(`X ${action} is not available for ${kind === "image" ? "images" : "this file"}`);
      return;
    }
    const label =
      kind && action === "open"
        ? kind === "image"
          ? "launch image viewer"
          : kind === "file"
            ? "open file"
            : "play"
        : targets.includes(action)
          ? `copy to ${action}`
          : action;
    run(label, () => {
      if (kind && kind !== "image") {
        if (!effects.openMedia) throw new Error("Opener unavailable");
        return effects.openMedia(value.text, cwd);
      }
      if (value.kind === "image") {
        if (action === "open") {
          if (!effects.openImage) throw new Error("Image opener unavailable");
          return effects.openImage(value.text, cwd);
        }
        if (action !== "copy") {
          if (!effects.copyImageTo) throw new Error("Image clipboard unavailable");
          return effects.copyImageTo(action, value.text, cwd);
        }
        if (!effects.copyImage) throw new Error("Image clipboard unavailable");
        return effects.copyImage(value.text, cwd);
      }
      if (action === "copy" || action === "copy path") return effects.copy(value.text);
      if (targets.includes(action)) {
        if (!effects.copyTo) throw new Error("Copy unavailable");
        return effects.copyTo(action, value.text);
      }
      if (action === "run") {
        if (!cwd || !effects.run) throw new Error("Run unavailable");
        return effects.run({ cwd, command: value.text.trim() });
      }
      if (action === "open") {
        if (value.kind === "page") {
          if (!effects.openPage) throw new Error("Page unavailable");
          return effects.openPage(value.text);
        }
        if (value.kind === "file") {
          if (!openFile) throw new Error("File routing unavailable");
          return openFile(value.text);
        }
        if (!effects.openUrl) throw new Error("Browser unavailable");
        return effects.openUrl(value.text);
      }
      if (action === "tmux") {
        if (!cwd || !effects.tmux) throw new Error("Tmux unavailable");
        return effects.tmux({ cwd, command: value.text });
      }
      if (action !== "send" || !effects.send) throw new Error(`${action} unavailable`);
      if (value.kind === "file" && !value.text.startsWith("/") && !cwd)
        throw new Error("Workspace unavailable");
      return effects.send(
        value.kind === "file"
          ? { kind: "file", path: value.text.startsWith("/") ? value.text : `${cwd}/${value.text}` }
          : { kind: "text", text: value.text },
      );
    });
  };
  useSelectionHandler((selection) => {
    if (
      nativeSelection.current ||
      !enabled ||
      !effects ||
      selection.isDragging ||
      !selection.selectedRenderables.length
    )
      return;
    if (!selection.selectedRenderables.every((r) => r.id.startsWith("transcript-row-"))) return;
    const text = selection.getSelectedText();
    if (text) run("copy", () => effects.copy(text));
  });
  const [localCache] = useState(() => new MarkdownCache());
  const cache = measuredCache ?? localCache;
  const [localAnchor, setLocalAnchor] = useState<string | null>(null);
  const anchor = anchorState ? anchorState.value : localAnchor;
  const setAnchor = anchorState?.set ?? setLocalAnchor;
  const rows = useMemo(
    () =>
      cache.rows(items, width, Math.max(1, height - (effects ? 3 : 1)), [...offeredActions(effects), ...(effects?.readback ? ["__readback"] : [])]),
    [cache, items, width, height, effects],
  );
  const [focus, setFocus] = useState<string | null>(null);
  const actions = useMemo(
    () => new Set(items.filter((i) => i.action).map((i) => String(i.id))),
    [items],
  );
  const rowMessage = (row: MarkdownRow) =>
    row.id.slice(0, row.id.lastIndexOf(":", row.id.lastIndexOf(":") - 1));
  // With hints hidden the action row is one line: block buttons, then feedback or the vim mode.
  const hints = useContext(HintsShown);
  const viewport = Math.max(1, height - (effects ? (hints ? 3 : 2) : 1));
  const start = anchorIndex(rows, anchor, viewport);
  const scroll = (delta: number) => {
    const next = Math.max(0, Math.min(Math.max(0, rows.length - viewport), start + delta));
    setAnchor(next >= rows.length - viewport ? null : (rows[next]?.id ?? null));
  };
  // The transcript reads like an editor you cannot type into: a cursor, motions, visual select and
  // yank. State lives in a ref so two quick keys (`gg`, `yy`) see each other before a repaint.
  const vim = useRef<{
    cursor?: { id: string; col: number };
    anchor?: { id: string; col: number };
    mode?: VisualMode;
    pending?: string;
    want: number;
  }>({ want: 0 });
  const [, repaint] = useState(0);
  const rowIndex = (id: string) => anchorIndex(rows, id, 1);
  const posOf = (at?: { id: string; col: number }): Pos | undefined =>
    at && rows.length ? { row: rowIndex(at.id), col: at.col } : undefined;
  /** Move the cursor, scrolling only as far as needed to keep it in view. */
  const put = (next: Pos, sticky = false) => {
    const row = rows[next.row];
    if (!row) return;
    setTarget(row.target);
    vim.current.cursor = { id: row.id, col: next.col };
    if (!sticky) vim.current.want = next.col;
    const top =
      next.row < start ? next.row : next.row >= start + viewport ? next.row - viewport + 1 : start;
    if (top !== start) setAnchor(top >= rows.length - viewport ? null : (rows[top]?.id ?? null));
    repaint((n) => n + 1);
  };
  const leaveVisual = () => {
    vim.current.mode = undefined;
    vim.current.anchor = undefined;
  };
  const targetActions = targetKeys(effects);
  useKeyboard((key) => {
    if (!enabled || !keyboardEnabled || key.meta) return;
    const v = vim.current;
    const half = Math.max(1, Math.floor(viewport / 2));
    if (key.ctrl) {
      if (key.name !== "d" && key.name !== "u") return;
    }
    const ch = key.ctrl
      ? `C-${key.name}`
      : /^[\x21-\x7e]$/.test(key.sequence)
        ? key.sequence
        : key.name;
    if (ch === "R" && effects?.readback) {
      const row = v.cursor ? rows[posOf(v.cursor)!.row] : rows.slice(start, start + viewport).findLast((row) => !!row.target);
      const item = items.find((item) => String(item.id) === (row ? rowMessage(row) : ""));
      if (item?.kind === "assistant") read(item.text);
      key.preventDefault();
      return;
    }
    if (ch === "escape" && reading) { stopReading(); return; }
    const imageTarget = hoveredImage ?? target;
    if ((ch === "l" || ch === "return") && imageTarget?.kind === "image") {
      key.preventDefault();
      perform("open", imageTarget);
      return;
    }
    const pending = v.pending;
    v.pending = undefined;
    let cur = posOf(v.cursor);
    if (!cur) {
      const visible = rows.slice(start, start + viewport);
      const last = visible.findLastIndex(isText);
      if (last < 0) return;
      cur = { row: start + last, col: 0 };
      put(cur);
    }
    if (pending === "g" && ch === "g") {
      put({ row: firstText(rows), col: 0 });
      return;
    }
    if (
      rows[cur.row]?.image &&
      (!v.mode || v.anchor?.id === rows[cur.row]!.id) &&
      (ch === "y" || Object.hasOwn(targetActions, ch))
    ) {
      perform(ch === "y" ? "copy" : targetActions[ch]!, rows[cur.row]!.target);
      leaveVisual();
      return;
    }
    if (pending === "y" && ch === "y") {
      const text = selectionText(rows, cur, cur, "line");
      if (effects && text) run("yank line", () => effects.copy(text));
      return;
    }
    if (Object.hasOwn(targetActions, ch)) {
      const action = targetActions[ch]!;
      if (v.mode && v.anchor) {
        const picked = posOf(v.anchor);
        if (action === "run" || action === "open") {
          setFeedback(`X ${action} works on a code block or link, not a selection`);
        } else if (picked) {
          perform(action, { kind: "inline", text: selectionText(rows, picked, cur, v.mode) });
          leaveVisual();
        }
      } else if (effects) {
        if (target) perform(action);
        else setFeedback("X nothing under the pointer; click text or [ / ] first");
      }
      repaint((n) => n + 1);
      return;
    }
    switch (ch) {
      case "h":
      case "left":
        put(moveCols(rows, cur, -1));
        break;
      case "l":
      case "right":
        put(moveCols(rows, cur, 1));
        break;
      case "j":
      case "down":
        put(moveRows(rows, cur, 1, v.want), true);
        break;
      case "k":
      case "up":
        put(moveRows(rows, cur, -1, v.want), true);
        break;
      case "C-d":
        put(moveRows(rows, cur, half, v.want), true);
        break;
      case "C-u":
        put(moveRows(rows, cur, -half, v.want), true);
        break;
      case "pagedown":
        put(moveRows(rows, cur, viewport, v.want), true);
        break;
      case "pageup":
        put(moveRows(rows, cur, -viewport, v.want), true);
        break;
      case "w":
        put(wordForward(rows, cur));
        break;
      case "b":
        put(wordBack(rows, cur));
        break;
      case "e":
        put(wordEnd(rows, cur));
        break;
      case "0":
        put(lineStart(rows, cur, false));
        break;
      case "^":
        put(lineStart(rows, cur, true));
        break;
      case "$":
        put(lineEnd(rows, cur));
        break;
      case "g":
        v.pending = "g";
        break;
      case "home":
        put({ row: firstText(rows), col: 0 });
        break;
      case "G":
      case "end":
        setAnchor(null);
        put({ row: lastText(rows), col: 0 });
        break;
      case "v":
      case "V": {
        const mode = ch === "v" ? "char" : "line";
        if (v.mode === mode) leaveVisual();
        else {
          v.mode = mode;
          v.anchor ??= { id: rows[cur.row]!.id, col: cur.col };
        }
        repaint((n) => n + 1);
        break;
      }
      case "y": {
        if (!v.mode || !v.anchor) {
          v.pending = "y";
          break;
        }
        const picked = posOf(v.anchor)!;
        const text = selectionText(rows, picked, cur, v.mode);
        const range = selectionRange(rows, picked, cur, v.mode);
        const mode = v.mode;
        leaveVisual();
        put({ row: range.start.row, col: mode === "line" ? cur.col : range.start.col });
        if (effects && text) run("yank", () => effects.copy(text));
        break;
      }
      case "escape":
        if (v.mode) {
          key.preventDefault();
          leaveVisual();
          repaint((n) => n + 1);
        }
        break;
      case "]":
      case "[": {
        if (!effects) break;
        const targets = rows
          .slice(start, start + viewport)
          .flatMap((r) => [r.target, ...r.spans.map((s) => s.target)])
          .filter((t): t is Target => !!t);
        const unique = targets.filter(
          (t, i) => targets.findIndex((v) => v.kind === t.kind && v.text === t.text) === i,
        );
        const i = unique.findIndex((t) => t.kind === target?.kind && t.text === target.text);
        setTarget(unique[(i + (ch === "]" ? 1 : -1) + unique.length) % unique.length]);
        break;
      }
      case "}":
      case "{": {
        const ids = [...actions];
        const index = ids.indexOf(focus ?? "");
        const id = ids[(index + (ch === "}" ? 1 : -1) + ids.length) % ids.length];
        if (id) {
          setFocus(id);
          setAnchor(rows.find((r) => rowMessage(r) === id)?.id ?? null);
        }
        break;
      }
      case "return": {
        const id =
          focus && actions.has(focus)
            ? focus
            : rows
                .slice(start, start + viewport)
                .map(rowMessage)
                .find((id) => actions.has(id));
        if (id) {
          setFocus(id);
          activate?.(id);
        }
        break;
      }
      case "p":
        loadEarlier?.();
        break;
    }
  });
  const cursorAt = enabled && keyboardEnabled ? posOf(vim.current.cursor) : undefined;
  const anchorAt = vim.current.mode ? posOf(vim.current.anchor) : undefined;
  const range =
    cursorAt && anchorAt && vim.current.mode
      ? selectionRange(rows, anchorAt, cursorAt, vim.current.mode)
      : undefined;
  const modeLabel =
    vim.current.mode === "line" ? "-- V-LINE -- " : vim.current.mode ? "-- VISUAL -- " : "";
  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
      onMouseDown={(event) => {
        nativeSelection.current = event.modifiers.shift;
      }}
      onMouseScroll={(event) => {
        if (enabled) scroll(event.scroll?.direction === "up" ? -3 : 3);
      }}
    >
      <box height={viewport} flexShrink={0} flexDirection="column" overflow="hidden">
        {rows.slice(start, start + viewport).map((row, offset) => {
          if (row.image) {
            const image = row.image;
            if (offset > 0 && rows[start + offset - 1]?.image?.id === image.id) return null;

            return (
              <ImagePreview
                key={row.id}
                visibleHeight={Math.min(image.height - image.offset, viewport - offset)}
                image={image}
                width={width}
                effects={effects}
                cwd={cwd}
                hover={() => {
                  if (enabled) setHoveredImage(row.target);
                }}
                unhover={() => setHoveredImage(undefined)}
                selected={
                  (target?.kind === "image" && target.text === image.source) ||
                  hoveredImage?.text === image.source
                }
                perform={enabled ? (action) => perform(action, row.target) : undefined}
                select={() => {
                  if (!enabled) return;
                  setTarget(row.target);
                  put({ row: start + offset - image.offset, col: 0 });
                }}
              />
            );
          }
          if (row.separator) return <SeparatorRow key={row.id} row={row} />;
          const index = start + offset;
          const columns = range && selectedColumns(rows, range, index);
          const cells = (
            <Row
              key={row.id}
              row={row}
              from={columns?.[0]}
              to={columns?.[1]}
              cursor={cursorAt?.row === index ? cursorAt.col : undefined}
              place={enabled ? (col) => put({ row: index, col }) : undefined}
              {...(row.framed ? { width: Math.max(2, width - FRAME_SIDE * 2) } : {})}
              press={
                enabled && effects
                  ? (action, value) => {
                      setTarget(value);
                      perform(action, value);
                    }
                  : undefined
              }
              point={
                enabled && effects
                  ? (value, click) => {
                      setTarget(value);
                      if (click && value.kind === "inline") perform("tmux", value);
                      if (
                        click &&
                        (value.kind === "file" || value.kind === "url" || value.kind === "page")
                      )
                        perform("open", value);
                    }
                  : undefined
              }
              focused={
                (focus !== null && rowMessage(row) === focus) ||
                !!(
                  target &&
                  [row.target, ...row.spans.map((s) => s.target)].some(
                    (t) => t?.kind === target.kind && t.text === target.text,
                  )
                )
              }
              activate={
                enabled && actions.size > 0 && actions.has(rowMessage(row))
                  ? () => {
                      setFocus(rowMessage(row));
                      activate?.(rowMessage(row));
                    }
                  : undefined
              }
            />
          );
          if (!row.framed) return cells;
          // The borders are separate, unselectable text, so a drag copies only the code.
          return (
            <box key={row.id} height={1} flexShrink={0} flexDirection="row">
              <text selectable={false} flexShrink={0} fg={theme.muted}>
                {"│ "}
              </text>
              {cells}
              <text selectable={false} flexShrink={0} fg={theme.muted}>
                {" │"}
              </text>
            </box>
          );
        })}
        {!rows.length && <text fg={theme.plain}>No messages yet</text>}
      </box>
      {effects && (
        <box height={hints ? 2 : 1} flexShrink={0} flexDirection="column">
          <box height={1} flexDirection="row">
            {reading && <box onMouseUp={(e) => { if (enabled && e.button === 0) stopReading(); }}>
              <text selectable={false} fg={theme.accent}>[stop reading] </text>
            </box>}
            {target ? (
              [
                ...(target.kind === "image"
                  ? mediaActions(effects, mediaKind(target.text))
                  : target.kind === "code"
                    ? (target.actions ?? [])
                    : [
                        target.kind === "file" ? "copy path" : "copy",
                        ...(target.kind === "inline"
                          ? offeredActions(effects).filter((a) => a !== "run")
                          : []),
                      ]),
                ...(["file", "url"].includes(target.kind)
                  ? ["open", ...(effects.send ? ["send"] : [])]
                  : target.kind === "page"
                    ? ["open"]
                    : []),
              ].map((action) => (
                <box
                  key={action}
                  onMouseUp={(e) => {
                    if (enabled && e.button === 0) perform(action);
                  }}
                >
                  <text selectable={false} fg={theme.accent}>{`[${action}] `}</text>
                </box>
              ))
            ) : hints ? (
              <text fg={theme.plain} selectable={false}>
                Hover / click text · [ / ] focus block
              </text>
            ) : null}
            {!hints && (
              <text fg={theme.plain} selectable={false}>
                {feedback || modeLabel}
              </text>
            )}
          </box>
          {hints && (
            <text fg={theme.plain} selectable={false}>
              {feedback ||
                (target?.kind === "image"
                  ? `l / Enter open image · y copy${effects.copyImageTo ? keyHints(effects, ["tmux", "run", "send"]) : ""}`
                  : modeLabel
                    ? `${modeLabel}y yank${keyHints(effects, ["run"])} · Esc cancel`
                    : `hjkl wbe move · v/V select · y yank${keyHints(effects, ["run"])} · Y block`)}
            </text>
          )}
        </box>
      )}
      <box height={1} flexDirection="row">
        {(history?.hasMoreHistory || history?.error || history?.loading) && (
          <box
            onMouseUp={(event) => {
              if (enabled && event.button === 0) loadEarlier?.();
            }}
          >
            <text fg={theme.accent}>
              {history?.loading ? "Loading earlier… " : (history?.error ?? "[p Earlier] · ")}
            </text>
          </box>
        )}
        <box
          onMouseUp={(event) => {
            if (enabled && event.button === 0) setAnchor(null);
          }}
        >
          <text fg={theme.accent}>
            {modeLabel +
              (anchor ? "[End Follow tail]" : "Following tail") +
              (actions.size ? " · {/} work · Enter expand" : "")}
          </text>
        </box>
      </box>
    </box>
  );
}
