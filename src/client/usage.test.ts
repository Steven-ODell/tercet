import { describe, expect, it } from "bun:test";
import { sidebarLimitProviders } from "./usage";
import { claude, usageNow } from "./usage-fixture";

describe("sidebarLimitProviders", () => {
  it("labels windows by duration and measures pace against the clock", () => {
    const [provider] = sidebarLimitProviders(
      [
        claude([
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 42,
            // 3 of 5 hours left, so 40% of the window has elapsed.
            resetsAt: "2026-10-22T15:00:00.000Z",
            windowDurationMins: 300,
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            resetsAt: "2026-10-26T12:00:00.000Z",
            windowDurationMins: 7 * 24 * 60,
          },
        ]),
      ],
      usageNow,
    );
    expect(provider?.windows.map((w) => [w.shortLabel, w.usedPercent, w.paceGap])).toEqual([
      ["5h", 42, -2],
      ["7d", 18, 25],
    ]);
  });

  it("falls back to provider labels when two windows share a duration", () => {
    const week = { kind: "weekly", usedPercent: 10, windowDurationMins: 10080 } as const;
    const [provider] = sidebarLimitProviders(
      [
        claude([
          { ...week, id: "seven_day", label: "Weekly" },
          { ...week, id: "seven_day_opus", label: "Weekly Opus" },
        ]),
      ],
      usageNow,
    );
    expect(provider?.windows.map((w) => [w.shortLabel, w.paceGap])).toEqual([
      ["Weekly", null],
      ["Weekly Opus", null],
    ]);
  });

  it("leaves out providers without windows", () => {
    expect(sidebarLimitProviders([claude([])], usageNow)).toEqual([]);
  });
});
