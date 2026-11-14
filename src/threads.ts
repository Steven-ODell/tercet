import * as DateTime from "effect/DateTime";
import type { OrchestrationV2ShellSnapshot, OrchestrationV2ThreadShell } from "@t3tools/contracts";

/**
 * What `tercet list` and `tercet tmux` know about a thread. Pure: built from the shell snapshot,
 * so the commands and their tests share one definition of "active" and one JSON shape.
 */
export type ThreadState = "running" | "waiting" | "failed" | "limited" | "idle";

export interface ThreadRow {
  id: string;
  /** The first eight characters of `id`; `tercet attach` accepts it. */
  shortId: string;
  title: string;
  project: string;
  projectId: string;
  state: ThreadState;
  pinned: boolean;
  archived: boolean;
  provider: string;
  model: string;
  branch: string | null;
  updatedAt: string;
}

const LIVE = new Set(["preparing", "queued", "starting", "running"]);

/** The same reading of a shell as the sidebar badge (`threadBadge`), without the unread dot. */
export function threadState(thread: OrchestrationV2ThreadShell): ThreadState {
  if (thread.lastErrorClass === "usage_limit") return "limited";
  const status = thread.activityRunStatus ?? thread.status;
  if (thread.pendingRuntimeRequest || status === "waiting") return "waiting";
  if (status === "failed") return "failed";
  if (LIVE.has(status)) return "running";
  return "idle";
}

/** A thread that needs a window in `tercet tmux`: working, or stopped on a question. */
export const isActive = (state: ThreadState) => state === "running" || state === "waiting";

const iso = (at: DateTime.Utc) => new Date(DateTime.toEpochMillis(at)).toISOString();

export function threadRows(
  snapshot: Pick<OrchestrationV2ShellSnapshot, "threads" | "projects">,
  options: { all?: boolean } = {},
): ThreadRow[] {
  const projects = new Map(snapshot.projects.map((project) => [String(project.id), project.title]));
  return snapshot.threads
    .filter(
      (thread) =>
        !thread.deletedAt &&
        thread.lineage.relationshipToParent !== "subagent" &&
        (options.all || thread.archivedAt === null),
    )
    .map((thread) => ({
      id: String(thread.id),
      shortId: String(thread.id).slice(0, 8),
      title: thread.title,
      project: projects.get(String(thread.projectId)) ?? String(thread.projectId),
      projectId: String(thread.projectId),
      state: threadState(thread),
      pinned: thread.pinnedAt != null,
      archived: thread.archivedAt !== null,
      provider: String(thread.providerInstanceId),
      model: String(thread.modelSelection.model),
      branch: thread.branch,
      updatedAt: iso(thread.updatedAt),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type Resolved =
  | { kind: "found"; row: ThreadRow }
  | { kind: "none" }
  | { kind: "ambiguous"; rows: ThreadRow[] };

/** An id, a unique id prefix (the short id), or a unique piece of the title (any case). */
export function resolveThread(rows: readonly ThreadRow[], query: string): Resolved {
  const q = query.trim();
  if (!q) return { kind: "none" };
  const exact = rows.find((row) => row.id === q);
  if (exact) return { kind: "found", row: exact };
  const lower = q.toLowerCase();
  for (const matches of [
    rows.filter((row) => row.id.toLowerCase().startsWith(lower)),
    rows.filter((row) => row.title.toLowerCase().includes(lower)),
  ]) {
    if (matches.length === 1) return { kind: "found", row: matches[0]! };
    if (matches.length > 1) return { kind: "ambiguous", rows: matches };
  }
  return { kind: "none" };
}

/** The plain table `tercet list` prints: id, state, project, title; the title is never cut. */
export function formatTable(rows: readonly ThreadRow[]): string {
  if (!rows.length) return "No threads.";
  const cell = (text: string, width: number) => text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)));
  const stateWidth = Math.max(5, ...rows.map((row) => row.state.length));
  const projectWidth = Math.min(24, Math.max(7, ...rows.map((row) => Bun.stringWidth(row.project))));
  const head = `${cell("ID", 8)}  ${cell("STATE", stateWidth)}  ${cell("PROJECT", projectWidth)}  TITLE`;
  const lines = rows.map((row) => {
    const project = Bun.stringWidth(row.project) > projectWidth ? `${row.project.slice(0, projectWidth - 1)}…` : row.project;
    return `${cell(row.shortId, 8)}  ${cell(row.state, stateWidth)}  ${cell(project, projectWidth)}  ${row.pinned ? "◆ " : ""}${row.title.replace(/\s+/g, " ")}`;
  });
  return [head, ...lines].join("\n");
}
