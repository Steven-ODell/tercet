import { theme } from "./theme";
import { hintFor } from "./keymap";
import { fileIcon } from "./icons";
import { useEffect, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ThreadId } from "@t3tools/contracts";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { Client } from "./runtime";
import { useClientAtom } from "./screen";

export type DiffTarget = { threadId: ThreadId; turn?: number; path?: string };
export type DiffFile = { path: string; additions: number; deletions: number; lines: string[] };
function patchPath(value: string) {
  try {
    value = JSON.parse(value);
  } catch {
    /* Git quotes paths with spaces and escapes. */
  }
  return value.replace(/^[ab]\//, "");
}
/** Keep metadata and binary/rename-only files visible, counting only hunk lines. */
export function diffFiles(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk = false;
  for (const line of patch.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git ("(?:[^"\\]|\\.)*"|\S+) (.+)$/);
      file = {
        path: patchPath(match?.[2] ?? line.slice(11)),
        additions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(file);
      hunk = false;
    }
    if (!file) continue;
    if (!hunk && line.startsWith("+++ ") && line.slice(4) !== "/dev/null")
      file.path = patchPath(line.slice(4));
    if (!hunk && line.startsWith("--- ") && line.slice(4) !== "/dev/null")
      file.path = patchPath(line.slice(4));
    if (!hunk && line.startsWith("rename to ")) file.path = patchPath(line.slice(10));
    if (line.startsWith("@@")) hunk = true;
    if (hunk && line[0] === "+") file.additions++;
    if (hunk && line[0] === "-") file.deletions++;
    file.lines.push(line);
  }
  return files;
}

export function DiffPanel({
  client,
  target,
  enabled,
  close,
  height,
}: {
  client: Client;
  target?: DiffTarget;
  enabled: boolean;
  close: () => void;
  height: number;
}) {
  const selected = useClientAtom(client, client.selectedThreadId);
  const states = useClientAtom(client, client.transcripts);
  const status = useClientAtom(client, client.status);
  const threadId = target?.threadId ?? selected;
  const projection = threadId ? states.get(threadId)?.projection : undefined;
  const checkpoints = useMemo(
    () => (projection ? deriveThreadCheckpointSummaries(projection) : []),
    [projection],
  );
  const turns = [...new Set(checkpoints.map((c) => c.checkpointTurnCount))].sort((a, b) => a - b);
  const latest = turns.at(-1) ?? 0;
  const hasProjection = !!projection;
  const [turn, setTurn] = useState(target?.turn);
  const [patch, setPatch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [index, setIndex] = useState(0);
  const [opened, setOpened] = useState(false);
  const [offset, setOffset] = useState(0);
  const files = useMemo(() => diffFiles(patch), [patch]);
  useEffect(() => {
    let active = true;
    setPatch("");
    setError("");
    setPending(false);
    setIndex(0);
    setOpened(false);
    setOffset(0);
    if (!threadId || !hasProjection || !latest) return;
    if (status !== "live") {
      setError("Disconnected. Reconnect, then r Retry.");
      return;
    }
    setPending(true);
    const input = { threadId, toTurnCount: turn ?? latest, ignoreWhitespace: true };
    const request =
      turn === undefined
        ? client.diffs.full(input)
        : client.diffs.turn({ ...input, fromTurnCount: Math.max(0, turn - 1) });
    void request
      .then((result) => {
        if (!active) return;
        setPatch(result.diff);
        const found = diffFiles(result.diff).findIndex((f) => f.path === target?.path);
        if (found >= 0) {
          setIndex(found);
          setOpened(true);
        }
      })
      .catch(() => {
        if (active) setError("Diff unavailable. Reconnect or r Retry.");
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [client, threadId, hasProjection, latest, turn, retry, status, target?.path]);
  const visible = Math.max(1, height - 9);
  const file = files[index];
  const back = () => {
    if (opened) setOpened(false);
    else close();
  };
  const move = (delta: number) =>
    opened
      ? setOffset((n) =>
          Math.max(0, Math.min(Math.max(0, (file?.lines.length ?? 0) - 1), n + delta)),
        )
      : setIndex((n) => Math.max(0, Math.min(files.length - 1, n + delta)));
  const cycle = () => setTurn((n) => (n === undefined ? turns[0] : turns[turns.indexOf(n) + 1]));
  useKeyboard((key) => {
    if (!enabled || key.defaultPrevented || key.ctrl || key.meta || key.name === "tab") return;
    if (key.name === "escape" && !opened) return;
    key.preventDefault();
    if (key.name === "escape") back();
    else if (key.name === "h") {
      if (opened) back();
    } else if (key.name === "up" || key.name === "k") move(-1);
    else if (key.name === "down" || key.name === "j") move(1);
    else if ((key.name === "return" || key.name === "l" || key.name === "right") && file) {
      setOpened(true);
      setOffset(0);
    } else if (key.sequence === "t") cycle();
    else if (key.sequence === "a") setTurn(undefined);
    else if (key.sequence === "r") setRetry((n) => n + 1);
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
  const start = Math.max(0, index - visible + 1);
  return (
    <box flexDirection="column" height="100%" minHeight={0}>
      <box flexDirection="row" flexWrap="wrap" flexShrink={0}>
        {button("[a All]", () => setTurn(undefined))}
        {button("[t Turn]", cycle)}
        {button(opened ? "[Esc Back]" : `[${hintFor("leave")} Close]`, back)}
        {button("[r Retry]", () => setRetry((n) => n + 1))}
      </box>
      <text fg={theme.plain} flexShrink={0}>
        {turn === undefined ? "Full thread" : `Turn ${turn}`} · whitespace ignored
      </text>
      <text fg={theme.plain} flexShrink={0}>
        {files.length} files +{formatDiffCount(files.reduce((n, f) => n + f.additions, 0))} −
        {formatDiffCount(files.reduce((n, f) => n + f.deletions, 0))}
      </text>
      {!threadId && <text fg={theme.plain}>Select a thread</text>}
      {threadId && !projection && <text fg={theme.plain}>Loading checkpoints…</text>}
      {projection && !latest && <text fg={theme.plain}>No checkpoints yet</text>}
      {pending && <text fg={theme.plain}>Loading diff…</text>}
      {error && <text fg={theme.plain}>{error}</text>}
      {!pending && !error && latest > 0 && !files.length && (
        <text fg={theme.plain}>No changed files</text>
      )}
      {opened && file && (
        <text fg={theme.plain} flexShrink={0}>
          <span fg={fileIcon(file.path).color}>{fileIcon(file.path).glyph} </span>
          {file.path}
        </text>
      )}
      <scrollbox flexGrow={1} minHeight={0} scrollY scrollX={false}>
        {opened
          ? file?.lines.slice(offset, offset + visible).map((line, i) => (
              <text
                key={offset + i}
                fg={
                  line.startsWith("+")
                    ? theme.green
                    : line.startsWith("-")
                      ? theme.red
                      : theme.bright
                }
              >
                {line}
              </text>
            ))
          : files.slice(start, start + visible).map((f, i) => (
              <box
                key={f.path}
                onMouseUp={(e) => {
                  if (e.button === 0) {
                    setIndex(start + i);
                    setOpened(true);
                    setOffset(0);
                  }
                }}
              >
                <text fg={index === start + i ? theme.accent : theme.bright} selectable={false}>
                  {index === start + i ? "› " : "  "}
                  <span fg={fileIcon(f.path).color}>{fileIcon(f.path).glyph} </span>
                  {f.path} +{formatDiffCount(f.additions)} −{formatDiffCount(f.deletions)}
                </text>
              </box>
            ))}
      </scrollbox>
      <box flexDirection="row" flexShrink={0}>
        {button("[↑]", () => move(-visible))}
        {button("[↓]", () => move(visible))}
      </box>
    </box>
  );
}
