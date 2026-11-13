import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import {
  EMPTY_THREAD_HISTORY_META,
  type ThreadHistoryMeta,
} from "@t3tools/client-runtime/state/thread-history-merge";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
export interface TranscriptState {
  projection: OrchestrationV2ThreadProjection | null;
  sequence: number;
  history: ThreadHistoryMeta;
  error: string | null;
  unsupported?: boolean;
}
export const emptyTranscript: TranscriptState = {
  projection: null,
  sequence: -1,
  history: EMPTY_THREAD_HISTORY_META,
  error: null,
};
export function receiveThread(
  state: TranscriptState,
  item: OrchestrationV2ThreadStreamItem,
): TranscriptState {
  if (item.kind === "snapshot")
    return {
      projection: boundedSnapshotProjection(item),
      sequence: item.snapshotSequence,
      error: null,
      history: {
        ...EMPTY_THREAD_HISTORY_META,
        historyCursor: item.historyCursor ?? null,
        hasMoreHistory: item.hasMoreHistory ?? false,
        latestLocalTurnOrdinal: item.latestLocalTurnOrdinal ?? null,
      },
    };
  if (item.kind === "synchronized" || item.sequence <= state.sequence) return state;
  if (item.kind === "unknown-event")
    return { ...state, sequence: item.sequence, unsupported: true };
  const projection = applyOrchestrationV2ProjectionEvent(
    state.projection,
    item.event,
    state.history.hasMoreHistory
      ? { partialTimeline: true, latestLocalTurnOrdinal: state.history.latestLocalTurnOrdinal }
      : undefined,
  );
  return {
    ...state,
    projection,
    sequence: item.sequence,
    error: null,
    history:
      item.event.type === "turn-item.updated"
        ? {
            ...state.history,
            latestLocalTurnOrdinal: Math.max(
              state.history.latestLocalTurnOrdinal ?? 0,
              item.event.payload.ordinal,
            ),
          }
        : state.history,
  };
}
