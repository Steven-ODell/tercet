import { describe, expect, it } from "bun:test";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

import { allocate, chipLayout, contextDetailOf, detailLines, relativeMinutes } from "./context-meter";
import { contextContentOf } from "./context-content";

const report = (providerThreadId: string, updatedAt: string, extra: object = {}) => ({
  providerThreadId: providerThreadId as never,
  tokenUsage: {
    usedTokens: 64_921,
    maxTokens: 200_000,
    inputTokens: 64_919,
    cachedInputTokens: 64_598,
    outputTokens: 2,
    updatedAt,
    ...extra,
  },
});

describe("contextDetailOf", () => {
  it("splits used into cached, new input and output, then free and the compact buffer", () => {
    const detail = contextDetailOf({
      activeProviderThreadId: "p1",
      providerThread: { contextUsage: { usedTokens: 64_921, maxTokens: 200_000 } },
      providerTurns: [report("p1", "2026-11-12T10:00:00Z", { autoCompactThreshold: 160_000 })],
    })!;
    expect(detail.percent).toBeCloseTo(32.46, 1);
    expect(detail.slices.map((s) => [s.name, s.tokens])).toEqual([
      ["Cached input", 64_598],
      ["New input", 321],
      ["Output", 2],
      ["Free", 95_079],
      ["Compact buffer", 40_000],
    ]);
  });

  it("takes the newest report of the active provider thread only", () => {
    const detail = contextDetailOf({
      activeProviderThreadId: "p2",
      providerThread: undefined,
      providerTurns: [
        report("p2", "2026-11-12T09:00:00Z", { usedTokens: 1_000, inputTokens: 900, outputTokens: 100 }),
        report("p1", "2026-11-12T11:00:00Z"),
        report("p2", "2026-11-12T10:00:00Z", { usedTokens: 2_000, inputTokens: 1_900, outputTokens: 100 }),
      ],
    })!;
    expect(detail.used).toBe(2_000);
  });

  it("falls back to the provider thread's totals as one used slice", () => {
    const detail = contextDetailOf({
      activeProviderThreadId: "p1",
      providerThread: { contextUsage: { usedTokens: 46_009, maxTokens: 1_000_000 } },
      providerTurns: [],
    })!;
    expect(detail.slices.map((s) => s.name)).toEqual(["Used", "Free"]);
    expect(detail.compactAt).toBeNull();
  });

  it("has nothing before the first report, and no bar without a window size", () => {
    expect(
      contextDetailOf({ activeProviderThreadId: "p1", providerThread: undefined, providerTurns: [] }),
    ).toBeNull();
    const sizeless = contextDetailOf({
      activeProviderThreadId: "p1",
      providerThread: { contextUsage: { usedTokens: 40_000 } },
      providerTurns: undefined,
    })!;
    expect(sizeless.slices).toEqual([]);
    expect(chipLayout(sizeless, 80, false)).toMatchObject({ head: "Context 40k", bar: 0 });
  });
});

describe("allocate", () => {
  it("fills the width and keeps a sliver for every used slice", () => {
    const cells = allocate(
      [
        { tokens: 64_598, kind: "used" },
        { tokens: 321, kind: "used" },
        { tokens: 135_081, kind: "free" },
      ],
      20,
    );
    expect(cells.reduce((a, b) => a + b, 0)).toBe(20);
    expect(cells[1]).toBe(1);
  });
});

describe("chipLayout", () => {
  const detail = contextDetailOf({
    activeProviderThreadId: "p1",
    providerThread: { contextUsage: { usedTokens: 430_000, maxTokens: 1_000_000 } },
    providerTurns: [],
  });
  it("drops the bar, then the tokens, then itself as room runs out", () => {
    expect(chipLayout(detail, 60, false)).toMatchObject({ bar: 24, tail: "430k / 1M" });
    expect(chipLayout(detail, 30, false)).toMatchObject({ bar: 0, tail: "430k / 1M" });
    expect(chipLayout(detail, 14, false)).toMatchObject({ bar: 0, tail: "" });
    expect(chipLayout(detail, 5, false)).toBeNull();
    expect(chipLayout(null, 40, false)?.head).toBe("Context unknown");
  });
});

describe("detailLines", () => {
  it("says when the prompt cache runs out", () => {
    const now = Date.parse("2026-11-12T10:00:00Z");
    const detail = contextDetailOf({
      activeProviderThreadId: "p1",
      providerThread: undefined,
      providerTurns: [report("p1", "2026-11-12T09:50:00Z", { promptCacheExpiresAt: "2026-11-12T10:50:00Z" })],
    });
    expect(detailLines(detail, 42, now).map((l) => l.text)).toContain(
      "Prompt cache warm, expires in 50m.",
    );
    expect(relativeMinutes(now - 3 * 60_000, now)).toBe("3m ago");
    expect(relativeMinutes(now + 65 * 60_000, now)).toBe("in 1h 5m");
  });
});

const row = (
  type: OrchestrationV2ProjectedTurnItem["item"]["type"],
  values: object,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
) => ({ visibility, item: { type, providerThreadId: "p1", status: "completed", ...values } }) as OrchestrationV2ProjectedTurnItem;

describe("contextContentOf", () => {
  it("estimates loaded messages and ranks tools with argument and result text", () => {
    const content = contextContentOf({
      runs: [],
      visibleTurnItems: [
        row("user_message", { text: "éééé" }),
        row("assistant_message", { text: "reply" }),
        row("reasoning", { text: "some reasoning" }),
        row("command_execution", { input: "echo out", output: "example text" }),
        row("dynamic_tool", { toolName: "Read", input: "test", output: "read a longer file" }),
        row("dynamic_tool", { toolName: "Read", input: "more", outputOmitted: true, output: "ignored preview" }),
        row("dynamic_tool", { toolName: "Other", input: { truncated: true, summary: "ignored argument preview" } }),
      ],
    }, "p1", true)!;
    expect(content.categories).toEqual([
      { name: "Tool arguments", tokens: 4 },
      { name: "Tool results", tokens: 8 },
      { name: "User messages", tokens: 2 },
      { name: "Assistant messages", tokens: 2 },
      { name: "Visible reasoning", tokens: 4 },
    ]);
    expect(content.tools).toEqual([
      { name: "Read", calls: 2, tokens: 7 },
      { name: "Shell commands", calls: 1, tokens: 5 },
      { name: "Other", calls: 1, tokens: 0 },
    ]);
    expect(content.missingToolDetails).toBe(2);
    const lines = detailLines(null, 42, 0, content).map((line) => line.text);
    expect(lines).toContain("Loaded transcript (estimated)");
    expect(lines).toContain("Read · 2 calls · ~7");
    expect(lines.join(" ")).toContain("Older history is outside the loaded transcript.");
    expect(lines.join(" ")).toContain("Some tool text unavailable for 2 calls.");
  });

  it("scopes estimates to the active provider thread since its last loaded compaction", () => {
    const content = contextContentOf({
      runs: [{ id: "run", providerThreadId: "p1" }] as never,
      visibleTurnItems: [
        row("user_message", { text: "Before compaction" }),
        row("compaction", { summary: "seed" }),
        row("user_message", { text: "next", providerThreadId: null, runId: "run" }),
        row("user_message", { text: "Inherited" }, "inherited"),
        row("compaction", { summary: "Other provider", providerThreadId: "p2" }),
        row("assistant_message", { text: "Old provider", providerThreadId: "p2" }),
      ],
    }, "p1", false)!;
    expect(content.categories).toEqual([
      { name: "User messages", tokens: 1 },
      { name: "Plans and summaries", tokens: 1 },
    ]);
    expect(content.compacted).toBe(true);
    expect(detailLines(null, 42, 0, content).map((line) => line.text)).toContain(
      "Since the last loaded compaction.",
    );
  });
});
