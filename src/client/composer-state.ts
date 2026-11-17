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
/**
 * `tag` in front of a message so the agent knows which machine it was typed on. A message that
 * already starts with `<from ` is left alone, and an image-only one becomes just the tag.
 */
export function tagMessage(tag: string | undefined, text: string) {
  if (!tag || text.trimStart().startsWith("<from ")) return text;
  return text.trim() ? `${tag} ${text}` : tag;
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
  async function command(
    build: OrchestrationV2Command | (() => Promise<OrchestrationV2Command>),
    prepare?: () => Promise<void>,
  ) {
    const interrupt = typeof build !== "function" && build.type === "run.interrupt";
    if (!interrupt && client.registry.get(busy)) return false;
    if (!interrupt) client.registry.set(busy, true);
    client.registry.set(error, "");
    try {
      await prepare?.();
      await client.dispatch(typeof build === "function" ? await build() : build);
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
    /**
     * A picked file: a PNG the clipboard path would take goes as an image the model sees, anything
     * else as a file the agent can open.
     */
    attachFile(id: string, file: { name: string; mimeType: string; bytes: Uint8Array }) {
      if ((client.registry.get(images)[id]?.length ?? 0) >= 8)
        throw new Error("Send at most 8 attachments at once.");
      let type: "image" | "file" = "file";
      if (file.mimeType === "image/png")
        try {
          validateClipboardPng(file.bytes);
          type = "image";
        } catch {}
      const upload = { type, name: file.name, mimeType: file.mimeType };
      client.registry.set(images, {
        ...client.registry.get(images),
        [id]: [
          ...(client.registry.get(images)[id] ?? []),
          { key: crypto.randomUUID(), bytes: file.bytes, upload },
        ],
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
      const attachments: NonNullable<(typeof pending)[number]["uploaded"]>[] = [];
      // A thread left unnamed takes its title from the first message, as on web. The server ignores
      // the seed once the thread has messages, and a thread the user named never sends one.
      const unnamed = isUnnamedThread(client, id);
      const ok = await command(
        edit
          ? { ...base, type: "queued-run.edit", runId: edit, text }
          : async () => {
              // Looked up now, not at startup: the machine you type on can change between messages.
              const tag = await client.boundary.messageTag?.().catch(() => undefined);
              return {
                ...base,
                type: "message.dispatch" as const,
                messageId: MessageId.make(crypto.randomUUID()),
                text: tagMessage(tag, text),
                attachments,
                // The title comes from what you wrote, not from the tag.
                ...(unnamed
                  ? {
                      titleSeed: deriveThreadTitleSeed({
                        text,
                        attachments: pending.map((image) => ({
                          type: image.upload?.type ?? ("image" as const),
                          name: image.upload?.name ?? "clipboard.png",
                        })),
                      }),
                    }
                  : {}),
                createdBy: "user" as const,
                creationSource: "server" as const,
                ...(mode === "steer" ? { deliveryIntent: "steer" as const } : {}),
                dispatchMode: {
                  type: mode === "queue" ? ("queue_after_active" as const) : ("start_immediately" as const),
                },
              };
            },
        async () => {
          for (const image of pending) {
            image.uploaded ??= await client.uploadImage(image.bytes, image.upload);
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
