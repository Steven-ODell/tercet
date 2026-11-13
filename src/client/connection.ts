import { threadWebUrl } from "../actions";
import {
  ORCHESTRATION_V2_WS_METHODS as RPC,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
  type ServerConfigStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  orchestrationProtocolCompatibilityError,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import { RpcSessionFactory, layer } from "@t3tools/client-runtime/rpc/session";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Socket from "effect/socket/Socket";

/** Scoped sessions retain shared protocol checks, ticket auth and shell codecs. */
function withConnection<A, E>(
  url: string,
  token: string,
  use: (
    session: Effect.Success<ReturnType<RpcSessionFactory["Service"]["connect"]>>,
  ) => Effect.Effect<A, E, import("effect/Scope").Scope>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: url });
      const incompatible = orchestrationProtocolCompatibilityError(descriptor);
      if (incompatible) return yield* incompatible;
      const socketUrl = new URL(
        yield* resolveRemoteWebSocketConnectionUrl({
          httpBaseUrl: url,
          wsBaseUrl: url.replace(/^http/, "ws"),
          bearerToken: token,
          connectionMethod: "direct",
        }),
      );
      socketUrl.searchParams.set("orchestrationProtocol", "2");
      const factory = yield* RpcSessionFactory;
      const session = yield* factory.connect({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: url,
        socketUrl: socketUrl.toString(),
        httpAuthorization: { _tag: "Bearer", token },
        target: new BearerConnectionTarget({
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          connectionId: "tercet",
        }),
      });
      yield* session.ready;
      return yield* Effect.raceFirst(use(session), session.closed);
    }),
  ).pipe(
    Effect.provide(layer({})),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(Socket.WebSocketConstructor, (url) => new WebSocket(url)),
  );
}

/** What tercet keeps of archived threads: a snapshot, then per-thread moves in and out. */
export type ArchiveEvent =
  | { kind: "snapshot"; snapshot: { threads: readonly OrchestrationV2ThreadShell[] } }
  | { kind: "thread.updated"; thread: OrchestrationV2ThreadShell }
  | { kind: "thread.removed"; threadId: ThreadId };

export function followShell(
  url: string,
  token: string,
  receive: (item: OrchestrationV2ShellStreamItem) => void,
  receiveConfig: (event: ServerConfigStreamEvent) => void = () => {},
  receiveArchive: (event: ArchiveEvent) => void = () => {},
) {
  return withConnection(url, token, (session) =>
    Effect.gen(function* () {
      // Upstream has no archive stream: load the archive once, then follow moves in the shell
      // stream, whose thread events say which list ("active" or "archive") they belong to.
      yield* session.client[RPC.getArchivedShellSnapshot]({}).pipe(
        Effect.flatMap((snapshot) =>
          Effect.sync(() => receiveArchive({ kind: "snapshot", snapshot })),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* session.client[WS_METHODS.subscribeServerConfig]({}).pipe(
        Stream.runForEach((event) => Effect.sync(() => receiveConfig(event))),
        Effect.forkScoped,
      );
      yield* session.client[RPC.subscribeShell]({}).pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            if (item.kind === "thread.updated")
              receiveArchive(
                item.location === "archive"
                  ? { kind: "thread.updated", thread: item.thread }
                  : { kind: "thread.removed", threadId: item.thread.id },
              );
            else if (item.kind === "thread.removed" && item.location === "archive")
              receiveArchive({ kind: "thread.removed", threadId: item.threadId });
            receive(item);
          }),
        ),
      );
    }),
  );
}
export function followThread(
  url: string,
  token: string,
  threadId: ThreadId,
  receive: (item: OrchestrationV2ThreadStreamItem) => void,
) {
  return withConnection(url, token, (session) =>
    session.client[RPC.subscribeThread]({
      threadId,
      acceptBoundedSnapshot: true,
      requestCompletionMarker: true,
    }).pipe(Stream.runForEach((item) => Effect.sync(() => receive(item)))),
  );
}

export function getTurnItem(
  url: string,
  token: string,
  input: import("@t3tools/contracts").OrchestrationV2GetTurnItemInput,
) {
  return withConnection(url, token, (session) => session.client[RPC.getTurnItem](input));
}

export function dispatchCommand(
  url: string,
  token: string,
  command: import("@t3tools/contracts").OrchestrationV2Command,
) {
  return withConnection(url, token, (session) => session.client[RPC.dispatchCommand](command));
}
export function completeComposer(
  url: string,
  token: string,
  cwd: string,
  prefix: string,
  query: string,
  instanceId: import("@t3tools/contracts").ProviderInstanceId,
) {
  return withConnection(url, token, (session) =>
    Effect.gen(function* () {
      if (prefix === "@") {
        const result = yield* session.client[WS_METHODS.projectsSearchEntries]({
          cwd,
          query: query.slice(0, 256),
          limit: 8,
        });
        return result.entries.map((entry) => "@" + entry.path);
      }
      const result = yield* session.client[WS_METHODS.serverRefreshProviders]({ instanceId, cwd });
      const provider = result.providers.find((provider) => provider.instanceId === instanceId);
      const workspace = provider?.workspaceSnapshots?.find((workspace) => workspace.cwd === cwd);
      return (workspace?.skills ?? provider?.skills ?? [])
        .filter(
          (skill) =>
            skill.enabled &&
            skill.userInvocable !== false &&
            skill.name.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(0, 8)
        .map((skill) => (skill.userInvocationOnly ? "/" : "$") + skill.name);
    }),
  );
}

export function searchThreads(url: string, token: string, query: string) {
  return withConnection(url, token, (session) =>
    session.client[RPC.searchThreads]({ query, limit: 50 }),
  );
}

export function answerSecret(
  url: string,
  token: string,
  input: import("@t3tools/contracts").SecretRequestAnswerInput,
) {
  return withConnection(url, token, (session) =>
    session.client[WS_METHODS.secretsAnswerRequest](input),
  );
}

export function mediaUrl(url: string, token: string, threadId: ThreadId, path: string) {
  return withConnection(url, token, (session) =>
    session.client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "media-file", threadId, path },
    }).pipe(Effect.map((result) => new URL(result.relativeUrl, url).href)),
  );
}

export function pageUrl(url: string, token: string, attachmentId: string, mimeType = "text/html") {
  return withConnection(url, token, (session) =>
    session.client[WS_METHODS.assetsCreateUrl]({
      resource: {
        _tag: "attachment",
        attachmentId,
        fileName: mimeType.startsWith("image/")
          ? "image"
          : mimeType === "text/html"
            ? "page.html"
            : mimeType.split("/")[0] || "file",
        mimeType,
        disposition: "inline",
      },
    }).pipe(Effect.map((result) => new URL(result.relativeUrl, url).href)),
  );
}

export const fileMethods = {
  list: (url: string, token: string, input: import("@t3tools/contracts").ProjectListEntriesInput) =>
    withConnection(url, token, (session) => session.client[WS_METHODS.projectsListEntries](input)),
  find: (
    url: string,
    token: string,
    input: import("@t3tools/contracts").ProjectSearchEntriesInput,
  ) =>
    withConnection(url, token, (session) =>
      session.client[WS_METHODS.projectsSearchEntries](input),
    ),
  search: (
    url: string,
    token: string,
    input: import("@t3tools/contracts").ProjectSearchContentsInput,
  ) =>
    withConnection(url, token, (session) =>
      session.client[WS_METHODS.projectsSearchContents](input),
    ),
  read: (url: string, token: string, input: import("@t3tools/contracts").ProjectReadFileInput) =>
    withConnection(url, token, (session) => session.client[WS_METHODS.projectsReadFile](input)),
};

export const diffMethods = {
  full: (
    url: string,
    token: string,
    input: import("@t3tools/contracts").OrchestrationGetFullThreadDiffInput,
  ) => withConnection(url, token, (session) => session.client[RPC.getFullThreadDiff](input)),
  turn: (
    url: string,
    token: string,
    input: import("@t3tools/contracts").OrchestrationGetTurnDiffInput,
  ) => withConnection(url, token, (session) => session.client[RPC.getTurnDiff](input)),
};

export function workspaceRefs(url: string, token: string, cwd: string) {
  return withConnection(url, token, (session) =>
    Effect.gen(function* () {
      const refs: import("@t3tools/contracts").VcsRef[] = [];
      let cursor: number | undefined;
      do {
        const page = yield* session.client[WS_METHODS.vcsListRefs]({
          cwd,
          refKind: "local",
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        refs.push(...page.refs);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return refs;
    }),
  );
}

export function uploadImage(url: string, token: string, bytes: Uint8Array) {
  return withConnection(url, token, (session) =>
    Effect.gen(function* () {
      const meta = {
        type: "image" as const,
        name: "clipboard.png",
        mimeType: "image/png" as const,
        sizeBytes: bytes.length,
      };
      const minted = yield* session.client[WS_METHODS.attachmentsCreateUploadUrl](meta);
      yield* Effect.tryPromise(async () => {
        const response = await fetch(new URL(minted.relativeUrl, url), {
          method: "POST",
          headers: { "Content-Type": meta.mimeType },
          body: Buffer.from(bytes),
        });
        if (!response.ok) throw new Error("Image upload failed");
      }).pipe(
        Effect.tapError(() =>
          session.client[WS_METHODS.attachmentsDelete]({ attachmentId: minted.attachmentId }).pipe(
            Effect.ignore,
          ),
        ),
      );
      return { ...meta, id: minted.attachmentId };
    }),
  );
}

export type TerminalOp =
  | { kind: "write"; data: string }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "restart"; cwd: string; worktreePath: string | null; cols: number; rows: number };

/**
 * One socket carries a terminal's output stream and everything typed into it. `bind` hands the
 * caller a synchronous `send`; ops run in order, so keystrokes never overtake each other.
 */
export function terminalSession(
  url: string,
  token: string,
  input: import("@t3tools/contracts").TerminalAttachInput,
  receive: (event: import("@t3tools/contracts").TerminalAttachStreamEvent) => void,
  bind: (send: (op: TerminalOp) => void) => void,
) {
  return withConnection(url, token, (session) =>
    Effect.gen(function* () {
      const ops = yield* Queue.unbounded<TerminalOp>();
      bind((op) => void Queue.offerUnsafe(ops, op));
      const id = { threadId: input.threadId, terminalId: input.terminalId };
      yield* Queue.take(ops).pipe(
        Effect.flatMap((op) =>
          op.kind === "write"
            ? session.client[WS_METHODS.terminalWrite]({ ...id, data: op.data })
            : op.kind === "resize"
              ? session.client[WS_METHODS.terminalResize]({ ...id, cols: op.cols, rows: op.rows })
              : // Upstream has no terminal.restart; closing and reopening starts a fresh shell.
                session.client[WS_METHODS.terminalClose](id).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    session.client[WS_METHODS.terminalOpen]({
                      ...id,
                      cwd: op.cwd,
                      worktreePath: op.worktreePath,
                      cols: op.cols,
                      rows: op.rows,
                    }),
                  ),
                ),
        ),
        // A write to an exited shell fails; the panel already shows that state.
        Effect.ignore,
        Effect.forever,
        Effect.forkScoped,
      );
      yield* session.client[WS_METHODS.terminalAttach](input).pipe(
        Stream.runForEach((event) => Effect.sync(() => receive(event))),
      );
    }),
  );
}

// Read cached inventories only: no preview launch, device discovery or helper startup.
export function listPreviews(url: string, token: string, threadId: ThreadId) {
  return withConnection(url, token, (session) =>
    session.client[WS_METHODS.previewList]({ threadId }),
  );
}
export function deviceState(url: string, token: string) {
  return withConnection(url, token, (session) =>
    session.client[WS_METHODS.subscribeDeviceState]({}).pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.map((states) => states[0]!),
    ),
  );
}
export function webThreadUrl(url: string, threadId: string) {
  return fetchRemoteEnvironmentDescriptor({ httpBaseUrl: url }).pipe(
    Effect.map((descriptor) => threadWebUrl(url, descriptor.environmentId, threadId)),
    Effect.provide(FetchHttpClient.layer),
  );
}
