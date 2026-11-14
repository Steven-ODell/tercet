import { PullRequestPanel } from "./pull-requests.tsx";
import { createPullRequestWorkflow } from "./pull-requests.ts";
import { BranchPanel, createBranchWorkflow, type BranchTarget } from "./git-workflows.tsx";
import { EditorPanel } from "./editor";
import type { EditorSession } from "../embedded-editor";
import { theme } from "./theme";
import { LaunchersPanel } from "./launchers";
import { TerminalPanel, type QueuedRun } from "./terminal";
import { NewThreadPicker } from "./workspace";
import { DiffPanel, type DiffTarget } from "./diff";
import { FilesPanel } from "./files";
import { pendingCard, requestKey, RequestPanel } from "./requests";
import { useAgentRows } from "./agents";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { ModelPicker } from "./model-picker";
import { ThreadPalette } from "./thread-palette";
import { createDictation } from "./dictation";
import { hasDictation } from "../actions";
import { failureText } from "../actions";
import { allThreads, createThreadActions } from "./thread-actions";
import type { OrchestrationV2ThreadShell, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { ThreadComposer } from "./composer";
import { ThreadTranscript } from "./transcript";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { ContextChip, contextDetailOf, ContextDropdown } from "./context-meter";
import { paneGlyphs, selectionIcon } from "./icons";
import { ThreadSidebar, wrapName } from "./sidebar";
import type { Client } from "./runtime";
import { ConnectionScreen, ServerNotice, useClientAtom } from "./screen";
import { cheatSheet, commandForKey, hintFor, HintsShown, keymap, type Command } from "./keymap";
import { targetKeys } from "../actions";
import { onMediaNotice } from "./media";

type Pane = "sidebar" | "transcript" | "composer" | "right";
type RightPanel = "files" | "diff" | "launchers" | "terminal" | "editor";
type Overlay =
  "pullRequests" | "branches" | "workspace" | "model" | "effort" | "palette" | "search" | "menu" | "help" | "context";

/** Outer width of the right pane. Files and diff show file contents, so they take a real share. */
function rightWidth(kind: RightPanel, width: number) {
  if (kind === "terminal" || kind === "editor") return Math.max(24, Math.floor(width * 0.5));
  if (kind === "diff") return Math.max(24, Math.floor(width * 0.45));
  if (width < 100) return 24;
  return kind === "files" ? Math.max(32, Math.floor(width * 0.38)) : 32;
}

// Same names as the web composer's access menu.
const runtimeModeLabels: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export function AppFrame({
  client,
  onQuit,
  content = {},
  effects: configured,
}: {
  effects?: import("../actions").Actions;
  client: Client;
  onQuit?: () => void;
  content?: Partial<Record<Pane, ReactNode>>;
}) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const status = useClientAtom(client, client.status);
  const count = useClientAtom(client, client.threadCount);
  const selectedId = useClientAtom(client, client.selectedThreadId);
  const snapshot = useClientAtom(client, client.snapshot);
  useClientAtom(client, client.transcripts);
  // The agent view is a temporary stack above the selected thread: Esc pops it, selection never changes.
  const [agentStack, setAgentStack] = useState<ThreadId[]>([]);
  const agentId = agentStack.at(-1) ?? null;
  const agentCard = agentId ? pendingCard(client.getThread(agentId).projection) : undefined;
  const hasCard = !!(agentId
    ? agentCard
    : selectedId && pendingCard(client.getThread(selectedId).projection));
  const agents = useAgentRows(client, selectedId);
  const runningAgents = agents.filter((agent) => agent.live).length;
  const agentThread = agentId
    ? (snapshot?.threads.find((thread) => thread.id === agentId) ??
      client.registry.get(client.archives).find((thread) => thread.id === agentId))
    : undefined;
  const selected = snapshot?.threads.find((thread) => thread.id === selectedId);
  const providers = useClientAtom(client, client.providers);
  const logo = selected && selectionIcon(selected.modelSelection, providers);
  // Upstream keeps context usage on the thread's active provider thread, not on the shell.
  const projection = selected ? client.getThread(selected.id).projection : undefined;
  const providerThread = projection?.providerThreads?.find(
    (thread) => thread.id === selected?.activeProviderThreadId,
  );
  const contextDetail = selected
    ? contextDetailOf({
        activeProviderThreadId: selected.activeProviderThreadId,
        providerThread,
        providerTurns: projection?.providerTurns,
      })
    : null;
  const effort = selected?.modelSelection.options?.find((option) =>
    ["reasoningEffort", "effort", "variant"].includes(option.id),
  )?.value;
  // The top row: status on the left, the context chip on the right in whatever room is left.
  const statusText = `tercet · ${status} · threads=${count}${selected ? ` · ${runtimeModeLabels[selected.runtimeMode] ?? selected.runtimeMode}` : ""}`;
  const agentsText =
    runningAgents > 0 ? `${runningAgents} ${runningAgents === 1 ? "agent" : "agents"} running` : "";
  const chipColumns =
    width - Bun.stringWidth(statusText) - (agentsText ? 2 + Bun.stringWidth(agentsText) : 0) - 2;
  const headerRows = selected
    ? [
        ...wrapName(
          `${logo?.glyph} ${selected.modelSelection.model} · effort ${effort ?? "default"}`,
          width,
        ),
        ...wrapName(
          `${paneGlyphs.branch} ${selected.branch ?? "branch unknown"} · ${selected.worktreePath ?? snapshot?.projects.find((p) => p.id === selected.projectId)?.workspaceRoot ?? "workspace unknown"}`,
          width,
        ),
      ]
    : [];
  // A server tercet was not built for (client/compat.ts) gets a banner above the header rows.
  const notice = useContext(ServerNotice);
  const noticeRows = notice
    ? wrapName(
        `! ${notice.text} [ Dismiss${hintFor("dismissNotice") === "none" ? "" : ` (${hintFor("dismissNotice")})`} ]`,
        width,
      )
    : [];
  const topRows = headerRows.length + noticeRows.length;
  // The two key hint rows at the bottom; the hints key (Alt+i) gives them back to the panes.
  const [hintsShown, setHintsShown] = useState(true);
  useEffect(() => {
    void client.boundary
      .showHints?.()
      .then(setHintsShown)
      .catch(() => {});
  }, [client]);
  // Rows outside the panes: header and banner above, the hint rows below.
  const chromeRows = topRows + (hintsShown ? 2 : 0);
  const [sidebarWanted, setSidebar] = useState(true);
  const [narrowSidebar, setNarrowSidebar] = useState(false);
  const sidebar = width >= 70 ? sidebarWanted : narrowSidebar;
  const [focus, setFocusPane] = useState<Pane>("sidebar");
  // The composer shrinks to its draft line while another pane has focus or right after a send.
  // Anything that focuses it (click, key command, paste) opens it again.
  const [sent, setSent] = useState(false);
  const setFocus = (next: Pane) => {
    if (next === "composer") setSent(false);
    setFocusPane(next);
  };
  // A queued message keeps the composer open so its [steer] row stays reachable without a click first.
  const hasQueued =
    !agentId &&
    !!selectedId &&
    !!client.getThread(selectedId).projection?.runs.some((run) => run.status === "queued");
  const composerCollapsed = !hasCard && !hasQueued && (!!agentId || focus !== "composer" || sent);
  const composerHeight = hasCard
    ? Math.min(19, Math.max(15, height - 5 - chromeRows))
    : composerCollapsed
      ? 3
      : 9;
  const [filePath, setFilePath] = useState<{
    threadId: typeof selectedId;
    path: string;
    serial: number;
  }>();
  const [diffTarget, setDiffTarget] = useState<DiffTarget>();
  const [diffSerial, setDiffSerial] = useState(0);
  const [editorSession, setEditorSession] = useState<EditorSession>();
  const [right, setRight] = useState<RightPanel | null>(null);
  // [run] without a `commands.run` setting types the block into the side terminal and presses Enter.
  const [queuedRun, setQueuedRun] = useState<QueuedRun>();
  const runThread = useRef(selectedId);
  runThread.current = selectedId;
  const effects = useMemo(
    () =>
      !configured || configured.run || !client.terminalAvailable
        ? configured
        : {
            ...configured,
            run: ({ command }: { cwd: string; command: string }) => {
              setQueuedRun((last) => ({
                id: (last?.id ?? 0) + 1,
                text: command,
                threadId: runThread.current ?? undefined,
              }));
              setRight("terminal");
              setFocus("right");
              return Promise.resolve();
            },
          },
    [configured, client],
  );
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const actions = useMemo(() => createThreadActions(client), [client]);
  useEffect(() => {
    client.viewThread(agentId);
  }, [client, agentId]);
  useEffect(() => setAgentStack([]), [selectedId]);
  // A queued [run] belongs to the thread and the open terminal it was sent to; it never waits for another.
  useEffect(() => setQueuedRun(undefined), [selectedId]);
  useEffect(() => {
    if (right !== "terminal") setQueuedRun(undefined);
  }, [right]);
  const agentCardKey = agentId && agentCard ? `${agentId}:${requestKey(agentCard)}` : undefined;
  useEffect(() => {
    // A question asked by the agent you are viewing is answered from the composer pane.
    if (agentCardKey) setFocus("composer");
  }, [agentCardKey]);
  const openAgent = (threadId: ThreadId) => {
    setAgentStack((stack) => (stack.at(-1) === threadId ? stack : [...stack, threadId]));
    setRight(null);
    setFocus("transcript");
  };
  const closeAgent = () => {
    setAgentStack((stack) => stack.slice(0, -1));
    setFocus("transcript");
  };
  const [menuTarget, setMenuTarget] = useState<OrchestrationV2ThreadShell>();
  const [actionError, setActionError] = useState("");
  // Its messages show beside the composer's mic button, and on this status line only while the
  // collapsed composer hides that button: dictation keeps running after the composer loses focus.
  const dictation = useMemo(() => createDictation(client, effects), [client, effects]);
  const micMessage = useSyncExternalStore(dictation.subscribe, dictation.getMessage);
  useEffect(() => () => dictation.dispose(), [dictation]);
  // The media ladder's one-time hint (tmux passthrough off) when the first image falls back.
  useEffect(() => onMediaNotice(setActionError), []);
  const [quitArmed, setQuitArmed] = useState(false);
  useEffect(() => {
    setNarrowSidebar(false);
    if (width < 70) setFocus(right ? "right" : "transcript");
  }, [width, right]);
  const center = useRef<"transcript" | "composer">("transcript");
  useEffect(() => {
    if (focus === "transcript" || focus === "composer") center.current = focus;
  }, [focus]);
  const visiblePanes = (): Pane[] => [
    ...(sidebar ? ["sidebar" as const] : []),
    ...(width >= 70 || !right ? ["transcript" as const, "composer" as const] : []),
    ...(right ? ["right" as const] : []),
  ];
  const cwd =
    selected?.worktreePath ??
    snapshot?.projects.find((p) => p.id === selected?.projectId)?.workspaceRoot;
  const busyWorkspace = (path: string) => (snapshot?.threads ?? []).filter((t) =>
    (t.worktreePath ?? snapshot?.projects.find((p) => p.id === t.projectId)?.workspaceRoot) === path
  ).some((t) => !!t.activeRunId || !!t.activityRunStatus || client.getThread(t.id).projection?.runs.some((run) =>
    !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status)));
  const busyWorkspaceRef = useRef(busyWorkspace);
  busyWorkspaceRef.current = busyWorkspace;
  const branchTarget = useRef<BranchTarget | undefined>(undefined);
  branchTarget.current = selected && cwd ? {
    projectId: selected.projectId, threadId: selected.id,
    projectCwd: snapshot!.projects.find((p) => p.id === selected.projectId)!.workspaceRoot,
    worktreePath: selected.worktreePath, branch: selected.branch,
    knownWorkspaces: snapshot?.threads.filter((t) => t.projectId === selected.projectId),
    running: busyWorkspace(cwd),
  } : undefined;
  const branchWorkflow = useMemo(() => createBranchWorkflow(client, () => branchTarget.current, (path) => busyWorkspaceRef.current(path)), [client]);
  const pullRequestWorkflow = useMemo(() => createPullRequestWorkflow(client, () => branchTarget.current), [client]);
  const runShell = () =>
    Promise.resolve().then(() => {
      if (!cwd || !effects?.shell) throw new Error("Unavailable");
      return effects.shell({ cwd });
    });
  const runWeb = () =>
    Promise.resolve().then(() => {
      if (!selectedId || !effects?.openThread) throw new Error("Unavailable");
      return effects.openThread({ threadId: selectedId });
    });
  const openRight = (panel: RightPanel) => {
    if (panel === "diff") setDiffTarget(undefined);
    setRight(panel);
    setFocus("right");
  };
  const dispatch = (command: Command) => {
    if (command === "quit") {
      if (editorSession?.running) {
        setActionError("Quit the editor with :wq (save) or :q! (discard) before quitting Tercet.");
        setRight("editor");
        setFocus("right");
        return;
      }
      if (quitArmed) (onQuit ?? (() => renderer.destroy()))();
      else setQuitArmed(true);
      return;
    }
    setQuitArmed(false);
    if (command === "dismissNotice") {
      notice?.dismiss();
      return;
    }
    // The composer runs attach itself (it owns the draft), from wherever a paste would land.
    if (command === "attach" || command === "spell") return;
    if (command === "hints") {
      setHintsShown(!hintsShown);
      return;
    }
    if (command === "dictation") {
      // As the [mic] button does, dictation writes in the composer: an external dictation tool
      // (commands.dictation, e.g. voxtype) types its text as keys, and in another pane those keys
      // are commands, so the first words were lost. A focused shell keeps them, to dictate there.
      if (!(focus === "right" && (right === "terminal" || right === "editor")))
        setFocus("composer");
      void dictation.toggle(selectedId ?? undefined);
      return;
    }
    if (command === "newThread") {
      if (!overlay) {
        setMenuTarget(selected);
        setOverlay("workspace");
      }
      return;
    }
    if (command === "threadMenu" || command === "search") {
      setMenuTarget(selected);
      setOverlay(command === "search" ? "search" : "menu");
      return;
    }
    if (command === "close" && overlay) {
      setOverlay(null);
      return;
    }
    if (
      command === "help" ||
      command === "branches" ||
      command === "pullRequests" ||
      command === "context" ||
      command === "model" ||
      command === "effort" ||
      command === "palette"
    ) {
      setMenuTarget(selected);
      setOverlay(overlay === command ? null : command);
      return;
    }
    if (overlay) return;
    if (command === "shell" || command === "web") {
      const effect = command === "shell" ? runShell : runWeb;
      setActionError(`${command} …`);
      effect()
        .then(() => setActionError(`${command} ✓`))
        .catch((error) =>
          setActionError(failureText(error, `${command} failed; select a thread and retry.`)),
        );
    } else if (command === "sidebar") {
      if (width < 70) setNarrowSidebar(!sidebar);
      else setSidebar(!sidebar);
      if (focus === "sidebar") setFocus("transcript");
    } else if (
      command === "files" ||
      command === "diff" ||
      command === "launchers" ||
      command === "terminal" ||
      command === "editor"
    ) {
      if (command === "diff") setDiffTarget(undefined);
      setRight(right === command ? null : command);
      setFocus(right === command ? "transcript" : "right");
    } else if (command === "leave") {
      // Alt+c closes the right panel (files, diff, terminal, launchers) from wherever focus is.
      if (right) {
        setRight(null);
        if (focus === "right") setFocus(width >= 70 ? center.current : "transcript");
      } else if (focus === "sidebar") setFocus(center.current);
    } else if (command === "close") {
      if (agentId && focus !== "right") {
        closeAgent();
        return;
      }
      if (focus === "right") {
        // Esc leaves the side panel for the centre; a terminal too narrow to show both closes it.
        if (width >= 70) setFocus(center.current);
        else {
          setRight(null);
          setFocus("transcript");
        }
        return;
      }
      // Esc with nothing to close walks the panes in reading order.
      const panes = visiblePanes();
      setFocus(panes[(panes.indexOf(focus) + 1) % panes.length]!);
    } else if (command.startsWith("focus")) {
      // Columns are sidebar | transcript over composer | right panel.
      const centerShown = width >= 70 || !right;
      const leftward: Pane | undefined =
        focus === "right" && centerShown ? center.current : sidebar ? "sidebar" : undefined;
      const rightward: Pane | undefined =
        focus === "sidebar" && centerShown ? center.current : right ? "right" : undefined;
      const target: Pane | undefined =
        command === "focusLeft"
          ? focus === "sidebar"
            ? undefined
            : leftward
          : command === "focusRight"
            ? focus === "right"
              ? undefined
              : rightward
            : command === "focusUp"
              ? focus === "composer" || (focus === "right" && centerShown)
                ? "transcript"
                : undefined
              : focus === "transcript" || (focus === "right" && centerShown)
                ? "composer"
                : undefined;
      if (target) setFocus(target);
    }
  };
  useKeyboard((key) => {
    const found = commandForKey(key);
    // A command whose action is missing is not bound, like it is not listed in help.
    const command =
      (found === "shell" && !effects?.shell) ||
      (found === "dictation" && !hasDictation(effects)) ||
      (found === "attach" && !effects?.pickFiles) ||
      (found === "spell" && !effects?.spell) ||
      (found === "dismissNotice" && !notice)
        ? undefined
        : found;
    if (key.defaultPrevented) return;
    // PR drafts and nested Back own Esc and review chords while this overlay is open.
    if (overlay === "pullRequests" && command !== "pullRequests" && command !== "quit") return;
    if (
      focus === "composer" &&
      key.name === "escape" &&
      !effects?.toggleDictation &&
      ["recording", "transcribing"].includes(dictation.getSnapshot())
    ) {
      key.preventDefault();
      dictation.cancel();
      return;
    }
    // Editor input includes Esc, Ctrl commands and Alt chords, except explicit pane navigation.
    if (
      focus === "right" &&
      right === "editor" &&
      !overlay &&
      !(key.meta && (command === "focusLeft" || command === "leave"))
    )
      return;
    // A focused terminal owns every key except the Alt bindings, Esc and Ctrl+c included.
    if (focus === "right" && right === "terminal" && !overlay && !key.meta) return;
    if (focus === "right" && !!right && !overlay && !key.ctrl && !key.meta && key.name !== "escape")
      return;
    if (hasCard && focus === "composer" && !overlay && !key.ctrl && !key.meta) return;
    if (
      (overlay === "model" || overlay === "effort" || overlay === "workspace") &&
      !key.ctrl &&
      !key.meta &&
      key.name !== "escape"
    )
      return;
    // Keys without Ctrl or Alt (? . and capitals) are text while writing.
    const bare = !key.ctrl && !key.meta && key.name !== "escape";
    if (focus === "composer" && !overlay && bare) return;
    // Terminals send Ctrl+j as a bare linefeed; Vim insert keys start typing below.
    if (
      focus === "transcript" &&
      !overlay &&
      ((key.name === "linefeed" && !key.meta) ||
        (["i", "a", "o"].includes(key.name.toLowerCase()) && !key.ctrl && !key.meta))
    ) {
      key.preventDefault();
      setFocus("composer");
      return;
    }
    if (command === "dictation" && (focus === "composer" || overlay)) return;
    if (command) {
      key.preventDefault();
      dispatch(command);
    } else setQuitArmed(false);
  });
  // The same table drives dispatch, so help lists exactly the keys that work.
  const helpLines = cheatSheet(
    keymap(),
    {
      shell: !!effects?.shell,
      dictation: hasDictation(effects),
      notice: !!notice,
      attach: !!effects?.pickFiles,
      spell: !!effects?.spell,
    },
    targetKeys(effects),
  ).flatMap((part, i) => [
    ...(i ? [{ text: "", title: false }] : []),
    { text: part.title, title: true },
    ...part.rows.map((row) => ({ text: `${row.keys.padEnd(20)}${row.label}`, title: false })),
  ]);
  const pane = (
    id: Pane,
    title: string,
    children: ReactNode,
    size: { width?: number; height?: number; flexGrow?: number },
  ) => (
    <box
      {...size}
      minWidth={0}
      minHeight={0}
      flexShrink={size.flexGrow ? 1 : 0}
      border
      borderStyle="rounded"
      borderColor={focus === id ? theme.accent : theme.border}
      // The border stays quiet when unfocused; its title must still read.
      titleColor={focus === id ? theme.accent : theme.muted}
      title={`${focus === id ? "● " : ""}${paneGlyphs[id === "right" ? (right === "editor" ? "terminal" : (right ?? "files")) : id]} ${title}`}
      onMouseDown={() => {
        // Opening on press moves the Send row under this click's release.
        if (id === "composer" && composerCollapsed) return;
        if (!overlay) {
          setFocus(id);
          setQuitArmed(false);
        }
      }}
      onMouseUp={(event) => {
        if (id === "composer" && composerCollapsed && event.button === 0 && !overlay) {
          setFocus(id);
          setQuitArmed(false);
        }
      }}
    >
      {(id === "sidebar" || id === "transcript" || id === "composer" || id === "right") &&
      !content[id] ? (
        children
      ) : (
        <scrollbox width="100%" height="100%" scrollY scrollX={false}>
          {children}
        </scrollbox>
      )}
    </box>
  );
  return (
    <HintsShown.Provider value={hintsShown}>
      <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.canvas}>
        <box height={1} flexShrink={0} flexDirection="row">
          <text fg={theme.text}>{statusText}</text>
          {runningAgents > 0 && (
            <box
              marginLeft={2}
              onMouseUp={(event) => {
                if (event.button === 0 && !overlay) openRight("launchers");
              }}
            >
              <text fg={theme.accent} selectable={false}>
                {agentsText}
              </text>
            </box>
          )}
          {selected && (
            <>
              <box flexGrow={1} />
              <ContextChip
                detail={contextDetail}
                columns={chipColumns}
                open={overlay === "context"}
                onToggle={() => {
                  if (!overlay || overlay === "context") dispatch("context");
                }}
              />
            </>
          )}
        </box>
        {noticeRows.length > 0 && (
          <box
            flexDirection="column"
            flexShrink={0}
            onMouseUp={(event) => {
              if (event.button === 0) notice?.dismiss();
            }}
          >
            {noticeRows.map((row, i) => (
              <text key={i} height={1} fg={theme.yellow}>
                {row}
              </text>
            ))}
          </box>
        )}
        {headerRows.map((row) => (
          <text onMouseUp={(event) => { if (event.button === 0 && row.includes(`${paneGlyphs.branch} `)) dispatch("branches"); }}
            key={row}
            height={1}
            flexShrink={0}
            fg={contextDetail?.level === "full" ? theme.red : theme.accent}
          >
            {logo && row.startsWith(logo.glyph) ? (
              <>
                <span fg={logo.color}>{logo.glyph}</span>
                {row.slice(logo.glyph.length)}
              </>
            ) : (
              row
            )}
          </text>
        ))}
        <box flexGrow={1} minHeight={0} flexDirection="row">
          {sidebar &&
            pane(
              "sidebar",
              "Threads",
              content.sidebar ?? (
                <ThreadSidebar
                  client={client}
                  width={(width < 100 ? 22 : 30) - 2}
                  height={Math.max(1, height - 5 - chromeRows)}
                  enabled={!overlay}
                  keyboardEnabled={focus === "sidebar"}
                  onOpen={() => {
                    if (width >= 70 || !right) setFocus("transcript");
                  }}
                  onMenu={(id) => {
                    setMenuTarget(allThreads(client).find((t) => t.id === id));
                    setOverlay("menu");
                  }}
                />
              ),
              { width: width < 100 ? 22 : 30 },
            )}
          <box flexGrow={1} minWidth={0} flexDirection="column" visible={width >= 70 || !right}>
            {pane(
              "transcript",
              agentId
                ? `Agent · ${agentThread ? formatSubagentDisplayTitle(agentThread.title) : "thread"} · read-only`
                : "Transcript",
              content.transcript ??
                (status === "live" || selectedId ? (
                  <ThreadTranscript
                    effects={effects}
                    threadId={agentId ?? undefined}
                    openAgent={openAgent}
                    openDiff={
                      agentId
                        ? undefined
                        : (target) => {
                            setDiffTarget(target);
                            setDiffSerial((n) => n + 1);
                            setRight("diff");
                            setFocus("right");
                          }
                    }
                    openFile={
                      agentId
                        ? undefined
                        : (path) => {
                            setFilePath((previous) => ({
                              threadId: selectedId,
                              path,
                              serial: (previous?.serial ?? 0) + 1,
                            }));
                            setRight("files");
                            setFocus("right");
                          }
                    }
                    client={client}
                    width={Math.max(
                      2,
                      width -
                        (sidebar ? (width < 100 ? 22 : 30) : 0) -
                        (right ? rightWidth(right, width) : 0) -
                        2,
                    )}
                    height={Math.max(2, height - 13 - chromeRows - (composerHeight - 9))}
                    enabled={!overlay}
                    keyboardEnabled={focus === "transcript"}
                  />
                ) : (
                  <ConnectionScreen client={client} keyboardEnabled={!overlay} />
                )),
              { flexGrow: 1 },
            )}
            {pane(
              "composer",
              agentId ? "Agent · read-only" : "Composer",
              content.composer ?? (
                <>
                  {/* Stays mounted while an agent is viewed so an unsent draft is kept. */}
                  <box visible={!agentId} height="100%">
                    <ThreadComposer
                      client={client}
                      effects={effects}
                      dictation={dictation}
                      enabled={!overlay && focus === "composer" && !agentId}
                      pasteEnabled={
                        !overlay &&
                        !agentId &&
                        (width >= 70 || !right) &&
                        !(focus === "right" && (right === "terminal" || right === "editor"))
                      }
                      collapsed={composerCollapsed}
                      onSent={() => setSent(true)}
                      onInputFocus={() => setFocus("composer")}
                    />
                  </box>
                  {agentId && (
                    <box flexDirection="column" height="100%">
                      {agentCard && (
                        <RequestPanel
                          key={agentCardKey}
                          client={client}
                          id={agentId}
                          card={agentCard}
                          enabled={!overlay && focus === "composer"}
                          onEscape={closeAgent}
                        />
                      )}
                      <box
                        height={1}
                        flexShrink={0}
                        onMouseUp={(event) => {
                          if (event.button === 0 && !overlay) closeAgent();
                        }}
                      >
                        <text fg={theme.accent} selectable={false}>
                          Read-only agent view · [Esc Back]
                        </text>
                      </box>
                    </box>
                  )}
                </>
              ),
              { height: composerHeight },
            )}
          </box>
          {right &&
            pane(
              "right",
              right === "files"
                ? "Files"
                : right === "diff"
                  ? "Diff"
                  : right === "editor"
                    ? "Editor"
                    : right === "terminal"
                      ? "Terminal"
                      : "Launchers",
              content.right ??
                (right === "editor" ? (
                  <EditorPanel
                    session={editorSession}
                    enabled={!overlay && focus === "right"}
                    width={
                      (width < 70
                        ? Math.max(1, width - (sidebar ? 22 : 0))
                        : rightWidth("editor", width)) - 2
                    }
                    height={height - 6 - chromeRows}
                    close={() => {
                      setRight("files");
                      setFocus("right");
                    }}
                  />
                ) : right === "terminal" ? (
                  <TerminalPanel
                    client={client}
                    threadId={selectedId ?? undefined}
                    cwd={
                      selected?.worktreePath ??
                      snapshot?.projects.find((p) => p.id === selected?.projectId)?.workspaceRoot
                    }
                    worktreePath={selected?.worktreePath ?? null}
                    enabled={!overlay && focus === "right"}
                    queuedRun={queuedRun}
                    onRunDone={(id) => setQueuedRun((last) => (last?.id === id ? undefined : last))}
                    height={height - 6 - chromeRows}
                    width={
                      (width < 70
                        ? Math.max(1, width - (sidebar ? 22 : 0))
                        : rightWidth("terminal", width)) - 2
                    }
                    close={() => {
                      setRight(null);
                      setFocus("transcript");
                    }}
                  />
                ) : right === "launchers" ? (
                  <LaunchersPanel
                    key={selectedId}
                    open={openRight}
                    shell={effects?.shell ? runShell : undefined}
                    agents={agents}
                    openAgent={openAgent}
                    now={client.now}
                    enabled={!overlay && focus === "right"}
                    close={() => {
                      setRight(null);
                      setFocus("transcript");
                    }}
                  />
                ) : right === "files" ? (
                  <FilesPanel
                    key={`${selectedId}:${filePath?.serial ?? 0}`}
                    api={client.files}
                    edit={
                      effects?.embeddedEditor
                        ? (path) => {
                            if (!cwd) return;
                            void effects.embeddedEditor!({ cwd, path })
                              .then((session) => {
                                setEditorSession(session);
                                setRight("editor");
                                setFocus("right");
                                setActionError("");
                              })
                              .catch((error) =>
                                setActionError(failureText(error, "Editor failed")),
                              );
                          }
                        : undefined
                    }
                    cwd={
                      selected?.worktreePath ??
                      snapshot?.projects.find((p) => p.id === selected?.projectId)?.workspaceRoot
                    }
                    path={filePath?.threadId === selectedId ? filePath.path : undefined}
                    enabled={!overlay && focus === "right"}
                    effects={effects}
                    height={height - 5 - chromeRows}
                    width={
                      (width < 70
                        ? Math.max(1, width - (sidebar ? 22 : 0))
                        : rightWidth("files", width)) - 2
                    }
                    close={() => {
                      setRight(null);
                      setFocus("transcript");
                    }}
                  />
                ) : (
                  <DiffPanel
                    key={`${selectedId}:${diffSerial}`}
                    client={client}
                    target={diffTarget}
                    enabled={!overlay && focus === "right"}
                    height={height - 5 - chromeRows}
                    close={() => {
                      setRight(null);
                      setFocus("transcript");
                    }}
                  />
                )),
              {
                width:
                  width < 70 ? Math.max(1, width - (sidebar ? 22 : 0)) : rightWidth(right, width),
              },
            )}
        </box>
        <text height={1} flexShrink={0} fg={theme.accent}>
          {actionError ||
            (quitArmed
              ? "Press Ctrl+c again to quit; any other key cancels"
              : composerCollapsed && micMessage
                ? micMessage
                : `Focus: ${focus}${hintsShown || hintFor("hints") === "none" ? "" : ` · ${hintFor("hints")} hints`}`)}
        </text>
        {hintsShown && (
          <box height={2} flexShrink={0} flexDirection="row" flexWrap="wrap">
            {keymap()
              .filter(
                (binding) =>
                  binding.chord &&
                  [
                    "sidebar",
                    "web",
                    "launchers",
                    "model",
                    "effort",
                    "palette",
                    "help",
                    "leave",
                    "close",
                    "hints",
                  ].includes(binding.id),
              )
              // Files, Diff, Terminal and Shell live in the launcher list; their Alt keys still work and stay in Help.
              .map((binding) => (
                <box
                  key={binding.id}
                  height={1}
                  marginRight={2}
                  onMouseUp={(event) => {
                    if (event.button === 0) dispatch(binding.id);
                  }}
                >
                  <text fg={theme.text} selectable={false}>
                    {binding.hint} {binding.id === "hints" ? "Hide hints" : binding.label}
                  </text>
                </box>
              ))}
          </box>
        )}
        {(overlay === "palette" || overlay === "search" || overlay === "menu") && (
          <ThreadPalette
            key={overlay}
            client={client}
            mode={overlay}
            target={menuTarget}
            actions={actions}
            newThread={() => setOverlay("workspace")}
            close={() => setOverlay(null)}
            width={width}
            height={height}
          />
        )}
        {(overlay === "model" || overlay === "effort") && (
          <ModelPicker
            key={overlay}
            client={client}
            effort={overlay === "effort"}
            close={() => setOverlay(null)}
            width={width}
            height={height}
          />
        )}
        {overlay === "pullRequests" && <PullRequestPanel workflow={pullRequestWorkflow} target={branchTarget.current} effects={effects} close={() => setOverlay(null)} />}
        {overlay === "branches" && <BranchPanel workflow={branchWorkflow} target={branchTarget.current} close={() => setOverlay(null)} />}
        {overlay === "workspace" && (
          <NewThreadPicker
            client={client}
            target={menuTarget}
            actions={actions}
            close={() => setOverlay(null)}
            created={() => {
              setOverlay("model");
              if (width >= 70 || !right) setFocus("composer");
            }}
          />
        )}
        {overlay === "context" && (
          <ContextDropdown
            detail={contextDetail}
            width={width}
            height={height}
            now={client.now}
            close={() => setOverlay(null)}
          />
        )}
        {overlay === "help" && (
          <box position="absolute" left={0} top={0} width="100%" height="100%">
            <box
              position="absolute"
              left={Math.max(0, Math.floor((width - Math.min(60, width)) / 2))}
              top={Math.max(
                0,
                Math.floor((height - 4 - Math.min(height - 4, helpLines.length + 3)) / 2),
              )}
              width={Math.min(60, width)}
              height={Math.min(height - 4, helpLines.length + 3)}
              border
              borderStyle="rounded"
              borderColor={theme.accent}
              backgroundColor={theme.canvas}
              title="Keys"
              flexDirection="column"
            >
              <scrollbox scrollY scrollX={false} flexGrow={1}>
                {helpLines.map((line, i) => (
                  <text key={i} fg={line.title ? theme.accent : theme.text}>
                    {line.text}
                  </text>
                ))}
              </scrollbox>
              <box
                height={1}
                onMouseUp={(event) => {
                  if (event.button === 0) dispatch("close");
                }}
              >
                <text fg={theme.accent} selectable={false}>
                  [ Esc Close ]
                </text>
              </box>
            </box>
          </box>
        )}
      </box>
    </HintsShown.Provider>
  );
}
