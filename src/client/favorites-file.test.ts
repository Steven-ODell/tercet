import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchFavorites, writeFavorite, type FavoriteEntry } from "./favorites-file";
import { parseJsonc } from "./settings";

const codex: FavoriteEntry = { provider: "codex", model: "gpt-5.5" };
const opus: FavoriteEntry = { provider: "claude", model: "opus" };

const reparse = (text: string) => parseJsonc(text).value;

const file = `// my settings
{
  "server": {
    "url": "http://127.0.0.1:3773", // trailing comment
  },
  "defaults": {
    // New threads start here.
    "provider": "codex",
    "favorites": [
      { "provider": "codex", "model": "gpt-5.5" },
    ],
    "hints": true,
  },
  "theme": { "accent": "#b07cf5" },
}
`;
const OLD_LIST = `[\n      { "provider": "codex", "model": "gpt-5.5" },\n    ]`;

test("add appends to the list and keeps everything else byte-identical", () => {
  const out = patchFavorites(file, opus, true);
  expect(out).toBe(
    file.replace(
      OLD_LIST,
      `[\n      { "provider": "codex", "model": "gpt-5.5" },\n      { "provider": "claude", "model": "opus" }\n    ]`,
    ),
  );
  expect(reparse(out)).toEqual({
    server: { url: "http://127.0.0.1:3773" },
    defaults: { provider: "codex", favorites: [codex, opus], hints: true },
    theme: { accent: "#b07cf5" },
  });
});

test("replacing an entry keeps its position and updates options", () => {
  const withOpus = patchFavorites(file, opus, true);
  const replaced = patchFavorites(withOpus, { ...codex, options: { effort: "medium" } }, true);
  expect(reparse(replaced)).toMatchObject({
    defaults: {
      favorites: [{ ...codex, options: { effort: "medium" } }, opus],
    },
  });
  expect(replaced).toContain(
    '{ "provider": "codex", "model": "gpt-5.5", "options": { "effort": "medium" } },',
  );
});

test("remove drops the entry and leaves an empty list as []", () => {
  const out = patchFavorites(file, codex, false);
  expect(out).toBe(file.replace(OLD_LIST, "[]"));
  expect(reparse(out)).toMatchObject({ defaults: { favorites: [] } });
});

test("removing an absent entry returns the text unchanged", () => {
  expect(patchFavorites(file, opus, false)).toBe(file);
});

test("defaults without favorites gets favorites as its first key", () => {
  const text = `{\n  "defaults": {\n    // c\n    "provider": "codex",\n  },\n}\n`;
  const out = patchFavorites(text, codex, true);
  expect(out).toBe(
    `{\n  "defaults": {\n    "favorites": [\n      { "provider": "codex", "model": "gpt-5.5" }\n    ],\n    // c\n    "provider": "codex",\n  },\n}\n`,
  );
  expect(reparse(out)).toMatchObject({ defaults: { favorites: [codex], provider: "codex" } });
});

test("no defaults adds a defaults block as the first root key", () => {
  const text = `{\n  "theme": { "accent": "#b07cf5" },\n}\n`;
  const out = patchFavorites(text, codex, true);
  expect(out).toBe(
    `{\n  "defaults": {\n    "favorites": [\n      { "provider": "codex", "model": "gpt-5.5" }\n    ]\n  },\n  "theme": { "accent": "#b07cf5" },\n}\n`,
  );
  expect(reparse(out)).toEqual({ defaults: { favorites: [codex] }, theme: { accent: "#b07cf5" } });
});

test("empty or whitespace text becomes a fresh file; removing from it is a no-op", () => {
  const fresh = `{\n  "defaults": {\n    "favorites": [\n      { "provider": "codex", "model": "gpt-5.5" }\n    ]\n  }\n}\n`;
  expect(patchFavorites("", codex, true)).toBe(fresh);
  expect(patchFavorites("  \n", codex, true)).toBe(fresh);
  expect(patchFavorites("", codex, false)).toBe("");
  expect(reparse(fresh)).toEqual({ defaults: { favorites: [codex] } });
});

test("comment text, string values and trailing commas do not confuse the scanner", () => {
  const text = `{
  // favorites live below
  "defaults": {
    "sendShortcut": "favorites", /* favorites */
    "favorites": [],
  },
}
`;
  const out = patchFavorites(text, codex, true);
  expect(out).toBe(
    text.replace(
      '"favorites": []',
      '"favorites": [\n      { "provider": "codex", "model": "gpt-5.5" }\n    ]',
    ),
  );
  expect(reparse(out)).toEqual({ defaults: { sendShortcut: "favorites", favorites: [codex] } });
});

test("a favorites key nested in another object is ignored", () => {
  const other = `  "other": { "favorites": [ { "provider": "x", "model": "y" } ] },`;
  const text = `{\n${other}\n  "defaults": { "provider": "codex" },\n}\n`;
  const out = patchFavorites(text, codex, true);
  expect(out).toContain(other);
  expect(reparse(out)).toEqual({
    other: { favorites: [{ provider: "x", model: "y" }] },
    defaults: { favorites: [codex], provider: "codex" },
  });
});

test("invalid JSON or a non-object root throws and returns nothing", () => {
  expect(() => patchFavorites('{ "defaults": { "favorites": [ }', codex, true)).toThrow(
    /favorites: settings file is not valid JSON/,
  );
  expect(() => patchFavorites("[]", codex, true)).toThrow(/root must be a JSON object/);
  expect(() => patchFavorites('{ "defaults": 3 }', codex, true)).toThrow(/defaults must be/);
});

test("writeFavorite creates the file, updates it, and leaves no temp files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-fav-"));
  try {
    const path = join(dir, "nested", "settings.json");
    expect(await writeFavorite(path, codex, true)).toEqual([codex]);
    expect(reparse(await readFile(path, "utf8"))).toEqual({ defaults: { favorites: [codex] } });
    expect(await writeFavorite(path, opus, true)).toEqual([codex, opus]);
    expect(await writeFavorite(path, codex, false)).toEqual([opus]);
    expect(await readdir(join(dir, "nested"))).toEqual(["settings.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeFavorite rejects an invalid file and leaves it unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-fav-"));
  try {
    const path = join(dir, "settings.json");
    const broken = `{ "defaults": [ }`;
    await Bun.write(path, broken);
    await expect(writeFavorite(path, codex, true)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path, "utf8")).toBe(broken);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
