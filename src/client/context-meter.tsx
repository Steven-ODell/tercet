// The context meter: a bar for the selected thread's context window in the top-right corner of
// the header, and a dropdown under it with the breakdown. The server reports totals, not the
// categories Claude Code's /context counts, so the bar splits what it does know: cached input,
// new input, output, free room and the auto-compact buffer.
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { theme, type Color } from "./theme";
import { formatContextFillPercent, formatContextWindowTokens } from "./usage";

type Turn = Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "tokenUsage" | "turnTokenUsage">;

export interface ContextSlice {
  readonly name: string;
  readonly tokens: number;
  readonly kind: "used" | "free" | "buffer";
  readonly color: Color;
}

export interface ContextDetail {
  readonly used: number;
  readonly max: number | null;
  /** 0-100; null without a window size. */
  readonly percent: number | null;
  readonly level: "normal" | "high" | "full";
  /** Used, then free, then the auto-compact buffer; empty without a window size. */
  readonly slices: ReadonlyArray<ContextSlice>;
  readonly compactAt: number | null;
  /** Epoch ms the provider's prompt cache runs out, when it said. */
  readonly cacheExpiresAt: number | null;
  readonly reasoning: number | null;
  /** The newest turn's own totals, every model call in it summed. */
  readonly turn: Turn["turnTokenUsage"] | null;
  readonly cost: ThreadTokenUsageSnapshot["cost"] | null;
}

/** "430k", "1M": a capital M so a million does not read as minutes. */
export const tokensText = (value: number) => formatContextWindowTokens(value).replace(/m$/, "M");

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Newest usage report by timestamp, like web's: turns are ordered by provider thread, not time. */
function latestUsage(turns: ReadonlyArray<Turn>): {
  usage: OrchestrationV2ProviderTurnTokenUsage | null;
  turn: Turn | null;
} {
  let usage: OrchestrationV2ProviderTurnTokenUsage | null = null;
  let turn: Turn | null = null;
  for (const candidate of turns) {
    const report = candidate.tokenUsage;
    if (report === undefined) continue;
    // Ties go to the later entry, since live upserts append.
    if (usage === null || Date.parse(report.updatedAt) >= Date.parse(usage.updatedAt)) {
      usage = report;
      turn = candidate;
    }
  }
  return { usage, turn };
}

/**
 * The selected thread's context, from its active provider thread: the newest turn report when
 * there is one (it carries the cache split and compact threshold), else the provider thread's
 * own snapshot. Null before the first report.
 */
export function contextDetailOf(input: {
  readonly activeProviderThreadId: string | null | undefined;
  readonly providerThread: { readonly contextUsage?: ThreadTokenUsageSnapshot | null } | undefined;
  readonly providerTurns: ReadonlyArray<Turn> | undefined;
}): ContextDetail | null {
  const turns = (input.providerTurns ?? []).filter(
    (turn) => !input.activeProviderThreadId || turn.providerThreadId === input.activeProviderThreadId,
  );
  const { usage: live, turn } = latestUsage(turns);
  const snapshot = input.providerThread?.contextUsage ?? null;
  const source = live ?? snapshot;
  if (source === null) return null;
  const used = Math.max(0, source.usedTokens);
  const maxRaw = num(source.maxTokens) ?? num(snapshot?.maxTokens);
  const max = maxRaw !== null && maxRaw > 0 ? maxRaw : null;
  const percent = max === null ? null : Math.min(100, (used / max) * 100);
  const compactRaw = num(source.autoCompactThreshold) ?? num(snapshot?.autoCompactThreshold);
  const compactAt = compactRaw !== null && max !== null && compactRaw < max ? compactRaw : null;

  const slices: ContextSlice[] = [];
  if (max !== null) {
    const input = num(source.inputTokens);
    const cached = num(source.cachedInputTokens);
    const output = num(source.outputTokens);
    // Used is the last call's input plus its output; split it only when the parts add up.
    if (input !== null && output !== null && input + output <= used + 1 && input + output > 0) {
      const hit = Math.min(cached ?? 0, input);
      slices.push(
        { name: "Cached input", tokens: hit, kind: "used", color: theme.accent },
        { name: "New input", tokens: input - hit, kind: "used", color: theme.cyan },
        { name: "Output", tokens: output, kind: "used", color: theme.pink },
      );
      const rest = used - input - output;
      if (rest > 1) slices.push({ name: "Other", tokens: rest, kind: "used", color: theme.blue });
    } else slices.push({ name: "Used", tokens: used, kind: "used", color: theme.accent });
    const room = Math.max(used, compactAt ?? max);
    slices.push({ name: "Free", tokens: room - used, kind: "free", color: theme.muted });
    if (compactAt !== null)
      slices.push({
        name: "Compact buffer",
        tokens: max - room,
        kind: "buffer",
        color: theme.border,
      });
  }
  const expires = live?.promptCacheExpiresAt ? Date.parse(live.promptCacheExpiresAt) : NaN;
  return {
    used,
    max,
    percent,
    level: percent === null ? "normal" : percent >= 90 ? "full" : percent >= 70 ? "high" : "normal",
    slices: slices.filter((slice) => slice.tokens > 0 || slice.kind === "free"),
    compactAt,
    cacheExpiresAt: Number.isFinite(expires) ? expires : null,
    reasoning: num(source.reasoningOutputTokens),
    turn: turn?.turnTokenUsage ?? null,
    cost: snapshot?.cost ?? null,
  };
}

/** Cells per slice, summing to `width`; a used slice with tokens always gets one so it shows. */
export function allocate(slices: ReadonlyArray<{ tokens: number; kind: string }>, width: number) {
  const total = slices.reduce((sum, slice) => sum + slice.tokens, 0);
  if (total === 0 || width <= 0) return slices.map(() => 0);
  const exact = slices.map((slice) => (slice.tokens / total) * width);
  const out = exact.map(Math.floor);
  const order = exact.map((_, i) => i).sort((a, b) => (exact[b]! % 1) - (exact[a]! % 1));
  for (let left = width - out.reduce((s, n) => s + n, 0), k = 0; left > 0; left--, k++)
    out[order[k % order.length]!]! += 1;
  slices.forEach((slice, i) => {
    if (slice.kind !== "used" || slice.tokens === 0 || out[i]! > 0) return;
    const biggest = out.indexOf(Math.max(...out));
    if (out[biggest]! <= 1) return;
    out[biggest]! -= 1;
    out[i] = 1;
  });
  return out;
}

const glyph = (slice: ContextSlice) => (slice.kind === "free" ? "▱" : "▰");

function Bar({ slices, width }: { slices: ReadonlyArray<ContextSlice>; width: number }) {
  const cells = allocate(slices, width);
  return (
    <>
      {slices.map((slice, i) =>
        cells[i] ? (
          <span key={slice.name} fg={slice.color}>
            {glyph(slice).repeat(cells[i]!)}
          </span>
        ) : null,
      )}
    </>
  );
}

const headText = (detail: ContextDetail | null) =>
  detail === null
    ? "Context unknown"
    : detail.percent === null
      ? `Context ${tokensText(detail.used)}`
      : `Context ${formatContextFillPercent(detail.percent)}`;
const tailText = (detail: ContextDetail) =>
  detail.max === null ? "" : `${tokensText(detail.used)} / ${tokensText(detail.max)}`;

/** The chip's layout for the columns it has: bar and tokens drop first. Null when nothing fits. */
export function chipLayout(detail: ContextDetail | null, columns: number, open: boolean) {
  const head = headText(detail);
  const tail = detail ? tailText(detail) : "";
  const arrow = open ? " ▴" : " ▾";
  const base = Bun.stringWidth(head + arrow);
  const withTail = tail ? base + 1 + Bun.stringWidth(tail) : base;
  const hasBar = !!detail && detail.slices.length > 0;
  if (hasBar && columns >= withTail + 1 + 8)
    return { head, tail, arrow, bar: Math.min(24, columns - withTail - 1) };
  if (columns >= withTail) return { head, tail, arrow, bar: 0 };
  if (columns >= base) return { head, tail: "", arrow, bar: 0 };
  return null;
}

export const chipWidth = (layout: NonNullable<ReturnType<typeof chipLayout>>) =>
  Bun.stringWidth(layout.head + layout.arrow) +
  (layout.bar ? layout.bar + 1 : 0) +
  (layout.tail ? Bun.stringWidth(layout.tail) + 1 : 0);

/** The header's top-right chip. A click opens the dropdown, like Alt+u. */
export function ContextChip({
  detail,
  columns,
  open,
  onToggle,
}: {
  detail: ContextDetail | null;
  columns: number;
  open: boolean;
  onToggle: () => void;
}) {
  const layout = chipLayout(detail, columns, open);
  if (!layout) return null;
  const color =
    detail === null
      ? theme.muted
      : detail.level === "full"
        ? theme.red
        : detail.level === "high"
          ? theme.yellow
          : theme.accent;
  return (
    <box
      flexShrink={0}
      onMouseUp={(event) => {
        if (event.button === 0) onToggle();
      }}
    >
      <text selectable={false} fg={theme.muted}>
        <span fg={color}>{layout.head}</span>
        {layout.bar > 0 && detail ? (
          <>
            {" "}
            <Bar slices={detail.slices} width={layout.bar} />
          </>
        ) : null}
        {layout.tail ? ` ${layout.tail}` : ""}
        <span fg={open ? theme.accent : theme.muted}>{layout.arrow}</span>
      </text>
    </box>
  );
}

function share(tokens: number, max: number | null) {
  if (max === null) return "";
  return formatContextFillPercent((tokens / max) * 100);
}

/** "in 42m", "3m ago", "in 1h 5m". */
export function relativeMinutes(at: number, now: number) {
  const minutes = Math.round(Math.abs(at - now) / 60_000);
  const text = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return at >= now ? `in ${text}` : `${text} ago`;
}

export interface DetailLine {
  readonly text: string;
  readonly color?: Color;
  /** A bar instead of text. */
  readonly bar?: true;
  readonly swatch?: ContextSlice;
}

/** The dropdown's rows for `width` inner columns. */
export function detailLines(
  detail: ContextDetail | null,
  width: number,
  now: number,
): DetailLine[] {
  if (detail === null)
    return [
      { text: "No usage reported yet.", color: theme.muted },
      { text: "The server sends it after the", color: theme.muted },
      { text: "thread's first turn.", color: theme.muted },
    ];
  const lines: DetailLine[] = [
    {
      text:
        detail.max === null
          ? `${tokensText(detail.used)} used · window size unknown`
          : `${formatContextFillPercent(detail.percent ?? 0)} used · ${tailText(detail)}`,
      color: theme.text,
    },
  ];
  if (detail.slices.length > 0) {
    lines.push({ text: "", bar: true });
    const nameWidth = Math.max(...detail.slices.map((slice) => slice.name.length));
    for (const slice of detail.slices) {
      const tokens = tokensText(slice.tokens).padStart(6);
      const pct = share(slice.tokens, detail.max).padStart(5);
      lines.push({ text: `${slice.name.padEnd(nameWidth)} ${tokens} ${pct}`, swatch: slice });
    }
  }
  lines.push({ text: "" });
  lines.push({
    text:
      detail.compactAt !== null
        ? `Compacts at ${detail.compactAt.toLocaleString("en-US")} tokens.`
        : "Compacts automatically when needed.",
    color: theme.muted,
  });
  if (detail.cacheExpiresAt !== null)
    lines.push({
      text:
        detail.cacheExpiresAt > now
          ? `Prompt cache warm, expires ${relativeMinutes(detail.cacheExpiresAt, now)}.`
          : `Prompt cache expired ${relativeMinutes(detail.cacheExpiresAt, now)}.`,
      color: detail.cacheExpiresAt > now ? theme.green : theme.yellow,
    });
  const turn = detail.turn;
  if (turn && turn.inputTokens !== undefined && turn.outputTokens !== undefined) {
    const parts = [`${tokensText(turn.inputTokens)} in`];
    if (turn.cachedInputTokens) parts.push(`${tokensText(turn.cachedInputTokens)} cached`);
    parts.push(`${tokensText(turn.outputTokens)} out`);
    lines.push({ text: "" }, { text: "Last turn, all calls", color: theme.accent });
    lines.push({ text: parts.join(" · "), color: theme.text });
    if (turn.reasoningTokens) lines.push({ text: `${tokensText(turn.reasoningTokens)} reasoning` });
    if (turn.otherUsage)
      lines.push({
        text: `Subagents, compaction: ${tokensText(turn.otherUsage.inputTokens)} in · ${tokensText(turn.otherUsage.outputTokens)} out`,
        color: theme.muted,
      });
  } else if (detail.reasoning) lines.push({ text: `${tokensText(detail.reasoning)} reasoning` });
  if (detail.cost) {
    const digits = Math.abs(detail.cost.amount) > 0 && Math.abs(detail.cost.amount) < 0.01 ? 4 : 2;
    lines.push({ text: `Cost ${detail.cost.currency} ${detail.cost.amount.toFixed(digits)}` });
  }
  // Long lines wrap by words so nothing is cut at narrow widths.
  return lines.flatMap((line) =>
    line.bar || line.swatch || Bun.stringWidth(line.text) <= width
      ? [line]
      : wrapWords(line.text, width).map((text) => ({ ...line, text })),
  );
}

function wrapWords(text: string, width: number) {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    const next = row ? `${row} ${word}` : word;
    if (Bun.stringWidth(next) > width && row) {
      rows.push(row);
      row = word;
    } else row = next;
  }
  if (row) rows.push(row);
  return rows;
}

/** The dropdown under the chip, right-aligned to the screen edge. */
export function ContextDropdown({
  detail,
  width,
  height,
  now: nowOf,
  close,
}: {
  detail: ContextDetail | null;
  width: number;
  height: number;
  now: () => number;
  close: () => void;
}) {
  // A minute clock for the cache countdown, like the usage footer's.
  const [now, setNow] = useState(nowOf);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowOf()), 60_000);
    return () => clearInterval(timer);
  }, [nowOf]);
  const outer = Math.min(46, width);
  const inner = Math.max(1, outer - 4);
  const lines = detailLines(detail, inner, now);
  const boxHeight = Math.min(Math.max(3, height - 1), lines.length + 3);
  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%">
      <box
        position="absolute"
        left={0}
        top={0}
        width="100%"
        height="100%"
        onMouseUp={(event) => {
          if (event.button === 0) close();
        }}
      />
      <box
        position="absolute"
        left={Math.max(0, width - outer)}
        top={1}
        width={outer}
        height={boxHeight}
        border
        borderStyle="rounded"
        borderColor={theme.accent}
        backgroundColor={theme.canvas}
        title="Context window"
        titleColor={theme.accent}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <scrollbox scrollY scrollX={false} flexGrow={1}>
          {lines.map((line, i) =>
            line.bar && detail ? (
              <text key={i}>
                <Bar slices={detail.slices} width={inner} />
              </text>
            ) : line.swatch ? (
              <text key={i} fg={theme.text}>
                <span fg={line.swatch.color}>{glyph(line.swatch)} </span>
                {line.text}
              </text>
            ) : (
              <text key={i} fg={line.color ?? theme.text}>
                {line.text}
              </text>
            ),
          )}
        </scrollbox>
        <box
          height={1}
          onMouseUp={(event) => {
            if (event.button === 0) close();
          }}
        >
          <text fg={theme.accent} selectable={false}>
            [ Esc Close ]
          </text>
        </box>
      </box>
    </box>
  );
}
