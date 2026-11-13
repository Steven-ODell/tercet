import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  PINNED_SERVER_VERSION,
  blocksStart,
  checkDescriptor,
  checkServer,
  compatMessage,
  compatWarning,
  supportedRange,
  type ServerCheck,
} from "./compat";
import { ServerGate } from "./screen";
import { AppFrame } from "./frame";
import { createClient } from "./runtime";
import * as Effect from "effect/Effect";

const descriptor = (serverVersion: unknown, orchestrationProtocolVersion: unknown = 2) => ({
  serverVersion,
  orchestrationProtocolVersion,
  environmentId: "env",
  label: "box",
});

test("each verdict: tested, in range, out of range, other protocol, no version", () => {
  expect(Bun.semver.satisfies(PINNED_SERVER_VERSION, supportedRange)).toBe(true);
  expect(checkDescriptor(descriptor("0.1.8"))).toEqual({
    kind: "ok",
    version: "0.1.8",
    tested: true,
  });
  expect(checkDescriptor(descriptor("0.1.12"))).toEqual({
    kind: "ok",
    version: "0.1.12",
    tested: false,
  });
  // Outside the range on the same protocol: starts, under a warning.
  for (const version of ["0.2.0", "0.1.7", "1.0.0", "0.1.9-nightly.3", "banana"])
    expect(checkDescriptor(descriptor(version))).toEqual({
      kind: "out-of-range",
      version,
      protocol: 2,
    });
  // The right version on another protocol stops; old servers default to 1.
  expect(checkDescriptor(descriptor("0.1.8", 3))).toEqual({
    kind: "protocol",
    version: "0.1.8",
    protocol: 3,
  });
  expect(checkDescriptor(descriptor("0.3.0", 3)).kind).toBe("protocol");
  expect(checkDescriptor({ serverVersion: "0.1.8" })).toMatchObject({
    kind: "protocol",
    protocol: 1,
  });
  for (const version of [undefined, null, "", "  ", 18])
    expect(checkDescriptor(descriptor(version)).kind).toBe("no-version");
  expect(checkDescriptor(null).kind).toBe("no-version");
});

test("only ok and the pinned release go without a warning", () => {
  expect(compatWarning(checkDescriptor(descriptor("0.1.8")))).toBeNull();
  expect(compatWarning(checkDescriptor(descriptor("0.1.12")))).toBeNull();
  expect(compatWarning({ kind: "unreachable", error: "x" })).toBeNull();
  expect(compatWarning(checkDescriptor(descriptor("0.2.0")))).toBe(
    `Built for T3 ${PINNED_SERVER_VERSION}, you're on 0.2.0: some things may not work.`,
  );
  expect(compatWarning(checkDescriptor(descriptor("0.1.8", 3)))).toContain("protocol 2");
  expect(compatWarning(checkDescriptor(descriptor(undefined)))).toContain("no version");
});

test("unreachable servers: refused, HTTP errors, timeouts and non-JSON all get one verdict", async () => {
  const refused = await checkServer("http://127.0.0.1:1");
  expect(refused).toEqual({ kind: "unreachable", error: "connection refused" });
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("<html>a web page</html>", { status: 404 }),
  });
  try {
    expect(await checkServer(server.url.origin)).toEqual({
      kind: "unreachable",
      error: "HTTP 404 from /.well-known/t3/environment",
    });
  } finally {
    server.stop(true);
  }
  const notJson = await checkServer("http://x", async () => JSON.parse("<html>"));
  expect(notJson).toEqual({
    kind: "unreachable",
    error: "the reply is not a T3 environment descriptor",
  });
  const slow = await checkServer("http://x", async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  expect(slow).toEqual({ kind: "unreachable", error: "no answer within 3 s" });
});

test("only an unreachable server or another protocol stops; --ignore-version passes the protocol", () => {
  const newer = checkDescriptor(descriptor("0.3.0"));
  const protocol = checkDescriptor(descriptor("0.1.8", 3));
  const missing = checkDescriptor(descriptor(undefined));
  const down: ServerCheck = { kind: "unreachable", error: "connection refused" };
  const all = [newer, protocol, missing, down];
  expect(all.map((c) => blocksStart(c, false))).toEqual([false, true, true, true]);
  expect(all.map((c) => blocksStart(c, true))).toEqual([false, false, false, true]);
  expect(blocksStart(checkDescriptor(descriptor("0.1.8")), false)).toBe(false);
});

test("each message names what was found, what is supported and what to do, in ASCII", () => {
  const url = "http://box:3773";
  const unsupported = compatMessage(checkDescriptor(descriptor("0.3.0", 3)), url);
  expect(unsupported.title).toBe("Incompatible server protocol");
  const text = unsupported.lines.join("\n");
  expect(text).toContain("runs T3 0.3.0, orchestration protocol 3");
  expect(text).toContain("tercet speaks protocol 2");
  expect(text).toContain("--ignore-version");
  expect(text).toContain("What to do");
  const missing = compatMessage(checkDescriptor({}), url);
  expect(missing.title).toBe("The server did not report a version");
  expect(missing.lines.join("\n")).toContain("--ignore-version");
  const local = compatMessage(
    { kind: "unreachable", error: "connection refused" },
    "http://127.0.0.1:3773",
  );
  expect(local.lines.join("\n")).toContain("start the server (`t3`)");
  const remote = compatMessage({ kind: "unreachable", error: "connection refused" }, url);
  expect(remote.lines.join("\n")).toContain("check --url");
  for (const message of [unsupported, missing, local, remote])
    expect(/^[\x20-\x7e\n]*$/.test([message.title, ...message.lines].join("\n"))).toBe(true);
});

test("the gate draws full screen, quits on q, and opens the app once the server answers", async () => {
  let quits = 0;
  let readies = 0;
  const unsupported = await testRender(
    <ServerGate
      url="http://box:3773"
      initial={checkDescriptor(descriptor("0.3.0", 3))}
      check={async () => checkDescriptor(descriptor("0.3.0", 3))}
      ignoreVersion={false}
      onReady={() => readies++}
      onQuit={() => quits++}
    >
      <text>the app</text>
    </ServerGate>,
    { width: 100, height: 20 },
  );
  try {
    await unsupported.flush();
    const frame = unsupported.captureCharFrame();
    expect(frame).toContain("tercet: Incompatible server protocol");
    expect(frame).toContain("runs T3 0.3.0");
    expect(frame).toContain("[ Quit (q) ]");
    expect(frame).not.toContain("Retry");
    expect(frame).not.toContain("the app");
    await act(async () => unsupported.mockInput.pressKey("q"));
    expect(quits).toBe(1);
    expect(readies).toBe(0);
  } finally {
    await act(async () => unsupported.dispose());
  }

  let up = false;
  const down = await testRender(
    <ServerGate
      url="http://127.0.0.1:3775"
      initial={{ kind: "unreachable", error: "connection refused" }}
      check={async () =>
        up
          ? checkDescriptor(descriptor("0.1.8"))
          : { kind: "unreachable", error: "connection refused" }
      }
      ignoreVersion={false}
      onReady={() => readies++}
      onQuit={() => quits++}
    >
      <text>the app</text>
    </ServerGate>,
    { width: 100, height: 20 },
  );
  try {
    await down.flush();
    expect(down.captureCharFrame()).toContain("Cannot reach the T3 server");
    expect(down.captureCharFrame()).toContain("[ Retry (r) ]");
    up = true;
    await act(async () => {
      down.mockInput.pressKey("r");
      await Bun.sleep(20);
    });
    await down.flush();
    expect(down.captureCharFrame()).toContain("the app");
    expect(readies).toBe(1);
    // Keys belong to the app now.
    await act(async () => down.mockInput.pressKey("q"));
    expect(quits).toBe(1);
  } finally {
    await act(async () => down.dispose());
  }

  const ignored = await testRender(
    <ServerGate
      url="http://box:3773"
      initial={checkDescriptor(descriptor(undefined))}
      check={async () => checkDescriptor(descriptor(undefined))}
      ignoreVersion
      onReady={() => readies++}
      onQuit={() => quits++}
    >
      <text>the app</text>
    </ServerGate>,
    { width: 100, height: 20 },
  );
  try {
    await ignored.flush();
    expect(ignored.captureCharFrame()).toContain("the app");
    expect(readies).toBe(2);
  } finally {
    await act(async () => ignored.dispose());
  }
});

const fakeClient = () => {
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
    },
    false,
  );
  client.registry.set(client.status, "live");
  return client;
};

const gated = (version: string) => (
  <ServerGate
    url="http://box:3773"
    initial={checkDescriptor(descriptor(version))}
    check={async () => checkDescriptor(descriptor(version))}
    ignoreVersion={false}
    onReady={() => {}}
    onQuit={() => {}}
  >
    <AppFrame client={fakeClient()} />
  </ServerGate>
);

test("a newer server opens the app under a banner that Alt+x or a click dismisses", async () => {
  const banner = `Built for T3 ${PINNED_SERVER_VERSION}, you're on 0.2.0`;
  for (const how of ["key", "click"] as const) {
    const view = await testRender(gated("0.2.0"), {
      width: 120,
      height: 30,
      kittyKeyboard: true,
      exitOnCtrlC: false,
    });
    try {
      await view.flush();
      let frame = view.captureCharFrame();
      expect(frame).toContain(banner);
      expect(frame).toContain("[ Dismiss (Alt+x) ]");
      expect(frame).toContain("Threads");
      // The dismiss key is listed in help while the banner shows.
      await act(async () => view.mockInput.pressKey("?"));
      await view.flush();
      expect(view.captureCharFrame()).toContain("Dismiss server warning");
      await act(async () => view.mockInput.pressKey("ESCAPE"));
      await view.flush();
      if (how === "key") await act(async () => view.mockInput.pressKey("x", { meta: true }));
      else {
        const row = view
          .captureCharFrame()
          .split("\n")
          .findIndex((l) => l.includes(banner));
        await act(async () => {
          await view.mockMouse.click(5, row);
        });
      }
      await view.flush();
      frame = view.captureCharFrame();
      expect(frame).not.toContain(banner);
      expect(frame).toContain("Threads");
      // Gone for the session: help no longer offers a key that does nothing.
      await act(async () => view.mockInput.pressKey("?"));
      await view.flush();
      expect(view.captureCharFrame()).not.toContain("Dismiss server warning");
    } finally {
      await act(async () => view.dispose());
    }
  }
});

test("the pinned release and its patches draw no banner and list no dismiss key", async () => {
  for (const version of [PINNED_SERVER_VERSION, "0.1.12"]) {
    const view = await testRender(gated(version), { width: 120, height: 30 });
    try {
      await view.flush();
      expect(view.captureCharFrame()).not.toContain("Built for T3");
      await act(async () => view.mockInput.pressKey("?"));
      await view.flush();
      expect(view.captureCharFrame()).not.toContain("Dismiss server warning");
    } finally {
      await act(async () => view.dispose());
    }
  }
});
