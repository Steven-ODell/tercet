import { useEffect, useState } from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import { decodePasteBytes } from "@opentui/core";
import type { EditorSession } from "../embedded-editor";
import { encodeKey, screenText } from "./terminal-screen";
import { theme } from "./theme";
import { commandForKey, hintFor } from "./keymap";

export function EditorPanel({
  session,
  enabled,
  width,
  height,
  close,
}: {
  session?: EditorSession;
  enabled: boolean;
  width: number;
  height: number;
  close(): void;
}) {
  const [, paint] = useState(0);
  useEffect(() => session?.subscribe(() => paint((n) => n + 1)), [session]);
  useEffect(() => {
    session?.resize(Math.max(2, width), Math.max(1, height - 2));
  }, [session, width, height]);
  useKeyboard((key) => {
    if (!enabled || key.defaultPrevented || key.eventType === "release") return;
    const command = commandForKey(key);
    if (key.meta && (command === "focusLeft" || command === "leave")) return;
    key.preventDefault();
    if (session?.running) {
      const data = encodeKey(key, session.screen.modes.applicationCursorKeysMode);
      if (data) session.write(key.meta ? `\x1b${data}` : data);
    } else if (key.name === "return" || key.name === "escape") close();
  });
  usePaste((event) => {
    if (!enabled || !session?.running) return;
    event.preventDefault();
    const text = decodePasteBytes(event.bytes);
    session.write(
      session.screen.modes.bracketedPasteMode
        ? `\x1b[200~${text}\x1b[201~`
        : text.replace(/\r?\n/g, "\r"),
    );
  });
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <text fg={theme.muted} height={1} wrapMode="none">
        {session
          ? `${session.cwd} · ${session.path}`
          : "Select a file in Files and press e to edit."}
      </text>
      <box flexGrow={1} overflow="hidden">
        {session && (
          <text
            fg={theme.plain}
            content={screenText(session.screen, enabled && session.running)}
            wrapMode="none"
          />
        )}
      </box>
      <box height={1} flexDirection="row">
        <text fg={theme.muted}>
          {session?.running
            ? `:w saves · :q quits · ${hintFor("focusLeft")} chat · ${hintFor("leave")} hides`
            : `Editor exited${session ? ` (${session.exitCode})` : ""} · Enter returns to Files`}
        </text>
        <box
          onMouseUp={(e) => {
            if (e.button === 0) close();
          }}
        >
          <text fg={theme.accent}> [Back]</text>
        </box>
      </box>
    </box>
  );
}
