import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORCHESTRATION_V2_WS_METHODS as RPC, ThreadId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  orchestrationProtocolCompatibilityError,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import { RpcSessionFactory, layer } from "@t3tools/client-runtime/rpc/session";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Socket from "effect/socket/Socket";

export const sandboxUrl = "http://127.0.0.1:3775";
// scripts/sandbox.sh writes the token into its sandbox dir and exports TERCET_SANDBOX_DIR.
export const tokenPath = process.env.TERCET_SANDBOX_DIR
  ? join(process.env.TERCET_SANDBOX_DIR, "token")
  : fileURLToPath(new URL("../../.t3/sandbox/token", import.meta.url));

// This gate spike must never accidentally reach the live environment.
export function assertSandboxUrl(url: string) {
  if (url !== sandboxUrl) throw new Error(`Sandbox spike only accepts ${sandboxUrl}`);
}

export function connectSandbox(token: string, url = sandboxUrl) {
  assertSandboxUrl(url);
  return Effect.gen(function* () {
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: url });
    const incompatible = orchestrationProtocolCompatibilityError(descriptor);
    if (incompatible) return yield* incompatible;
    const socketUrl = new URL(
      yield* resolveRemoteWebSocketConnectionUrl({
        httpBaseUrl: url,
        wsBaseUrl: url.replace("http:", "ws:"),
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
        connectionId: "tercet-sandbox",
      }),
    });
    yield* session.ready;
    return session;
  });
}

export function withSandbox<A, E>(
  use: (session: AwaitedSession) => Effect.Effect<A, E>,
  token?: string,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const credential = token ?? (yield* Effect.promise(() => readFile(tokenPath, "utf8"))).trim();
      const session = yield* connectSandbox(credential);
      return yield* use(session);
    }),
  ).pipe(
    Effect.provide(layer({})),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(Socket.WebSocketConstructor, (url) => new WebSocket(url)),
    Effect.timeout("30 seconds"),
  );
}
type AwaitedSession = Effect.Success<ReturnType<typeof connectSandbox>>;

export const listThreads = (session: AwaitedSession) =>
  session.client[RPC.subscribeShell]({}).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((items) => items[0]?.snapshot.threads ?? []),
  );

if (import.meta.main) {
  const args = process.argv.slice(2);
  const task =
    args[0] === "--list"
      ? withSandbox((session) =>
          listThreads(session).pipe(
            Effect.flatMap((threads) =>
              Effect.sync(() => {
                for (const thread of threads) console.log(`${thread.id}\t${thread.title}`);
                if (!threads.length) console.log("Sandbox has no threads.");
              }),
            ),
          ),
        )
      : args[0] === "--follow" && args[1]
        ? withSandbox((session) =>
            session.client[RPC.subscribeThread]({
              threadId: ThreadId.make(args[1]!),
              requestCompletionMarker: true,
            }).pipe(
              Stream.runForEach((item) => Effect.sync(() => console.log(JSON.stringify(item)))),
            ),
          )
        : Effect.fail(new Error("usage: connect.ts --list | --follow <thread-id>"));
  try {
    await Effect.runPromise(task);
  } catch {
    console.error("Sandbox connection failed or timed out. Check sandbox.sh up/token.");
    process.exitCode = 1;
  }
}
