import { theme, type Color } from "./theme";
import { pendingCard } from "./requests";
import { useEffect, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import {
  EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
  resolveSettledThreadTimestamp,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  createInboxReturnTracker,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";
import { pendingSubagentRequestsByThread } from "../ext/thread-shell";
import * as DateTime from "effect/DateTime";
import { modelIcon, projectGlyph, selectionIcon, type Icon } from "./icons";
import { projectColor } from "./project-color";
import type { Client } from "./runtime";
import { useClientAtom } from "./screen";
import { useUsageLimits, limitLine, limitParts, type LimitPart } from "./meters";

type Thread = OrchestrationV2ThreadShell;
const stamp = (at: DateTime.Utc | null | undefined) =>
  at == null ? 0 : DateTime.toEpochMillis(at);
export function threadBadge(thread: Thread, visited = 0) {
  if (thread.lastErrorClass === "usage_limit")
    return `◷ limited · reset ${thread.usageLimitResetAt ?? "unknown"}`;
  // `status` follows the latest run. A message queued behind a live run and then cancelled makes
  // it "cancelled" while the earlier run is still working; the activity run is what is live.
  const status = thread.activityRunStatus ?? thread.status;
  if (thread.pendingRuntimeRequest || status === "waiting") return "? waiting";
  if (status === "failed") return "× failed";
  if (["preparing", "queued", "starting", "running"].includes(status)) return "▶ running";
  if (
    thread.latestVisibleMessage?.role === "assistant" &&
    stamp(thread.latestVisibleMessage.updatedAt) > Math.max(stamp(thread.lastVisitedAt), visited)
  )
    return "● unread";
  return "·";
}

// Cell-aware wrapping keeps names intact, including wide glyphs and combining marks.
export function wrapName(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.replaceAll("\t", " ").split("\n")) {
    let row = "";
    let cells = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      line,
    )) {
      const size = Bun.stringWidth(segment);
      if (cells + size > Math.max(2, width) && row) {
        rows.push(row);
        row = "";
        cells = 0;
      }
      row += segment;
      cells += size;
    }
    rows.push(row);
  }
  return rows;
}
export type SidebarShelf = "working" | "snoozed" | "settled";
export interface SidebarEntry {
  key: string;
  text: string;
  thread?: Thread;
  project?: string;
  projectColor?: Color;
  projectGlyph?: string;
  /** The thread's model logo. `text` carries its glyph at the start of the status line. */
  modelIcon?: Icon;
  timeLabel?: string;
  shelf?: SidebarShelf;
  /** Key of the first thread a Show more row reveals. */
  more?: string;
}
export interface SidebarOptions {
  hideMachine?: boolean;
  expanded?: ReadonlySet<SidebarShelf>;
  settledVisible?: number;
  workingShelf?: boolean;
  inboxReturns?: ReturnType<typeof createInboxReturnTracker>;
  selected?: string | null | undefined;
  now?: string;
  visited?: ReadonlyMap<string, number>;
  waiting?: ReadonlySet<string>;
  providers?: readonly ServerProvider[];
}
// Same page sizes as the settled tail in apps/web/src/components/Sidebar.tsx.
export const SETTLED_TAIL_INITIAL_COUNT = 10;
export const SETTLED_TAIL_PAGE_COUNT = 25;
// A client holds one environment here; the shared sorts only use it as a tiebreak.
const SINGLE_ENVIRONMENT = EnvironmentId.make("tercet");

// Web's compactSidebarTimeLabel(formatRelativeTimeLabel(...)), with an injected clock.
export function sidebarTimeLabel(timestamp: string | null, now: number): string {
  if (timestamp === null) return "";
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// Port of resolveSidebarThreadSection, apps/web/src/components/Sidebar.logic.ts.
function resolveSidebarThreadSection(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}) {
  if (input.snoozed) return "snoozed";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

/** Web's flat roster: pinned, active, then the Working, Snoozed and Settled shelves.
    Web labels Pinned and Active only during a drag, so here only shelves get headers. */
export function sidebarEntries(
  snapshot: OrchestrationV2ShellSnapshot | null,
  options: SidebarOptions = {},
): SidebarEntry[] {
  if (!snapshot) return [];
  const {
    hideMachine = false,
    expanded = new Set<SidebarShelf>(),
    settledVisible = SETTLED_TAIL_INITIAL_COUNT,
    workingShelf = false,
    inboxReturns,
    selected = null,
    now = new Date().toISOString(),
    visited,
    waiting,
    providers = [],
  } = options;
  const projects = new Map(
    snapshot.projects.map((project) => [
      String(project.id),
      { title: project.title, color: projectColor(project), glyph: projectGlyph(project) },
    ]),
  );
  const requests = pendingSubagentRequestsByThread(snapshot.threads);
  const shells = snapshot.threads
    .filter((thread) => !thread.deletedAt)
    .map((thread) =>
      presentThreadShell(SINGLE_ENVIRONMENT, thread, requests.get(thread.id) ?? null),
    );
  inboxReturns?.observe(workingShelf ? shells : null);
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  for (const shell of shells) {
    if (
      shell.archivedAt !== null ||
      shell.lineage.relationshipToParent === "subagent" ||
      (hideMachine && ["mcp", "server", "provider"].includes(shell.source.creationSource))
    )
      continue;
    const section = resolveSidebarThreadSection({
      snoozed: effectiveSnoozed(shell, { now }),
      settled: shell.settledOverride === "settled",
      pinned: shell.pinnedAt != null,
    });
    (section === "snoozed"
      ? snoozed
      : section === "settled"
        ? settled
        : section === "pinned"
          ? pinned
          : workingShelf && isThreadWorking(shell)
            ? working
            : active
    ).push(shell);
  }
  if (!pinned.length && !active.length && !working.length && !snoozed.length && !settled.length)
    return [];

  const row = (shell: EnvironmentThreadShell): SidebarEntry => {
    const icon = selectionIcon(shell.source.modelSelection, providers);
    return {
      key: shell.id,
      thread: shell.source,
      project: projects.get(shell.projectId)?.title ?? shell.projectId,
      projectColor: projects.get(shell.projectId)?.color ?? theme.muted,
      projectGlyph: projects.get(shell.projectId)?.glyph,
      modelIcon: icon,
      timeLabel: sidebarTimeLabel(
        shell.settledOverride === "settled" && !effectiveSnoozed(shell, { now })
          ? resolveSettledThreadTimestamp(shell)
          : (shell.latestUserMessageAt ?? shell.updatedAt),
        Date.parse(now),
      ),
      text: `${shell.pinnedAt ? "◆ " : ""}${shell.title}\n${icon.glyph} ${
        waiting?.has(shell.id) ? "? waiting" : threadBadge(shell.source, visited?.get(shell.id))
      }`,
    };
  };
  // A collapsed shelf never hides the open thread, as on web.
  const shelfRows = (shelf: SidebarShelf, threads: readonly EnvironmentThreadShell[]) =>
    (expanded.has(shelf) ? threads : threads.filter((shell) => shell.id === selected)).map(row);
  const header = (shelf: SidebarShelf, label: string, count: number): SidebarEntry => ({
    key: `shelf:${shelf}`,
    shelf,
    text: expanded.has(shelf) ? `▾ ${label}` : `▸ ${label} (${count})`,
  });

  const entries = [
    ...sortPinnedThreadsByOrderKey(pinned).map(row),
    ...(workingShelf
      ? sortInboxThreadsByReturn(active, inboxReturns?.returnedAt)
      : sortActiveThreadsByOrderKey(active)
    ).map(row),
  ];
  if (working.length)
    entries.push(
      header("working", "Working", working.length),
      ...shelfRows("working", sortWorkingThreadsBySend(working)),
    );
  if (snoozed.length)
    entries.push(
      header("snoozed", "Snoozed", snoozed.length),
      ...shelfRows(
        "snoozed",
        snoozed.toSorted(
          (left, right) =>
            (toSortableTimestamp(left.snoozedUntil ?? undefined) ?? 0) -
            (toSortableTimestamp(right.snoozedUntil ?? undefined) ?? 0),
        ),
      ),
    );
  const sortedSettled = sortSettledThreads(settled);
  // The open thread never hides under Show more either.
  const settledTail = sortedSettled.slice(settledVisible);
  const openInTail = settledTail.find((shell) => shell.id === selected);
  const firstHidden = settledTail.find((shell) => shell.id !== selected);
  entries.push(
    header("settled", "Settled", settled.length),
    ...shelfRows("settled", [
      ...sortedSettled.slice(0, settledVisible),
      ...(openInTail ? [openInTail] : []),
    ]),
  );
  if (expanded.has("settled") && firstHidden)
    entries.push({
      key: "settled:more",
      more: firstHidden.id,
      text: `+ Show ${Math.min(settledTail.length - (openInTail ? 1 : 0), SETTLED_TAIL_PAGE_COUNT)} more`,
    });
  return entries;
}
/** Cell-aware one-line fit: a name that overflows ends in an ellipsis, like web's truncate. */
export function truncateName(text: string, width: number): string {
  const line = text.replaceAll("\t", " ");
  if (Bun.stringWidth(line) <= width) return line;
  let row = "";
  let cells = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    line,
  )) {
    const size = Bun.stringWidth(segment);
    if (cells + size > Math.max(1, width) - 1) break;
    row += segment;
    cells += size;
  }
  return `${row}…`;
}

/**
 * Every thread is two rows, as on web: the title, then the status with the project and the age
 * as tails. Whatever does not fit ends in an ellipsis; nothing wraps.
 */
export function sidebarRows(entries: readonly SidebarEntry[], width: number) {
  return entries.flatMap((entry, index) => {
    const glyph = entry.modelIcon?.glyph;
    const timeWidth = entry.timeLabel ? Bun.stringWidth(entry.timeLabel) + 1 : 0;
    const lines = entry.text.split("\n");
    const rows = lines.map((line, at) => {
      const text = truncateName(
        line,
        Math.max(1, width - 2 - (at === lines.length - 1 ? timeWidth : 0)),
      );
      // `lead` draws the logo in its own color ahead of the status.
      const logo = glyph !== undefined && text.startsWith(glyph);
      return {
        entry,
        lead: logo ? `  ${glyph}` : "",
        text: logo ? text.slice(glyph.length) : `  ${text}`,
        projectText: "",
        timeText: "",
        rule: false,
      };
    });
    // A line under every thread that another thread follows, like the transcript's speaker rule.
    const ruled = entry.thread !== undefined && entries[index + 1]?.thread !== undefined;
    const withRule = () =>
      ruled
        ? [
            ...rows,
            {
              entry,
              lead: "",
              text: "─".repeat(Math.max(1, width)),
              projectText: "",
              timeText: "",
              rule: true,
            },
          ]
        : rows;
    const last = rows[rows.length - 1]!;
    if (entry.project) {
      const project = entry.projectGlyph ? `${entry.projectGlyph} ${entry.project}` : entry.project;
      const tail = `${last.text.trim() === "·" ? "" : " ·"} ${project}`;
      const room = width - timeWidth - Bun.stringWidth(last.lead + last.text);
      // Under a few cells the project is only an ellipsis; leave it out.
      if (room >= 4) last.projectText = truncateName(tail, room);
    }
    if (entry.timeLabel) {
      const space = width - Bun.stringWidth(last.lead + last.text + last.projectText);
      last.timeText =
        " ".repeat(Math.max(0, space - Bun.stringWidth(entry.timeLabel))) + entry.timeLabel;
    }
    return withRule();
  });
}

// Module scope so the inbox order survives hiding the sidebar with Alt+b.
const inboxReturns = createInboxReturnTracker();

export function ThreadSidebar({
  client,
  width,
  height,
  enabled,
  keyboardEnabled,
  onMenu,
  onOpen,
}: {
  client: Client;
  width: number;
  height: number;
  enabled: boolean;
  keyboardEnabled: boolean;
  onMenu?: (id: import("@t3tools/contracts").ThreadId) => void;
  /** `l` or Right opened a thread: the frame moves focus into the transcript. */
  onOpen?: () => void;
}) {
  const transcripts = useClientAtom(client, client.transcripts);
  const waiting = useMemo(
    () =>
      new Set(
        [...transcripts].filter(([, state]) => pendingCard(state.projection)).map(([id]) => id),
      ),
    [transcripts],
  );
  const snapshot = useClientAtom(client, client.snapshot);
  const selected = useClientAtom(client, client.selectedThreadId);
  const visited = useClientAtom(client, client.visitedThreads);
  const providers = useClientAtom(client, client.providers);
  const [hideMachine, setHideMachine] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<SidebarShelf>>(new Set());
  const [settledVisible, setSettledVisible] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const [workingShelf, setWorkingShelf] = useState(false);
  const [wakeTick, setWakeTick] = useState(0);
  const [limitsOpen, setLimitsOpen] = useState(true);
  const [cursor, setCursor] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [shownSelected, setShownSelected] = useState(selected);
  // Relative ages need only one shared minute tick, including while the server is idle.
  useEffect(() => {
    const timer = setInterval(() => setWakeTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    void client.boundary
      .sidebarWorkingShelf?.()
      .then(setWorkingShelf)
      .catch(() => {});
  }, [client]);
  // Re-classify exactly at the next wake so a woken thread leaves the Snoozed shelf.
  useEffect(() => {
    const now = client.now();
    const wakes = (snapshot?.threads ?? [])
      .map((thread) => stamp(thread.snoozedUntil))
      .filter((wake) => wake > now);
    if (!wakes.length) return undefined;
    const delay = Math.min(Math.min(...wakes) - now + 50, 2_147_483_647);
    const timer = setTimeout(() => setWakeTick((tick) => tick + 1), delay);
    return () => clearTimeout(timer);
  }, [client, snapshot, wakeTick]);
  const entries = useMemo(() => {
    void wakeTick;
    return sidebarEntries(snapshot, {
      hideMachine,
      expanded,
      settledVisible,
      workingShelf,
      inboxReturns,
      selected,
      now: new Date(client.now()).toISOString(),
      visited,
      waiting,
      providers,
    });
  }, [
    client,
    snapshot,
    hideMachine,
    expanded,
    settledVisible,
    workingShelf,
    selected,
    visited,
    waiting,
    providers,
    wakeTick,
  ]);
  const rows = useMemo(() => sidebarRows(entries, width), [entries, width]);
  const limits = useUsageLimits(client);
  const footer: LimitPart[][] = limits.flatMap((provider) => [
    ...(limits.length > 1
      ? wrapName(`${modelIcon(provider.driver, "").glyph} ${provider.instanceId}`, width).map(
          (text) => [{ text }],
        )
      : []),
    ...provider.windows.flatMap((limit) =>
      Bun.stringWidth(limitLine(limit, width)) <= width
        ? [limitParts(limit, width)]
        : wrapName(limitLine(limit, width), width).map((text) => [{ text }]),
    ),
  ]);
  // One header row stays so the box can be reopened; the usage rows below it fold away.
  const footerHeader = footer.length > 0 && height >= 6 ? 1 : 0;
  const footerHeight = limitsOpen
    ? Math.min(footer.length, Math.max(0, height - 4 - footerHeader))
    : 0;
  const viewport = Math.max(1, height - 3 - footerHeight - footerHeader);
  const top = Math.max(0, Math.min(offset, rows.length - viewport));
  const activate = (entry: SidebarEntry) => {
    setCursor(entry.key);
    if (entry.thread) client.openThread(entry.thread.id);
    const { shelf, more } = entry;
    if (shelf)
      setExpanded((old) => {
        const next = new Set(old);
        if (next.has(shelf)) next.delete(shelf);
        else next.add(shelf);
        return next;
      });
    if (more) {
      setSettledVisible((count) => count + SETTLED_TAIL_PAGE_COUNT);
      setCursor(more);
    }
  };
  // Before the first move the cursor rests on the open thread, or else the first thread.
  const current =
    entries.find((e) => e.key === cursor) ??
    entries.find((e) => e.thread?.id === selected) ??
    entries.find((e) => e.thread);
  // A thread opened from elsewhere (the palette, a link) moves the cursor onto it and scrolls it
  // into view; otherwise the highlight would stay on the thread the cursor last rested on.
  if (shownSelected !== selected) {
    setShownSelected(selected);
    const target = entries.find((e) => e.thread?.id === selected);
    if (target && current?.thread?.id !== selected) {
      setCursor(target.key);
      const rowIndex = rows.findIndex((r) => r.entry === target);
      if (rowIndex >= 0)
        setOffset(
          rowIndex < top ? rowIndex : rowIndex >= top + viewport ? rowIndex - viewport + 1 : top,
        );
    }
  }
  const toggle = () => {
    setHideMachine((old) => !old);
    setSettledVisible(SETTLED_TAIL_INITIAL_COUNT);
    setOffset(0);
  };
  useKeyboard((key) => {
    if (!enabled || !keyboardEnabled || key.ctrl || key.meta) return;
    if (key.name === "." && onMenu) {
      if (current?.thread) {
        key.preventDefault();
        onMenu(current.thread.id);
      }
    }
    if (key.name === "h") toggle();
    if (key.name === "u" && footerHeader) setLimitsOpen((open) => !open);
    if (key.name === "return" || key.name === "l" || key.name === "right") {
      const entry = current ?? entries[0];
      if (entry) activate(entry);
      if (entry?.thread && key.name !== "return") onOpen?.();
    }
    if (["up", "down", "j", "k"].includes(key.name)) {
      const index = current ? entries.indexOf(current) : -1;
      const delta = key.name === "up" || key.name === "k" ? -1 : 1;
      const next = entries[Math.max(0, Math.min(entries.length - 1, index + delta))];
      if (next) {
        setCursor(next.key);
        const rowIndex = rows.findIndex((r) => r.entry === next);
        setOffset(
          rowIndex < top ? rowIndex : rowIndex >= top + viewport ? rowIndex - viewport + 1 : top,
        );
      }
    }
    if (key.name === "home") setOffset(0);
    if (key.name === "end") setOffset(Math.max(0, rows.length - viewport));
  });
  return (
    <box width={width} height={height} flexDirection="column">
      <box
        height={2}
        onMouseUp={(event) => {
          if (enabled && event.button === 0) toggle();
        }}
      >
        <text
          fg={theme.accent}
          selectable={false}
        >{`[h] ${hideMachine ? "Human only" : "All threads"}`}</text>
      </box>
      <box
        height={viewport}
        flexDirection="column"
        onMouseScroll={(event) => {
          if (enabled)
            setOffset(
              Math.max(
                0,
                Math.min(
                  Math.max(0, rows.length - viewport),
                  top + (event.scroll?.direction === "up" ? -3 : 3),
                ),
              ),
            );
        }}
      >
        {rows.slice(top, top + viewport).map((row, index) => (
          <text
            key={`${row.entry.key}:${top + index}`}
            height={1}
            selectable={false}
            fg={
              row.rule
                ? theme.rule
                : row.entry.thread
                  ? row.entry.thread.id === selected
                    ? theme.strong
                    : theme.text
                  : theme.muted
            }
            bg={
              !row.rule && row.entry.key === (keyboardEnabled ? current?.key : cursor)
                ? theme.highlight
                : undefined
            }
            onMouseUp={
              row.rule
                ? undefined
                : (event) => {
                    if (enabled && event.button === 0) activate(row.entry);
                    if (enabled && event.button === 2 && row.entry.thread)
                      onMenu?.(row.entry.thread.id);
                  }
            }
          >
            {row.lead ? <span fg={row.entry.modelIcon?.color}>{row.lead}</span> : null}
            {row.text}
            {row.projectText ? <span fg={row.entry.projectColor}>{row.projectText}</span> : null}
            {row.timeText ? <span fg={theme.muted}>{row.timeText}</span> : null}
          </text>
        ))}
        {!rows.length && <text fg={theme.muted}>No threads</text>}
      </box>
      {footerHeader > 0 && (
        <box
          height={1}
          flexShrink={0}
          onMouseUp={(event) => {
            if (enabled && event.button === 0) setLimitsOpen((open) => !open);
          }}
        >
          <text fg={theme.muted} selectable={false}>{`${limitsOpen ? "▾" : "▸"} [u] Usage`}</text>
        </box>
      )}
      {footerHeight > 0 && (
        <scrollbox height={footerHeight} flexShrink={0} scrollY scrollX={false}>
          {footer.map((parts, i) => (
            <text key={i} height={1} fg={theme.accent}>
              {parts.map((part, j) => (
                <span key={j} fg={part.color}>
                  {part.text}
                </span>
              ))}
            </text>
          ))}
        </scrollbox>
      )}
    </box>
  );
}
