import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import type { CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import type { OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import { createClient } from "./runtime";
import { AppFrame } from "./frame";
import { fixtureNow, flatFixture } from "./sidebar-fixture";
import { emptyTranscript } from "./transcript-state";
import { asciiText } from "./icons";
import { applyLook } from "./look";
import { defaultSettings } from "./settings";
import { PRESET_NAMES, rgbOf, theme, type Color } from "./theme";

// Screenshot fixtures: the real frame on fixture data, once per preset and icon set, with the
// help, palette and model overlays open in turn. Each screen must keep every label whole, and
// every character of text must stand out from its background.

function fixtureClient() {
  const snapshot = flatFixture();
  const threadId: ThreadId = snapshot.threads[0]!.id;
  const row = (id: string, type: string, values: object) => ({
    sourceThreadId: threadId,
    sourceItemId: id,
    item: { id, type, status: "completed", runId: "run", ...values },
  });
  const projection = {
    thread: { id: threadId },
    runs: [],
    visibleTurnItems: [
      row("u1", "user_message", { text: "Add a line between speakers." }),
      row("c1", "command_execution", { input: "bun test" }),
      row("a1", "assistant_message", {
        text: "Tests pass.\n\n- One rule per change\n\n```bash\nnice -n 10 make\n```\n\nSee `src/a.ts`.",
      }),
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const client = createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
    },
    false,
    () => Date.parse(fixtureNow),
  );
  client.registry.set(client.snapshot, snapshot);
  client.registry.set(client.status, "live");
  client.registry.set(
    client.transcripts,
    new Map([[threadId, { ...emptyTranscript, projection }]]),
  );
  client.openThread(threadId);
  return client;
}

const luminance = (color: Color) => {
  const [r, g, b] = rgbOf(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: Color, b: Color) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** Text cells whose color is too close to their background, ignoring borders and blocks. */
function faint(frame: CapturedFrame, minimum: number) {
  const found: string[] = [];
  for (const line of frame.lines)
    for (const span of line.spans) {
      const text = span.text.replace(/[\s─-▟]/g, "");
      if (!text) continue;
      const bg = span.bg.a === 0 ? theme.canvas : span.bg;
      const ratio = contrast(span.fg, bg);
      if (ratio < minimum)
        found.push(
          `${JSON.stringify(text)} at ${ratio.toFixed(2)} fg ${rgbOf(span.fg)} bg ${rgbOf(bg)}`,
        );
    }
  return found;
}

const screens = [
  { name: "main", keys: [] as [string, object?][], labels: ["Threads", "Transcript", "Composer"] },
  { name: "help", keys: [["?"]], labels: ["Anywhere", "Close overlay / next pane", "Esc Close"] },
  { name: "palette", keys: [["p", { ctrl: true }]], labels: ["Esc close"] },
  { name: "model", keys: [["m", { meta: true }]], labels: ["Model"] },
] satisfies { name: string; keys: [string, object?][]; labels: string[] }[];
const always = ["Add a line between speakers.", "Tests pass.", "? Help", "Alt+b Sidebar"];

afterAll(() => applyLook(defaultSettings()));

for (const preset of PRESET_NAMES)
  for (const icons of ["nerd", "unicode", "ascii"] as const)
    test(`${preset} with ${icons} icons: labels whole, text visible${icons === "ascii" ? ", ASCII only" : ""}`, async () => {
      applyLook({ ...defaultSettings(), theme: { preset }, icons });
      const client = fixtureClient();
      const view = await testRender(<AppFrame client={client} onQuit={() => {}} />, {
        width: 120,
        height: 40,
        kittyKeyboard: true,
        exitOnCtrlC: false,
      });
      try {
        await view
          .waitForFrame((f) => f.includes("Add a line between speakers."))
          .catch((error) => {
            throw new Error(`${error}\n${view.captureCharFrame()}`);
          });
        for (const screen of screens) {
          for (const [name, modifiers] of screen.keys)
            await act(async () => view.mockInput.pressKey(name, modifiers));
          await view.waitForFrame((f) => screen.labels.every((label) => f.includes(label)));
          await act(async () => view.renderOnce());
          // asciiFrame runs after the frame is captured, so the check applies its table here.
          const raw = view.captureCharFrame();
          const text = icons === "ascii" ? asciiText(raw) : raw;
          for (const label of [...screen.labels, ...(screen.name === "main" ? always : [])])
            expect(text, `${screen.name}: ${label}`).toContain(label);
          if (icons === "ascii") {
            const odd = [...new Set(text.replace(/[\x20-\x7e\n]/g, ""))];
            expect(odd, `${screen.name} non-ASCII`).toEqual([]);
          } else expect(faint(view.captureSpans(), 3), `${screen.name} faint text`).toEqual([]);
          if (screen.keys.length) await act(async () => view.mockInput.pressEscape());
        }
      } finally {
        await act(async () => view.renderer.destroy());
        await client.dispose();
      }
    });
