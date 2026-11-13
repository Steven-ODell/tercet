import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type RunId,
  type ThreadId,
  type ClientSettings,
} from "@t3tools/contracts";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { validateClipboardPng, type PendingImage } from "./image";
import { Atom } from "effect/reactivity";
import type { Client } from "./runtime";
import { isUnnamedThread } from "./thread-actions";

export interface DraftStore {
  read(): Promise<Record<string, string>>;
  write(drafts: Record<string, string>): Promise<void>;
}
export type SendShortcut = ClientSettings["sendShortcut"];
export function requiresModifier(shortcut: SendShortcut, text: string) {
  return shortcut === "mod-enter" || (shortcut === "mod-enter-multiline" && /[\r\n]/.test(text));
}
export function completionTrigger(text: string, cursor: number) {
  const match = /(?:^|\s)([@/:])([^\s]*)$/.exec(text.slice(0, cursor));
  return match
    ? { prefix: match[1]!, query: match[2]!, start: cursor - match[2]!.length - 1, end: cursor }
    : null;
}
export function createComposer(client: Client, storage?: DraftStore) {
  const images = Atom.make<Record<string, readonly PendingImage[]>>({}).pipe(Atom.keepAlive);
  const drafts = Atom.make<Record<string, string>>({}).pipe(Atom.keepAlive);
  const error = Atom.make("").pipe(Atom.keepAlive);
  const busy = Atom.make(false).pipe(Atom.keepAlive);
  const shortcut = Atom.make<SendShortcut>("enter").pipe(Atom.keepAlive);
  let writes = Promise.resolve();
  let lastSaved: Record<string, string> | undefined;
  const ready =
    storage
      ?.read()
      .then((saved) => {
        client.registry.set(drafts, { ...saved, ...client.registry.get(drafts) });
      })
      .catch(() => client.registry.set(error, "Drafts could not be loaded.")) ?? Promise.resolve();
  client.addFinalizer(() => writes.then(() => ready));
  function setDraft(id: string, text: string) {
    client.registry.set(drafts, { ...client.registry.get(drafts), [id]: text });
    if (!storage) return;
    writes = writes
      .then(() => ready)
      .then(async () => {
        const latest = client.registry.get(drafts);
        if (latest !== lastSaved) {
          await storage?.write(latest);
          lastSaved = latest;
        }
      })
      .catch(() => {
        client.registry.set(error, "Draft could not be saved.");
      });
  }
  async function command(command: OrchestrationV2Command, prepare?: () => Promise<void>) {
    const interrupt = command.type === "run.interrupt";
    if (!interrupt && client.registry.get(busy)) return false;
    if (!interrupt) client.registry.set(busy, true);
    client.registry.set(error, "");
    try {
      await prepare?.();
      await client.dispatch(command);
      return true;
    } catch {
      client.registry.set(error, "Command failed. Draft kept; retry when connected.");
      return false;
    } finally {
      if (!interrupt) client.registry.set(busy, false);
    }
  }
  function runs(id: string) {
    return client.getThread(id).projection?.runs ?? [];
  }
  const active = (id: string) =>
    runs(id).findLast((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    );
  return {
    images,
    attach(id: string, bytes: Uint8Array) {
      validateClipboardPng(bytes);
      if ((client.registry.get(images)[id]?.length ?? 0) >= 8)
        throw new Error("Send at most 8 clipboard images at once.");
      client.registry.set(images, {
        ...client.registry.get(images),
        [id]: [...(client.registry.get(images)[id] ?? []), { key: crypto.randomUUID(), bytes }],
      });
    },
    removeImage(id: string, key: string) {
      if (client.registry.get(busy)) return;
      client.registry.set(images, {
        ...client.registry.get(images),
        [id]: (client.registry.get(images)[id] ?? []).filter((image) => image.key !== key),
      });
    },
    drafts,
    error,
    busy,
    shortcut,
    ready,
    setDraft,
    active,
    queued: (id: string) =>
      runs(id)
        .filter((run) => run.status === "queued")
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0)),
    flush: () => writes,
    async send(id: ThreadId, alternate = false, edit?: RunId) {
      const text = client.registry.get(drafts)[id] ?? "";
      const pending = client.registry.get(images)[id] ?? [];
      if (!text.trim() && !pending.length) return false;
      if (edit && pending.length) {
        client.registry.set(error, "Leave queued edit before sending images.");
        return false;
      }
      const mode = resolveComposerDispatchMode({
        running: !!active(id),
        alternateModifier: alternate,
        activeTurnDefault: "queue",
      });
      const base = { commandId: CommandId.make(crypto.randomUUID()), threadId: id };
      const attachments: import("@t3tools/contracts").ChatImageAttachment[] = [];
      // A thread left unnamed takes its title from the first message, as on web. The server ignores
      // the seed once the thread has messages, and a thread the user named never sends one.
      const unnamed = isUnnamedThread(client, id);
      const ok = await command(
        edit
          ? { ...base, type: "queued-run.edit", runId: edit, text }
          : {
              ...base,
              type: "message.dispatch",
              messageId: MessageId.make(crypto.randomUUID()),
              text,
              attachments,
              ...(unnamed
                ? {
                    titleSeed: deriveThreadTitleSeed({
                      text,
                      attachments: pending.map(() => ({ type: "image" as const, name: "clipboard.png" })),
                    }),
                  }
                : {}),
              createdBy: "user",
              creationSource: "server",
              ...(mode === "steer" ? { deliveryIntent: "steer" as const } : {}),
              dispatchMode: { type: mode === "queue" ? "queue_after_active" : "start_immediately" },
            },
        async () => {
          for (const image of pending) {
            image.uploaded ??= await client.uploadImage(image.bytes);
            attachments.push(image.uploaded);
          }
        },
      );
      if (ok)
        client.registry.set(images, {
          ...client.registry.get(images),
          [id]: (client.registry.get(images)[id] ?? []).filter((image) => !pending.includes(image)),
        });
      if (ok && client.registry.get(drafts)[id] === text) setDraft(id, "");
      return ok;
    },
    stop(id: ThreadId) {
      const run = active(id);
      return run
        ? command({
            type: "run.interrupt",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId: id,
            runId: run.id,
            holdQueue: true,
          })
        : Promise.resolve(false);
    },
    /** Steers a queued message into the running turn instead of waiting for it to finish. */
    promote(id: ThreadId, runId: RunId) {
      const target = active(id);
      if (!target) {
        client.registry.set(error, "Nothing is running to steer.");
        return Promise.resolve(false);
      }
      return command({
        type: "queued-message.promote-to-steer",
        commandId: CommandId.make(crypto.randomUUID()),
        threadId: id,
        queuedRunId: runId,
        targetRunId: target.id,
      });
    },
    cancel(id: ThreadId, runId: RunId) {
      return command({
        type: "queued-run.cancel",
        commandId: CommandId.make(crypto.randomUUID()),
        threadId: id,
        runId,
      });
    },
  };
}
