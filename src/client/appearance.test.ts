import { expect, test } from "bun:test";
import { appearanceFromEnv, appearanceOf, detectAppearance, parseBackground } from "./appearance";
import { AUTO_PRESETS, PRESET_NAMES, PRESETS, THEME_CHOICES, resolvePreset, setTheme, theme } from "./theme";

test("OSC 11 replies parse with any digit count and either terminator", () => {
  expect(parseBackground("\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\")).toEqual([30, 30, 46]);
  expect(parseBackground("\x1b]11;rgb:ff/ff/ff\x07")).toEqual([255, 255, 255]);
  expect(parseBackground("\x1b]11;rgb:f/0/8\x07")).toEqual([255, 0, 136]);
  expect(parseBackground("\x1b]11;#fafafa\x07")).toEqual([250, 250, 250]);
  expect(parseBackground("\x1b[?62;4c")).toBeNull();
});

test("a background is dark or light by brightness", () => {
  expect(appearanceOf([30, 30, 46])).toBe("dark");
  expect(appearanceOf([250, 244, 232])).toBe("light");
});

test("COLORFGBG: the last field is the background's ANSI index", () => {
  expect(appearanceFromEnv({ COLORFGBG: "15;0" })).toBe("dark");
  expect(appearanceFromEnv({ COLORFGBG: "0;default;15" })).toBe("light");
  expect(appearanceFromEnv({ COLORFGBG: "0;8" })).toBe("dark");
  expect(appearanceFromEnv({ COLORFGBG: "nonsense" })).toBeNull();
  expect(appearanceFromEnv({})).toBeNull();
});

function terminal(reply: string) {
  const listeners = new Set<(chunk: string) => void>();
  const written: string[] = [];
  return {
    written,
    input: {
      isTTY: true,
      setRawMode: () => {},
      on: (_: "data", listener: (chunk: string) => void) => void listeners.add(listener),
      off: (_: "data", listener: (chunk: string) => void) => void listeners.delete(listener),
      resume: () => {},
      pause: () => {},
    },
    output: {
      write: (bytes: string) => {
        written.push(bytes);
        queueMicrotask(() => listeners.forEach((listener) => listener(reply)));
      },
    },
  };
}

test("detection reads the terminal's answer, then COLORFGBG, then gives up", async () => {
  const light = terminal("\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?62;4c");
  expect(await detectAppearance(light.input, light.output, { COLORFGBG: "15;0" })).toEqual({
    appearance: "light",
    source: "terminal background",
  });
  expect(light.written.join("")).toContain("\x1b]11;?");
  const silent = terminal("\x1b[?62;4c");
  expect((await detectAppearance(silent.input, silent.output, { COLORFGBG: "0;15" })).source).toBe(
    "COLORFGBG",
  );
  const none = terminal("\x1b[?62;4c");
  expect(await detectAppearance(none.input, none.output, {})).toEqual({
    appearance: null,
    source: "no answer from the terminal",
  });
  const notATty = { ...terminal("").input, isTTY: false };
  expect((await detectAppearance(notATty, { write() {} }, {})).appearance).toBeNull();
});

test("there are 15 presets and auto makes 16", () => {
  expect(PRESET_NAMES).toHaveLength(15);
  expect(THEME_CHOICES).toHaveLength(16);
  expect(THEME_CHOICES.at(-1)).toBe("auto");
});

test("auto resolves to Cyberdream on dark or unknown, and light on light", () => {
  expect(resolvePreset("auto", "dark")).toBe(AUTO_PRESETS.dark);
  expect(resolvePreset("auto", null)).toBe("cyberdream");
  expect(resolvePreset("auto", "light")).toBe("light");
  expect(resolvePreset("nord", "light")).toBe("nord");
  expect(resolvePreset(undefined, "light")).toBe("cyberdream");
  setTheme({ preset: "auto", accent: "#123456" }, "light");
  expect(theme.canvas).toBe(PRESETS.light.canvas);
  expect(theme.accent).toBe("#123456");
  setTheme({});
});

test("every preset fills every role", () => {
  for (const name of PRESET_NAMES) {
    const preset = PRESETS[name];
    expect(Object.keys(preset).sort(), name).toEqual(Object.keys(PRESETS.cyberdream).sort());
    expect(preset.ansi, name).toHaveLength(16);
  }
});
