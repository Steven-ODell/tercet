// The README demo: the real frame on made-up threads, no server or token. Nothing here is real
// data; scripts/demo/record drives it in a private tmux and records it.
//   bun scripts/demo/app.tsx
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { editorAction } from "../../src/embedded-editor";
import { hostActions, systemHost } from "../../src/portable";
import { defaultSettings } from "../../src/client/settings";
import { terminalLifecycle } from "../../src/terminal-lifecycle";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { createClient, waitForLive } from "../../src/client/runtime";
import { AppFrame } from "../../src/client/frame";
import { baseThread } from "../../src/client/sidebar-fixture";
import { emptyTranscript } from "../../src/client/transcript-state";
import { loadPreviewImage } from "../../src/client/image-preview-source";
import { decideMedia, setMedia } from "../../src/client/media";
import type { Actions } from "../../src/actions";

const nowIso = "2026-11-12T17:30:00.000Z";
const at = DateTime.makeUnsafe(nowIso);
const image = resolve(import.meta.dir, "night-sky.png");
// Only the appended feature recording enables real I/O, inside its disposable workspace.
const workspace = process.env.TERCET_DEMO_WORKSPACE;

const project = (id: string, title: string) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: workspace ?? `/home/demo/${id}`,
  projectIcon: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: nowIso,
  updatedAt: nowIso,
});

const thread = (
  id: string,
  projectId: string,
  minutesAgo: number,
  title: string,
  extra: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...baseThread,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
  id: ThreadId.make(id),
  projectId: ProjectId.make(projectId),
  title,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  createdAt: DateTime.subtract(at, { minutes: minutesAgo }),
  updatedAt: DateTime.subtract(at, { minutes: minutesAgo }),
  ...extra,
});

const snapshot: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 1,
  archivedThreads: [],
  projects: [project("weather-cli", "weather-cli"), project("pixel-garden", "pixel-garden")],
  threads: [
    thread("retry", "weather-cli", 3, "Fix the flaky retry test in fetchForecast"),
    thread("sky", "pixel-garden", 9, "Why does the night sky scene render so dark?"),
    thread("units", "weather-cli", 21, "Rename the Celsius toggle to Units"),
    thread("json", "weather-cli", 1, "Add a --json flag to the forecast command", {
      status: "running",
    }),
    thread("notes", "pixel-garden", 48, "Draft the 0.3 release notes", {
      pinnedAt: at,
      pinOrderKey: "a",
    }),
    thread("lint", "pixel-garden", 300, "Set up the lint config", {
      settledOverride: "settled",
      settledAt: DateTime.subtract(at, { hours: 5 }),
    }),
  ],
};

let n = 0;
const rows = (threadId: string, items: [type: string, values: object][]) =>
  items.map(([type, values]) => {
    const id = `${threadId}-${n++}`;
    return {
      sourceThreadId: threadId,
      sourceItemId: id,
      item: { id, type, status: "completed", runId: `${threadId}-run`, ...values },
    };
  });

const conversations: Record<string, [type: string, values: object][]> = {
  retry: [
    [
      "user_message",
      { text: "The retry test in fetchForecast fails about one run in ten. Fix it?" },
    ],
    ["command_execution", { input: "rg -n 'retry' src/forecast.ts test/forecast.test.ts" }],
    ["command_execution", { input: "bun test test/forecast.test.ts --rerun-each 20" }],
    [
      "assistant_message",
      {
        text: [
          "The test waits a fixed 50 ms for the second attempt, but the backoff adds up to 40 ms",
          "of jitter, so a slow machine sometimes misses it. I made the clock injectable and the",
          "test now advances it instead of sleeping.",
          "",
          "- `fetchForecast` takes an optional `clock`",
          "- the test passes a fake clock and calls `clock.tick(100)`",
          "",
          "Run it a few hundred times to be sure:",
          "",
          "```sh",
          "bun test test/forecast.test.ts --rerun-each 200",
          "```",
        ].join("\n"),
      },
    ],
  ],
  sky: [
    [
      "user_message",
      {
        text: "This is the night scene after the palette change. Why is it so dark?",
        attachments: [
          {
            type: "image",
            id: "night-sky",
            name: "night-sky.png",
            mimeType: "image/png",
            sizeBytes: 18_199,
          },
        ],
      },
    ],
    [
      "assistant_message",
      {
        text: [
          "The sky gradient now ends at `#3b2a6b`, and the ambient light still multiplies by 0.6,",
          "which was tuned for the old, brighter palette. Raise it to 0.85:",
          "",
          "```ts",
          "export const ambient = { night: 0.85, day: 1 };",
          "```",
        ].join("\n"),
      },
    ],
  ],
  units: [
    ["user_message", { text: "Rename the Celsius toggle to Units and keep the old flag working." }],
    ["command_execution", { input: "rg -n 'celsius' src" }],
    [
      "assistant_message",
      {
        text: "Done. `--celsius` still works and prints a one-line notice. The diff is in the panel.",
      },
    ],
  ],
  json: [
    ["user_message", { text: "Add a --json flag to `weather forecast`." }],
    ["command_execution", { input: "rg -n 'parseArgs' src/cli.ts" }],
  ],
  notes: [["user_message", { text: "Draft the 0.3 release notes from the merged PRs." }]],
  lint: [["user_message", { text: "Set up the lint config." }]],
};

const diff = [
  "diff --git a/src/cli.ts b/src/cli.ts",
  "--- a/src/cli.ts",
  "+++ b/src/cli.ts",
  "@@ -12,9 +12,12 @@ export function parseArgs(argv: string[]) {",
  "   const flags = {",
  "     city: argv[0] ?? 'here',",
  "-    celsius: argv.includes('--celsius'),",
  "+    units: argv.includes('--celsius') ? 'metric' : readUnits(argv),",
  "   };",
  "+  if (argv.includes('--celsius'))",
  "+    console.error('--celsius is now --units metric');",
  "   return flags;",
  " }",
  "diff --git a/src/settings.ts b/src/settings.ts",
  "--- a/src/settings.ts",
  "+++ b/src/settings.ts",
  "@@ -3,5 +3,5 @@",
  " export const labels = {",
  "-  celsius: 'Celsius',",
  "+  units: 'Units',",
  "   city: 'City',",
  " };",
  "",
].join("\n");

const projection = (threadId: string) =>
  ({
    thread: snapshot.threads.find((t) => t.id === threadId),
    ...Object.fromEntries(
      [
        "runs",
        "attempts",
        "nodes",
        "subagents",
        "providerSessions",
        "providerThreads",
        "providerTurns",
        "runtimeRequests",
        "plans",
        "turnItems",
        "checkpointScopes",
        "contextHandoffs",
        "contextTransfers",
      ].map((key) => [key, []]),
    ),
    updatedAt: at,
    messages: [{ id: `${threadId}-m`, role: "assistant", runId: `${threadId}-run` }],
    checkpoints:
      threadId === "units"
        ? [
            {
              runId: `${threadId}-run`,
              appRunOrdinal: 1,
              status: "ready",
              files: [],
              capturedAt: at,
            },
          ]
        : [],
    visibleTurnItems: rows(threadId, conversations[threadId] ?? []),
  }) as unknown as OrchestrationV2ThreadProjection;

setMedia(
  decideMedia({
    setting: "blocks",
    env: process.env,
    replies: null,
    tmux: { inside: false, passthrough: null, client: null },
  }),
);

const client = createClient(
  {
    readToken: () => Effect.succeed("demo"),
    issueToken: () => Effect.die("no issuance"),
    wake: () => Effect.void,
    pause: () => Effect.never,
    follow: (_, receive) =>
      Effect.sync(() => receive({ kind: "snapshot", snapshot })).pipe(Effect.andThen(Effect.never)),
  },
  false,
  () => Date.parse(nowIso),
);
client.registry.set(client.snapshot, snapshot);
client.registry.set(client.status, "live");
client.registry.set(
  client.transcripts,
  new Map(
    snapshot.threads.map((t) => [t.id, { ...emptyTranscript, projection: projection(t.id) }]),
  ),
);
client.diffs.full = async (input) => ({ ...input, fromTurnCount: 0, diff });

// Preserve the original fixture when no feature-recording workspace is supplied.
const embedded = editorAction("http://127.0.0.1");
const settings = defaultSettings();
settings.launchers = { editor: ["nvim", "--clean", "--", "{path}"], editorMode: "tmux" };
if (workspace) {
  client.files.list = async () => ({
    entries: (await readdir(workspace, { withFileTypes: true })).map((entry) => ({
      path: entry.name,
      kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    })),
    truncated: false,
  });
  client.files.read = async ({ relativePath }) => {
    const contents = await readFile(resolve(workspace, relativePath), "utf8");
    return { relativePath, contents, byteLength: Buffer.byteLength(contents), truncated: false };
  };
  client.boundary.terminal = (_, input, receive, bind) =>
    Effect.callback(() => {
      const child = Bun.spawn(["bash", "--noprofile", "--norc", "-i"], {
        cwd: workspace,
        env: { ...process.env, PS1: "$ ", TERM: "xterm-256color", HISTFILE: "/dev/null" },
        terminal: {
          cols: input.cols,
          rows: input.rows,
          data: (_, bytes) =>
            receive({
              type: "output",
              threadId: input.threadId,
              terminalId: input.terminalId,
              data: Buffer.from(bytes).toString("utf8"),
            }),
        },
      });
      receive({
        type: "snapshot",
        snapshot: {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: workspace,
          worktreePath: null,
          status: "running",
          pid: child.pid,
          history: "",
          label: "bash",
          exitCode: null,
          exitSignal: null,
          updatedAt: nowIso,
        },
      });
      bind((op) => {
        if (op.kind === "write") child.terminal?.write(op.data);
        else if (op.kind === "resize") child.terminal?.resize(op.cols, op.rows);
      });
      return Effect.sync(() => {
        child.kill();
        child.terminal?.close();
      });
    });
  client.start();
  await waitForLive(client);
}

// Original transcript actions remain harmless fixture actions.
const effects: Actions = {
  copy() {},
  run: async () => {},
  openUrl: async () => {},
  openImage: async () => {},
  loadImage: (source, cwd) => loadPreviewImage(source, cwd, async () => image),
  ...(workspace
    ? {
        embeddedEditor: embedded.open,
        editor: hostActions({ settings, host: systemHost(), writeTerminal() {} }).editor,
      }
    : {}),
};

const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
terminalLifecycle(renderer, async () => {
  embedded.dispose();
  await client.dispose();
});
createRoot(renderer).render(<AppFrame client={client} effects={effects} />);
