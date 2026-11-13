import { theme } from "./theme";
import { hintFor } from "./keymap";
import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ProjectEntry, ProjectReadFileResult } from "@t3tools/contracts";
import type { Client } from "./runtime";
import type { Actions } from "../actions";
import { fileIcon, type Icon } from "./icons";
import { code } from "./markdown";
import { InlineImage } from "./image-preview";
import { mediaKind } from "./media";

export type FilesApi = Client["files"];
type Row = ProjectEntry & { lead?: string; icon: Icon; label: string; line?: number };
/** What the terminal can draw natively; everything else is read as text. */
const isImage = (path: string) => /\.(png|jpe?g|gif|webp)$/i.test(path);
// Video and audio are never read as text; the preview names them (web plays them inline).
type Loaded =
  { text: ProjectReadFileResult } | { image: Uint8Array } | { media: "video" | "audio" };

/** The panel owns navigation only; all filesystem reads belong to the connected environment. */
export function FilesPanel({
  api,
  cwd,
  path,
  enabled,
  effects,
  close,
  height,
  width = 30,
  peekDelay = 80,
}: {
  api: FilesApi;
  cwd?: string;
  path?: string;
  enabled: boolean;
  effects?: Actions;
  close: () => void;
  height: number;
  /** Inner cell width, used to size and clip the preview. */
  width?: number;
  /** Wait before previewing the row under the cursor, so holding j does not read every file. */
  peekDelay?: number;
}) {
  const [mode, setMode] = useState<"tree" | "find" | "search">("tree");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [index, setIndex] = useState(0);
  const [file, setFile] = useState<string>();
  const [line, setLine] = useState(0);
  const [preview, setPreview] = useState<Loaded>();
  const [peeking, setPeeking] = useState(true);
  const [peek, setPeek] = useState<{ path: string; loaded?: Loaded; failed?: boolean }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const readGeneration = useRef(0);
  // Expanding a folder lists only that folder; everything already listed is reused until a retry.
  const listings = useRef(new Map<string, ReturnType<FilesApi["list"]>>());
  const lastView = useRef("");
  // Previews already read, so moving back over a file shows it at once.
  const loads = useRef(new Map<string, Promise<Loaded>>());
  const loadImage = effects?.loadImage;
  const load = (target: string): Promise<Loaded> => {
    const key = `${cwd}\0${target}`;
    const known = loads.current.get(key);
    if (known) return known;
    const kind = mediaKind(target);
    const fresh: Promise<Loaded> =
      kind === "video" || kind === "audio"
        ? Promise.resolve({ media: kind })
        : isImage(target) && loadImage
          ? loadImage(target, cwd).then((image) => ({ image }))
          : api.read({ cwd: cwd!, relativePath: target }).then((text) => ({ text }));
    if (loads.current.size >= 32) loads.current.delete(loads.current.keys().next().value!);
    loads.current.set(key, fresh);
    fresh.catch(() => loads.current.delete(key));
    return fresh;
  };
  useEffect(() => {
    listings.current.clear();
    loads.current.clear();
    setExpanded([]);
    setFile(undefined);
    setPreview(undefined);
    setQuery("");
    setMode("tree");
  }, [cwd]);
  useEffect(() => {
    if (path) {
      setFile(path.replace(/:\d+(?::\d+)?$/, ""));
      setLine(Math.max(0, Number(path.match(/:(\d+)(?::\d+)?$/)?.[1] ?? 1) - 1));
    }
  }, [path, cwd]);
  useEffect(() => {
    if (!cwd) return;
    let current = true;
    setLoading(true);
    setError("");
    // Expanding or collapsing a folder keeps the rows and the cursor; a new mode or query starts over.
    const view = `${cwd}\0${mode}\0${query}`;
    if (view !== lastView.current) {
      lastView.current = view;
      setRows([]);
      setIndex(0);
    }
    const load = async (): Promise<{ rows: Row[]; truncated: boolean }> => {
      if (mode === "search") {
        if (!query) return { rows: [], truncated: false };
        const result = await api.search({
          cwd,
          query,
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });
        return {
          rows: result.matches.map((m) => ({
            path: m.path,
            kind: "file",
            icon: fileIcon(m.path),
            label: `${m.path}:${m.lineNumber} ${m.lineContent}`,
            line: m.lineNumber,
          })),
          truncated: result.truncated,
        };
      }
      if (mode === "find") {
        const result = await api.find({ cwd, query, limit: 100, kind: "file" });
        return {
          rows: result.entries.map((e) => ({
            ...e,
            icon: fileIcon(e.path, e.kind),
            label: e.path,
          })),
          truncated: result.truncated,
        };
      }
      const dirs = ["", ...expanded];
      const results = await Promise.all(
        dirs.map((directoryPath) => {
          const key = `${cwd}\0${directoryPath}`;
          const known = listings.current.get(key);
          if (known) return known;
          const fresh = api.list({ cwd, directoryPath });
          listings.current.set(key, fresh);
          fresh.catch(() => listings.current.delete(key));
          return fresh;
        }),
      );
      const flatten = (dir: string, depth: number): Row[] =>
        [...(results[dirs.indexOf(dir)]?.entries ?? [])]
          .sort((a, b) =>
            a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "directory" ? -1 : 1,
          )
          .flatMap((e) => [
            {
              ...e,
              lead: `${"  ".repeat(depth)}${e.kind === "directory" ? (expanded.includes(e.path) ? "▾ " : "▸ ") : "  "}`,
              icon: fileIcon(e.path, e.kind, expanded.includes(e.path)),
              label: e.path.split("/").at(-1) ?? e.path,
            },
            ...(e.kind === "directory" && expanded.includes(e.path)
              ? flatten(e.path, depth + 1)
              : []),
          ]);
      return { rows: flatten("", 0), truncated: results.some((r) => r.truncated) };
    };
    // Search submits explicitly; cleanup rejects stale responses after navigation.
    void load()
      .then((result) => {
        if (current) {
          setRows(result.rows);
          setIndex((n) => Math.max(0, Math.min(n, result.rows.length - 1)));
          setNotice(result.truncated ? "Results limited; narrow your query" : "");
        }
      })
      .catch(() => {
        if (current) setError("Files unavailable. Reconnect or [r Retry].");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, cwd, mode, query, expanded, retry]);
  useEffect(() => {
    const generation = ++readGeneration.current;
    setPreview(undefined);
    setError("");
    if (!file || !cwd) return;
    setLoading(true);
    void load(file)
      .then((result) => {
        if (generation === readGeneration.current) setPreview(result);
      })
      .catch(() => {
        if (generation === readGeneration.current)
          setError("Preview unavailable (binary, missing or denied). [r Retry]");
      })
      .finally(() => {
        if (generation === readGeneration.current) setLoading(false);
      });
    return () => {
      readGeneration.current++;
    };
  }, [api, cwd, file, retry]);
  const lines = useMemo(
    () => (preview && "text" in preview ? preview.text.contents.split("\n") : []),
    [preview],
  );
  const visible = Math.max(1, height - 9);
  // The list keeps the top; the preview of the row under the cursor gets the rest.
  const peekRows = peeking && !file && visible >= 12 ? Math.floor(visible * 0.55) - 1 : 0;
  const listRows = peekRows ? visible - peekRows - 1 : visible;
  const cursor = file ? undefined : rows[index];
  const peekPath = peekRows && cursor?.kind === "file" ? cursor.path : undefined;
  useEffect(() => {
    setPeek(peekPath ? { path: peekPath } : undefined);
    if (!peekPath || !cwd) return;
    let current = true;
    const show = () =>
      void load(peekPath).then(
        (loaded) => current && setPeek({ path: peekPath, loaded }),
        () => current && setPeek({ path: peekPath, failed: true }),
      );
    const wait = loads.current.has(`${cwd}\0${peekPath}`) ? 0 : peekDelay;
    const timer = wait ? setTimeout(show, wait) : undefined;
    if (!wait) show();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, cwd, peekPath, retry]);
  const choose = (row?: Row) => {
    if (!row) return;
    if (row.kind === "directory")
      setExpanded((value) =>
        value.includes(row.path)
          ? value.filter((p) => p !== row.path && !p.startsWith(row.path + "/"))
          : [...value, row.path],
      );
    else {
      setFile(row.path);
      setLine(Math.max(0, (row.line ?? 1) - 1));
      setEditing(false);
    }
  };
  const changeMode = (next: typeof mode) => {
    setFile(undefined);
    setMode(next);
    setQuery("");
    setDraft("");
    setEditing(next !== "tree");
    setNotice("");
  };
  const editor = async () => {
    if (!cwd || !file) return;
    setNotice("Opening editor…");
    try {
      if (!effects?.editor) throw new Error();
      await effects.editor({ cwd, path: file });
      setNotice("Editor ✓");
    } catch {
      setNotice("Editor failed. Press o to retry.");
    }
  };
  useKeyboard((key) => {
    if (!enabled || key.defaultPrevented || key.ctrl || key.meta || key.name === "tab") return;
    if (key.name === "escape") {
      // At the top level Esc is left for the frame, which leaves the panel.
      if (!editing && !file) return;
      key.preventDefault();
      if (editing) setEditing(false);
      else setFile(undefined);
      return;
    }
    key.preventDefault();
    if (editing) {
      if (key.name === "return") {
        setQuery(draft);
        setEditing(false);
        return;
      }
      if (key.name === "backspace") setDraft((q) => q.slice(0, -1));
      else if (
        key.sequence &&
        Array.from(key.sequence).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
        draft.length < 256
      )
        setDraft((q) => q + key.sequence);
      return;
    }
    if (["up", "down", "j", "k"].includes(key.name)) {
      const delta = key.name === "up" || key.name === "k" ? -1 : 1;
      if (file) setLine((n) => Math.max(0, Math.min(lines.length - 1, n + delta)));
      else setIndex((n) => Math.max(0, Math.min(rows.length - 1, n + delta)));
    } else if (key.name === "h" || key.name === "left") {
      // Back out one level: close the file, collapse the folder, else jump to the parent folder.
      const row = rows[index];
      if (file) setFile(undefined);
      else if (row?.kind === "directory" && expanded.includes(row.path)) choose(row);
      else if (row && mode === "tree") {
        const parent = rows.findIndex((r) => r.path === row.path.split("/").slice(0, -1).join("/"));
        if (parent >= 0) setIndex(parent);
      }
    } else if (key.name === "l" || key.name === "right") {
      // Open the file or expand the folder; on an open folder, step into it.
      const row = rows[index];
      if (!file && row?.kind === "directory" && expanded.includes(row.path))
        setIndex(Math.min(rows.length - 1, index + 1));
      else if (!file) choose(row);
    } else if (key.name === "return") choose(rows[index]);
    else if (key.sequence === "o") void editor();
    else if (key.sequence === "p") setPeeking((v) => !v);
    else if (key.sequence === "g" || key.sequence === "G") {
      const last = Math.max(0, (file ? lines.length : rows.length) - 1);
      (file ? setLine : setIndex)(key.sequence === "g" ? 0 : last);
    } else if (key.sequence === "b") {
      setFile(undefined);
      changeMode("tree");
    } else if (key.sequence === "/") changeMode("find");
    else if (key.sequence === "s") changeMode("search");
    else if (key.sequence === "r") {
      listings.current.clear();
      loads.current.clear();
      setRetry((n) => n + 1);
    }
  });
  const button = (label: string, action: () => void) => (
    <box
      flexShrink={0}
      onMouseUp={(e) => {
        if (e.button === 0) action();
      }}
    >
      <text fg={theme.accent} selectable={false}>
        {label}
      </text>
    </box>
  );
  const start = Math.max(0, index - listRows + 1);
  const numbered = (from: number, count: number, source: readonly string[]) =>
    source.slice(from, from + count).map((text, i) => (
      <text fg={theme.plain} key={from + i} height={1} flexShrink={0}>
        <span fg={theme.muted}>{from + i + 1} </span>
        {code(text.slice(0, Math.max(1, width - 6))).map((s, j) => (
          <span key={j} fg={s.color}>
            {s.text}
          </span>
        ))}
      </text>
    ));
  const peekLines =
    peek?.loaded && "text" in peek.loaded ? peek.loaded.text.contents.split("\n") : [];
  const peekTitle = cursor ? ` ${cursor.path.split("/").at(-1)} ` : "";
  return (
    <box flexDirection="column" height="100%" minHeight={0}>
      <box flexDirection="row" flexWrap="wrap" flexShrink={0}>
        {button("[b Tree]", () => changeMode("tree"))}
        {button("[/ Find]", () => changeMode("find"))}
        {button("[s Search]", () => changeMode("search"))}
        {button(peeking ? "[p Preview on]" : "[p Preview off]", () => setPeeking((v) => !v))}
        {button(editing || file ? "[Esc Back]" : `[${hintFor("leave")} Close]`, () => {
          if (editing) setEditing(false);
          else if (file) setFile(undefined);
          else close();
        })}
      </box>
      <text flexShrink={0} fg={theme.muted}>
        {cwd ?? "Select a project thread"}
      </text>
      {mode !== "tree" &&
        button(`${editing ? "Typing" : "Query"}: ${draft || "(empty)"} [Enter results]`, () => {
          if (editing) setQuery(draft);
          setEditing((v) => !v);
        })}
      {file && (
        <>
          <text fg={theme.plain} flexShrink={0}>
            <span fg={fileIcon(file).color}>{fileIcon(file).glyph} </span>
            {file}
          </text>
          {button("[o Editor]", () => {
            void editor();
          })}
        </>
      )}
      {loading && <text fg={theme.plain}>Loading files…</text>}
      {error && button(error, () => setRetry((n) => n + 1))}
      {notice && <text fg={theme.plain}>{notice}</text>}
      {preview && "text" in preview && preview.text.truncated && (
        <text fg={theme.plain}>Preview truncated</text>
      )}
      <scrollbox flexGrow={1} minHeight={0} scrollY scrollX={false}>
        {file ? (
          preview && "image" in preview ? (
            <InlineImage
              bytes={preview.image}
              width={Math.max(1, width)}
              height={visible}
              fallback={`[image ${file}]`}
            />
          ) : preview && "media" in preview ? (
            <text fg={theme.accent} selectable={false}>{`[${preview.media} ${file}]`}</text>
          ) : (
            numbered(line, visible, lines)
          )
        ) : (
          rows.slice(start, start + listRows).map((row, i) => (
            <box
              key={`${row.path}:${row.line ?? ""}`}
              onMouseUp={(e) => {
                if (e.button === 0) {
                  setIndex(start + i);
                  choose(row);
                }
              }}
            >
              <text fg={start + i === index ? theme.accent : theme.bright} selectable={false}>
                {start + i === index ? "› " : "  "}
                {row.lead}
                <span fg={row.icon.color}>{row.icon.glyph} </span>
                {row.label}
              </text>
            </box>
          ))
        )}
        {!file && !loading && !error && rows.length === 0 && (
          <text fg={theme.plain}>{query ? "No matches" : "No files"}</text>
        )}
      </scrollbox>
      {peekRows > 0 && (
        <box
          flexDirection="column"
          flexShrink={0}
          height={peekRows + 1}
          overflow="hidden"
          onMouseUp={(e) => {
            if (e.button === 0 && cursor?.kind === "file") choose(cursor);
          }}
        >
          <text height={1} flexShrink={0} fg={theme.muted} selectable={false}>
            {`──${peekTitle}${"─".repeat(Math.max(0, width - 2 - Bun.stringWidth(peekTitle)))}`}
          </text>
          {peek?.loaded && "image" in peek.loaded ? (
            <InlineImage
              key={peek.path}
              bytes={peek.loaded.image}
              width={Math.max(1, width)}
              height={peekRows}
              fallback={`[image ${peek.path}]`}
            />
          ) : peek?.loaded && "media" in peek.loaded ? (
            <text fg={theme.accent} selectable={false}>
              {`[${peek.loaded.media} ${peek.path}]`}
            </text>
          ) : peek?.loaded ? (
            numbered(Math.max(0, (cursor?.line ?? 1) - 3), peekRows, peekLines)
          ) : (
            <text fg={theme.muted} selectable={false}>
              {peek?.failed
                ? "No preview (binary, missing or denied)"
                : cursor?.kind === "directory"
                  ? "Folder: Enter or l opens it"
                  : peek
                    ? "…"
                    : ""}
            </text>
          )}
        </box>
      )}
      <box flexDirection="row" flexShrink={0}>
        {button("[↑]", () =>
          file
            ? setLine((n) => Math.max(0, n - visible))
            : setIndex((n) => Math.max(0, n - listRows)),
        )}
        {button("[↓]", () =>
          file
            ? setLine((n) => Math.min(Math.max(0, lines.length - 1), n + visible))
            : setIndex((n) => Math.min(Math.max(0, rows.length - 1), n + listRows)),
        )}
      </box>
    </box>
  );
}
