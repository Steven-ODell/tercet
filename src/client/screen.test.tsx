import { act } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import { createClient } from "./runtime";
import { ConnectionScreen } from "./screen";

test("retry screen shows server-down state and reconnects by key and mouse", async () => {
  let attempts = 0;
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("unexpected issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => {
        attempts++;
        return Effect.fail(new Error("server down"));
      },
    },
    false,
  );
  const view = await testRender(<ConnectionScreen client={client} />, { width: 80, height: 24 });
  try {
    await act(async () => {
      client.start();
    });
    await view.waitForFrame((frame) => frame.includes("Server unavailable"));
    expect(view.captureCharFrame()).toContain("Retry (r)");
    expect(attempts).toBe(1);
    await act(async () => {
      view.mockInput.pressKey("r");
    });
    await view.flush();
    expect(attempts).toBe(2);
    await act(async () => {
      await view.mockMouse.click(5, 2);
    });
    await view.flush();
    expect(attempts).toBe(3);
    expect(view.captureCharFrame()).toContain("threads=0");
  } finally {
    await act(async () => {
      await view.dispose();
    });
    await client.dispose();
  }
});
