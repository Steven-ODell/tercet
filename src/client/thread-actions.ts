import {
  CommandId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { Client } from "./runtime";

import { defaultSelection, runtimeModeFor, selectionFor } from "./model-defaults";

export const DEFAULT_THREAD_TITLE = "New thread";

// Threads this client just created with no name. A new thread can take a moment to reach the shell
// snapshot, and a first message sent in that gap must still seed its title.
const createdUnnamed = new WeakMap<Client, Set<string>>();

/** True when the thread still has the default title, so its first message should seed a name. */
export function isUnnamedThread(client: Client, id: string) {
  const shell = client.registry.get(client.snapshot)?.threads.find((thread) => thread.id === id);
  return shell ? shell.title === DEFAULT_THREAD_TITLE : !!createdUnnamed.get(client)?.has(id);
}
export const threadActions = [
  "new",
  "settle",
  "unsettle",
  "pin",
  "unpin",
  "rename",
  "archive",
  "unarchive",
  "fork",
  "parent",
  "delete",
] as const;
export type ThreadAction = (typeof threadActions)[number];
export function allThreads(client: Client) {
  const snapshot = client.registry.get(client.snapshot);
  return [
    ...new Map(
      [
        ...(snapshot?.archivedThreads ?? []),
        ...client.registry.get(client.archives),
        ...(snapshot?.threads ?? []),
      ].map((t) => [t.id, t]),
    ).values(),
  ];
}
/** Subsequence scoring keeps title and action filtering useful with abbreviated queries. */
export function fuzzyScore(text: string, query: string) {
  let cursor = 0;
  let score = 0;
  const lower = text.toLowerCase();
  for (const char of query.toLowerCase().trim()) {
    const index = lower.indexOf(char, cursor);
    if (index < 0) return -1;
    score += index === cursor ? 3 : 1;
    cursor = index + 1;
  }
  return score;
}
export function createThreadActions(client: Client) {
  let busy = false;
  let undo: OrchestrationV2Command | undefined;
  const commandId = () => CommandId.make(crypto.randomUUID());
  return {
    async undo() {
      if (!undo || busy) return;
      busy = true;
      try {
        await client.dispatch({ ...undo, commandId: commandId() });
        undo = undefined;
      } finally {
        busy = false;
      }
    },
    async run(
      action: ThreadAction,
      thread?: OrchestrationV2ThreadShell,
      title?: string,
      confirmed = false,
      workspace?: import("./workspace").WorkspaceChoice,
      projectId?: OrchestrationV2ThreadShell["projectId"],
    ) {
      if (busy) throw new Error("Wait for the current action");
      const id = thread?.id;
      if (action !== "new" && !thread) throw new Error("Select a thread first");
      if (action === "delete" && !confirmed) throw new Error("Confirm permanent deletion first");
      const base = { commandId: commandId(), threadId: id! };
      let command: OrchestrationV2Command;
      let reverse: OrchestrationV2Command | undefined;
      let open: ThreadId | undefined;
      if (action === "parent") {
        const parent = thread!.lineage.parentThreadId;
        if (!parent) throw new Error("This thread has no parent");
        client.openThread(parent);
        return;
      }
      if (action === "new") {
        const wanted = projectId ?? thread?.projectId;
        const project =
          client.registry.get(client.snapshot)?.projects.find((p) => p.id === wanted) ??
          client.registry.get(client.snapshot)?.projects[0];
        if (!project) throw new Error("No project available");
        open = ThreadId.make(crypto.randomUUID());
        const providers = client.registry.get(client.providers);
        const defaults = client.boundary.newThreadDefaults;
        const initialSelection =
          client.registry.get(client.newModelSelection) ??
          defaultSelection(providers, defaults) ??
          thread?.modelSelection ??
          project.defaultModelSelection ??
          // No selected thread and no project default: reuse what the project's threads already use.
          client.registry.get(client.snapshot)?.threads.find((t) => t.projectId === project.id)
            ?.modelSelection;
        const fallback = providers.find(
          (p) =>
            p.enabled &&
            p.status !== "disabled" &&
            p.status !== "error" &&
            p.availability !== "unavailable" &&
            p.supportsTextGeneration !== false &&
            p.models.length,
        );
        const seed =
          initialSelection ??
          (fallback && { instanceId: fallback.instanceId, model: fallback.models[0]!.slug });
        if (!seed) throw new Error("No model available. Enable a provider first");
        const provider = providers.find((p) => p.instanceId === seed.instanceId);
        const model = provider?.models.find((m) => m.slug === seed.model);
        const modelSelection = provider && model ? selectionFor(provider, model) : seed;
        command = {
          ...base,
          type: "thread.create",
          threadId: open,
          projectId: project.id,
          title: title?.trim() || DEFAULT_THREAD_TITLE,
          modelSelection,
          runtimeMode: provider ? runtimeModeFor(provider, defaults?.mode) : "approval-required",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
          branch: workspace?.branch ?? null,
          worktreePath: workspace?.worktreePath ?? null,
        };
        reverse = { ...base, type: "thread.archive", threadId: open };
      } else if (action === "fork") {
        const run = client
          .getThread(id!)
          .projection?.runs.findLast((run) => run.status === "completed");
        if (!run)
          throw new Error("Fork needs a completed run; open the thread and wait for history");
        open = ThreadId.make(crypto.randomUUID());
        command = {
          commandId: base.commandId,
          type: "thread.fork",
          sourceThreadId: id!,
          targetThreadId: open,
          sourcePoint: { type: "run", runId: run.id },
          title: `${thread!.title} (fork)`,
          createdBy: "user",
          creationSource: "web",
        };
        reverse = { ...base, type: "thread.archive", threadId: open };
      } else if (action === "rename") {
        if (!title?.trim()) throw new Error("Enter a title");
        command = { ...base, type: "thread.metadata.update", title: title.trim() };
        reverse = { ...base, type: "thread.metadata.update", title: thread!.title };
      } else {
        command =
          action === "unsettle"
            ? { ...base, type: "thread.unsettle", reason: "user" }
            : { ...base, type: `thread.${action}` };
        if (action === "settle") reverse = { ...base, type: "thread.unsettle", reason: "user" };
        if (action === "unsettle") reverse = { ...base, type: "thread.settle" };
        if (action === "pin") reverse = { ...base, type: "thread.unpin" };
        if (action === "unpin") reverse = { ...base, type: "thread.pin" };
        if (action === "archive") reverse = { ...base, type: "thread.unarchive" };
        if (action === "unarchive") reverse = { ...base, type: "thread.archive" };
      }
      busy = true;
      try {
        await client.dispatch(command);
        undo = reverse;
        if (open && command.type === "thread.create" && command.title === DEFAULT_THREAD_TITLE) {
          const ids = createdUnnamed.get(client) ?? new Set<string>();
          ids.add(open);
          createdUnnamed.set(client, ids);
        }
        if (open) client.openThread(open);
        if (action === "delete" && client.registry.get(client.selectedThreadId) === id)
          client.registry.set(client.selectedThreadId, null);
        return open;
      } finally {
        busy = false;
      }
    },
  };
}
