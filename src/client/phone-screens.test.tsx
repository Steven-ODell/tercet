import { act } from "react";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import type {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { createClient, waitForLive } from "./runtime";
import { AppFrame } from "./frame";
import { fixtureNow, flatFixture } from "./sidebar-fixture";
import { claude } from "./usage-fixture";
import { emptyTranscript } from "./transcript-state";
import { applyLook } from "./look";
import { defaultSettings } from "./settings";

// Phone screens on fixture data, no server: the real frame at 50x40 (portrait), 50x20 (portrait with
// the keyboard up) and 110x20 (landscape). Each screen is compared with acceptance/phone/<name>-<w>x<h>.txt;
// `TERCET_RECORD=1 bun test src/client/phone-screens.test.tsx` rewrites them.

const RECORD = process.env.TERCET_RECORD === "1";
const DIR = new URL("../../acceptance/phone/", import.meta.url).pathname;
const longTitle =
  "Make the phone terminal layout usable in portrait and landscape: wrap every thread name, keep the composer above the keyboard and never cut a label";
const longModel = "Claude Opus 5.5 Extended Thinking Preview With A Very Long Display Name";
const longMessage =
  "Please wrap every thread name instead of cutting it with an ellipsis, and keep the composer above the keyboard on a fifty column phone screen.";
const reply =
  "Done. Names wrap on word breaks, the project and age move to their own row when they do not fit, and the composer keeps four rows.\n\n- One view at a time\n- Tabs on the status row\n\n```bash\nbun test\n```";
const SIZES = ["50x40", "50x20", "110x20"] as const;
type Size = (typeof SIZES)[number];
const dims = (size: Size) => size.split("x").map(Number) as [number, number];

beforeAll(() => applyLook(defaultSettings()));
afterAll(() => applyLook(defaultSettings()));

async function fixtureClient() {
  const base = flatFixture();
  const thread = base.threads.find((t) => t.id === "active-a-new")!;
  const selected = {
    ...thread,
    id: "long-thread" as ThreadId,
    title: longTitle,
    status: "idle" as const,
    modelSelection: { instanceId: "claudeAgent", model: "long" },
    // Pinned first, so the short screens show it without scrolling the list.
    pinnedAt: thread.createdAt,
    pinOrderKey: "0",
    worktreePath: "/fixture/a",
    branch: "phone-layout",
  };
  const snapshot = {
    ...base,
    threads: [selected, ...base.threads],
  } as OrchestrationV2ShellSnapshot;
  const row = (id: string, type: string, values: object) => ({
    sourceThreadId: selected.id,
    sourceItemId: id,
    item: { id, type, status: "completed", runId: "run", ...values },
  });
  const projection = {
    thread: { id: selected.id },
    runs: [],
    visibleTurnItems: [
      row("u1", "user_message", { text: longMessage }),
      row("a1", "assistant_message", { text: reply }),
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: (_, receive) =>
        Effect.sync(() => receive({ kind: "snapshot", snapshot })).pipe(
          Effect.andThen(Effect.never),
        ),
      files: {
        list: (_: string, input: { directoryPath?: string }) =>
          Effect.succeed({
            entries: input.directoryPath
              ? [
                  { path: "src/client/phone-screens.test.tsx", kind: "file" },
                  { path: "src/client/frame.tsx", kind: "file" },
                ]
              : [
                  { path: "src", kind: "directory" },
                  { path: "docs", kind: "directory" },
                  { path: "README.md", kind: "file" },
                ],
            truncated: false,
          }),
        read: () =>
          Effect.succeed({
            relativePath: "README.md",
            contents: "# Tercet\n\nA terminal client for T3.\n",
            byteLength: 36,
            truncated: false,
          }),
        find: () => Effect.succeed({ entries: [], truncated: false }),
        search: () => Effect.succeed({ matches: [], truncated: false }),
      } as never,
    },
    false,
    () => Date.parse(fixtureNow),
  );
  client.start();
  await waitForLive(client);
  client.registry.set(client.snapshot, snapshot);
  client.registry.set(client.providers, [
    {
      ...claude([]),
      models: [
        { slug: "long", name: longModel, isCustom: false, capabilities: null },
        { slug: "b", name: "Sonnet 5.5", isCustom: false, capabilities: null },
        { slug: "c", name: "Haiku 5.5", isCustom: false, capabilities: null },
        { slug: "d", name: "Fable 5.2", isCustom: false, capabilities: null },
        { slug: "e", name: "Opus 5.5", isCustom: false, capabilities: null },
      ],
    },
  ] as never);
  client.registry.set(
    client.transcripts,
    new Map([[selected.id, { ...emptyTranscript, projection }]]),
  );
  client.openThread(selected.id);
  return client;
}

async function screen(
  size: Size,
  drive: (t: {
    frame: () => string;
    key: (name: string, modifiers?: { ctrl?: boolean; meta?: boolean }) => Promise<void>;
    tap: (label: string) => Promise<void>;
    type: (text: string) => Promise<void>;
    resize: (w: number, h: number) => Promise<void>;
    settle: (predicate: (frame: string) => boolean) => Promise<void>;
  }) => Promise<void>,
  start: Size = size,
) {
  const [w0, h0] = dims(start);
  const client = await fixtureClient();
  const view = await testRender(<AppFrame client={client} onQuit={() => {}} />, {
    width: w0,
    height: h0,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const frame = () => view.captureCharFrame();
  const t = {
    frame,
    key: async (name: string, modifiers?: { ctrl?: boolean; meta?: boolean }) => {
      await act(async () =>
        view.mockInput.pressKey(name === "escape" ? "ESCAPE" : name, modifiers),
      );
      await view.flush();
    },
    tap: async (label: string) => {
      const lines = frame().split("\n");
      const y = lines.findIndex((line) => line.includes(label));
      expect(y, `no "${label}" on screen`).toBeGreaterThanOrEqual(0);
      await act(async () => {
        await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
      });
      await view.flush();
    },
    type: async (text: string) => {
      await act(async () => {
        await view.mockInput.typeText(text);
      });
      await view.flush();
    },
    resize: async (w: number, h: number) => {
      await act(async () => view.resize(w, h));
      await view.flush();
    },
    settle: async (predicate: (frame: string) => boolean) => {
      // waitForFrame gives up as soon as the renderer is idle, so poll it against a deadline.
      const deadline = Date.now() + 3000;
      for (;;) {
        try {
          await view.waitForFrame(predicate);
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
        }
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      await act(async () => view.renderOnce());
    },
  };
  try {
    await t.settle((f) => f.includes("Alpha pinned first"));
    await drive(t);
    await act(async () => view.renderOnce());
    return frame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n+$/, "\n");
  } finally {
    await act(async () => view.renderer.destroy());
    await client.dispose();
  }
}

function check(name: string, size: Size, text: string) {
  const [w, h] = dims(size);
  const lines = text.replace(/\n$/, "").split("\n");
  expect(lines.length).toBeLessThanOrEqual(h);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(w);
  const file = `${DIR}${name}-${size}.txt`;
  if (RECORD) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
  } else expect(text).toBe(readFileSync(file, "utf8"));
}

/** Border characters and whitespace removed, to find a name that wrapped across rows. */
const flat = (text: string) => text.replace(/[│┃║\s]/g, "");
/** The cells inside the overlay box, so panes behind a narrower overlay do not interleave. */
const box = (text: string) => {
  const lines = text.split("\n");
  const top = lines.find((line) => line.includes("┌"))!;
  const [x0, x1] = [top.indexOf("┌"), top.indexOf("┐")];
  return lines.map((line) => line.slice(x0 + 1, x1)).join("\n");
};
/** The leftmost pane, so a wide screen's other columns do not interleave with its rows. */
const firstPane = (text: string) => {
  const top = text.split("\n").find((line) => line.includes("╮"))!;
  const x1 = top.indexOf("╮");
  return text
    .split("\n")
    .map((line) => line.slice(0, x1 + 1))
    .join("\n");
};
/** The `[…]` tap cell on the selected thread is a button, not a cut name. */
const ellipsisRows = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.replaceAll("[…]", "").includes("…") && !line.includes("filter"));

const waitChat = (f: string) => f.includes("Done. Names wrap");
const draft = "Wrap it, then run the tests";

for (const size of SIZES) {
  test(`threads at ${size}: the long title wraps whole`, async () => {
    const text = await screen(size, async () => {});
    check("threads", size, text);
    expect(flat(firstPane(text).replaceAll("[…]", ""))).toContain(flat(longTitle));
    expect(ellipsisRows(text)).toEqual([]);
  });

  test(`chat at ${size}: transcript over the composer`, async () => {
    const text = await screen(size, async (t) => {
      if (size !== "110x20") await t.tap("[Chat]");
      await t.settle(waitChat);
    });
    check("chat", size, text);
    expect(text).toContain("Composer");
    expect(text).toContain("Done. Names wrap");
  });

  test(`model at ${size}: the long model name wraps whole`, async () => {
    const text = await screen(size, async (t) => {
      await t.key("m", { meta: true });
      await t.settle((f) => f.includes("Model · Favorites first"));
    });
    check("model", size, text);
    expect(flat(box(text))).toContain(flat(longModel));
    expect(ellipsisRows(text)).toEqual([]);
    expect(text).toContain("[ Esc Close ]");
  });

  test(`menu at ${size}: every row is whole`, async () => {
    const text = await screen(size, async (t) => {
      await t.tap("[Menu]");
      await t.settle((f) => f.includes("tap a row"));
    });
    check("menu", size, text);
    expect(text).toContain("tap a row");
  });

  test(`files at ${size}: the tree fits`, async () => {
    const text = await screen(size, async (t) => {
      await t.key("f", { meta: true });
      await t.settle((f) => f.includes("README.md"));
    });
    check("files", size, text);
    expect(text).toContain("README.md");
  });
}

// The keyboard halves the rows: portrait goes 50x40 -> 50x20, landscape is already 110x20.
for (const size of ["50x20", "110x20"] as const)
  test(`chat with the keyboard up at ${size}: draft and [send] stay visible`, async () => {
    const text = await screen(
      size,
      async (t) => {
        if (size === "50x20") {
          await t.tap("[Chat]");
          await t.settle(waitChat);
          await t.resize(50, 20);
        }
        if (size === "50x20") await t.key("i");
        else await t.tap("Composer");
        await t.type(draft);
        await t.settle((f) => f.includes(draft));
      },
      size === "50x20" ? "50x40" : size,
    );
    check("chat-keyboard", size, text);
    expect(text).toContain(draft);
    expect(text).toContain("[send");
  });
