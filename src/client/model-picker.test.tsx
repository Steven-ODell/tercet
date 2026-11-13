import { act } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  CommandId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ClientSettings,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { claude } from "./usage-fixture";
import { createClient, waitForLive, type Client } from "./runtime";
import { AppFrame } from "./frame";
import { defaultRuntimeMode } from "./model-defaults";
import { catalogRows, selectionFor } from "./model-picker";
import { allThreads, createThreadActions } from "./thread-actions";
import { platform } from "./platform";
import { connectionConfig } from "./config";
import { sandboxUrl, tokenPath } from "../spikes/connect";

const provider = {
  ...claude([]),
  supportedRuntimeModes: ["approval-required", "full-access"] as const,
  models: [
    {
      slug: "opus-5.5",
      name: "Opus 5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select" as const,
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
          { id: "fastMode", label: "Fast", type: "boolean" as const, currentValue: false },
          {
            id: "serviceTier",
            label: "Service tier",
            type: "select" as const,
            options: [
              { id: "default", label: "Default", isDefault: true },
              { id: "priority", label: "Priority" },
            ],
          },
        ],
      },
    },
    { slug: "sonnet-5.5", name: "Sonnet 5.5", isCustom: false, capabilities: null },
  ],
};
const favorites: ClientSettings["favorites"] = [
  { provider: provider.instanceId, model: "opus-5.5" },
];

test("favorites retain settings order and exact instance routing; options belong to selected live model", () => {
  const custom = { ...provider, instanceId: ProviderInstanceId.make("personal") };
  const rows = catalogRows([custom, provider], favorites, "");
  expect(rows[0]?.provider.instanceId).toBe(provider.instanceId);
  expect(rows[1]?.provider.instanceId).toBe(custom.instanceId);
  expect(catalogRows([provider], favorites, "sonnet").map((r) => r.model.slug)).toEqual([
    "sonnet-5.5",
  ]);
  expect(
    selectionFor(provider, provider.models[1]!, {
      instanceId: provider.instanceId,
      model: "opus-5.5",
      options: [{ id: "fastMode", value: true }],
    }).options,
  ).toEqual([]);
});

test("keyboard and pointer model/options/runtime selection, cancellation, errors and new-thread defaults", async () => {
  const commands: OrchestrationV2Command[] = [];
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
      modelFavorites: async () => favorites,
      dispatch: (_, c) =>
        Effect.sync(() => {
          commands.push(c);
        }),
    },
    false,
  );
  client.start();
  await new Promise<void>((r) => queueMicrotask(r));
  client.registry.set(client.providers, [provider]);
  const view = await testRender(<AppFrame client={client} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  async function key(name: string, meta = false) {
    await act(async () => {
      view.mockInput.pressKey(name, { meta });
    });
    await view.flush();
  }
  async function click(label: string) {
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((l) => l.includes(label));
    expect(y).toBeGreaterThan(-1);
    await act(async () => {
      await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  }
  try {
    await key("m", true);
    expect(view.captureCharFrame()).toContain("★ Favorites · Opus 5.5");
    await key("RETURN");
    expect(view.captureCharFrame()).not.toContain("Effort and options");
    expect(client.registry.get(client.newRuntimeMode)).toBe("full-access");
    expect(client.registry.get(client.newModelSelection)?.options).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: false },
      { id: "serviceTier", value: "default" },
    ]);
    await key("e", true);
    await key("RETURN"); // effort high -> max
    await key("ARROW_DOWN");
    await key("RETURN"); // fast
    await key("ARROW_DOWN");
    await key("RETURN"); // tier
    await click("Runtime:");
    await click("[ Apply selection ]");
    expect(client.registry.get(client.newModelSelection)?.options).toEqual([
      { id: "reasoningEffort", value: "max" },
      { id: "fastMode", value: true },
      { id: "serviceTier", value: "priority" },
    ]);
    expect(client.registry.get(client.newRuntimeMode)).toBe("approval-required");
    await key("e", true);
    expect(view.captureCharFrame()).toContain("Effort: max");
    await key("ESCAPE");
    await key("m", true);
    await act(async () => {
      await view.mockInput.typeText("sonnet");
    });
    await view.flush();
    await key("ESCAPE");
    expect(client.registry.get(client.newModelSelection)?.model).toBe("opus-5.5");
    await key("m", true);
    await key("ARROW_DOWN");
    await key("RETURN");
    expect(client.registry.get(client.newModelSelection)?.model).toBe("sonnet-5.5");
    await act(async () => client.registry.set(client.providers, [{ ...provider, enabled: false }]));
    await key("m", true);
    await key("RETURN");
    expect(view.captureCharFrame()).toContain("Provider unavailable or disabled");
    await key("ESCAPE");
    await act(async () => {
      client.registry.set(client.providers, [provider]);
      client.registry.set(client.modelPreferences, {
        favorites: [{ provider: provider.instanceId, model: "sonnet-5.5" }],
        providerModelPreferences: {},
      });
    });
    await key("m", true);
    expect(view.captureCharFrame()).toContain("★ Favorites · Sonnet 5.5");
    expect(view.captureCharFrame()).not.toContain("★ Favorites · Opus 5.5");
    await key("ESCAPE");
    expect(commands).toHaveLength(0); // staged defaults never send a turn or create a thread
  } finally {
    await view.dispose();
    await client.dispose();
  }
});

test("j/k/l/h move through the model list and options; / or a letter starts the filter", async () => {
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
      modelFavorites: async () => favorites,
    },
    false,
  );
  client.start();
  await new Promise<void>((r) => queueMicrotask(r));
  client.registry.set(client.providers, [provider]);
  const view = await testRender(<AppFrame client={client} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const key = async (name: string, meta = false) => {
    await act(async () => {
      view.mockInput.pressKey(name, { meta });
    });
    await view.flush();
  };
  const type = async (text: string) => {
    await act(async () => {
      await view.mockInput.typeText(text);
    });
    await view.flush();
  };
  const cursorLine = () =>
    view
      .captureCharFrame()
      .split("\n")
      .find((l) => l.includes("› ")) ?? "";
  try {
    await key("m", true);
    const first = cursorLine();
    await key("j");
    const second = cursorLine();
    expect(second).not.toBe(first);
    await key("k");
    expect(cursorLine()).toBe(first);
    await key("l");
    expect(view.captureCharFrame()).not.toContain("Model · Favorites first");
    await key("e", true);
    expect(view.captureCharFrame()).toContain("Effort and options");
    await key("j");
    await key("k");
    await key("h");
    expect(view.captureCharFrame()).toContain("Effort · choose model");
    await type("/");
    await type("sonnet");
    expect(view.captureCharFrame()).toContain("Sonnet 5.5");
    expect(view.captureCharFrame()).not.toContain("Opus 5.5");
    await key("ESCAPE");
    expect(view.captureCharFrame()).not.toContain("Model · Favorites first");
    await key("m", true);
    expect(view.captureCharFrame()).toContain("Opus 5.5"); // a fresh picker starts unfiltered
    // A burst (one stdin chunk, as a fast typist or a paste sends it) keeps every character,
    // movement letters included, even though the filter input is not focused yet.
    await act(async () => {
      view.mockInput.pressKeys(["sonhjklx\x7f\x7f\x7f\x7f\x7fnet"]);
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("sonnet");
    expect(view.captureCharFrame()).toContain("Sonnet 5.5");
    expect(view.captureCharFrame()).not.toContain("Opus 5.5");
    await key("ESCAPE");
  } finally {
    await view.dispose();
    await client.dispose();
  }
});

function waitState(client: Client, predicate: () => boolean) {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("Sandbox projection timeout"));
    }, 20000);
    const off = client.registry.subscribe(client.snapshot, () => {
      if (predicate()) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}
test.skipIf(process.env.TERCET_SANDBOX_TEST !== "1")(
  "sandbox picker keyboard and click persist modelSelection; new thread inherits selection",
  async () => {
    const config = await connectionConfig(
      ["--url", sandboxUrl, "--token-file", tokenPath],
      async () => undefined,
      "/unused",
    );
    const client = createClient(platform(config), false);
    client.start();
    await waitForLive(client);
    const actions = createThreadActions(client);
    const seed = allThreads(client).find((t) => !t.archivedAt)!;
    const id = await actions.run("new", seed);
    await waitState(client, () => allThreads(client).some((t) => t.id === id));
    const created = [id!];
    const view = await testRender(<AppFrame client={client} />, {
      width: 120,
      height: 40,
      kittyKeyboard: true,
      exitOnCtrlC: false,
    });
    async function key(name: string, meta = false) {
      await act(async () => {
        view.mockInput.pressKey(name, { meta });
      });
      await view.flush();
    }
    async function click(label: string) {
      const lines = view.captureCharFrame().split("\n");
      const y = lines.findIndex((l) => l.includes(label));
      expect(y).toBeGreaterThan(-1);
      await act(async () => {
        await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
      });
      await view.flush();
    }
    try {
      // The sandbox catalog is live; choose two available entries without starting any turns.
      const live = client.registry
        .get(client.providers)
        .find((p) => p.enabled && p.status === "ready" && p.models.length >= 2)!;
      expect(live).toBeDefined();
      for (const [i, model] of live.models.slice(0, 2).entries()) {
        await key("m", true);
        await act(async () => {
          await view.mockInput.typeText(model.slug);
        });
        await view.flush();
        if (i === 0) await key("RETURN");
        else await click(model.name);
        await waitState(
          client,
          () => allThreads(client).find((t) => t.id === id)?.modelSelection.model === model.slug,
        );
        expect(allThreads(client).find((t) => t.id === id)?.modelSelection).toMatchObject({
          instanceId: live.instanceId,
          model: model.slug,
        });
      }
      const next = await actions.run(
        "new",
        allThreads(client).find((t) => t.id === id),
      );
      created.push(next!);
      await waitState(client, () => allThreads(client).some((t) => t.id === next));
      expect(allThreads(client).find((t) => t.id === next)?.modelSelection).toEqual(
        client.registry.get(client.newModelSelection)!,
      );
    } finally {
      await view.dispose();
      for (const threadId of created)
        await client.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
        });
      await client.dispose();
    }
  },
);

test("fresh choices override catalog speed/effort defaults, and permissions follow the driver", () => {
  const model = {
    ...provider.models[0]!,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          currentValue: "max",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
            { id: "max", label: "Max" },
          ],
        },
        { id: "fastMode", label: "Fast", type: "boolean" as const, currentValue: true },
        {
          id: "serviceTier",
          label: "Tier",
          type: "select" as const,
          currentValue: "priority",
          options: [
            { id: "default", label: "Standard" },
            { id: "priority", label: "Fast", isDefault: true },
          ],
        },
      ],
    },
  };
  expect(selectionFor(provider, model).options).toEqual([
    { id: "effort", value: "high" },
    { id: "fastMode", value: false },
    { id: "serviceTier", value: "default" },
  ]);
  const edited = { ...selectionFor(provider, model), options: [{ id: "effort", value: "max" }] };
  expect(selectionFor(provider, model, edited).options?.[0]?.value).toBe("max");
  for (const driver of ["claudeAgent", "codex", "opencode"]) {
    const custom = {
      ...provider,
      driver: ProviderDriverKind.make(driver),
      instanceId: ProviderInstanceId.make("personal"),
    };
    expect(defaultRuntimeMode(custom)).toBe(
      driver === "opencode" ? "approval-required" : "full-access",
    );
  }
  const openModel = {
    ...model,
    capabilities: {
      optionDescriptors: [
        {
          id: "variant",
          label: "Variant",
          type: "select" as const,
          currentValue: "default",
          options: [
            { id: "default", label: "Default" },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
  };
  expect(selectionFor(provider, openModel).options).toEqual([{ id: "variant", value: "high" }]);
});

test("OpenCode permissions can be opened after selection and reset on the next choice", async () => {
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
    },
    false,
  );
  client.start();
  await new Promise<void>((r) => queueMicrotask(r));
  client.registry.set(client.providers, [
    { ...provider, driver: ProviderDriverKind.make("opencode") },
  ]);
  const view = await testRender(<AppFrame client={client} />, {
    width: 100,
    height: 30,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const key = async (name: string, meta = false) => {
    await act(async () => {
      view.mockInput.pressKey(name, { meta });
    });
    await view.flush();
  };
  try {
    await key("m", true);
    await key("RETURN");
    expect(client.registry.get(client.newRuntimeMode)).toBe("approval-required");
    await key("e", true);
    for (let i = 0; i < 3; i++) await key("ARROW_DOWN");
    await key("RETURN");
    await key("ARROW_DOWN");
    await key("ARROW_DOWN");
    await key("RETURN");
    expect(client.registry.get(client.newRuntimeMode)).toBe("full-access");
    await key("m", true);
    await key("RETURN");
    expect(client.registry.get(client.newRuntimeMode)).toBe("approval-required");
  } finally {
    await view.dispose();
    await client.dispose();
  }
});
