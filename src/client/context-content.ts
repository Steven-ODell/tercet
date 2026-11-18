import type { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  turnItemNeedsDetailFetch,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { omitToolOutputImageData } from "@t3tools/shared/toolOutput";

type ContentProjection = Pick<OrchestrationV2ThreadProjection, "visibleTurnItems" | "runs">;

function textBytes(text: string | null | undefined): number {
  return text ? Buffer.byteLength(text, "utf8") : 0;
}

function valueBytes(value: unknown): number {
  return textBytes(typeof value === "string" ? value : JSON.stringify(value ?? undefined));
}

const estimateTokens = (bytes: number) => Math.ceil(bytes / 4);

function toolContent(item: OrchestrationV2TurnItem) {
  switch (item.type) {
    case "command_execution":
      return {
        name: "Shell commands",
        input: textBytes(item.input),
        output: item.outputOmitted ? 0 : textBytes(turnItemOutputText(item)),
        incomplete: turnItemNeedsDetailFetch(item),
      };
    case "dynamic_tool": {
      const input = item.input;
      const summarized =
        typeof input === "object" && input !== null && "truncated" in input &&
        input.truncated === true && "summary" in input && typeof input.summary === "string";
      const output = item.outputOmitted ? null : turnItemOutputText({
        ...item,
        output: omitToolOutputImageData(item.output),
      });
      return {
        name: item.toolName?.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim() || "Unnamed tools",
        input: summarized ? 0 : valueBytes(input),
        output: textBytes(output),
        incomplete: turnItemNeedsDetailFetch(item),
      };
    }
    case "file_search":
    case "web_search":
      return {
        name: item.type === "file_search" ? "File search" : "Web search",
        input: textBytes(item.type === "file_search" ? item.pattern : item.patterns?.join("\n")),
        output: textBytes(turnItemOutputText(item)),
        incomplete: false,
      };
    case "file_change":
      return {
        name: "File edits",
        input: item.diffStr ? textBytes(item.diffStr) : textBytes(item.oldStr) + textBytes(item.newStr),
        output: 0,
        incomplete: !item.diffStr && !item.oldStr && !item.newStr,
      };
    case "subagent":
      return {
        name: "Subagent messages",
        input: textBytes(item.prompt),
        output: textBytes(item.result),
        incomplete: item.promptOmitted === true || item.resultOmitted === true,
      };
    default:
      return null;
  }
}

/** Estimate loaded transcript text without apportioning the provider's separate window total. */
export function contextContentOf(
  projection: ContentProjection,
  activeProviderThreadId: string | null | undefined,
  hasMoreHistory: boolean,
) {
  if (!activeProviderThreadId) return null;
  const providerByRun = new Map(projection.runs.map((run) => [run.id, run.providerThreadId]));
  const items = projection.visibleTurnItems
    .flatMap(({ item, visibility }) => {
      if (visibility !== "local") return [];
      const provider = item.type === "handoff"
        ? item.toProviderThreadId
        : item.providerThreadId ?? (item.runId && providerByRun.get(item.runId));
      return provider === activeProviderThreadId ? [item] : [];
    });
  const lastCompaction = items.findLastIndex(
    (item) => item.type === "compaction" && item.status === "completed",
  );
  const bytes = {
    "Tool arguments": 0,
    "Tool results": 0,
    "User messages": 0,
    "Assistant messages": 0,
    "Visible reasoning": 0,
    "Plans and summaries": 0,
  };
  const tools = new Map<string, { name: string; bytes: number; calls: number }>();
  let missingToolDetails = 0;
  for (const item of items.slice(Math.max(0, lastCompaction))) {
    const tool = toolContent(item);
    if (tool) {
      bytes["Tool arguments"] += tool.input;
      bytes["Tool results"] += tool.output;
      if (tool.incomplete) missingToolDetails++;
      const total = tools.get(tool.name) ?? { name: tool.name, bytes: 0, calls: 0 };
      total.bytes += tool.input + tool.output;
      total.calls++;
      tools.set(tool.name, total);
      continue;
    }
    switch (item.type) {
      case "user_message":
        bytes["User messages"] += textBytes(item.text);
        break;
      case "assistant_message":
        bytes["Assistant messages"] += textBytes(item.text);
        break;
      case "reasoning":
        bytes["Visible reasoning"] += textBytes(item.text);
        break;
      case "proposed_plan":
        bytes["Plans and summaries"] += textBytes(item.markdown);
        break;
      case "handoff":
      case "compaction":
        bytes["Plans and summaries"] += textBytes(item.summary);
        break;
    }
  }
  return {
    categories: Object.entries(bytes)
      .filter(([, size]) => size > 0)
      .map(([name, size]) => ({ name, tokens: estimateTokens(size) })),
    tools: [...tools.values()]
      .sort((a, b) => b.bytes - a.bytes || b.calls - a.calls || a.name.localeCompare(b.name))
      .map((tool) => ({ name: tool.name, calls: tool.calls, tokens: estimateTokens(tool.bytes) })),
    hasMoreHistory,
    compacted: lastCompaction >= 0,
    missingToolDetails,
  };
}

export type ContextContent = NonNullable<ReturnType<typeof contextContentOf>>;
