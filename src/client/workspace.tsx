import { theme } from "./theme";
import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { OrchestrationV2ThreadShell, VcsRef } from "@t3tools/contracts";
import type { Client } from "./runtime";
import { useClientAtom } from "./screen";
import type { createThreadActions } from "./thread-actions";

export interface WorkspaceChoice {
  branch: string | null;
  worktreePath: string | null;
}
/** Thread bindings are historical hints, not proof that a worktree still exists. */
export async function verifiedWorkspaceChoices(
  root: string,
  refs: readonly VcsRef[],
  known: readonly WorkspaceChoice[],
  status: (cwd: string) => Promise<{ isRepo: boolean; refName: string | null }>,
): Promise<WorkspaceChoice[]> {
  const live = workspaceChoices(root, refs);
  const paths = new Set(live.map((row) => row.worktreePath ?? root));
  const candidates = known.filter((row) => {
    if (!row.worktreePath || paths.has(row.worktreePath)) return false;
    paths.add(row.worktreePath);
    return true;
  });
  const checked = await Promise.all(candidates.map(async (row) => {
    try {
      const value = await status(row.worktreePath!);
      return value.isRepo ? { branch: value.refName, worktreePath: row.worktreePath } : undefined;
    } catch { return undefined; }
  }));
  return workspaceChoices(root, refs, checked.filter((row): row is WorkspaceChoice => row !== undefined));
}
export function workspaceChoices(root: string, refs: readonly VcsRef[], known: readonly WorkspaceChoice[] = []): WorkspaceChoice[] {
  const current = refs.find((ref) => ref.worktreePath === root) ?? refs.find((ref) => ref.current && !ref.worktreePath);
  const choices = new Map<string, WorkspaceChoice>();
  choices.set(root, { branch: current?.name ?? null, worktreePath: null });
  for (const row of [...refs.map((ref) => ({ branch: ref.name, worktreePath: ref.worktreePath ?? null })), ...known]) {
    if (row.worktreePath && row.worktreePath !== root && !choices.has(row.worktreePath)) choices.set(row.worktreePath, row);
  }
  return [...choices.values()];
}
/** The current project first, so Enter alone starts where you already are. */
export function projectChoices<P extends { id: string }>(
  projects: readonly P[],
  currentId: string | undefined,
): P[] {
  return [...projects].sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId));
}
/**
 * Ctrl+n: j/k or arrows pick the project, l or Enter continues. A project with other worktrees
 * then asks which one; a project with only its root creates the thread straight away. There is no
 * name prompt: the first message names the thread.
 */
export function NewThreadPicker({
  client,
  target,
  actions,
  close,
  created,
}: {
  client: Client;
  target?: OrchestrationV2ThreadShell;
  actions: ReturnType<typeof createThreadActions>;
  close: () => void;
  created?: () => void;
}) {
  const snapshot = useClientAtom(client, client.snapshot);
  const projects = projectChoices(snapshot?.projects ?? [], target?.projectId);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<(typeof projects)[number]>();
  const next = (index: number) => {
    if (projects[index]) setPicked(projects[index]);
  };
  useKeyboard((key) => {
    if (picked || key.defaultPrevented) return;
    if (key.name === "escape") {
      key.preventDefault();
      close();
    }
    if (key.name === "return" || key.name === "l") {
      key.preventDefault();
      next(cursor);
    }
    const step =
      key.name === "up" || key.name === "k" ? -1 : key.name === "down" || key.name === "j" ? 1 : 0;
    if (step) {
      key.preventDefault();
      setCursor((n) => Math.max(0, Math.min(projects.length - 1, n + step)));
    }
  });
  if (picked)
    return (
      <WorkspacePicker
        client={client}
        target={target}
        actions={actions}
        close={() => setPicked(undefined)}
        created={created ?? close}
        projectId={picked.id}
        chooseSoleRow
      />
    );
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      backgroundColor={theme.canvas}
      border
      borderColor={theme.accent}
      flexDirection="column"
    >
      <text fg={theme.accent}>New thread</text>
      <text fg={theme.muted}>Project</text>
      <scrollbox flexGrow={1} scrollY scrollX={false}>
        {projects.map((project, index) => (
          <text
            key={project.id}
            fg={index === cursor ? theme.strong : theme.text}
            bg={index === cursor ? theme.highlight : undefined}
            onMouseUp={(event) => {
              if (event.button === 0) next(index);
            }}
          >
            {`${index === cursor ? "› " : "  "}${project.title} · ${project.workspaceRoot}`}
          </text>
        ))}
        {!projects.length && (
          <text fg={theme.plain}>
            {
              "No projects on this server yet. Add one in the T3 web app or with `t3 project add <folder>`; it shows up here."
            }
          </text>
        )}
      </scrollbox>
      <text fg={theme.muted}>j/k project · l/Enter next · Esc close</text>
      <box flexDirection="row">
        <text
          fg={theme.plain}
          onMouseUp={(event) => {
            if (event.button === 0) next(cursor);
          }}
        >
          [l next]
        </text>
        <text
          fg={theme.plain}
          onMouseUp={(event) => {
            if (event.button === 0) close();
          }}
        >
          {" "}
          [Esc close]
        </text>
      </box>
    </box>
  );
}
export function WorkspacePicker({
  client,
  target,
  actions,
  close,
  created,
  projectId,
  chooseSoleRow = false,
}: {
  client: Client;
  target?: OrchestrationV2ThreadShell;
  actions: ReturnType<typeof createThreadActions>;
  close: () => void;
  /** Runs once the thread exists. Defaults to `close`. */
  created?: () => void;
  projectId?: OrchestrationV2ThreadShell["projectId"];
  /** Create without asking when the project has only its root to offer. */
  chooseSoleRow?: boolean;
}) {
  const wanted = projectId ?? target?.projectId;
  const project =
    client.registry.get(client.snapshot)?.projects.find((p) => p.id === wanted) ??
    client.registry.get(client.snapshot)?.projects[0];
  const root = project?.workspaceRoot;
  const [rows, setRows] = useState<WorkspaceChoice[]>([]);
  const [cursor, setCursor] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError("");
    if (!root) {
      setError("No project available.");
      setLoading(false);
      return;
    }
    void client
      .workspaceRefs(root)
      .then(async (refs) => {
        const choices = await verifiedWorkspaceChoices(root, refs,
          client.registry.get(client.snapshot)?.threads.filter((t) => t.projectId === project?.id) ?? [],
          (cwd) => client.git("status", { cwd, localOnly: true }));
        if (!stale) {
          setRows(choices);
          setCursor(0);
          if (chooseSoleRow && choices.length === 1) void create(choices[0]!);
        }
      })
      .catch(() => {
        // Folders outside git have no refs at all, and they can still hold a thread.
        if (!stale) {
          const projectRoot = { branch: null, worktreePath: null };
          setRows([projectRoot]);
          setError("Workspace list unavailable. r Retry, Enter uses the project root.");
          if (chooseSoleRow) void create(projectRoot);
        }
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [client, root, attempt]);
  function choose(index: number) {
    if (!loading && rows[index]) void create(rows[index]);
  }
  async function create(choice: WorkspaceChoice) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await actions.run("new", target, undefined, false, choice, projectId);
      (created ?? close)();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "";
      setError(`Thread creation failed${reason ? `: ${reason}` : ". Retry when connected."}`);
    } finally {
      setBusy(false);
    }
  }
  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    key.preventDefault();
    if ((key.name === "escape" || key.name === "h") && !busy) close();
    if (key.name === "r" && !busy) setAttempt((n) => n + 1);
    if (key.name === "up" || key.name === "k") setCursor((n) => Math.max(0, n - 1));
    if (key.name === "down" || key.name === "j") setCursor((n) => Math.min(rows.length - 1, n + 1));
    if (key.name === "return" || key.name === "l") choose(cursor);
  });
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      backgroundColor={theme.canvas}
      border
      borderColor={theme.accent}
      flexDirection="column"
    >
      <text fg={theme.accent}>New thread · choose workspace</text>
      <text fg={theme.plain}>
        {loading
          ? "Loading workspaces…"
          : busy
            ? "Creating…"
            : error || "j/k · l/Enter choose · h/Esc back · r Retry"}
      </text>
      <scrollbox flexGrow={1} scrollY scrollX={false}>
        {!loading &&
          rows.map((row, index) => (
            <text
              key={row.worktreePath ?? "root"}
              fg={index === cursor ? theme.accent : theme.text}
              onMouseUp={(event) => {
                if (event.button === 0) choose(index);
              }}
            >
              {`${index === cursor ? "› " : "  "}${row.branch ?? "Project root"} · ${row.worktreePath ?? root}`}
            </text>
          ))}
      </scrollbox>
      <box flexDirection="row">
        <text
          fg={theme.plain}
          onMouseUp={() => {
            if (!busy) setAttempt((n) => n + 1);
          }}
        >
          [r Retry]
        </text>
        <text
          fg={theme.plain}
          onMouseUp={() => {
            if (!busy) close();
          }}
        >
          {" "}
          [Esc close]
        </text>
      </box>
    </box>
  );
}
