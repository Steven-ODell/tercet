import { describe, expect, it } from "bun:test";

import { formatContextFillPercent } from "./usage";

describe("formatContextFillPercent", () => {
  it("never rounds a non-empty context down to 0%", () => {
    expect(formatContextFillPercent(0.4)).toBe("<1%");
    expect(formatContextFillPercent(0)).toBe("0%");
    expect(formatContextFillPercent(42.6)).toBe("43%");
  });
});
