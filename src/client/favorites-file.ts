import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseJsonc } from "./settings";

export type FavoriteEntry = { provider: string; model: string; options?: Record<string, string | boolean> };

type Token = {
  kind: "{" | "}" | "[" | "]" | ":" | "," | "string" | "atom";
  start: number;
  end: number;
  value?: string;
};

type Member = { key: string; keyTok: Token; valueIdx: number };
type Obj = { open: Token; close: Token; items: Member[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Validates the file with parseJsonc and returns the favorites list (empty when absent). */
function readSettings(text: string): FavoriteEntry[] {
  let root: unknown;
  try {
    root = parseJsonc(text).value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const line = (err as { line?: number }).line;
    throw new Error(
      `favorites: settings file is not valid JSON${line ? ` (line ${line})` : ""}: ${message}`,
    );
  }
  if (!isObject(root)) throw new Error("favorites: settings file root must be a JSON object");
  const defaults = root.defaults;
  if (defaults === undefined) return [];
  if (!isObject(defaults)) throw new Error("favorites: defaults must be a JSON object");
  const favorites = defaults.favorites;
  if (favorites === undefined) return [];
  if (!Array.isArray(favorites)) throw new Error("favorites: defaults.favorites must be a list");
  favorites.forEach((item, i) => {
    if (!isObject(item) || typeof item.provider !== "string" || typeof item.model !== "string")
      throw new Error(`favorites: defaults.favorites[${i}] must have a provider and a model`);
  });
  return favorites as FavoriteEntry[];
}

/** Splits valid JSONC into tokens, skipping whitespace and comments. Run only after parseJsonc. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 2;
    } else if (/\s|﻿/.test(c)) {
      i++;
    } else if (c === '"') {
      const start = i++;
      while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out.push({ kind: "string", start, end: i, value: JSON.parse(text.slice(start, i)) });
    } else if ("{}[]:,".includes(c)) {
      out.push({ kind: c as Token["kind"], start: i, end: ++i });
    } else {
      const start = i;
      while (i < text.length && !/[\s{}\[\]:,"]/.test(text[i]!)) i++;
      out.push({ kind: "atom", start, end: i });
    }
  }
  return out;
}

/** Index just past the value starting at token `k`. */
function skipValue(toks: Token[], k: number): number {
  if (toks[k]!.kind !== "{" && toks[k]!.kind !== "[") return k + 1;
  let depth = 0;
  for (let j = k; ; j++) {
    const kind = toks[j]!.kind;
    if (kind === "{" || kind === "[") depth++;
    else if (kind === "}" || kind === "]") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
}

/** Direct members of the object whose `{` is token `openIdx`. */
function objectAt(toks: Token[], openIdx: number): Obj {
  const items: Member[] = [];
  let j = openIdx + 1;
  while (toks[j]!.kind !== "}") {
    const keyTok = toks[j]!;
    items.push({ key: keyTok.value!, keyTok, valueIdx: j + 2 });
    j = skipValue(toks, j + 2);
    if (toks[j]!.kind === ",") j++;
  }
  return { open: toks[openIdx]!, close: toks[j]!, items };
}

/** Leading whitespace of the line holding `pos`. */
function lineIndent(text: string, pos: number): string {
  const lineStart = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** Indent of the line holding `pos`, but only when `pos` is the first thing on its line. */
function leadingIndent(text: string, pos: number): string | undefined {
  const lineStart = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, pos)) ? lineIndent(text, pos) : undefined;
}

/** Indent for a new member of `obj`: match its first member, else one step deeper than `objIndent`. */
function memberIndentOf(text: string, obj: Obj, objIndent: string): string {
  const first = obj.items[0];
  return (first && leadingIndent(text, first.keyTok.start)) ?? `${objIndent}  `;
}

const formatOptions = (options: Record<string, string | boolean>) => {
  const entries = Object.entries(options);
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
};

function formatEntry(entry: FavoriteEntry): string {
  const parts = [`"provider": ${JSON.stringify(entry.provider)}`, `"model": ${JSON.stringify(entry.model)}`];
  if (entry.options) parts.push(`"options": ${formatOptions(entry.options)}`);
  return `{ ${parts.join(", ")} }`;
}

/** The array text. `keyIndent` is the indent of the line holding its key. */
function formatList(list: FavoriteEntry[], keyIndent: string, eol: string): string {
  if (list.length === 0) return "[]";
  const inner = `${keyIndent}  `;
  const body = list.map((entry) => inner + formatEntry(entry)).join(`,${eol}`);
  return `[${eol}${body}${eol}${keyIndent}]`;
}

/** Adds `memberText` (no indent) as the first member of `obj`. */
function insertFirst(
  text: string,
  obj: Obj,
  memberIndent: string,
  objIndent: string,
  memberText: string,
  eol: string,
): string {
  if (obj.items.length === 0) {
    return (
      text.slice(0, obj.open.start) +
      `{${eol}${memberIndent}${memberText}${eol}${objIndent}}` +
      text.slice(obj.close.end)
    );
  }
  return (
    text.slice(0, obj.open.end) +
    `${eol}${memberIndent}${memberText},` +
    text.slice(obj.open.end)
  );
}

/**
 * Pure. Returns the settings text with `entry` added or replaced (on) or removed (off) in
 * `defaults.favorites`. Only the favorites array's text changes; everything else is kept as is.
 */
export function patchFavorites(text: string, entry: FavoriteEntry, on: boolean): string {
  if (text.trim() === "") {
    return on ? `{\n  "defaults": {\n    "favorites": ${formatList([entry], "    ", "\n")}\n  }\n}\n` : text;
  }

  const list = readSettings(text);
  const same = (f: FavoriteEntry) => f.provider === entry.provider && f.model === entry.model;
  const at = list.findIndex(same);
  let next: FavoriteEntry[];
  if (!on) {
    if (at < 0) return text;
    next = list.filter((f) => !same(f));
  } else if (at < 0) {
    next = [...list, entry];
  } else {
    next = list.flatMap((f, i) => (same(f) ? (i === at ? [entry] : []) : [f]));
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const toks = tokenize(text);
  const root = objectAt(toks, 0);
  const rootIndent = lineIndent(text, root.open.start);
  const defaults = root.items.find((m) => m.key === "defaults");

  if (!defaults) {
    const mi = memberIndentOf(text, root, rootIndent);
    const block = `"defaults": {${eol}${mi}  "favorites": ${formatList(next, `${mi}  `, eol)}${eol}${mi}}`;
    return insertFirst(text, root, mi, rootIndent, block, eol);
  }

  const defaultsObj = objectAt(toks, defaults.valueIdx);
  const defaultsIndent = lineIndent(text, toks[defaults.valueIdx - 2]!.start);
  const favorites = defaultsObj.items.find((m) => m.key === "favorites");

  if (!favorites) {
    const mi = memberIndentOf(text, defaultsObj, defaultsIndent);
    return insertFirst(
      text,
      defaultsObj,
      mi,
      defaultsIndent,
      `"favorites": ${formatList(next, mi, eol)}`,
      eol,
    );
  }

  const arrStart = toks[favorites.valueIdx]!.start;
  const arrEnd = toks[skipValue(toks, favorites.valueIdx) - 1]!.end;
  const keyIndent = lineIndent(text, favorites.keyTok.start);
  return text.slice(0, arrStart) + formatList(next, keyIndent, eol) + text.slice(arrEnd);
}

/**
 * Reads `path` (missing = empty), applies patchFavorites and writes it back atomically (temp file
 * in the same directory, then rename). Returns the resulting favorites list.
 */
export async function writeFavorite(
  path: string,
  entry: FavoriteEntry,
  on: boolean,
): Promise<FavoriteEntry[]> {
  const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  const next = patchFavorites(text, entry, on);
  if (next !== text) {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, next, "utf8");
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
  return next.trim() === "" ? [] : readSettings(next);
}
