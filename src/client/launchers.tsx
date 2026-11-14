import { theme } from "./theme";
import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ThreadId } from "@t3tools/contracts";
import { failureText } from "../actions";
import { agentElapsed, type AgentRow } from "./agents";

const noAgents: readonly AgentRow[] = [];
export type LauncherPanel = "files" | "diff" | "terminal" | "editor";

/**
 * The launcher is a plain list, like the web right-panel empty state. Add an entry with one line:
 * `run` may return a promise, in which case the panel shows its progress and result.
 */
export function LaunchersPanel({
  enabled,
  open,
  shell,
  close,
  agents = noAgents,
  openAgent,
  now = Date.now,
}: {
  enabled: boolean;
  open: (panel: LauncherPanel) => void;
  /** Absent without a shell launcher; the entry is then not drawn. */
  shell?: () => Promise<unknown>;
  close: () => void;
  /** The current thread's subagents. Quiet by default: with none the list says "No agents". */
  agents?: readonly AgentRow[];
  openAgent?: (threadId: ThreadId) => void;
  now?: () => number;
}) {
  type Entry = {
    label: string;
    letter?: string;
    run: () => void | Promise<unknown>;
    /** The first agent row carries the "Agents" heading. */
    heading?: boolean;
    detail?: string;
  };
  const [clock, setClock] = useState(now());
  const anyLive = agents.some((agent) => agent.live);
  // Elapsed times tick once a second, only while this panel is open and an agent is working.
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => setClock(now()), 1000);
    return () => clearInterval(timer);
  }, [anyLive, now]);
  const entries: Entry[] = [
    { label: "Files", letter: "f", run: () => open("files") },
    { label: "Diff", letter: "d", run: () => open("diff") },
    { label: "Editor", letter: "e", run: () => open("editor") },
    { label: "Terminal", letter: "t", run: () => open("terminal") },
    ...(shell ? [{ label: "Shell", letter: "s", run: shell }] : []),
    ...(agents.length
      ? agents.map((agent, i) => ({
          label: agent.title,
          detail: [agent.state, agentElapsed(agent, clock)].filter(Boolean).join(" · "),
          heading: i === 0,
          run: () => openAgent?.(agent.threadId),
        }))
      : [{ label: "No agents", letter: "a", run: () => {} }]),
  ];
  const firstAgent = agents.length ? entries.findIndex((entry) => entry.heading) : -1;
  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState("");
  const launch = (entry: Entry) => {
    if (!enabled) return;
    const result = entry.run();
    if (!result) return;
    setFeedback(`${entry.label} …`);
    result
      .then(() => setFeedback(`${entry.label} ✓`))
      .catch((error) =>
        setFeedback(failureText(error, `${entry.label} failed; select a thread and retry.`)),
      );
  };
  useKeyboard((key) => {
    if (!enabled || key.defaultPrevented || key.ctrl || key.meta) return;
    const byLetter = entries.find((entry) => entry.letter === key.name);
    if (key.name === "down" || key.name === "j")
      setIndex((n) => Math.min(entries.length - 1, n + 1));
    else if (key.name === "up" || key.name === "k") setIndex((n) => Math.max(0, n - 1));
    else if (key.name === "return" || key.name === "l")
      launch(entries[Math.min(index, entries.length - 1)]!);
    // A jumps to the first agent; Enter then opens it, so several agents are never opened blindly.
    else if (key.name === "a" && firstAgent >= 0) setIndex(firstAgent);
    else if (byLetter) launch(byLetter);
    else return;
    key.preventDefault();
  });
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <scrollbox flexGrow={1} scrollY scrollX={false}>
        {entries.map((entry, i) => (
          <box key={`${i}:${entry.label}`} flexDirection="column">
            {entry.heading && (
              <text fg={theme.muted} selectable={false}>
                {"  "}Agents (A)
              </text>
            )}
            <box
              onMouseUp={(event) => {
                if (!enabled || event.button !== 0) return;
                setIndex(i);
                launch(entry);
              }}
            >
              <text fg={index === i ? theme.accent : theme.text} selectable={false}>
                {index === i ? "› " : "  "}
                {entry.detail ? entry.label : `${entry.label} (${entry.letter!.toUpperCase()})`}
              </text>
              {entry.detail && (
                <text fg={theme.muted} selectable={false}>
                  {"    "}
                  {entry.detail}
                </text>
              )}
            </box>
          </box>
        ))}
      </scrollbox>
      <text fg={theme.plain}>{feedback}</text>
      <box
        onMouseUp={(event) => {
          if (enabled && event.button === 0) close();
        }}
      >
        <text fg={theme.accent} selectable={false}>
          [Close]
        </text>
      </box>
    </box>
  );
}
