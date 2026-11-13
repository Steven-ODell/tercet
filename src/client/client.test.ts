import { expect, test } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { AuthStandardClientScopes, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { connectionConfig } from "./config";
import {
  createClient,
  UNREADABLE_SERVER,
  UNREADABLE_THREAD,
  waitForLive,
  type Boundary,
  type Client,
  type Status,
} from "./runtime";
import { platform, readOptional, tokenIssueArgs, issuedToken } from "./platform";
import { sandboxUrl, tokenPath } from "../spikes/connect";

const empty: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
};
const receiveSnapshot = (_: string, receive: Parameters<Boundary["follow"]>[1]) =>
  Effect.sync(() => receive({ kind: "snapshot", snapshot: empty })).pipe(
    Effect.andThen(Effect.never),
  );
function fake(overrides: Partial<Boundary> = {}): Boundary {
  return {
    readToken: () => Effect.succeed("stored"),
    issueToken: () => Effect.die("unexpected issuance"),
    wake: () => Effect.void,
    follow: receiveSnapshot,
    pause: () => Effect.never,
    ...overrides,
  };
}
function waitStatus(client: Client, expected: Status) {
  return new Promise<void>((resolve) => {
    const stop = client.registry.subscribe(client.status, (value) => {
      if (value === expected) {
        stop();
        resolve();
      }
    });
    if (client.registry.get(client.status) === expected) {
      stop();
      resolve();
    }
  });
}

test("config discovers origin, flags override and base-dir selects runtime state", async () => {
  const paths: string[] = [];
  const read = async (path: string) => {
    paths.push(path);
    return path.endsWith("server-runtime.json")
      ? JSON.stringify({ origin: sandboxUrl })
      : undefined;
  };
  const config = await connectionConfig([], read, "/fake", {});
  expect(config.url).toBe(sandboxUrl);
  expect(config.tokenFile).toBe("/fake/.config/tercet/token");
  expect(config.settingsFound).toBe(false);
  expect(paths).toEqual([
    "/fake/.config/tercet/settings.json",
    "/fake/.t3/userdata/server-runtime.json",
  ]);
  const fallback = await connectionConfig([], async () => undefined, "/fake", {});
  expect(fallback.url).toBe("http://127.0.0.1:3773");
  expect(fallback.autostart).toBe(true);
  await connectionConfig(["--base-dir", "/sandbox"], read, "/fake", {});
  expect(paths.at(-1)).toBe("/sandbox/userdata/server-runtime.json");
  paths.length = 0;
  const explicit = await connectionConfig(
    ["--url", sandboxUrl, "--token-file", "/token", "--base-dir", "/sandbox", "--dump-status"],
    read,
    "/fake",
    {},
  );
  expect(paths).toEqual(["/fake/.config/tercet/settings.json"]);
  expect(explicit).toMatchObject({
    managedToken: false,
    autostart: false,
    dumpStatus: true,
    baseDir: "/sandbox",
    tokenFile: "/token",
  });
  expect(
    tokenIssueArgs(explicit).filter((_, index, args) => args[index - 1] === "--scope"),
  ).toEqual([...AuthStandardClientScopes]);
  for (const args of [
    ["--url"],
    ["--wat"],
    ["--url", "file:///bad"],
    ["--url", "http://secret@localhost"],
  ]) {
    await expect(connectionConfig(args, read, "/fake", {})).rejects.toThrow();
  }
});

test("connect publishes snapshot/status and disposing releases session", async () => {
  let closed = false;
  const client = createClient(
    fake({
      follow: (token, receive) =>
        receiveSnapshot(token, receive).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              closed = true;
            }),
          ),
        ),
    }),
    false,
  );
  client.start();
  await waitForLive(client);
  expect(client.registry.get(client.snapshot)).toEqual(empty);
  expect(client.registry.get(client.threadCount)).toBe(0);
  await client.dispose();
  expect(closed).toBe(true);
});

test("first run issues missing token; rejected managed token refreshes then connects", async () => {
  const pause = await Effect.runPromise(Deferred.make<void>());
  let issued = 0;
  const tokens: string[] = [];
  const client = createClient(
    fake({
      readToken: () => Effect.succeed(undefined),
      issueToken: () => Effect.sync(() => `issued-${++issued}`),
      follow: (token, receive) => {
        tokens.push(token);
        return token === "issued-1"
          ? Effect.fail({ _tag: "EnvironmentAuthInvalidError" })
          : receiveSnapshot(token, receive);
      },
      pause: () => Deferred.await(pause),
    }),
    true,
  );
  try {
    client.start();
    await waitStatus(client, "rejected");
    await Effect.runPromise(Deferred.succeed(pause, undefined));
    await waitForLive(client);
    expect(tokens).toEqual(["issued-1", "issued-2"]);
    expect(issued).toBe(2);
  } finally {
    await client.dispose();
  }
});

test("explicit rejected token is not overwritten; retry rereads replacement", async () => {
  let token = "bad";
  const client = createClient(
    fake({
      readToken: () => Effect.succeed(token),
      follow: (value, receive) =>
        value === "bad"
          ? Effect.fail({ _tag: "EnvironmentAuthInvalidError" })
          : receiveSnapshot(value, receive),
    }),
    false,
  );
  try {
    client.start();
    await waitStatus(client, "rejected");
    expect(client.registry.get(client.message)).not.toContain("bad");
    token = "replacement";
    await client.retry();
    await waitForLive(client);
  } finally {
    await client.dispose();
  }
});

test("server down displays retry and automatic reconnect restores shell", async () => {
  const pause = await Effect.runPromise(Deferred.make<void>());
  let attempts = 0;
  const client = createClient(
    fake({
      follow: (token, receive) =>
        ++attempts === 1
          ? Effect.fail(new Error("connection refused"))
          : receiveSnapshot(token, receive),
      pause: () => Deferred.await(pause),
    }),
    false,
  );
  try {
    client.start();
    await waitStatus(client, "retry");
    expect(client.registry.get(client.message)).toContain("Server unavailable");
    await Effect.runPromise(Deferred.succeed(pause, undefined));
    await waitForLive(client);
    expect(attempts).toBe(2);
  } finally {
    await client.dispose();
  }
});

test("an undecodable item (a defect, not a failure) still says why and keeps reconnecting", async () => {
  const pause = await Effect.runPromise(Deferred.make<void>());
  let attempts = 0;
  const client = createClient(
    fake({
      // effect's RPC client turns a chunk that fails to decode into a defect (Effect.orDie).
      follow: (token, receive) =>
        ++attempts === 1 ? Effect.die(new Error("SchemaError")) : receiveSnapshot(token, receive),
      followThread: () => Effect.die(new Error("SchemaError")),
      pause: () => Deferred.await(pause),
    }),
    false,
  );
  try {
    client.start();
    await waitStatus(client, "retry");
    expect(client.registry.get(client.message)).toBe(UNREADABLE_SERVER);
    await Effect.runPromise(Deferred.succeed(pause, undefined));
    await waitForLive(client);
    expect(attempts).toBe(2);
    client.registry.set(client.selectedThreadId, "thread-1" as never);
    await Bun.sleep(20);
    expect(client.registry.get(client.transcripts).get("thread-1")?.error).toBe(UNREADABLE_THREAD);
  } finally {
    await client.dispose();
  }
});

test("disconnect after live keeps cached shell, then reconnects with fresh snapshot", async () => {
  const disconnect = await Effect.runPromise(Deferred.make<void>());
  const pause = await Effect.runPromise(Deferred.make<void>());
  let attempts = 0;
  const client = createClient(
    fake({
      follow: (_, receive) =>
        Effect.gen(function* () {
          receive({ kind: "snapshot", snapshot: { ...empty, snapshotSequence: ++attempts } });
          if (attempts === 1) {
            yield* Deferred.await(disconnect);
            return yield* Effect.fail(new Error("closed"));
          }
          yield* Effect.never;
        }),
      pause: () => Deferred.await(pause),
    }),
    false,
  );
  try {
    client.start();
    await waitForLive(client);
    await Effect.runPromise(Deferred.succeed(disconnect, undefined));
    await waitStatus(client, "retry");
    expect(client.registry.get(client.snapshot)?.snapshotSequence).toBe(1);
    await Effect.runPromise(Deferred.succeed(pause, undefined));
    await waitForLive(client);
    expect(client.registry.get(client.snapshot)?.snapshotSequence).toBe(2);
  } finally {
    await client.dispose();
  }
});

const integration = process.env.TERCET_SANDBOX_TEST === "1" ? test : test.skip;
integration("client runtime connects to sandbox and exposes seeded thread count", async () => {
  const config = await connectionConfig(
    ["--url", sandboxUrl, "--token-file", tokenPath],
    readOptional,
    "/unused",
    {},
  );
  const client = createClient(platform(config), false);
  try {
    client.start();
    await waitForLive(client);
    expect(client.registry.get(client.threadCount)).toBeGreaterThan(0);
  } finally {
    await client.dispose();
  }
});
integration("client classifies actual sandbox token rejection", async () => {
  const config = await connectionConfig(
    ["--url", sandboxUrl, "--token-file", tokenPath],
    readOptional,
    "/unused",
    {},
  );
  const client = createClient(
    {
      ...platform(config),
      readToken: () => Effect.succeed("invalid-token"),
      pause: () => Effect.never,
    },
    false,
  );
  try {
    client.start();
    await waitStatus(client, "rejected");
  } finally {
    await client.dispose();
  }
});

test("enrichment snapshots retain the authoritative shell", async () => {
  const client = createClient(
    fake({
      follow: (_, receive) =>
        Effect.sync(() => {
          receive({ kind: "snapshot", snapshot: { ...empty, snapshotSequence: 7 } });
          receive({ kind: "snapshot", snapshot: empty, resolvedRepositoryIdentityRoots: [] });
        }).pipe(Effect.andThen(Effect.never)),
    }),
    false,
  );
  try {
    client.start();
    await waitForLive(client);
    expect(client.registry.get(client.snapshot)?.snapshotSequence).toBe(7);
  } finally {
    await client.dispose();
  }
});

test("provider status stream replaces limits and clears removed windows", async () => {
  const { claude } = await import("./usage-fixture");
  let update: Parameters<Boundary["follow"]>[2] | undefined;
  const provider = claude([
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 42,
      windowDurationMins: 300,
    },
  ]);
  const client = createClient(
    fake({
      follow: (_, receive, receiveConfig) =>
        Effect.sync(() => {
          update = receiveConfig;
          receiveConfig({
            version: 1,
            type: "providerStatuses",
            payload: { providers: [provider] },
          });
          receive({ kind: "snapshot", snapshot: empty });
        }).pipe(Effect.andThen(Effect.never)),
    }),
    false,
  );
  try {
    client.start();
    await waitForLive(client);
    expect(client.registry.get(client.providers)).toEqual([provider]);
    update!({ version: 1, type: "providerStatuses", payload: { providers: [] } });
    expect(client.registry.get(client.providers)).toEqual([]);
  } finally {
    await client.dispose();
  }
});

test("CLI token parser excludes startup notices and rejects missing/ambiguous credentials", () => {
  const token =
    Buffer.from(JSON.stringify({ kind: "session", method: "bearer-access-token" })).toString(
      "base64url",
    ) + ".signature";
  expect(issuedToken(`Startup notice\n${token}\n`)).toBe(token);
  expect(issuedToken(token)).toBe(token);
  expect(() => issuedToken("Startup notice only")).toThrow();
  expect(() => issuedToken(`${token}\n${token}`)).toThrow();
  expect(() => issuedToken("bad.signature")).toThrow();
});
