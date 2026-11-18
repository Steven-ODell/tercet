import { act, type ReactNode } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import * as Effect from "effect/Effect";
import { composerFixture } from "./composer.test";
import { claude } from "./usage-fixture";
import { ModelPicker } from "./model-picker";
import { ThreadPalette } from "./thread-palette";
import { NewThreadPicker, WorkspacePicker } from "./workspace";
import { createThreadActions } from "./thread-actions";
import { LayoutContext } from "./layout-context";
import { layoutFor, type LayoutMode } from "./layout";

const longModel =
  "Claude Opus 5.5 Extended Thinking Preview With A Very Long Display Name";
const longThread =
  "Beta thread with a long name that goes on and on and on past fifty columns";
const provider = {
  ...claude([]),
  models: [
    { slug: "a", name: longModel, isCustom: false, capabilities: null },
    { slug: "b", name: "Sonnet 5.5", isCustom: false, capabilities: null },
    { slug: "c", name: "Haiku 5.5", isCustom: false, capabilities: null },
    { slug: "d", name: "Fable 5.2", isCustom: false, capabilities: null },
    { slug: "e", name: "Opus 5.5", isCustom: false, capabilities: null },
  ],
};

const BASE_120x40: Record<string, string> = {
  model: [
    "",
    "                      ┌──────────────────────────────────────────────────────────────────────────┐",
    "                      │Model · Favorites first                                                   │",
    "                      │Press / or type to filter all providers…                                  │",
    "                      │High where supported · Fast off · Claude/Codex full access                │",
    "                      │OpenCode asks · change permissions afterward with Alt+e                   │",
    "                      │› ✻ Claude · Claude Opus 5.5 Extended Thinking Preview With A Very Long   │",
    "                      │Display Name                                                              │",
    "                      │  ✻ Claude · Sonnet 5.5                                                   │",
    "                      │  ✻ Claude · Haiku 5.5                                                    │",
    "                      │  ✻ Claude · Fable 5.2                                                    │",
    "                      │  ✻ Claude · Opus 5.5                                                     │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │                                                                          │",
    "                      │j/k or ↑/↓ select · l/Enter choose · right-click favorite · h back        │",
    "                      │[ Esc Close ]                                                             │",
    "                      └──────────────────────────────────────────────────────────────────────────┘",
    "",
    "",
    "",
    "",
    "",
    "",
  ].join("\n"),
  palette: [
    "",
    "",
    "                         ┌────────────────────────────────────────────────────────────────────┐",
    "                         │Actions and thread search                                           │",
    "                         │Type to search…                                                     │",
    "                         │› New thread                                                        │",
    "                         │  Settle                                                            │",
    "                         │  Unsettle                                                          │",
    "                         │  Pin                                                               │",
    "                         │  Unpin                                                             │",
    "                         │  Rename                                                            │",
    "                         │  Archive                                                           │",
    "                         │  Unarchive                                                         │",
    "                         │  Fork                                                              │",
    "                         │  Parent                                                            │",
    "                         │  Delete permanently…                                               │",
    "                         │  Undo last action                                                  │",
    "                         │  Composer thread                                                   │",
    "                         │  Alpha                                                             │",
    "                         │  Beta thread with a long name that goes on and on and on past fifty│",
    "                         │columns                                                             │",
    "                         │  Gamma                                                             │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │                                                                    │",
    "                         │↑/↓ choose · Enter select · Esc close                               │",
    "                         │[ Enter select ] [ Esc Close ]                                      │",
    "                         └────────────────────────────────────────────────────────────────────┘",
    "",
    "",
    "",
    "",
    "",
  ].join("\n"),
  new: [
    "┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐",
    "│New thread                                                                                                            │",
    "│Project                                                                                                               │",
    "│› p · /fixture                                                                                                        │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│j/k project · l/Enter next · Esc close                                                                                │",
    "│[l next] [Esc close]                                                                                                  │",
    "└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
    "",
  ].join("\n"),
  ws: [
    "┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐",
    "│New thread · choose workspace                                                                                         │",
    "│j/k · l/Enter choose · h/Esc back · r Retry                                                                           │",
    "│› main · /fixture                                                                                                     │",
    "│  feature · /fixture-feature                                                                                          │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│                                                                                                                      │",
    "│[r Retry] [Esc close]                                                                                                 │",
    "└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
    "",
  ].join("\n"),
};

/** Rows with the trailing blanks cut, as saved from the base commit. */
const frame = (view: { captureCharFrame(): string }) =>
  view
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

async function fixture(plain = false) {
  const h = await composerFixture();
  h.client.registry.set(h.client.providers, [provider] as never);
  const snap = h.client.registry.get(h.client.snapshot)!;
  const extra = plain
    ? ["Alpha", longThread, "Gamma"]
    : [
        "Alpha",
        longThread,
        "Gamma",
        "Delta",
        "Epsilon",
        "Zeta",
        "Eta",
        "Theta",
      ];
  h.client.registry.set(h.client.snapshot, {
    ...snap,
    projects: plain
      ? snap.projects
      : [
          ...snap.projects,
          ...[
            "Second project with a long title",
            "Third",
            "Fourth",
            "Fifth",
          ].map(
            (title, i) =>
              ({
                ...snap.projects[0]!,
                id: `p${i}`,
                title,
                workspaceRoot: `/home/someone/projects/deeply/nested/${title.split(" ")[0]!.toLowerCase()}`,
              }) as never,
          ),
        ],
    threads: [
      ...snap.threads,
      ...extra.map(
        (title, i) => ({ ...snap.threads[0]!, id: `t${i}`, title }) as never,
      ),
    ],
  });
  h.client.boundary.workspaceRefs = () =>
    Effect.succeed([
      {
        name: "main",
        current: true,
        isDefault: true,
        worktreePath: "/fixture",
      },
      ...(plain
        ? [
            {
              name: "feature",
              current: false,
              isDefault: false,
              worktreePath: "/fixture-feature",
            },
          ]
        : ["one", "two", "three", "four"].map((name) => ({
            name: `feature/${name}-with-a-long-branch-name`,
            current: false,
            isDefault: false,
            worktreePath: `/home/someone/worktrees/${name}/with/a/long/path/to/the/checkout`,
          }))),
    ]);
  return h;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const pickers: Record<string, (h: Fixture) => ReactNode> = {
  model: (h) => (
    <ModelPicker
      client={h.client}
      effort={false}
      close={() => {}}
      width={W}
      height={H}
    />
  ),
  palette: (h) => (
    <ThreadPalette
      client={h.client}
      mode="palette"
      actions={createThreadActions(h.client)}
      close={() => {}}
      width={W}
      height={H}
    />
  ),
  new: (h) => (
    <NewThreadPicker
      client={h.client}
      actions={createThreadActions(h.client)}
      close={() => {}}
    />
  ),
  ws: (h) => (
    <WorkspacePicker
      client={h.client}
      actions={createThreadActions(h.client)}
      close={() => {}}
    />
  ),
};
// The pickers read the size from props or the renderer; `render` sets these before building.
let W = 120;
let H = 40;
async function render(
  name: string,
  h: Fixture,
  width: number,
  height: number,
  mode?: LayoutMode,
) {
  W = width;
  H = height;
  // A mode stands in for the frame's layout (the `layout` setting or TERCET_LAYOUT).
  const picker = pickers[name]!(h);
  const node = mode ? (
    <LayoutContext.Provider value={layoutFor({ width, height, mode })}>
      {picker}
    </LayoutContext.Provider>
  ) : (
    picker
  );
  const view = await testRender(node, {
    width,
    height,
    kittyKeyboard: true,
  });
  await view.waitForFrame((f) => f.length > 0);
  await view.flush();
  await act(async () => {});
  await view.flush();
  return view;
}

test.each(["model", "palette", "new", "ws"])(
  "%s picker at 120x40 is unchanged",
  async (name) => {
    const h = await fixture(true);
    const view = await render(name, h, 120, 40);
    try {
      expect(frame(view)).toBe(BASE_120x40[name]!);
    } finally {
      view.renderer.destroy();
      await h.client.dispose();
    }
  },
);

// The new-thread and workspace pickers look the same either way at these sizes, so only these two.
test.each(["model", "palette"])(
  "%s picker follows the layout setting, not the screen size",
  async (name) => {
    const h = await fixture(true);
    const views = [];
    try {
      // Compact at 120x40 gives the phone picker, still with nothing cut.
      views.push(await render(name, h, 120, 40, "compact"));
      expect(frame(views[0]!)).not.toBe(BASE_120x40[name]!);
      expectWhole(frame(views[0]!), 120, 40);
      // Full at 50x40 keeps the desktop picker.
      views.push(await render(name, h, 50, 40));
      views.push(await render(name, h, 50, 40, "full"));
      expect(frame(views[2]!)).not.toBe(frame(views[1]!));
    } finally {
      for (const view of views) view.renderer.destroy();
      await h.client.dispose();
    }
  },
);

const sizes: [number, number][] = [
  [50, 40],
  [50, 20],
  [50, 14],
  [50, 10],
  [110, 20],
];
/** Whitespace and box borders removed, to find a name that wrapped across rows. */
const flat = (text: string) => text.replace(/[│\s]/g, "");
function expectWhole(text: string, width: number, height: number) {
  const lines = text.replace(/\n$/, "").split("\n");
  expect(lines.length).toBeLessThanOrEqual(height);
  for (const line of lines) {
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    // Nothing cut at the border: a boxed row that opens with │ also closes with it.
    if (line.startsWith("│")) expect(line.trimEnd().endsWith("│")).toBe(true);
  }
  expect(lines.some((l) => l.includes("└"))).toBe(true);
}
const count = (text: string, names: string[]) =>
  names.filter((n) => text.includes(n)).length;

test.each(sizes)("model picker reflows at %ix%i", async (width, height) => {
  const h = await fixture();
  const view = await render("model", h, width, height);
  try {
    const text = frame(view);
    expectWhole(text, width, height);
    expect(text).toContain("Press / or type to filter");
    expect(text).toContain("[ Esc Close ]");
    // The long name is first and wraps whole; the rows after it still show (>= 3 rows).
    expect(flat(text)).toContain(flat(longModel));
    expect(
      text.split("\n").filter((l) => l.includes("…") && !l.includes("filter")),
    ).toEqual([]);
    expect(
      count(text, ["Sonnet 5.5", "Haiku 5.5", "Fable 5.2"]) + 1,
    ).toBeGreaterThanOrEqual(3);
    if (height >= 14) expect(flat(text)).toContain(flat("Tab edit favorite"));
  } finally {
    view.renderer.destroy();
    await h.client.dispose();
  }
});

test("model picker: Tab edits the highlighted model's favorite; the cursor row stays visible", async () => {
  const h = await fixture();
  const view = await render("model", h, 50, 14);
  try {
    for (let i = 0; i < 4; i++) {
      await act(async () => view.mockInput.pressKey("ARROW_DOWN"));
      await view.flush();
    }
    expect(frame(view)).toContain("› ✻ Claude · Opus 5.5");
    await act(async () => view.mockInput.pressKey("TAB"));
    await view.flush();
    const text = frame(view);
    expect(text).toContain("Favorite · ");
    expect(text).toContain("Save as favorite defaults");
    expect(text).toContain("[ Esc Close ]");
  } finally {
    view.renderer.destroy();
    await h.client.dispose();
  }
});

test.each(sizes)("thread palette reflows at %ix%i", async (width, height) => {
  const h = await fixture();
  const view = await render("palette", h, width, height);
  try {
    let text = frame(view);
    expectWhole(text, width, height);
    expect(text).toContain("Type to search");
    expect(text).toContain("[ Esc Close ]");
    expect(text).toContain("[ Enter select ]");
    expect(
      count(text, ["New thread", "Settle", "Unsettle", "Pin"]),
    ).toBeGreaterThanOrEqual(3);
    // Walk to the long thread name: it shows whole, and its row is on screen.
    for (let i = 0; i < 15; i++) {
      await act(async () => view.mockInput.pressKey("ARROW_DOWN"));
      await view.flush();
    }
    text = frame(view);
    expectWhole(text, width, height);
    expect(text).toContain("› ");
    expect(flat(text)).toContain(flat(longThread));
    expect(
      text.split("\n").filter((l) => l.includes("fifty") && l.includes("…")),
    ).toEqual([]);
  } finally {
    view.renderer.destroy();
    await h.client.dispose();
  }
});

test.each(sizes)(
  "new-thread picker reflows at %ix%i",
  async (width, height) => {
    const h = await fixture();
    const view = await render("new", h, width, height);
    try {
      let text = frame(view);
      expectWhole(text, width, height);
      expect(text).toContain("[Esc close]");
      expect(text).toContain("[l next]");
      expect(
        count(text, ["p · /fixture", "Second", "Third", "Fourth"]),
      ).toBeGreaterThanOrEqual(3);
      await act(async () => view.mockInput.pressKey("ARROW_DOWN"));
      await view.flush();
      text = frame(view);
      expect(text).toContain("› Second project with a long title");
      expect(flat(text)).toContain(
        flat("/home/someone/projects/deeply/nested/second"),
      );
      expect(text).not.toContain("…");
    } finally {
      view.renderer.destroy();
      await h.client.dispose();
    }
  },
);

test.each(sizes)("workspace picker reflows at %ix%i", async (width, height) => {
  const h = await fixture();
  const view = await render("ws", h, width, height);
  try {
    await view.waitForFrame(
      (f) => f.includes("Project root") || f.includes("main"),
    );
    let text = frame(view);
    expectWhole(text, width, height);
    expect(text).toContain("[Esc close]");
    expect(text).toContain("[r Retry]");
    expect(
      count(text, ["main", "feature/one", "feature/two", "feature/three"]),
    ).toBeGreaterThanOrEqual(height > 10 ? 3 : 2);
    for (let i = 0; i < 4; i++) {
      await act(async () => view.mockInput.pressKey("ARROW_DOWN"));
      await view.flush();
    }
    text = frame(view);
    expect(text).toContain("› feature/four");
    expect(flat(text)).toContain(
      flat("/home/someone/worktrees/four/with/a/long/path/to/the/checkout"),
    );
    expect(text).not.toContain("…");
  } finally {
    view.renderer.destroy();
    await h.client.dispose();
  }
});

/** The model list grown past what 50x14 can show. */
function manyModels(h: Fixture) {
  const extra = [1, 2, 3, 4, 5, 6].map((n) => ({
    slug: `x${n}`,
    name: `Extra ${n}`,
    isCustom: false,
    capabilities: null,
  }));
  h.client.registry.set(h.client.providers, [
    { ...provider, models: [...provider.models, ...extra] },
  ] as never);
}

/** A finger swipe on the phone arrives only as wheel events. */
async function wheel(
  view: Awaited<ReturnType<typeof render>>,
  direction: "up" | "down",
  n: number,
) {
  for (let i = 0; i < n; i++) {
    await act(async () => view.mockMouse.scroll(10, 6, direction));
    await view.flush();
  }
}

const wheelCases: [string, string, string][] = [
  ["model", "Extra 6", "Sonnet 5.5"],
  ["palette", "Theta", "New thread"],
  ["new", "Fifth", "Second"],
  ["ws", "feature/four", "feature/one"],
];

test.each(wheelCases)(
  "%s picker scrolls with the mouse wheel at 50x14",
  async (name, far, near) => {
    const h = await fixture();
    if (name === "model") manyModels(h);
    const view = await render(name, h, 50, 14);
    try {
      if (name === "ws")
        await view.waitForFrame(
          (f) => f.includes("Project root") || f.includes("main"),
        );
      let text = frame(view);
      expect(text).not.toContain(far);
      expect(text).toContain(
        name === "model" || name === "palette"
          ? "[ Esc Close ]"
          : "[Esc close]",
      );
      const cursorRow = text.split("\n").find((l) => l.includes("› "));
      await wheel(view, "down", 30);
      text = frame(view);
      expectWhole(text, 50, 14);
      expect(flat(text)).toContain(flat(far));
      expect(text).not.toContain("› ");
      // The wheel moves the window, not the cursor: the cursor row is still the first one.
      await wheel(view, "up", 30);
      text = frame(view);
      expectWhole(text, 50, 14);
      expect(flat(text)).toContain(flat(near));
      expect(text.split("\n").find((l) => l.includes("› "))).toBe(cursorRow);
    } finally {
      view.renderer.destroy();
      await h.client.dispose();
    }
  },
);

test("model picker: a key press after the wheel brings the cursor row back", async () => {
  const h = await fixture();
  manyModels(h);
  const view = await render("model", h, 50, 14);
  try {
    await wheel(view, "down", 30);
    expect(frame(view)).not.toContain("› ");
    await act(async () => view.mockInput.pressKey("ARROW_DOWN"));
    await view.flush();
    expect(frame(view)).toContain("› ✻ Claude · Sonnet 5.5");
  } finally {
    view.renderer.destroy();
    await h.client.dispose();
  }
});
