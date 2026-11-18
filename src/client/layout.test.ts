import { expect, test } from "bun:test";
import { layoutFor, layoutModeFromEnv } from "./layout";
import { defaultSettings, parseSettings, SettingsError } from "./settings";

const where = { home: "/home/u", dir: "/home/u/.config/tercet" };
const at = (width: number, height: number, mode?: "auto" | "compact" | "full") =>
  layoutFor({ width, height, mode });

test("desktop sizes are full", () => {
  expect(at(120, 40)).toEqual({ narrow: false, short: false, compact: false });
  expect(at(80, 24)).toEqual({ narrow: false, short: false, compact: false });
  expect(at(70, 24).compact).toBe(false);
});

test("narrow below 70 columns", () => {
  expect(at(50, 40)).toEqual({ narrow: true, short: false, compact: true });
  expect(at(69, 40).narrow).toBe(true);
});

test("short below 24 rows", () => {
  expect(at(110, 20)).toEqual({ narrow: false, short: true, compact: true });
  expect(at(80, 23).short).toBe(true);
  expect(at(80, 23).compact).toBe(true);
});

test("mode compact and full override the size", () => {
  expect(at(120, 40, "compact")).toEqual({ narrow: false, short: false, compact: true });
  expect(at(50, 10, "full")).toEqual({ narrow: true, short: true, compact: false });
  expect(at(50, 10, "auto").compact).toBe(true);
});

test("TERCET_LAYOUT beats the file", () => {
  expect(layoutModeFromEnv({}, "full")).toBe("full");
  expect(layoutModeFromEnv({})).toBe("auto");
  expect(layoutModeFromEnv({ TERCET_LAYOUT: "compact" }, "full")).toBe("compact");
  expect(layoutModeFromEnv({ TERCET_LAYOUT: "full" }, "compact")).toBe("full");
  expect(layoutModeFromEnv({ TERCET_LAYOUT: "auto" }, "compact")).toBe("auto");
  expect(layoutModeFromEnv({ TERCET_LAYOUT: "" }, "compact")).toBe("compact");
  expect(layoutModeFromEnv({ TERCET_LAYOUT: "bogus" }, "compact")).toBe("compact");
});

test("a bad layout setting is a SettingsError naming layout", () => {
  expect(defaultSettings().layout).toBe("auto");
  expect(parseSettings('{"layout": "compact"}', "/s.json", where).layout).toBe("compact");
  let error: unknown;
  try {
    parseSettings('{"layout": "tiny"}', "/s.json", where);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(SettingsError);
  expect((error as Error).message).toContain("layout:");
});
