import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import type { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  contextCompactionLabel,
  summarizeToolGroup,
  workEntryIndicatesToolFailure,
  type WorkLogPresentationEntry,
} from "@t3tools/client-runtime/work-log/presentation";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { extractToolActivityPresentation } from "@t3tools/client-runtime/work-log/tool-presentation";
import { toolCallLines, turnItemOutputText } from "@t3tools/client-runtime/work-log/item-detail";
import type { Message } from "./markdown";
import { fileSourceText } from "./media";
import { pageShotsOn, pageSource } from "./page-shot";
export type WorkRow = OrchestrationV2ThreadProjection["visibleTurnItems"][number];
const grouped = new Set([
  "command_execution",
  "reasoning",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
]);
/** Every item type this build renders; a new type in a vendor sync is a type error here. */
const KNOWN_ITEM_TYPES: { [K in OrchestrationV2TurnItem["type"]]: true } = {
  notification: true,
  user_message: true,
  assistant_message: true,
  reasoning: true,
  proposed_plan: true,
  todo_list: true,
  user_input_request: true,
  file_change: true,
  command_execution: true,
  file_search: true,
  web_search: true,
  approval_request: true,
  checkpoint: true,
  run_interrupt_request: true,
  run_interrupt_result: true,
  system_notice: true,
  error: true,
  compaction: true,
  handoff: true,
  fork: true,
  thread_created: true,
  subagent: true,
  dynamic_tool: true,
  secret_request: true,
  link_request: true,
};
export const isKnownItem = (item: { type?: unknown }) =>
  typeof item.type === "string" && Object.hasOwn(KNOWN_ITEM_TYPES, item.type);
/** One line of an unknown item's own fields (ids and bookkeeping left out), capped at 300. */
export function rawSummary(item: object): string {
  const skip = new Set(["id", "type", "status", "runId", "nodeId", "createdAt", "updatedAt"]);
  const fields = Object.entries(item).filter(([key, value]) => !skip.has(key) && value != null);
  if (!fields.length) return "(no other fields)";
  let text: string;
  try {
    text = fields
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(", ");
  } catch {
    text = fields.map(([key]) => key).join(", ");
  }
  text = text.replace(/\s+/g, " ");
  return text.length > 300 ? `${text.slice(0, 299)}~` : text;
}
export function itemLabel(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "command_execution":
      return commandDisplayText(item.input) || "Command";
    case "dynamic_tool":
      return item.toolName ?? "Tool";
    case "file_change":
      return `${item.fileName} +${item.additions ?? 0} −${item.deletions ?? 0}`;
    case "file_search":
      return `File search ${item.pattern ?? ""}`;
    case "web_search":
      return `Web search ${item.patterns?.join(", ") ?? ""}`;
    case "subagent":
      return item.prompt.split("\n", 1)[0]!.slice(0, 60) || "Subagent";
    case "compaction":
      return contextCompactionLabel(item);
    case "error":
      return item.failure.message;
    case "system_notice":
    case "run_interrupt_request":
    case "run_interrupt_result":
      return item.message;
    case "notification":
      return item.title ?? "Notification";
    case "secret_request":
      return `${item.label} · ${item.secretStatus}`;
    case "handoff":
      return `Handoff to ${item.toModel ?? item.toProviderInstanceId}`;
    default:
      return item.type.replaceAll("_", " ");
  }
}
export function workEntry(item: OrchestrationV2TurnItem): WorkLogPresentationEntry {
  return {
    id: String(item.id),
    createdAt: "",
    label: itemLabel(item),
    itemType: item.type,
    tone: item.type === "reasoning" ? "thinking" : "tool",
    structuredPayload: item,
    ...(item.type === "dynamic_tool"
      ? {
          toolTitle: item.toolName ?? undefined,
          toolData: { input: item.input },
          ...extractToolActivityPresentation(item),
        }
      : {}),
    ...(item.type === "command_execution" ? { command: item.input } : {}),
    toolLifecycleStatus:
      item.status === "running"
        ? "inProgress"
        : item.status === "failed"
          ? "failed"
          : item.status === "completed"
            ? "completed"
            : "idle",
  };
}
export function itemDetail(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "command_execution":
      return [
        item.input,
        turnItemOutputText(item),
        item.exitCode === undefined ? null : `Exit ${item.exitCode}`,
      ]
        .filter(Boolean)
        .join("\n");
    case "dynamic_tool": {
      const call = toolCallLines({ args: item.input });
      return [
        call.args?.map(([k, v]) => `${k}: ${v}`).join("\n"),
        call.argsText,
        turnItemOutputText(item),
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "file_change":
      return (
        item.diffStr ?? item.changes?.map((c) => JSON.stringify(c)).join("\n") ?? itemLabel(item)
      );
    case "file_search":
    case "web_search":
      return turnItemOutputText(item) ?? itemLabel(item);
    case "subagent":
      return [item.prompt, item.progress, item.result, item.childThreadId]
        .filter(Boolean)
        .join("\n");
    case "checkpoint":
      return item.files.map((f) => JSON.stringify(f)).join("\n") || "No changed files";
    case "todo_list":
      return item.steps.map((s) => `${s.status}: ${s.text}`).join("\n");
    case "user_input_request":
      return item.questions.map((q) => q.question).join("\n");
    case "approval_request":
      return item.prompt ?? item.requestKind;
    case "secret_request":
      return item.reason; // Only request metadata; never serialize a secret.
    case "compaction":
    case "handoff":
      return item.summary ?? itemLabel(item);
    case "notification":
      return item.detail ?? itemLabel(item);
    case "proposed_plan":
      return item.markdown;
    default:
      return itemLabel(item);
  }
}
// Projection updates keep unchanged items by identity, so per-item work and group summaries are
// remembered per object: a streamed item costs its own work, not the whole thread's (P7).
const groupable = new WeakMap<object, boolean>();
const entries = new WeakMap<object, WorkLogPresentationEntry>();
const summaries = new WeakMap<
  object,
  { items: readonly object[]; summary: ReturnType<typeof summarizeToolGroup> }
>();
const entryOf = (item: OrchestrationV2TurnItem) => {
  let entry = entries.get(item);
  if (!entry) entries.set(item, (entry = workEntry(item)));
  return entry;
};
function isGroupable(item: OrchestrationV2TurnItem) {
  let known = groupable.get(item);
  if (known === undefined) {
    known =
      grouped.has(item.type) &&
      !(item.type === "dynamic_tool" && !!htmlRenderFromToolItem(item)) &&
      !workEntryIndicatesToolFailure(entryOf(item));
    groupable.set(item, known);
  }
  return known;
}
function groupSummary(rows: readonly WorkRow[]) {
  const items = rows.map((r) => r.item);
  const cached = summaries.get(items[0]!);
  if (
    cached &&
    cached.items.length === items.length &&
    cached.items.every((x, i) => x === items[i])
  )
    return cached.summary;
  const summary = summarizeToolGroup(items.map(entryOf));
  summaries.set(items[0]!, { items, summary });
  return summary;
}
/** Contiguous work stays within a run and source thread; visible events split groups. */
export function workMessages(rows: readonly WorkRow[], expanded: ReadonlySet<string>): Message[] {
  const result: Message[] = [];
  let pending: WorkRow[] = [];
  const emitItem = (row: WorkRow) => {
    const id = `${row.sourceThreadId}/${row.sourceItemId}`;
    const item = row.item;
    if (!isKnownItem(item)) {
      // A type this build does not know (a newer server, or a renderer gap): label and fields,
      // always shown, never an empty row.
      const raw = item as { type?: unknown; status?: unknown };
      const type = typeof raw.type === "string" && raw.type ? raw.type : "untyped";
      result.push({
        id,
        compact: true,
        kind: `[?] unknown item: ${type}${typeof raw.status === "string" ? ` · ${raw.status}` : ""}`,
        text: rawSummary(item),
      });
      return;
    }
    if (item.type === "dynamic_tool") {
      const page = htmlRenderFromToolItem(item);
      if (page)
        result.push({
          id: `${id}/page`,
          kind: "Rendered page",
          text: `[open](${pageSource(page.attachmentId)})${
            pageShotsOn() ? `\n![Rendered page](${pageSource(page.attachmentId)})` : ""
          }`,
        });
    }
    if (item.type === "user_message" || item.type === "assistant_message") {
      result.push({
        id,
        kind: item.type === "user_message" ? "user" : "assistant",
        text: [
          item.text,
          // Screenshots and other images, video and audio, and plain files, as web shows them.
          ...(item.attachments ?? []).map(
            (a) =>
              `![${a.name.replace(/[[\]\n]/g, " ")}](${
                a.type === "image"
                  ? `tercet-image:${encodeURIComponent(JSON.stringify({ id: a.id, mime: a.mimeType }))}`
                  : fileSourceText({ id: a.id, mime: a.mimeType, name: a.name, size: a.sizeBytes })
              })`,
          ),
        ].join("\n"),
      });
      return;
    }
    result.push({
      id,
      compact: true,
      action: true,
      // A subagent with its own thread opens that thread (the agent view) instead of expanding.
      kind: `${item.type === "subagent" && item.childThreadId ? "[open]" : expanded.has(id) ? "[-]" : "[+]"} ${item.type.replaceAll("_", " ")} · ${item.status} · ${itemLabel(item)}`,
      text: expanded.has(id) ? itemDetail(item) : "",
    });
  };
  const flush = () => {
    if (!pending.length) return;
    const id = `work/${pending[0]!.sourceThreadId}/${pending[0]!.sourceItemId}`;
    const summary = groupSummary(pending);
    result.push({
      id,
      compact: true,
      action: true,
      kind: `${expanded.has(id) ? "[-]" : "[+]"} ${summary.summary} · ${pending.length} work items${summary.hasFailure ? " · FAILED" : ""}`,
      text: "",
    });
    if (expanded.has(id)) pending.forEach(emitItem);
    pending = [];
  };
  for (const row of rows) {
    const prev = pending.at(-1);
    if (prev && (prev.item.runId !== row.item.runId || prev.sourceThreadId !== row.sourceThreadId))
      flush();
    if (isGroupable(row.item)) pending.push(row);
    else {
      flush();
      emitItem(row);
    }
  }
  flush();
  return result;
}
