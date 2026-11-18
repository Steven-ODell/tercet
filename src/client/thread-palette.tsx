import { theme } from "./theme";
import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type {
  OrchestrationV2ThreadShell,
  OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import {
  allThreads,
  fuzzyScore,
  threadActions,
  type createThreadActions,
  type ThreadAction,
} from "./thread-actions";
import type { Client } from "./runtime";
import { useClientAtom } from "./screen";
import { wrapName } from "./sidebar";
import {
  pickerCompact,
  rowText,
  useWheelTop,
  windowWithHint,
  wrapWords,
} from "./model-picker";

export function ThreadPalette({
  client,
  mode,
  target,
  actions,
  close,
  newThread,
  width,
  height,
}: {
  client: Client;
  mode: "palette" | "search" | "menu";
  target?: OrchestrationV2ThreadShell;
  actions: ReturnType<typeof createThreadActions>;
  close: () => void;
  newThread?: () => void;
  width: number;
  height: number;
}) {
  useClientAtom(client, client.snapshot);
  useClientAtom(client, client.archives);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [prompt, setPrompt] = useState<"rename" | "delete">();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<
    readonly OrchestrationThreadSearchMatch[]
  >([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (mode !== "search") return;
    let stale = false;
    const valid = query.trim().length >= 2;
    if (!valid) return;
    const timer = setTimeout(() => {
      void client
        .search(query.trim().slice(0, 200))
        .then((result) => {
          if (!stale) setMatches(result.matches);
        })
        .catch(() => {
          if (!stale) setError("Search failed. Change query to retry.");
        })
        .finally(() => {
          if (!stale) setLoading(false);
        });
    }, 180);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [client, mode, query]);
  const threads = allThreads(client);
  type Row = {
    key: string;
    label: string;
    action?: ThreadAction | "undo";
    thread?: OrchestrationV2ThreadShell;
    id?: OrchestrationThreadSearchMatch["threadId"];
  };
  const candidates: Row[] =
    mode === "search"
      ? matches.map((match, index) => ({
          key: `${match.threadId}:${index}`,
          id: match.threadId,
          label: `${threads.find((t) => t.id === match.threadId)?.title ?? match.threadId} · ${match.source}: ${match.snippet}`,
        }))
      : [
          ...[...threadActions, "undo" as const].map((action) => ({
            key: action,
            action,
            label:
              action === "undo"
                ? "Undo last action"
                : `${action === "delete" ? "Delete permanently…" : action[0]!.toUpperCase() + action.slice(1)}${action === "new" ? " thread" : ""}`,
          })),
          ...(mode === "palette"
            ? threads.map((thread) => ({
                key: thread.id,
                thread,
                label: `${thread.archivedAt ? "[archived] " : ""}${thread.title}`,
              }))
            : []),
        ];
  const rows =
    mode === "search"
      ? candidates
      : candidates
          .map((row) => ({ row, score: fuzzyScore(row.label, query) }))
          .filter((entry) => entry.score >= 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.row);
  const index = Math.min(cursor, Math.max(0, rows.length - 1));
  async function execute(row?: Row) {
    if (busy || !row) return;
    setError("");
    if (row.action === "new" && newThread) {
      newThread();
      return;
    }
    if (row.action === "rename" || row.action === "delete") {
      setPrompt(row.action);
      setQuery("");
      return;
    }
    setBusy(true);
    try {
      if (row.action === "undo") await actions.undo();
      else if (row.action) await actions.run(row.action, target);
      else if (row.thread || row.id)
        client.openThread(row.thread?.id ?? row.id!);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!prompt) return execute(rows[index]);
    if (busy) return;
    if (prompt === "delete" && query !== "DELETE") {
      setError("Type DELETE to confirm");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await actions.run(prompt, target, query, true);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }
  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    if (key.name === "escape") {
      key.preventDefault();
      close();
    }
    if (key.name === "return") {
      key.preventDefault();
      void submit();
    }
    if (!prompt && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      setCursor(
        Math.max(
          0,
          Math.min(rows.length - 1, index + (key.name === "up" ? -1 : 1)),
        ),
      );
    }
  });
  const panelWidth = Math.min(70, width);
  const { top: wheelTop, onWheel } = useWheelTop(
    index,
    rows.length + (prompt ? 1000 : 0),
  );
  if (pickerCompact(width, height)) {
    // Phone sizes: the panel takes the whole screen; rows are wrapped whole and counted so the
    // filter, at least three rows and the buttons always show.
    const inner = panelWidth - 2;
    const title = prompt
      ? prompt === "delete"
        ? "Permanent delete · cannot be undone"
        : "Rename thread"
      : mode === "search"
        ? "Cross-thread search"
        : mode === "menu"
          ? "Thread actions"
          : "Actions and thread search";
    const titleLines = wrapWords(title, inner);
    const targetLines = target ? wrapWords(target.title, inner) : [];
    const errorLines = error ? wrapWords(error, inner) : [];
    const note = prompt
      ? ""
      : loading && !rows.length
        ? "Searching…"
        : !rows.length
          ? mode === "search" && query.length < 2
            ? "Enter at least two characters"
            : "No results"
          : "";
    const noteLines = note ? wrapWords(note, inner) : [];
    const hint = busy ? "Working…" : "↑/↓ choose · Enter select · Esc close";
    const hintLines = wrapWords(hint, inner);
    const fixed =
      titleLines.length + targetLines.length + 1 + errorLines.length + 1;
    const { win, hint: showHint } = prompt
      ? { win: { start: 0, rows: [] as string[][], last: 0 }, hint: true }
      : windowWithHint(
          rows.map((row) => row.label),
          index,
          inner - 2,
          Math.max(1, height - 2 - fixed - noteLines.length),
          hintLines.length,
          wheelTop,
        );
    return (
      <box position="absolute" left={0} top={0} width="100%" height="100%">
        <box
          position="absolute"
          left={Math.max(0, Math.floor((width - panelWidth) / 2))}
          top={0}
          width={panelWidth}
          height={height}
          border
          borderColor={theme.accent}
          backgroundColor={theme.canvas}
          flexDirection="column"
          onMouseScroll={onWheel(win.start, win.last)}
        >
          <text fg={theme.accent} height={titleLines.length} wrapMode="none">
            {titleLines.join("\n")}
          </text>
          {target && (
            <text fg={theme.muted} height={targetLines.length} wrapMode="none">
              {targetLines.join("\n")}
            </text>
          )}
          <input
            focused
            value={query}
            placeholderColor={theme.muted}
            placeholder={
              prompt === "delete"
                ? "Type DELETE"
                : prompt === "rename"
                  ? "New title"
                  : "Type to search…"
            }
            onInput={(text) => {
              setQuery(text);
              setCursor(0);
              setMatches([]);
              setError("");
              setLoading(mode === "search" && text.trim().length >= 2);
            }}
          />
          <box flexGrow={1} flexDirection="column">
            {win.rows.map((lines, offset) => {
              const row = rows[win.start + offset]!;
              const active = row === rows[index];
              return (
                <text
                  key={row.key}
                  height={lines.length}
                  wrapMode="none"
                  fg={active ? theme.strong : theme.text}
                  bg={active ? theme.highlight : undefined}
                  onMouseUp={(event) => {
                    if (event.button === 0) void execute(row);
                  }}
                >
                  {rowText(lines, active)}
                </text>
              );
            })}
            {noteLines.length > 0 && (
              <text fg={theme.plain} height={noteLines.length} wrapMode="none">
                {noteLines.join("\n")}
              </text>
            )}
          </box>
          {errorLines.length > 0 && (
            <text fg={theme.red} height={errorLines.length} wrapMode="none">
              {errorLines.join("\n")}
            </text>
          )}
          {showHint && (
            <text fg={theme.muted} height={hintLines.length} wrapMode="none">
              {hintLines.join("\n")}
            </text>
          )}
          <box flexDirection="row">
            <text
              fg={theme.plain}
              onMouseUp={(e) => {
                if (e.button === 0) void submit();
              }}
            >
              [ Enter select ]{" "}
            </text>
            <text
              fg={theme.plain}
              onMouseUp={(e) => {
                if (e.button === 0) close();
              }}
            >
              [ Esc Close ]
            </text>
          </box>
        </box>
      </box>
    );
  }
  const capacity = Math.max(1, height - 12);
  const visible: Row[] = [];
  let used = 0;
  for (const row of rows.slice(Math.max(0, index - 2))) {
    const size = wrapName(row.label, panelWidth - 6).length;
    if (used + size > capacity && visible.length) break;
    visible.push(row);
    used += size;
  }
  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%">
      <box
        position="absolute"
        left={Math.max(0, Math.floor((width - panelWidth) / 2))}
        top={2}
        width={panelWidth}
        height={Math.max(8, height - 6)}
        border
        borderColor={theme.accent}
        backgroundColor={theme.canvas}
        flexDirection="column"
      >
        <text fg={theme.accent}>
          {prompt
            ? prompt === "delete"
              ? "Permanent delete · cannot be undone"
              : "Rename thread"
            : mode === "search"
              ? "Cross-thread search"
              : mode === "menu"
                ? "Thread actions"
                : "Actions and thread search"}
        </text>
        {target && <text fg={theme.muted}>{target.title}</text>}
        <input
          focused
          value={query}
          placeholderColor={theme.muted}
          placeholder={
            prompt === "delete"
              ? "Type DELETE"
              : prompt === "rename"
                ? "New title"
                : "Type to search…"
          }
          onInput={(text) => {
            setQuery(text);
            setCursor(0);
            setMatches([]);
            setError("");
            setLoading(mode === "search" && text.trim().length >= 2);
          }}
        />
        <scrollbox flexGrow={1} scrollY scrollX={false}>
          {!prompt &&
            visible.map((row) => (
              <text
                key={row.key}
                fg={row === rows[index] ? theme.strong : theme.text}
                bg={row === rows[index] ? theme.highlight : undefined}
                onMouseUp={(event) => {
                  if (event.button === 0) void execute(row);
                }}
              >{`${row === rows[index] ? "› " : "  "}${row.label}`}</text>
            ))}
          {!prompt && !rows.length && (
            <text fg={theme.plain}>
              {loading
                ? "Searching…"
                : mode === "search" && query.length < 2
                  ? "Enter at least two characters"
                  : "No results"}
            </text>
          )}
        </scrollbox>
        <text fg={theme.red}>{error}</text>
        <text fg={theme.muted}>
          {busy ? "Working…" : "↑/↓ choose · Enter select · Esc close"}
        </text>
        <box flexDirection="row">
          <text
            fg={theme.plain}
            onMouseUp={(e) => {
              if (e.button === 0) void submit();
            }}
          >
            [ Enter select ]{" "}
          </text>
          <text
            fg={theme.plain}
            onMouseUp={(e) => {
              if (e.button === 0) close();
            }}
          >
            [ Esc Close ]
          </text>
        </box>
      </box>
    </box>
  );
}
