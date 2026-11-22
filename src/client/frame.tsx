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

/** How often tercet asks the server to re-read model catalogs while it is open. */
const MODEL_WATCH_MS = 5 * 60 * 1000;
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
import { contextContentOf } from "./context-content";
import { ContextChip, contextDetailOf, ContextDropdown } from "./context-meter";
import { paneGlyphs, selectionIcon } from "./icons";
import { ThreadSidebar, wrapName } from "./sidebar";
import { layoutFor, type LayoutMode } from "./layout";
import { LayoutContext } from "./layout-context";
import { compactComposerRows } from "./composer";
import type { Client } from "./runtime";
import { ConnectionScreen, ServerNotice, useClientAtom } from "./screen";
import { cheatSheet, commandForKey, hintFor, HintsShown, keymap, type Command } from "./keymap";
import { targetKeys } from "../actions";
import { onMediaNotice } from "./media";

type Pane = "sidebar" | "transcript" | "composer" | "right";
type RightPanel = "files" | "diff" | "launchers" | "terminal" | "editor";
type Overlay =
  "pullRequests" | "branches" | "workspace" | "model" | "effort" | "palette" | "search" | "menu" | "help" | "keys" | "context";

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
  attached = false,
}: {
  /** `tercet attach`: one thread, so no thread list and the composer has focus. */
  attached?: boolean;
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
  // Watch the model catalogs: a model added to OpenCode, Ollama, llama.cpp or a provider shows up
  // without opening the picker.
  useEffect(() => {
    void client.refreshModels();
    const timer = setInterval(() => void client.refreshModels(), MODEL_WATCH_MS);
    return () => clearInterval(timer);
  }, [client]);
  // Upstream keeps context usage on the thread's active provider thread, not on the shell.
  const transcript = selected ? client.getThread(selected.id) : undefined;
  const projection = transcript?.projection;
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
  // While an agent is open its own model fills the model row; the parent's is one Esc away.
  // The parent's subagent record knows what the agent asked for (a native subagent's child
  // shell carries the parent's selection); the child shell is the fallback.
  const agentParentId = agentStack.at(-2) ?? selectedId;
  const agentRecord = agentId
    ? (agentParentId ? client.getThread(agentParentId).projection : undefined)?.subagents?.find(
        (agent) => agent.childThreadId === agentId,
      )
    : undefined;
  const modelSelection = agentId
    ? (agentRecord?.modelSelection ??
      (agentRecord?.model && agentThread?.modelSelection.model !== agentRecord.model
        ? { instanceId: agentRecord.providerInstanceId, model: agentRecord.model }
        : agentThread?.modelSelection))
    : selected?.modelSelection;
  const modelLogo = modelSelection && selectionIcon(modelSelection, providers);
  const effort = modelSelection?.options?.find((option) =>
    ["reasoningEffort", "effort", "variant"].includes(option.id),
  )?.value;
  // The top row: status on the left, the context chip on the right in whatever room is left.
  const statusText = `tercet · ${status} · threads=${count}${selected ? ` · ${runtimeModeLabels[selected.runtimeMode] ?? selected.runtimeMode}` : ""}`;
  const agentsText =
    runningAgents > 0 ? `${runningAgents} ${runningAgents === 1 ? "agent" : "agents"} running` : "";
  // Narrow terminals (a phone) show one view at a time: Threads, Chat or the side panel.
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("auto");
  useEffect(() => {
    void client.boundary
      .layoutMode?.()
      .then(setLayoutMode)
      .catch(() => {});
  }, [client]);
  const layout = layoutFor({ width, height, mode: layoutMode });
  // Compact: slim chrome (a tab strip and one action bar). Below 70 columns it is also one view at
  // a time. "full" keeps the desktop columns at any size.
  const compact = layout.compact;
  const oneView = layout.narrow && compact;
  // Slim chrome hides the model and branch rows on a short screen until the strip's info tap.
  const [infoOpen, setInfoOpen] = useState(false);
  const allHeaderRows = selected
    ? [
        ...wrapName(
          `${modelLogo?.glyph} ${agentId ? "agent · " : ""}${modelSelection?.model ?? "model unknown"} · effort ${effort ?? "default"}`,
          width,
        ),
        ...wrapName(
          `${paneGlyphs.branch} ${selected.branch ?? "branch unknown"} · ${selected.worktreePath ?? snapshot?.projects.find((p) => p.id === selected.projectId)?.workspaceRoot ?? "workspace unknown"}`,
          width,
        ),
      ]
    : [];
  const infoToggle = compact && height < 30 && allHeaderRows.length > 0;
  const headerRows = !compact || height >= 30 || infoOpen ? allHeaderRows : [];
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
  // The compact strip and action bar take the two rows every layout already reserves.
  const chromeRows = topRows + (hintsShown && !compact ? 2 : 0);
  const [sidebarWanted, setSidebar] = useState(!attached);
  const [focus, setFocusPane] = useState<Pane>(attached ? "composer" : "sidebar");
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
  // The compact composer reports the rows its buttons need; the frame adds borders and a longer draft.
  const [composerRows, setComposerRows] = useState(() => compactComposerRows(40, {}));
  const panesRows = height - 2 - chromeRows;
  const composerHeight = hasCard
    ? Math.min(19, Math.max(15, height - 5 - chromeRows))
    : composerCollapsed
      ? 3
      : compact
        ? // Under 14 rows (the keyboard is up) the transcript shrinks to its title row.
          Math.max(3, panesRows < 14 ? panesRows - 2 : Math.min(composerRows + 4, panesRows - 2))
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
  const sidebarWidth = oneView ? width : width < 100 ? 22 : 30;
  const tuckSidebar = width >= 70 && (right === "files" || right === "diff") &&
    width - sidebarWidth - rightWidth(right, width) - 2 < 60;
  const [compactSidebar, setCompactSidebar] = useState(false);
  useEffect(() => setCompactSidebar(false), [right, tuckSidebar]);
  // One view at a time: the sidebar is the Threads view, shown exactly while it has focus.
  const sidebar = oneView ? focus === "sidebar" : tuckSidebar ? compactSidebar : sidebarWanted;
  const inChat = focus === "transcript" || focus === "composer";
  const hasSidebar = oneView ? !attached : sidebar;
  const rightTitle =
    right === "files"
      ? "Files"
      : right === "diff"
        ? "Diff"
        : right === "editor"
          ? "Editor"
          : right === "terminal"
            ? "Terminal"
            : "Launchers";
  const rightOuter = (kind: RightPanel) => (oneView ? Math.max(1, width) : rightWidth(kind, width));
  const tabs: { label: string; pane: Pane }[] = [
    ...(hasSidebar ? [{ label: "Threads", pane: "sidebar" as const }] : []),
    { label: "Chat", pane: "transcript" },
    ...(right ? [{ label: rightTitle, pane: "right" as const }] : []),
  ];
  const tabsText = [...tabs.map((tab) => `[${tab.label}]`), ...(infoToggle ? ["[Info]"] : [])].join(" ");
  const chipColumns = oneView
    ? width - Bun.stringWidth(tabsText) - 2
    : width - Bun.stringWidth(statusText) - (agentsText ? 2 + Bun.stringWidth(agentsText) : 0) - 2;

  useEffect(() => {
    if (!sidebar && focus === "sidebar") setFocusPane(right ? "right" : "transcript");
  }, [sidebar, focus, right]);
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
  const activeProviderThreadId = selected?.activeProviderThreadId;
  const hasMoreHistory = transcript?.history.hasMoreHistory ?? false;
  const contextContent = useMemo(
    () => overlay === "context" && projection
      ? contextContentOf(projection, activeProviderThreadId, hasMoreHistory)
      : null,
    [overlay, projection, activeProviderThreadId, hasMoreHistory],
  );
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
  // The view is the focused pane, so a resize never moves it; only a vanished panel does.
  useEffect(() => {
    if (oneView && focus === "right" && !right) setFocusPane("transcript");
  }, [oneView, focus, right]);
  const center = useRef<"transcript" | "composer">("transcript");
  useEffect(() => {
    if (focus === "transcript" || focus === "composer") center.current = focus;
  }, [focus]);
  const visiblePanes = (): Pane[] =>
    oneView
      ? [
          ...(hasSidebar ? ["sidebar" as const] : []),
          center.current,
          ...(right ? ["right" as const] : []),
        ]
      : [
          ...(sidebar ? ["sidebar" as const] : []),
          "transcript" as const,
          "composer" as const,
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
    if (command === "screenshot" || command === "attach" || command === "spell") return;
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
      if (oneView) setFocus(focus === "sidebar" ? center.current : "sidebar");
      else {
        if (tuckSidebar) setCompactSidebar(!sidebar);
        else setSidebar(!sidebar);
        if (focus === "sidebar") setFocus("transcript");
      }
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
      // Esc leaves the side panel for the centre; one view at a time it keeps walking the views.
      if (focus === "right" && !oneView) {
        setFocus(center.current);
        return;
      }
      // Esc with nothing to close walks the panes in reading order.
      const panes = visiblePanes();
      setFocus(panes[(panes.indexOf(focus) + 1) % panes.length]!);
    } else if (command.startsWith("focus")) {
      // Columns are sidebar | transcript over composer | right panel.
      const leftward: Pane | undefined =
        focus === "right" ? center.current : hasSidebar ? "sidebar" : undefined;
      const rightward: Pane | undefined =
        focus === "sidebar" ? center.current : right ? "right" : undefined;
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
              ? focus === "composer" || focus === "right"
                ? "transcript"
                : undefined
              : focus === "transcript" || focus === "right"
                ? "composer"
                : undefined;
      if (target) setFocus(target);
    }
  };
  // A Menu sheet row closes the sheet first, then runs its command once no overlay is open.
  const [pending, setPending] = useState<Command | null>(null);
  useEffect(() => {
    if (!pending || overlay) return;
    setPending(null);
    dispatch(pending);
  }, [pending, overlay]);
  const runFromSheet = (id: Command) => {
    setOverlay(null);
    if (id === "help") setOverlay("keys");
    else if (id !== "close") setPending(id);
  };
  useKeyboard((key) => {
    if (renderer.currentFocusedRenderable?.id === "transcript-search") return;
    const found = commandForKey(key);
    // A command whose action is missing is not bound, like it is not listed in help.
    const command =
      (found === "shell" && !effects?.shell) ||
      (found === "dictation" && !hasDictation(effects)) ||
      (found === "screenshot" && !effects?.captureRegion) ||
      (found === "attach" && !effects?.pickFiles) ||
      (found === "spell" && !effects?.spell) ||
      (found === "dismissNotice" && !notice)
        ? undefined
        : found;
    // The frame may receive the key before the composer hook. Let its selection own Copy.
    if (command === "quit" && focus === "composer" && renderer.currentFocusedEditor?.hasSelection()) {
      setQuitArmed(false);
      return;
    }
    const selection = renderer.getSelection();
    if (
      command === "quit" &&
      !overlay &&
      !(focus === "right" && (right === "terminal" || right === "editor")) &&
      selection?.selectedRenderables.length &&
      selection.selectedRenderables.every((r) => r.id.startsWith("transcript-row-")) &&
      selection.getSelectedText()
    ) {
      setQuitArmed(false);
      if (key.defaultPrevented) return;
      key.preventDefault();
      const text = selection.getSelectedText();
      if (effects)
        void Promise.resolve()
          .then(() => effects.copy(text))
          .catch(() => setActionError("Copy failed; retry"));
      return;
    }
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
  const sheet = cheatSheet(
    keymap(),
    {
      shell: !!effects?.shell,
      dictation: hasDictation(effects),
      notice: !!notice,
      screenshot: !!effects?.captureRegion,
      attach: !!effects?.pickFiles,
      spell: !!effects?.spell,
    },
    targetKeys(effects),
  );
  const helpLines = sheet.flatMap((part, i) => [
    ...(i ? [{ text: "", title: false }] : []),
    { text: part.title, title: true },
    ...part.rows.map((row) => ({ text: `${row.keys.padEnd(20)}${row.label}`, title: false })),
  ]);
  // Phone width: the reference wraps instead of clipping at the border.
  const keyLines = compact
    ? helpLines.flatMap((line) =>
        (line.text ? wrapName(line.text, width - 4) : [""]).map((text) => ({ ...line, text })),
      )
    : helpLines;
  const centerInner = Math.max(
    2,
    width - (sidebar ? sidebarWidth : 0) - (right && !oneView ? rightWidth(right, width) : 0) - 2,
  );
  const transcriptRows = height - chromeRows - composerHeight - 4;
  const barItems: { label: string; run: () => void }[] = [
    { label: "Menu", run: () => dispatch("help") },
    { label: "Model", run: () => dispatch("model") },
    { label: "Panels", run: () => dispatch("launchers") },
    { label: "Threads", run: () => dispatch("sidebar") },
    {
      label: "Help",
      run: () => {
        setMenuTarget(selected);
        setOverlay("keys");
      },
    },
  ];
  const barMessage =
    actionError ||
    (quitArmed
      ? "Press Ctrl+c again to quit; any other key cancels"
      : composerCollapsed && micMessage
        ? micMessage
        : "");
  const pane = (
    id: Pane,
    title: string,
    children: ReactNode,
    size: { width?: number; height?: number; flexGrow?: number; visible?: boolean },
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
    <LayoutContext.Provider value={layout}>
    <HintsShown.Provider value={hintsShown}>
      <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.canvas}>
        <box height={1} flexShrink={0} flexDirection="row">
          {oneView ? (
            [...tabs.map((tab) => (
              <box
                key={tab.pane}
                marginRight={1}
                onMouseUp={(event) => {
                  if (event.button !== 0 || overlay) return;
                  setFocus(tab.pane === "transcript" ? center.current : tab.pane);
                  setQuitArmed(false);
                }}
              >
                <text
                  fg={
                    (tab.pane === "transcript" ? inChat : focus === tab.pane)
                      ? theme.accent
                      : theme.muted
                  }
                  selectable={false}
                >
                  [{tab.label}]
                </text>
              </box>
            )),
            ...(infoToggle
              ? [
                  <box
                    key="info"
                    onMouseUp={(event) => {
                      if (event.button === 0 && !overlay) setInfoOpen(!infoOpen);
                    }}
                  >
                    <text fg={infoOpen ? theme.accent : theme.muted} selectable={false}>
                      [Info]
                    </text>
                  </box>,
                ]
              : [])]
          ) : (
            <box
              onMouseUp={(event) => {
                if (event.button === 0 && infoToggle && !overlay) setInfoOpen(!infoOpen);
              }}
            >
              <text fg={theme.text}>{statusText}</text>
            </box>
          )}
          {!oneView && runningAgents > 0 && (
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
            {modelLogo && row.startsWith(modelLogo.glyph) ? (
              <>
                <span fg={modelLogo.color}>{modelLogo.glyph}</span>
                {row.slice(modelLogo.glyph.length)}
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
                  width={sidebarWidth - 2}
                  height={Math.max(1, height - 5 - chromeRows)}
                  enabled={!overlay}
                  keyboardEnabled={focus === "sidebar"}
                  wrapNames={compact}
                  tapOpens={oneView}
                  onOpen={() => setFocus("transcript")}
                  onSettle={(id) => {
                    const thread = allThreads(client).find((t) => t.id === id);
                    actions
                      .run("settle", thread)
                      .catch((error) => setActionError(String(error?.message ?? error)));
                  }}
                  onMenu={(id) => {
                    setMenuTarget(allThreads(client).find((t) => t.id === id));
                    setOverlay("menu");
                  }}
                />
              ),
              { width: sidebarWidth },
            )}
          <box
            flexGrow={1}
            minWidth={0}
            flexDirection="column"
            visible={!oneView || inChat}
          >
            {pane(
              "transcript",
              agentId
                ? `Agent · ${agentThread ? formatSubagentDisplayTitle(agentThread.title) : "thread"} · read-only`
                : "Transcript",
              content.transcript ??
                (status === "live" || selectedId ? (
                  <box visible={!compact || transcriptRows >= 1} height="100%">
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
                        (sidebar ? sidebarWidth : 0) -
                        (right && !oneView ? rightWidth(right, width) : 0) -
                        2,
                    )}
                    height={Math.max(2, height - 13 - chromeRows - (composerHeight - 9))}
                    enabled={!overlay}
                    keyboardEnabled={focus === "transcript"}
                  />
                  </box>
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
                        (!oneView || inChat) &&
                        !(focus === "right" && (right === "terminal" || right === "editor"))
                      }
                      collapsed={composerCollapsed}
                      compact={compact}
                      width={centerInner}
                      onRows={setComposerRows}
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
              rightTitle,
              content.right ??
                (right === "editor" ? (
                  <EditorPanel
                    session={editorSession}
                    enabled={!overlay && focus === "right"}
                    width={rightOuter("editor") - 2}
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
                    width={rightOuter("terminal") - 2}
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
                    width={rightOuter("files") - 2}
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
              { width: rightOuter(right), visible: !oneView || focus === "right" },
            )}
        </box>
        {compact ? (
          // One tappable action bar replaces the focus line and both hint rows.
          <box height={1} flexShrink={0} flexDirection="row">
            {barMessage ? (
              <text
                fg={theme.accent}
                onMouseUp={(event) => {
                  if (event.button !== 0) return;
                  setActionError("");
                  setQuitArmed(false);
                }}
              >
                {barMessage}
              </text>
            ) : (
              barItems.map((item) => (
                <box
                  key={item.label}
                  marginRight={1}
                  onMouseUp={(event) => {
                    if (event.button === 0 && !overlay) item.run();
                  }}
                >
                  <text fg={theme.accent} selectable={false}>
                    [{item.label}]
                  </text>
                </box>
              ))
            )}
          </box>
        ) : (
          <text height={1} flexShrink={0} fg={theme.accent}>
            {barMessage ||
              `Focus: ${focus}${hintsShown || hintFor("hints") === "none" ? "" : ` · ${hintFor("hints")} hints`}`}
          </text>
        )}
        {hintsShown && !compact && (
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
              setFocus("composer");
            }}
          />
        )}
        {overlay === "context" && (
          <ContextDropdown
            detail={contextDetail}
            content={contextContent}
            width={width}
            height={height}
            now={client.now}
            close={() => setOverlay(null)}
          />
        )}
        {overlay === "help" && compact && (
          // The Menu sheet: every command is a row, and tapping one runs it.
          <box
            position="absolute"
            left={0}
            top={0}
            width="100%"
            height="100%"
            border
            borderStyle="rounded"
            borderColor={theme.accent}
            backgroundColor={theme.canvas}
            title="Menu · tap a row"
            flexDirection="column"
          >
            <scrollbox scrollY scrollX={false} flexGrow={1}>
              {sheet[0]!.rows.map((row) => {
                const lines = wrapName(`${row.keys.padEnd(11)} ${row.label}`, width - 4);
                return (
                  <box
                    key={row.id}
                    flexShrink={0}
                    height={lines.length}
                    flexDirection="column"
                    onMouseUp={(event) => {
                      if (event.button === 0 && row.id) runFromSheet(row.id as Command);
                    }}
                  >
                    {lines.map((line, i) => (
                      <text key={i} height={1} fg={theme.text} selectable={false}>
                        {line}
                      </text>
                    ))}
                  </box>
                );
              })}
              <box
                flexShrink={0}
                height={1}
                onMouseUp={(event) => {
                  if (event.button === 0) runFromSheet("help");
                }}
              >
                <text fg={theme.accent} selectable={false}>
                  [ Key reference ]
                </text>
              </box>
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
        )}
        {((overlay === "help" && !compact) || overlay === "keys") && (
          <box position="absolute" left={0} top={0} width="100%" height="100%">
            <box
              position="absolute"
              left={compact ? 0 : Math.max(0, Math.floor((width - Math.min(60, width)) / 2))}
              top={
                compact
                  ? 0
                  : Math.max(
                      0,
                      Math.floor((height - 4 - Math.min(height - 4, keyLines.length + 3)) / 2),
                    )
              }
              width={compact ? width : Math.min(60, width)}
              height={compact ? height : Math.min(height - 4, keyLines.length + 3)}
              border
              borderStyle="rounded"
              borderColor={theme.accent}
              backgroundColor={theme.canvas}
              title="Keys"
              flexDirection="column"
            >
              <scrollbox scrollY scrollX={false} flexGrow={1}>
                {keyLines.map((line, i) => (
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
    </LayoutContext.Provider>
  );
}
