import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionConfig } from "./config";
import { readOptional, platform } from "./platform";
import type { FavoriteEntry } from "./favorites-file";

async function boundaryFor(home: string) {
  const config = await connectionConfig(
    ["--url", "http://127.0.0.1:1"],
    readOptional,
    home,
    { XDG_CONFIG_HOME: join(home, ".config") },
  );
  return { config, boundary: platform(config) };
}

test("saveFavorite seeds an empty file in order, then writes the entry with options", async () => {
  const home = await mkdtemp(join(tmpdir(), "tercet-fav-"));
  try {
    const { boundary, config } = await boundaryFor(home);
    const a: FavoriteEntry = { provider: "claude", model: "opus-5.5" };
    const b: FavoriteEntry = { provider: "claude", model: "sonnet-5.5", options: { effort: "medium" } };
    const c: FavoriteEntry = { provider: "codex", model: "gpt" };

    const saved = await boundary.saveFavorite!(c, true, [a, b]);
    expect(saved).toEqual([a, b, c]);
    expect(await boundary.favoriteEntries!()).toEqual([a, b, c]);
    expect(config.settings.defaults.favorites).toEqual([a, b, c]);

    const text = await readFile(config.settingsPath, "utf8");
    expect(text).toContain('"effort"');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("saveFavorite removes an entry and keeps the existing list otherwise", async () => {
  const home = await mkdtemp(join(tmpdir(), "tercet-fav-"));
  try {
    const { boundary, config } = await boundaryFor(home);
    await boundary.saveFavorite!({ provider: "claude", model: "opus-5.5" }, true);
    const b: FavoriteEntry = { provider: "claude", model: "sonnet-5.5" };
    await boundary.saveFavorite!(b, true);

    const remaining = await boundary.saveFavorite!({ provider: "claude", model: "opus-5.5" }, false, [
      { provider: "ignored", model: "ignored" },
    ]);
    expect(remaining).toEqual([b]);
    expect(config.settings.defaults.favorites).toEqual([b]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("saveFavorite does not re-seed when favorites already exist", async () => {
  const home = await mkdtemp(join(tmpdir(), "tercet-fav-"));
  try {
    const dir = join(home, ".config", "tercet");
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ defaults: { favorites: [{ provider: "claude", model: "opus-5.5" }] } }),
    );
    const { boundary } = await boundaryFor(home);
    const extra: FavoriteEntry = { provider: "codex", model: "gpt" };
    const saved = await boundary.saveFavorite!(extra, true, [{ provider: "seed", model: "seed" }]);
    expect(saved).toEqual([{ provider: "claude", model: "opus-5.5" }, extra]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
