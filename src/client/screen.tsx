import { theme } from "./theme";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { blocksStart, compatMessage, type ServerCheck } from "./compat";
import { useKeyboard } from "@opentui/react";
import type { Atom } from "effect/reactivity";
import type { Client } from "./runtime";

export function useClientAtom<A>(client: Client, atom: Atom.Atom<A>) {
  return useSyncExternalStore(
    (notify) => client.registry.subscribe(atom, notify),
    () => client.registry.get(atom),
  );
}
export function ConnectionScreen({
  client,
  keyboardEnabled = true,
}: {
  client: Client;
  keyboardEnabled?: boolean;
}) {
  const status = useClientAtom(client, client.status);
  const count = useClientAtom(client, client.threadCount);
  const message = useClientAtom(client, client.message);
  useKeyboard((key) => {
    if (keyboardEnabled && key.name === "r") void client.retry();
  });
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.surface}>
      <text fg={theme.accent}>
        tercet — {status} — threads={count}
      </text>
      <text fg={theme.plain}>{message}</text>
      <box
        height={1}
        onMouseUp={(event) => {
          if (event.button === 0) void client.retry();
        }}
      >
        <text fg={theme.accent} selectable={false}>
          [ Retry (r) ]
        </text>
      </box>
    </box>
  );
}

/**
 * Full-screen stop for a server tercet should not open on (client/compat.ts): the version found,
 * the range supported and what to do. An unreachable server is checked again every 2 s; once a
 * check passes, `onReady` runs once (it starts the client) and the app takes the screen.
 */
export function ServerGate({
  url,
  initial,
  check,
  ignoreVersion,
  onReady,
  onQuit,
  children,
}: {
  url: string;
  initial: ServerCheck;
  check: () => Promise<ServerCheck>;
  ignoreVersion: boolean;
  onReady: () => void;
  onQuit: () => void;
  children: ReactNode;
}) {
  const [state, setState] = useState(initial);
  const blocked = blocksStart(state, ignoreVersion);
  const ready = useRef(false);
  const quit = useRef(false);
  const recheck = () => {
    void check().then((next) => {
      if (!quit.current) setState(next);
    });
  };
  useEffect(() => {
    if (!blocked && !ready.current) {
      ready.current = true;
      onReady();
    }
    if (!blocked || state.kind !== "unreachable") return;
    const timer = setInterval(recheck, 2000);
    return () => clearInterval(timer);
  }, [blocked, state.kind]);
  const leave = () => {
    quit.current = true;
    onQuit();
  };
  useKeyboard((key) => {
    if (!blocked) return;
    if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) leave();
    else if (key.name === "r") recheck();
  });
  if (!blocked) return <>{children}</>;
  const { title, lines } = compatMessage(state, url);
  const button = (label: string, run: () => void) => (
    <box
      height={1}
      onMouseUp={(event) => {
        if (event.button === 0) run();
      }}
    >
      <text fg={theme.accent} selectable={false}>
        {label}
      </text>
    </box>
  );
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={theme.surface}
      padding={1}
      gap={1}
    >
      <text fg={theme.accent}>tercet: {title}</text>
      <box flexDirection="column">
        {lines.map((line, i) => (
          <text key={i} fg={theme.plain}>
            {line}
          </text>
        ))}
      </box>
      <box flexDirection="row" gap={2} height={1}>
        {state.kind === "unreachable" ? button("[ Retry (r) ]", recheck) : null}
        {button("[ Quit (q) ]", leave)}
      </box>
    </box>
  );
}
