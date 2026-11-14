import { theme } from "./theme";
import { hintFor } from "./keymap";
import { useEffect, useMemo, useRef, useState } from "react";
import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { DEFAULT_TERMINAL_ID, type ThreadId } from "@t3tools/contracts";
import { Terminal } from "@xterm/headless";
import type { Client } from "./runtime";
import { useClientAtom } from "./screen";
import { encodeKey, screenText } from "./terminal-screen";

type State = "connecting" | "running" | "exited" | "closed" | "disconnected";

/**
 * The thread's server shell, the same session the web app's terminal drawer shows. While it has
 * focus every key but the Alt bindings goes to the shell, so Alt+h is the way back out.
 */
export function TerminalPanel({
  client,
  threadId,
  cwd,
  worktreePath,
  enabled,
  queuedRun,
  onRunSent,
  width,
  height,
  close,
}: {
  client: Client;
  threadId: ThreadId | undefined;
  cwd: string | undefined;
  worktreePath: string | null;
  enabled: boolean;
  /** A command from a code block's [run]: typed and entered once the shell is running. */
  queuedRun?: { id: number; text: string };
  onRunSent?: (id: number) => void;
  width: number;
  height: number;
  close: () => void;
}) {
  const cols = Math.max(2, width);
  const rows = Math.max(1, height - 1);
  const size = useRef({ cols, rows });
  size.current = { cols, rows };
  const live = useClientAtom(client, client.status) === "live";
  const term = useRef<Terminal | undefined>(undefined);
  const session = useRef<ReturnType<Client["terminal"]> | undefined>(undefined);
  const [state, setState] = useState<State>("connecting");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!threadId || !cwd || !live || !client.terminalAvailable) return;
    const screen = new Terminal({ ...size.current, scrollback: 5000, allowProposedApi: true });
    term.current = screen;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    // Output arrives in bursts; one repaint per frame keeps a noisy build from starving the UI.
    const paint = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        if (active) setFrame((n) => n + 1);
      }, 16);
    };
    // Replayed history contains old terminal queries; answering them would type into the shell.
    let replaying = false;
    const replay = (history: string) => {
      replaying = true;
      screen.reset();
      screen.write(history, () => {
        replaying = false;
        paint();
      });
    };
    setState("connecting");
    setError("");
    const attached = client.terminal(
      {
        threadId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd,
        worktreePath,
        ...size.current,
        restartIfNotRunning: true,
      },
      (event) => {
        if (!active) return;
        if (event.type === "snapshot" || event.type === "restarted") {
          replay(event.snapshot.history);
          setLabel(event.snapshot.label);
          setError("");
          setState(event.snapshot.status === "exited" ? "exited" : "running");
        } else if (event.type === "output") screen.write(event.data, paint);
        else if (event.type === "exited") setState("exited");
        else if (event.type === "closed") setState("closed");
        else if (event.type === "error") setError(event.message);
        else if (event.type === "activity") setLabel(event.label);
        else {
          screen.clear();
          paint();
        }
      },
      (failure) => {
        if (active) setState(failure ? "disconnected" : "closed");
      },
    );
    session.current = attached;
    const answers = screen.onData((data) => {
      if (!replaying) attached.send({ kind: "write", data });
    });
    return () => {
      active = false;
      clearTimeout(timer);
      answers.dispose();
      attached.stop();
      screen.dispose();
      term.current = undefined;
      session.current = undefined;
    };
  }, [client, threadId, cwd, worktreePath, live, retry]);
  useEffect(() => {
    const screen = term.current;
    if (!screen || (screen.cols === cols && screen.rows === rows)) return;
    screen.resize(cols, rows);
    setFrame((n) => n + 1);
    // A drag resize fires per column; the shell only needs the size it settles on.
    const timer = setTimeout(() => session.current?.send({ kind: "resize", cols, rows }), 80);
    return () => clearTimeout(timer);
  }, [cols, rows]);
  const restart = () => {
    if (state === "exited" && cwd)
      session.current?.send({ kind: "restart", cwd, worktreePath, cols, rows });
    else if (state !== "running") setRetry((n) => n + 1);
  };
  const write = (data: string) => {
    term.current?.scrollToBottom();
    // The server caps one write; a large paste goes in order as several.
    for (let at = 0; at < data.length; at += 32_768)
      session.current?.send({ kind: "write", data: data.slice(at, at + 32_768) });
  };
  const pasteText = (text: string) =>
    write(
      term.current?.modes.bracketedPasteMode
        ? `\x1b[200~${text}\x1b[201~`
        : text.replace(/\r?\n/g, "\r"),
    );
  useEffect(() => {
    if (!queuedRun || state !== "running") return;
    pasteText(queuedRun.text.trimEnd());
    write("\r");
    onRunSent?.(queuedRun.id);
  }, [queuedRun, state]);
  useKeyboard((key) => {
    if (!enabled || key.defaultPrevented || key.meta || key.eventType === "release") return;
    key.preventDefault();
    if (state !== "running") {
      if (key.name === "return") restart();
      return;
    }
    const data = encodeKey(key, !!term.current?.modes.applicationCursorKeysMode);
    if (data) write(data);
  });
  usePaste((event) => {
    if (!enabled || state !== "running") return;
    event.preventDefault();
    const text = decodePasteBytes(event.bytes);
    if (!text) return;
    pasteText(text);
  });
  const screen = useMemo(
    () => (term.current ? screenText(term.current, enabled && state === "running") : undefined),
    [frame, enabled, state, cols, rows],
  );
  const button = (text: string, action: () => void) => (
    <box
      marginLeft={1}
      onMouseUp={(event) => {
        if (event.button === 0) action();
      }}
    >
      <text fg={theme.accent} selectable={false}>
        {text}
      </text>
    </box>
  );
  const blocked = !client.terminalAvailable
    ? "Terminal is off in read-only mode."
    : !threadId
      ? "Select a thread."
      : !cwd
        ? "This thread has no workspace."
        : !live
          ? "Offline. The terminal returns when the server does."
          : "";
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      onMouseScroll={(event) => {
        if (!term.current) return;
        term.current.scrollLines(event.scroll?.direction === "up" ? -3 : 3);
        setFrame((n) => n + 1);
      }}
    >
      <box height={rows} flexShrink={0} overflow="hidden">
        {blocked ? (
          <text fg={theme.plain}>{blocked}</text>
        ) : (
          screen && <text fg={theme.plain} content={screen} wrapMode="none" />
        )}
      </box>
      <box height={1} flexShrink={0} flexDirection="row">
        <text fg={theme.muted} flexShrink={1} wrapMode="none">
          {blocked
            ? ""
            : error ||
              (state === "running"
                ? `${label || "shell"} · ${hintFor("leave")} leaves`
                : state === "connecting"
                  ? "Connecting…"
                  : state === "exited"
                    ? "Shell exited · Enter restarts"
                    : state === "closed"
                      ? "Terminal closed · Enter reopens"
                      : "Disconnected · Enter retries")}
        </text>
        {!blocked && state !== "running" && state !== "connecting" && button("[Restart]", restart)}
        {button("[Close]", close)}
      </box>
    </box>
  );
}
