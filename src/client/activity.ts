import {
  threadRuntimeIsActive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";
import { itemLabel, type WorkRow } from "./work-log";

/** What the agent is doing right now, for the status row under the transcript. */
export type Activity = { kind: "thinking" } | { kind: "tool"; label: string };

/** Null when the agent is idle or waiting on the user (those have their own prompts).
    A tool in the active run that is still running shows its label; every other
    moment of an active run is the model thinking. */
export function currentActivity(
  thread:
    | {
        runtime?: ThreadRuntimeSummary | null;
        hasPendingApprovals?: boolean;
        hasPendingUserInput?: boolean;
      }
    | undefined,
  rows: readonly WorkRow[],
): Activity | null {
  if (!thread || !threadRuntimeIsActive(thread.runtime)) return null;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return null;
  const runId = thread.runtime?.activeRunId;
  for (let i = rows.length - 1; i >= 0; i--) {
    const item = rows[i]!.item;
    if (runId && item.runId !== runId) continue;
    if (item.status !== "running") continue;
    if (item.type === "reasoning" || item.type === "assistant_message") return { kind: "thinking" };
    if (
      item.type === "command_execution" ||
      item.type === "dynamic_tool" ||
      item.type === "file_change" ||
      item.type === "file_search" ||
      item.type === "web_search"
    )
      return { kind: "tool", label: itemLabel(item) };
  }
  return { kind: "thinking" };
}
