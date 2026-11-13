import { expect, test } from "bun:test";
import type { ServerProvider } from "@t3tools/contracts";
import { emojiChoices } from "./emoji";
import { afterAll, beforeAll } from "bun:test";
import { fileIcon, modelIcon, paneGlyphs, projectGlyph, selectionIcon, setIconMode } from "./icons";

// Distinct glyphs per file type are the Nerd Font set; the others tell types apart by color.
beforeAll(() => setIconMode("nerd"));
afterAll(() => setIconMode());
import { sidebarRows } from "./sidebar";

test("a model's logo follows its driver, and any local model is the chip", () => {
  const claude = modelIcon("claudeAgent", "claude-opus-5-5");
  const openai = modelIcon("codex", "gpt-6.1-sol");
  const opencode = modelIcon("opencode", "opencode/beam-free");
  const local = modelIcon("opencode", "ollama/qwen3.5:9b");
  expect(new Set([claude, openai, opencode, local].map((i) => i.glyph)).size).toBe(4);
  expect(modelIcon("opencode", "lmstudio/x")).toBe(local);
  expect(modelIcon("someAcpAgent", "x")).toBe(modelIcon(undefined, "x"));
});

test("a custom instance takes its driver's logo from the catalog; a default id is the driver", () => {
  const providers = [{ instanceId: "work", driver: "claudeAgent" }] as unknown as ServerProvider[];
  const claude = modelIcon("claudeAgent", "m");
  const selection = (instanceId: string) => ({ instanceId, model: "m" }) as never;
  expect(selectionIcon(selection("work"), providers)).toBe(claude);
  expect(selectionIcon(selection("claudeAgent"), [])).toBe(claude);
});

test("file icons read the last segment: names beat extensions, folders open and close", () => {
  expect(fileIcon("a/b/x.ts").glyph).toBe(fileIcon("y.mts").glyph);
  expect(fileIcon("apps/package.json").glyph).not.toBe(fileIcon("data.json").glyph);
  expect(fileIcon("README.md").glyph).not.toBe(fileIcon("notes.md").glyph);
  expect(fileIcon("no-extension").glyph).toBe(fileIcon("mystery.qqq").glyph);
  expect(fileIcon("src", "directory").glyph).not.toBe(fileIcon("src", "directory", true).glyph);
  expect(fileIcon("@src/", "directory").glyph).toBe(fileIcon("src", "directory").glyph);
});

test("a project shows its chosen emoji or monogram, else a glyph, else the folder", () => {
  const folder = fileIcon("x", "directory").glyph;
  expect(projectGlyph({ projectIcon: { kind: "emoji", emoji: "🚀" } })).toBe("🚀");
  expect(projectGlyph({ projectIcon: { kind: "monogram", text: "M", color: "blue" } })).toBe("M");
  expect(projectGlyph({ projectIcon: null })).toBe(folder);
  const named = (name: string) =>
    projectGlyph({ projectIcon: { kind: "lucide", name, color: "red" } });
  expect(named("rocket")).not.toBe(folder);
  expect(named("not-a-mapped-icon")).toBe(folder);
});

test("emoji choices rank exact and prefix names first, and stay bounded", () => {
  expect(emojiChoices("")).toEqual([]);
  expect(emojiChoices("fire")[0]).toBe("🔥 fire");
  expect(emojiChoices("fire:")[0]).toBe("🔥 fire");
  expect(emojiChoices("+1")[0]).toBe("👍 thumbsup");
  expect(emojiChoices("zzqq")).toEqual([]);
  expect(emojiChoices("a").length).toBeLessThanOrEqual(8);
});

test("the sidebar logo and project glyph count toward the row's width", () => {
  const icon = modelIcon("claudeAgent", "m");
  const entry = {
    key: "x",
    text: `Name\n${icon.glyph} ▶ running`,
    project: "Repo",
    projectGlyph: "🚀",
    modelIcon: icon,
  };
  const inline = sidebarRows([entry], 28).at(-1)!;
  expect(inline.lead).toBe(`  ${icon.glyph}`);
  expect(inline.text).toBe(" ▶ running");
  expect(inline.projectText).toBe(" · 🚀 Repo");
  // Rows never wrap: a project with under four cells of room is left out.
  const narrow = sidebarRows([entry], 16);
  expect(narrow.at(-1)!.projectText).toBe("");
  expect(narrow.every((r) => Bun.stringWidth(r.lead + r.text + r.projectText) <= 16)).toBe(true);
});

test("unicode and ascii icons stay one cell, and ascii stays ASCII", () => {
  for (const mode of ["unicode", "ascii"] as const) {
    setIconMode(mode);
    const glyphs = [
      ...["claudeAgent", "codex", "opencode", "cursor", "grok", "antigravity", "pi", "x"].map(
        (driver) => modelIcon(driver, "m").glyph,
      ),
      modelIcon("opencode", "ollama/q").glyph,
      ...["a.ts", "README.md", ".env", "x"].map((path) => fileIcon(path).glyph),
      fileIcon("src", "directory").glyph,
      fileIcon("src", "directory", true).glyph,
      projectGlyph({ projectIcon: { kind: "lucide", name: "rocket", color: "red" } }),
      ...Object.values(paneGlyphs),
    ];
    for (const glyph of glyphs) expect(Bun.stringWidth(glyph)).toBe(1);
    if (mode === "ascii") expect(glyphs.join("")).toMatch(/^[\x20-\x7e]+$/);
    expect(fileIcon("src", "directory").glyph).not.toBe(fileIcon("src", "directory", true).glyph);
    expect(fileIcon("a.ts").color).not.toBe(fileIcon("a.json").color);
  }
  expect(projectGlyph({ projectIcon: { kind: "emoji", emoji: "🚀" } })).toBe("*");
  setIconMode("nerd");
});
