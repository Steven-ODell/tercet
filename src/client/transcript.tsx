import { theme } from "./theme";
import { useMemo, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { hintFor } from "./keymap";
import {
  turnItemNeedsDetailFetch,
  turnItemDetailRevision,
} from "@t3tools/client-runtime/work-log/item-detail";
import { EnvironmentId } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { workMessages } from "./work-log";
import { currentActivity } from "./activity";
import { ActivityRow } from "./activity-row";
import { MarkdownCache } from "./markdown";
import { useClientAtom } from "./screen";
import type { Client } from "./runtime";
import { TranscriptViewport } from "./transcript-viewport";
export { TranscriptViewport } from "./transcript-viewport";
const SINGLE_ENVIRONMENT = EnvironmentId.make("tercet");
export function ThreadTranscript({
  client,
  width,
  height,
  enabled,
  keyboardEnabled = true,
  effects,
  openFile,
  openDiff,
  openAgent,
  threadId,
}: {
  /** Shows this thread instead of the selected one: the agent view's child. */
  threadId?: import("@t3tools/contracts").ThreadId;
  /** A subagent item with a child thread opens that thread instead of expanding. */
  openAgent?: (threadId: import("@t3tools/contracts").ThreadId) => void;
  effects?: import("../actions").Actions;
  openFile?: (path: string) => void;
  openDiff?: (target: import("./diff").DiffTarget) => void;
  client: Client;
  width: number;
  height: number;
  enabled: boolean;
  keyboardEnabled?: boolean;
}) {
  const renderer = useRenderer();
  useKeyboard((key) => {
    if (renderer.currentFocusedRenderable?.id === "transcript-search") return;
    if (enabled && keyboardEnabled && key.name === "r") void client.retry();
  });
  const selectedId = useClientAtom(client, client.selectedThreadId);
  const id = threadId ?? selectedId;
  const states = useClientAtom(client, client.transcripts);
  const shell = useClientAtom(client, client.snapshot);
  const status = useClientAtom(client, client.status);
  const [caches] = useState(() => new Map<string, MarkdownCache>());
  const [anchors, setAnchors] = useState(new Map<string, string | null>());
  const state = id ? states.get(id) : undefined;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [details, setDetails] = useState(
    new Map<
      string,
      {
        revision: string;
        item?: import("@t3tools/contracts").OrchestrationV2TurnItem;
        message?: string;
      }
    >(),
  );
  const visibleRows = useMemo(() => state?.projection?.visibleTurnItems ?? [], [state?.projection]);
  const items = useMemo(() => {
    const rows = visibleRows.map((row) => {
      const detail = details.get(`${row.sourceThreadId}/${row.sourceItemId}`);
      return detail?.item && detail.revision === turnItemDetailRevision(row.item)
        ? { ...row, item: detail.item }
        : row;
    });
    return workMessages(rows, expanded).map((message) => {
      const detail = details.get(String(message.id));
      return expanded.has(String(message.id)) && detail?.message
        ? { ...message, text: `${message.text}\n${detail.message}` }
        : message;
    });
  }, [visibleRows, expanded, details]);
  const activate = (key: string) => {
    const changed = visibleRows.find((row) => `${row.sourceThreadId}/${row.sourceItemId}` === key);
    if (changed?.item.type === "subagent" && changed.item.childThreadId && openAgent) {
      openAgent(changed.item.childThreadId);
      return;
    }
    if (changed?.item.type === "file_change" && openDiff && state?.projection) {
      const checkpoint = state.projection.checkpoints.find((c) => c.runId === changed.item.runId);
      if (checkpoint?.appRunOrdinal != null) {
        openDiff({
          threadId: changed.sourceThreadId,
          turn: checkpoint.appRunOrdinal,
          path: changed.item.fileName,
        });
        return;
      }
    }
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    const row = visibleRows.find((row) => `${row.sourceThreadId}/${row.sourceItemId}` === key);
    if (!row || expanded.has(key) || !turnItemNeedsDetailFetch(row.item)) return;
    const revision = turnItemDetailRevision(row.item);
    const existing = details.get(key);
    if (
      existing?.revision === revision &&
      (existing.item || existing.message === "Loading detail…")
    )
      return;
    setDetails((old) => new Map(old).set(key, { revision, message: "Loading detail…" }));
    void client
      .fetchItem({ threadId: row.sourceThreadId, itemId: row.sourceItemId, revision })
      .then(
        (result) => {
          setDetails((old) =>
            new Map(old).set(
              key,
              result.item
                ? { revision, item: result.item }
                : { revision, message: "Detail unavailable. Collapse and expand to retry." },
            ),
          );
        },
        () =>
          setDetails((old) =>
            new Map(old).set(key, {
              revision,
              message: "Detail unavailable. Collapse and expand to retry.",
            }),
          ),
      );
  };
  if (!id) return <text fg={theme.plain}>Select a thread</text>;
  if (!state?.projection)
    return (
      <box flexDirection="column">
        <text fg={theme.plain}>{shell?.threads.find((t) => t.id === id)?.title}</text>
        <text fg={theme.plain}>
          {state?.error ?? (status === "live" ? "Loading transcript…" : "Transcript disconnected")}
        </text>
      </box>
    );
  const notice =
    state.error ??
    (state.unsupported
      ? `Unsupported server item · open this thread in Web (${hintFor("web")}).`
      : null) ??
    (status !== "live" ? "Transcript disconnected. Retry (r)." : null);
  if (!caches.has(id)) caches.set(id, new MarkdownCache());
  const rawThread = shell?.threads.find((t) => t.id === id);
  const activity = currentActivity(
    rawThread && presentThreadShell(SINGLE_ENVIRONMENT, rawThread),
    visibleRows,
  );
  return (
    <box flexDirection="column">
      {notice && (
        <box
          height={1}
          onMouseUp={(event) => {
            if (enabled && event.button === 0) void client.retry();
          }}
        >
          <text fg={theme.plain}>{notice}</text>
        </box>
      )}
      <TranscriptViewport
        effects={effects}
        openFile={openFile}
        cwd={
          shell?.threads.find((t) => t.id === id)?.worktreePath ??
          shell?.projects.find((p) => p.id === shell.threads.find((t) => t.id === id)?.projectId)
            ?.workspaceRoot
        }
        activate={activate}
        measuredCache={caches.get(id)}
        key={id}
        items={items}
        width={width}
        height={height - (notice ? 1 : 0) - 1}
        enabled={enabled}
        keyboardEnabled={keyboardEnabled}
        history={state.history}
        loadEarlier={() => client.loadEarlier(id)}
        anchorState={{
          value: anchors.get(id) ?? null,
          set: (value) => setAnchors((old) => new Map(old).set(id, value)),
        }}
      />
      <ActivityRow activity={activity} width={width} />
    </box>
  );
}
