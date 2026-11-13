import type {
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import { emptyTranscript, receiveThread, type TranscriptState } from "./transcript-state";
import {
  mergeOlderHistoryIntoProjection,
  applyHistoryPageMeta,
} from "@t3tools/client-runtime/state/thread-history-merge";
import type {
  ThreadId,
  ServerProvider,
  ServerConfigStreamEvent,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import {
  applyShellStreamEvent,
  mergeShellSnapshotProjects,
} from "@t3tools/client-runtime/state/shell-reducer";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Atom, AtomRegistry } from "effect/reactivity";

export interface Boundary {
  terminal?: (
    token: string,
    input: import("@t3tools/contracts").TerminalAttachInput,
    receive: (event: import("@t3tools/contracts").TerminalAttachStreamEvent) => void,
    bind: (send: (op: import("./connection").TerminalOp) => void) => void,
  ) => Effect.Effect<void, unknown>;
  previews?: (
    token: string,
    threadId: ThreadId,
  ) => Effect.Effect<import("@t3tools/contracts").PreviewListResult, unknown>;
  devices?: (
    token: string,
  ) => Effect.Effect<import("@t3tools/contracts").DeviceServiceState, unknown>;
  webThreadUrl?: (threadId: string) => Effect.Effect<string, unknown>;

  workspaceRefs?: (
    token: string,
    cwd: string,
  ) => Effect.Effect<readonly import("@t3tools/contracts").VcsRef[], unknown>;
  uploadImage?: (
    token: string,
    bytes: Uint8Array,
  ) => Effect.Effect<import("@t3tools/contracts").ChatImageAttachment, unknown>;
  diffs?: {
    [K in keyof typeof import("./connection").diffMethods]: (
      token: string,
      input: Parameters<(typeof import("./connection").diffMethods)[K]>[2],
    ) => ReturnType<(typeof import("./connection").diffMethods)[K]>;
  };
  files?: {
    [K in keyof typeof import("./connection").fileMethods]: (
      token: string,
      input: Parameters<(typeof import("./connection").fileMethods)[K]>[2],
    ) => ReturnType<(typeof import("./connection").fileMethods)[K]>;
  };
  mediaUrl?: (token: string, threadId: ThreadId, path: string) => Effect.Effect<string, unknown>;
  pageUrl?: (token: string, id: string, mimeType?: string) => Effect.Effect<string, unknown>;
  answerSecret?: (
    token: string,
    input: import("@t3tools/contracts").SecretRequestAnswerInput,
  ) => Effect.Effect<unknown, unknown>;
  modelFavorites?: () => Promise<import("@t3tools/contracts").ClientSettings["favorites"]>;
  search?: (
    token: string,
    query: string,
  ) => Effect.Effect<import("@t3tools/contracts").OrchestrationSearchThreadsResult, unknown>;
  scheduleCompletion?: (callback: () => void) => () => void;
  drafts?: import("./composer-state").DraftStore;
  sendShortcut?: () => Promise<import("./composer-state").SendShortcut>;
  sidebarWorkingShelf?: () => Promise<boolean>;
  /** `defaults` from the settings file: the model and mode new threads start with. */
  newThreadDefaults?: import("./model-defaults").NewThreadDefaults;
  dispatch?: (
    token: string,
    command: import("@t3tools/contracts").OrchestrationV2Command,
  ) => Effect.Effect<unknown, unknown>;
  complete?: (
    token: string,
    cwd: string,
    prefix: string,
    query: string,
    instanceId: import("@t3tools/contracts").ProviderInstanceId,
  ) => Effect.Effect<readonly string[], unknown>;
  itemDetail?: (
    token: string,
    input: import("@t3tools/contracts").OrchestrationV2GetTurnItemInput,
  ) => Effect.Effect<import("@t3tools/contracts").OrchestrationV2GetTurnItemResult, unknown>;
  readToken: () => Effect.Effect<string | undefined, unknown>;
  issueToken: () => Effect.Effect<string, unknown>;
  wake: () => Effect.Effect<void, unknown>;
  follow: (
    token: string,
    receive: (item: OrchestrationV2ShellStreamItem) => void,
    receiveConfig: (event: ServerConfigStreamEvent) => void,
    receiveArchive: (event: import("./connection").ArchiveEvent) => void,
  ) => Effect.Effect<void, unknown>;
  followThread?: (
    token: string,
    id: ThreadId,
    receive: (item: OrchestrationV2ThreadStreamItem) => void,
  ) => Effect.Effect<void, unknown>;
  historyPage?: (
    token: string,
    id: ThreadId,
    cursor: string,
  ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, unknown>;
  pause: () => Effect.Effect<void>;
}
export type Status = "connecting" | "live" | "retry" | "rejected";
/** Shown when the server sends something this tercet cannot decode, most likely a newer T3. */
export const UNREADABLE_SERVER =
  "The server sent data this tercet cannot read (a newer T3?). Retrying… (r: retry; `tercet doctor` shows versions)";
export const UNREADABLE_THREAD =
  "This thread has data this tercet cannot read (a newer T3?). Open it in Web, or retry (r).";
export function isRejected(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "EnvironmentAuthInvalidError" || error._tag === "EnvironmentAuthRequiredError")
  );
}

/** One registry and scoped session supervisor per TUI; all I/O is replaceable. */
export function createClient(
  boundary: Boundary,
  managedToken: boolean,
  now: () => number = Date.now,
) {
  const registry = AtomRegistry.make();
  const runtime = ManagedRuntime.make(Layer.empty);
  const status = Atom.make<Status>("connecting").pipe(Atom.keepAlive);
  const snapshot = Atom.make<OrchestrationV2ShellSnapshot | null>(null).pipe(Atom.keepAlive);
  const archives = Atom.make<readonly import("@t3tools/contracts").OrchestrationV2ThreadShell[]>(
    [],
  ).pipe(Atom.keepAlive);
  const modelPreferences = Atom.make<
    Pick<import("@t3tools/contracts").ServerSettings, "favorites" | "providerModelPreferences">
  >({ favorites: null, providerModelPreferences: null }).pipe(Atom.keepAlive);
  const newModelSelection = Atom.make<import("@t3tools/contracts").ModelSelection | null>(
    null,
  ).pipe(Atom.keepAlive);
  const newRuntimeMode = Atom.make<import("@t3tools/contracts").RuntimeMode | null>(null).pipe(
    Atom.keepAlive,
  );
  const providers = Atom.make<readonly ServerProvider[]>([]).pipe(Atom.keepAlive);
  const message = Atom.make("").pipe(Atom.keepAlive);
  const threadCount = Atom.make((get) => get(snapshot)?.threads.length ?? 0);
  const selectedThreadId = Atom.make<ThreadId | null>(null).pipe(Atom.keepAlive);
  /** The agent view's thread: followed like the selection but never selected, so no sidebar row. */
  const viewedThreadId = Atom.make<ThreadId | null>(null).pipe(Atom.keepAlive);
  const visitedThreads = Atom.make<ReadonlyMap<string, number>>(new Map()).pipe(Atom.keepAlive);
  const transcripts = Atom.make<ReadonlyMap<string, TranscriptState>>(new Map()).pipe(
    Atom.keepAlive,
  );
  const getThread = (id: string) => registry.get(transcripts).get(id) ?? emptyTranscript;
  const setThread = (id: string, state: TranscriptState) =>
    registry.set(transcripts, new Map(registry.get(transcripts)).set(id, state));
  const pageFibers = new Map<string, ReturnType<typeof runtime.runFork>>();
  /**
   * Follows one thread's stream into `transcripts`, replacing `previous`. The selected thread and
   * the agent view's thread each own a fiber, so opening an agent never changes the selection.
   */
  const followInto = (
    id: ThreadId | null,
    previous: ReturnType<typeof runtime.runFork> | undefined,
  ) =>
    runtime.runFork(
      Effect.gen(function* () {
        if (previous) yield* Fiber.interrupt(previous);
        if (!id || !token || !boundary.followThread) return;
        yield* boundary
          .followThread(token, id, (item) => setThread(id, receiveThread(getThread(id), item)))
          .pipe(
            Effect.catch(() =>
              Effect.sync(() =>
                setThread(id, { ...getThread(id), error: "Transcript disconnected. Retry (r)." }),
              ),
            ),
            // A stream item that fails to decode (a newer server's new field value) is a defect
            // in effect's RPC client, not a failure; without this the fiber dies silently.
            Effect.catchDefect(() =>
              Effect.sync(() => setThread(id, { ...getThread(id), error: UNREADABLE_THREAD })),
            ),
          );
      }),
    );
  let threadFiber: ReturnType<typeof runtime.runFork> | undefined;
  let viewFiber: ReturnType<typeof runtime.runFork> | undefined;
  const select = () => {
    threadFiber = followInto(registry.get(selectedThreadId), threadFiber);
  };
  const selectViewed = () => {
    viewFiber = followInto(registry.get(viewedThreadId), viewFiber);
  };
  const stopSelection = registry.subscribe(selectedThreadId, select);
  const stopViewed = registry.subscribe(viewedThreadId, selectViewed);
  const finalizers = new Set<() => Promise<unknown>>();
  let token: string | undefined;
  let refreshed = false;
  let started = false;
  const receive = (item: OrchestrationV2ShellStreamItem) => {
    const previous = registry.get(snapshot);
    if (item.kind === "snapshot")
      registry.set(
        snapshot,
        mergeShellSnapshotProjects(
          previous,
          item.snapshot,
          item.resolvedRepositoryIdentityRoots === undefined
            ? undefined
            : { resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots },
        ),
      );
    else if (previous && item.kind !== "synchronized" && item.kind !== "snapshot-required")
      registry.set(snapshot, applyShellStreamEvent(previous, item));
    else return;
    refreshed = false;
    registry.set(message, "");
    registry.set(status, "live");
  };
  const receiveConfig = (event: ServerConfigStreamEvent) => {
    if (event.type === "snapshot") {
      registry.set(providers, event.config.providers);
      registry.set(modelPreferences, event.config.settings);
    }
    if (event.type === "settingsUpdated") registry.set(modelPreferences, event.payload.settings);
    if (event.type === "providerStatuses") registry.set(providers, event.payload.providers);
  };
  const attempt = Effect.gen(function* () {
    registry.set(status, "connecting");
    // Document request also wakes the local autostart holder, if present.
    yield* boundary.wake();
    token ??= yield* boundary.readToken();
    if (!token) {
      if (!managedToken) return yield* Effect.fail({ _tag: "EnvironmentAuthInvalidError" });
      token = yield* boundary.issueToken();
    }
    select();
    selectViewed();
    yield* boundary
      .follow(token, receive, receiveConfig, (event) => {
        const previous = registry.get(archives);
        registry.set(
          archives,
          event.kind === "snapshot"
            ? event.snapshot.threads
            : event.kind === "thread.updated"
              ? [...previous.filter((t) => t.id !== event.thread.id), event.thread]
              : previous.filter((t) => t.id !== event.threadId),
        );
      })
      .pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            Effect.all([
              threadFiber ? Fiber.interrupt(threadFiber) : Effect.void,
              viewFiber ? Fiber.interrupt(viewFiber) : Effect.void,
            ]).pipe(Effect.asVoid),
          ),
        ),
      );
    return yield* Effect.fail(new Error("Connection ended"));
  });
  const cycle = attempt.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const rejected = isRejected(error);
        registry.set(status, rejected ? "rejected" : "retry");
        // Do not place raw RPC/CLI errors (which may contain credentials) in atoms or logs.
        registry.set(
          message,
          rejected
            ? "Token rejected. Retry with a fresh token file (r)."
            : "Server unavailable. Retrying… (r: retry)",
        );
        if (rejected && managedToken && !refreshed) {
          refreshed = true;
          token = yield* boundary.issueToken().pipe(Effect.catch(() => Effect.succeed(undefined)));
        } else if (rejected) {
          token = undefined;
        }
      }),
    ),
    // See followInto: an undecodable shell item would otherwise end the reconnect loop for good.
    Effect.catchDefect(() =>
      Effect.sync(() => {
        registry.set(status, "retry");
        registry.set(message, UNREADABLE_SERVER);
      }),
    ),
  );
  const loop = Effect.forever(cycle.pipe(Effect.andThen(() => boundary.pause())));
  let fiber: ReturnType<typeof runtime.runFork> | undefined;
  return {
    workspaceRefs(cwd: string) {
      if (!token || !boundary.workspaceRefs) return Promise.reject(new Error("Offline"));
      return runtime.runPromise(boundary.workspaceRefs(token, cwd));
    },
    uploadImage(bytes: Uint8Array) {
      if (!token || !boundary.uploadImage) return Promise.reject(new Error("Offline"));
      return runtime.runPromise(boundary.uploadImage(token, bytes));
    },
    get terminalAvailable() {
      return !!boundary.terminal;
    },
    /** Attaches to a thread's shell. `done` fires once when the stream ends or fails. */
    terminal(
      input: import("@t3tools/contracts").TerminalAttachInput,
      receive: (event: import("@t3tools/contracts").TerminalAttachStreamEvent) => void,
      done: (error?: unknown) => void,
    ) {
      let send = (_op: import("./connection").TerminalOp) => {};
      if (!token || !boundary.terminal) {
        done(new Error("Offline"));
        return { send, stop() {} };
      }
      const fiber = runtime.runFork(
        boundary
          .terminal(token, input, receive, (bound) => {
            send = bound;
          })
          .pipe(Effect.match({ onFailure: done, onSuccess: () => done() })),
      );
      return {
        send: (op: import("./connection").TerminalOp) => send(op),
        stop: () => void runtime.runFork(Fiber.interrupt(fiber)),
      };
    },
    previews(threadId: ThreadId) {
      if (!token || !boundary.previews) return Promise.reject(new Error("Previews unavailable"));
      return runtime.runPromise(boundary.previews(token, threadId));
    },
    devices() {
      if (!token || !boundary.devices) return Promise.reject(new Error("Devices unavailable"));
      return runtime.runPromise(boundary.devices(token));
    },
    webThreadUrl(threadId: string) {
      if (!boundary.webThreadUrl) return Promise.reject(new Error("Web unavailable"));
      return runtime.runPromise(boundary.webThreadUrl(threadId));
    },
    mediaUrl(path: string) {
      const threadId = registry.get(selectedThreadId);
      if (!token || !threadId || !boundary.mediaUrl) return Promise.reject(new Error("Offline"));
      return runtime.runPromise(boundary.mediaUrl(token, threadId, path));
    },
    pageUrl(id: string, mimeType?: string) {
      if (!token || !boundary.pageUrl) return Promise.reject(new Error("Offline"));
      return runtime.runPromise(boundary.pageUrl(token, id, mimeType));
    },
    diffs: {
      full(input: import("@t3tools/contracts").OrchestrationGetFullThreadDiffInput) {
        if (!token || !boundary.diffs) return Promise.reject(new Error("Offline"));
        return runtime.runPromise(boundary.diffs.full(token, input));
      },
      turn(input: import("@t3tools/contracts").OrchestrationGetTurnDiffInput) {
        if (!token || !boundary.diffs) return Promise.reject(new Error("Offline"));
        return runtime.runPromise(boundary.diffs.turn(token, input));
      },
    },
    files: {
      list(input: import("@t3tools/contracts").ProjectListEntriesInput) {
        if (!token || !boundary.files)
          return Promise.reject(new Error("Files unavailable; reconnect and retry"));
        return runtime.runPromise(boundary.files.list(token, input));
      },
      find(input: import("@t3tools/contracts").ProjectSearchEntriesInput) {
        if (!token || !boundary.files)
          return Promise.reject(new Error("Files unavailable; reconnect and retry"));
        return runtime.runPromise(boundary.files.find(token, input));
      },
      search(input: import("@t3tools/contracts").ProjectSearchContentsInput) {
        if (!token || !boundary.files)
          return Promise.reject(new Error("Files unavailable; reconnect and retry"));
        return runtime.runPromise(boundary.files.search(token, input));
      },
      read(input: import("@t3tools/contracts").ProjectReadFileInput) {
        if (!token || !boundary.files)
          return Promise.reject(new Error("Files unavailable; reconnect and retry"));
        return runtime.runPromise(boundary.files.read(token, input));
      },
    },
    answerSecret(input: import("@t3tools/contracts").SecretRequestAnswerInput) {
      if (!token || !boundary.answerSecret) return Promise.reject(new Error("Offline"));
      return runtime.runPromise(boundary.answerSecret(token, input));
    },
    archives,
    newModelSelection,
    newRuntimeMode,
    modelPreferences,
    boundary,
    search(query: string) {
      if (!token || !boundary.search) return Promise.reject(new Error("Search unavailable"));
      return runtime.runPromise(boundary.search(token, query));
    },
    addFinalizer(finalizer: () => Promise<unknown>) {
      finalizers.add(finalizer);
    },
    dispatch(command: import("@t3tools/contracts").OrchestrationV2Command) {
      if (!token || !boundary.dispatch) return Promise.reject(new Error("Offline"));
      return runtime.runPromise(boundary.dispatch(token, command));
    },
    complete(
      cwd: string,
      prefix: string,
      query: string,
      instanceId: import("@t3tools/contracts").ProviderInstanceId,
    ) {
      if (!token || !boundary.complete) return Promise.resolve([] as readonly string[]);
      return runtime.runPromise(boundary.complete(token, cwd, prefix, query, instanceId));
    },
    registry,
    runtime,
    status,
    snapshot,
    providers,
    now,
    message,
    threadCount,
    selectedThreadId,
    viewedThreadId,
    visitedThreads,
    transcripts,
    getThread,
    fetchItem(input: import("@t3tools/contracts").OrchestrationV2GetTurnItemInput) {
      if (!token || !boundary.itemDetail) return Promise.reject(new Error("Detail unavailable"));
      return runtime.runPromise(boundary.itemDetail(token, input));
    },
    loadEarlier(id: ThreadId) {
      const state = getThread(id);
      const cursor = state.history.historyCursor;
      if (!token || !cursor || state.history.loading || !boundary.historyPage) return;
      setThread(id, { ...state, history: { ...state.history, loading: true, error: null } });
      const pageFiber = runtime.runFork(
        boundary.historyPage(token, id, cursor).pipe(
          Effect.tap((page) =>
            Effect.sync(() => {
              const latest = getThread(id);
              if (latest.history.historyCursor !== cursor || !latest.projection) return;
              setThread(id, {
                ...latest,
                projection: mergeOlderHistoryIntoProjection(latest.projection, page.items),
                history: applyHistoryPageMeta(latest.history, page),
              });
            }),
          ),
          Effect.catch(() =>
            Effect.sync(() => {
              const latest = getThread(id);
              if (latest.history.historyCursor === cursor)
                setThread(id, {
                  ...latest,
                  history: {
                    ...latest.history,
                    loading: false,
                    error: "History unavailable. Retry earlier.",
                  },
                });
            }),
          ),
        ),
      );
      pageFibers.set(id, pageFiber);
    },
    /** Streams a child thread for the agent view; `null` stops it. */
    viewThread(id: ThreadId | null) {
      registry.set(viewedThreadId, id);
    },
    openThread(id: ThreadId) {
      registry.set(selectedThreadId, id);
      registry.set(visitedThreads, new Map(registry.get(visitedThreads)).set(id, now()));
    },
    start() {
      if (started) return;
      started = true;
      fiber = runtime.runFork(loop);
    },
    async retry() {
      if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
      token = undefined;
      refreshed = false;
      fiber = runtime.runFork(loop);
      started = true;
    },
    async dispose() {
      stopSelection();
      stopViewed();
      if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
      if (threadFiber) await Effect.runPromise(Fiber.interrupt(threadFiber));
      if (viewFiber) await Effect.runPromise(Fiber.interrupt(viewFiber));
      for (const pageFiber of pageFibers.values())
        await Effect.runPromise(Fiber.interrupt(pageFiber));
      pageFibers.clear();
      for (const finalizer of finalizers) await finalizer();
      finalizers.clear();
      await runtime.dispose();
      registry.dispose();
    },
  };
}
export type Client = ReturnType<typeof createClient>;

export function waitForLive(client: Client, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Connection did not become live"));
    }, timeoutMs);
    const unsubscribe = client.registry.subscribe(client.status, (value) => {
      if (value === "live") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
    if (client.registry.get(client.status) === "live") {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}
