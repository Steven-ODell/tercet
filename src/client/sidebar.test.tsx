import { parseColor } from "@opentui/core";
import { theme } from "./theme";
import { paneGlyphs } from "./icons";
import { act } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  MessageId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  createInboxReturnTracker,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import {
  ThreadSidebar,
  sidebarTimeLabel,
  sidebarEntries,
  sidebarRows,
  truncateName,
  threadBadge,
  wrapName,
  type SidebarShelf,
} from "./sidebar";
import { projectColor } from "./project-color";
import { baseThread as base, fixtureNow, flatFixture } from "./sidebar-fixture";
import { createClient, waitForLive } from "./runtime";
import { AppFrame } from "./frame";
import { platform, readOptional } from "./platform";
import { connectionConfig } from "./config";
import { sandboxUrl, tokenPath } from "../spikes/connect";

const projectId = Schema.decodeUnknownSync(ProjectId);
const threadId = Schema.decodeUnknownSync(ThreadId);
const messageId = Schema.decodeUnknownSync(MessageId);
const at = DateTime.makeUnsafe("2026-11-08T12:00:00Z");
function fixture(): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    archivedThreads: [],
    projects: ["a", "b"].map((id) => ({
      id: projectId(`project-${id}`),
      title: `Project ${id.toUpperCase()}`,
      workspaceRoot: `/fixture/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-08T12:00:00Z",
      updatedAt: "2026-11-08T12:00:00Z",
    })),
    threads: [
      { ...base, pinnedAt: at },
      {
        ...base,
        id: threadId("two"),
        title: "A long thread name that overflows with an ellipsis",
        updatedAt: DateTime.add(at, { hours: 1 }),
      },
      { ...base, id: threadId("settled"), title: "Hidden history", settledOverride: "settled" },
      ...["mcp", "server", "provider"].map((source) => ({
        ...base,
        id: threadId(source),
        creationSource: source as "mcp" | "server" | "provider",
        title: `Machine ${source}`,
      })),
      { ...base, id: threadId("other"), projectId: projectId("project-b"), title: "Other project" },
    ],
  };
}
function fakeClient() {
  return createClient(
    {
      readToken: () => Effect.succeed("fake"),
      issueToken: () => Effect.die("no issuance"),
      wake: () => Effect.void,
      pause: () => Effect.never,
      follow: () => Effect.never,
    },
    false,
  );
}
const shelves = (...names: SidebarShelf[]) => new Set(names);
const presented = (snapshot: OrchestrationV2ShellSnapshot) =>
  snapshot.threads.map((thread) => presentThreadShell(EnvironmentId.make("tercet"), thread));
const flat = (shelf: ReadonlySet<SidebarShelf> = shelves()) =>
  sidebarEntries(flatFixture(), { now: fixtureNow, expanded: shelf });

test("threads from two projects interleave in the shared functions' order with no project rows", () => {
  const snapshot = flatFixture();
  const shells = presented(snapshot);
  const entries = flat();
  const pick = (...ids: string[]) => shells.filter((shell) => ids.includes(shell.id));
  const pinned = sortPinnedThreadsByOrderKey(pick("pin-a", "pin-b"));
  const active = sortActiveThreadsByOrderKey(
    pick("active-a-new", "active-a-old", "active-b-new", "active-b-old", "snooze-woken", "machine"),
  );
  expect(entries.map((entry) => entry.key)).toEqual([
    ...pinned.map((shell) => shell.id),
    ...active.map((shell) => shell.id),
    "shelf:snoozed",
    "shelf:settled",
  ]);
  const activeKeys = entries.filter((e) => e.key.startsWith("active-")).map((e) => e.key);
  expect(activeKeys).toEqual(["active-a-new", "active-b-new", "active-a-old", "active-b-old"]);
  expect(entries.filter((e) => e.key.startsWith("active-")).map((e) => e.project)).toEqual([
    "Alpha repo",
    "Beta repo",
    "Alpha repo",
    "Beta repo",
  ]);
  expect(entries.every((entry) => entry.thread || entry.shelf || entry.more)).toBe(true);
  expect(entries.some((entry) => /repo/.test(entry.text))).toBe(false);
});

test("section rules match web: snooze over settled over pin, and hidden threads stay hidden", () => {
  const keys = flat(shelves("snoozed", "settled")).map((entry) => entry.key);
  for (const hidden of ["subagent", "archived", "deleted"]) expect(keys).not.toContain(hidden);
  expect(keys.indexOf("snooze-woken")).toBeLessThan(keys.indexOf("shelf:snoozed"));
  expect(keys.indexOf("settled-00")).toBeGreaterThan(keys.indexOf("shelf:settled"));

  const snapshot = flatFixture();
  const both = sidebarEntries(
    {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === "snooze-soon" ? { ...thread, settledOverride: "settled" as const } : thread,
      ),
    },
    { now: fixtureNow, expanded: shelves("snoozed") },
  ).map((entry) => entry.key);
  expect(both.slice(both.indexOf("shelf:snoozed") + 1, both.indexOf("shelf:settled"))).toEqual([
    "snooze-soon",
    "snooze-late",
  ]);
});

test("shelves collapse by default, count, sort soonest wake first and page settled threads", () => {
  const collapsed = flat();
  expect(collapsed.find((e) => e.shelf === "snoozed")?.text).toBe("▸ Snoozed (2)");
  expect(collapsed.find((e) => e.shelf === "settled")?.text).toBe("▸ Settled (12)");
  expect(collapsed.some((e) => e.more)).toBe(false);

  const open = flat(shelves("snoozed", "settled"));
  const keys = open.map((e) => e.key);
  expect(open.find((e) => e.shelf === "snoozed")?.text).toBe("▾ Snoozed");
  expect(keys.slice(keys.indexOf("shelf:snoozed") + 1, keys.indexOf("shelf:settled"))).toEqual([
    "snooze-soon",
    "snooze-late",
  ]);
  const settled = sortSettledThreads(
    presented(flatFixture()).filter((shell) => shell.id.startsWith("settled-")),
  );
  expect(keys.slice(keys.indexOf("shelf:settled") + 1, -1)).toEqual(
    settled.slice(0, 10).map((shell) => shell.id),
  );
  expect(open.at(-1)?.text).toBe("+ Show 2 more");
  expect(open.at(-1)?.more).toBe(settled[10]!.id);
  const all = sidebarEntries(flatFixture(), {
    now: fixtureNow,
    expanded: shelves("settled"),
    settledVisible: 35,
  });
  expect(all.some((e) => e.more)).toBe(false);
  expect(all.filter((e) => e.key.startsWith("settled-")).length).toBe(12);
  expect(all.at(-1)?.key).toBe(settled[11]!.id);

  // The open thread stays visible behind a collapsed shelf and past the settled page.
  const deep = settled[11]!.id;
  const pulled = sidebarEntries(flatFixture(), { now: fixtureNow, selected: deep });
  expect(pulled.at(-2)?.key).toBe("shelf:settled");
  expect(pulled.at(-1)?.key).toBe(deep);
  const paged = sidebarEntries(flatFixture(), {
    now: fixtureNow,
    selected: deep,
    expanded: shelves("settled"),
  });
  expect(paged.at(-1)?.text).toBe("+ Show 1 more");
  expect(paged.at(-2)?.key).toBe(deep);
});

test("Working shelf stays off by default and uses the shared inbox and working sorts", () => {
  const snapshot = flatFixture();
  const requested = new Map([
    ["active-a-old", "2026-11-08T11:59:00Z"],
    ["active-b-new", "2026-11-08T11:58:00Z"],
  ]);
  const threads = snapshot.threads.map((thread) => {
    const at = requested.get(thread.id);
    return at
      ? {
          ...thread,
          status: "running" as const,
          activeRunId: `run-${thread.id}` as never,
          latestRunId: `run-${thread.id}` as never,
          latestRunRequestedAt: DateTime.makeUnsafe(at),
        }
      : thread;
  });
  const working = { ...snapshot, threads };
  expect(sidebarEntries(working, { now: fixtureNow }).some((e) => e.shelf === "working")).toBe(
    false,
  );
  const entries = sidebarEntries(working, {
    now: fixtureNow,
    workingShelf: true,
    inboxReturns: createInboxReturnTracker(),
    expanded: shelves("working"),
  });
  const keys = entries.map((e) => e.key);
  const shells = presented(working);
  const inboxIds = new Set(["active-a-new", "active-b-old", "snooze-woken", "machine"]);
  const workingIds = new Set(["active-a-old", "active-b-new"]);
  const inbox = sortInboxThreadsByReturn(shells.filter((s) => inboxIds.has(s.id)));
  const folded = sortWorkingThreadsBySend(shells.filter((s) => workingIds.has(s.id)));
  expect(keys.slice(2, keys.indexOf("shelf:working"))).toEqual(inbox.map((s) => s.id));
  expect(keys.slice(keys.indexOf("shelf:working") + 1, keys.indexOf("shelf:snoozed"))).toEqual(
    folded.map((s) => s.id),
  );
  expect(entries.find((e) => e.shelf === "working")?.text).toBe("▾ Working");
  const collapsed = sidebarEntries(working, { now: fixtureNow, workingShelf: true });
  expect(collapsed.find((e) => e.shelf === "working")?.text).toBe("▸ Working (2)");
});

test("compact ages match web, including future times and minute/hour/day boundaries", () => {
  const now = Date.parse(fixtureNow);
  for (const [age, label] of [
    [-60, "now"],
    [0, "now"],
    [59, "now"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h"],
    [86399, "23h"],
    [86400, "1d"],
    [259200, "3d"],
  ] as const) {
    expect(sidebarTimeLabel(new Date(now - age * 1000).toISOString(), now)).toBe(label);
  }
  expect(sidebarTimeLabel(null, now)).toBe("");
  expect(sidebarTimeLabel("invalid", now)).toBe("");
});

test("ages use the last user interaction and settled completion, as on web", () => {
  const snapshot = {
    ...fixture(),
    threads: [
      { ...base, latestUserMessageAt: DateTime.subtract(at, { minutes: 5 }), updatedAt: at },
    ],
  };
  const entries = sidebarEntries(snapshot, { now: fixtureNow });
  expect(entries[0]?.timeLabel).toBe("5m");
  const settled = {
    ...snapshot,
    threads: [
      {
        ...snapshot.threads[0]!,
        settledOverride: "settled" as const,
        settledAt: DateTime.subtract(at, { minutes: 2 }),
      },
    ],
  };
  expect(
    sidebarEntries(settled, { now: fixtureNow, expanded: shelves("settled") }).find((e) => e.thread)
      ?.timeLabel,
  ).toBe("2m");
  const fallback = {
    ...snapshot,
    threads: [{ ...base, updatedAt: DateTime.subtract(at, { hours: 3 }) }],
  };
  expect(sidebarEntries(fallback, { now: fixtureNow })[0]?.timeLabel).toBe("3h");
});

test.each([20, 32])(
  "a long title ends in an ellipsis on one row and the age stays bottom right at width %i",
  async (width) => {
    const client = fakeClient();
    const snapshot = {
      ...fixture(),
      threads: [
        {
          ...base,
          title: "Complete 界界 thread name that overflows",
          latestUserMessageAt: DateTime.subtract(at, { minutes: 5 }),
        },
      ],
    };
    client.registry.set(client.snapshot, snapshot);
    const view = await testRender(
      <ThreadSidebar client={client} width={width} height={20} enabled keyboardEnabled />,
      { width, height: 20 },
    );
    try {
      await view.flush();
      const entry = sidebarEntries(snapshot, { now: new Date(client.now()).toISOString() })[0]!;
      const lines = view.captureCharFrame().split("\n");
      const ageRow = lines.findIndex((line) => line.endsWith(entry.timeLabel!));
      expect(Bun.stringWidth(lines[ageRow]!)).toBe(width);
      // Title row, then the age row: no wrapped rows between them.
      const titleRow = lines.findIndex((line) => line.includes("Complete"));
      expect(titleRow).toBeGreaterThan(0);
      expect(ageRow).toBe(titleRow + 1);
      expect(lines[titleRow]!.trimEnd().endsWith("…")).toBe(true);
      expect(Bun.stringWidth(lines[titleRow]!.trimEnd())).toBeLessThanOrEqual(width);
      const rows = sidebarRows([entry], width);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => !row.projectText.includes("\n"))).toBe(true);
      await act(async () => {
        await view.mockMouse.click(width - 1, ageRow);
      });
      expect(client.registry.get(client.selectedThreadId)).toBe(base.id);
    } finally {
      await act(async () => view.renderer.destroy());
      await client.dispose();
    }
  },
);

test("a line separates one thread from the next, but not a thread from a shelf header", () => {
  const rows = sidebarRows(flat(), 20);
  const rules = rows.filter((r) => r.rule);
  expect(rules.length).toBeGreaterThan(0);
  expect(rules.every((r) => r.text === "─".repeat(20) && r.entry.thread)).toBe(true);
  const entries = flat();
  const last = entries.filter((e) => e.thread).at(-1)!;
  expect(rows.some((r) => r.rule && r.entry === last)).toBe(false);
});

test("the machine filter is reversible and thread rows truncate to one line while wrapName stays lossless", () => {
  const snapshot = flatFixture();
  expect(flat().some((e) => e.key === "machine")).toBe(true);
  expect(
    sidebarEntries(snapshot, { now: fixtureNow, hideMachine: true }).some(
      (e) => e.key === "machine",
    ),
  ).toBe(false);
  const name = "Wide 界界 e\u0301 👩‍💻 complete name";
  const lines = wrapName(name, 8);
  expect(lines.join("")).toBe(name);
  expect(lines.every((line) => Bun.stringWidth(line) <= 8)).toBe(true);
  const rows = sidebarRows(flat(), 20).filter((r) => r.entry.key === "active-a-old" && !r.rule);
  // Title row and status row, whatever the title length.
  expect(rows).toHaveLength(2);
  expect(rows[0]!.text.trimEnd().endsWith("…")).toBe(true);
  expect(
    rows.every((r) => Bun.stringWidth(r.lead + r.text + r.projectText + r.timeText) <= 20),
  ).toBe(true);
  // A title that fits is untouched, and wide glyphs are never split.
  expect(truncateName("Short", 20)).toBe("Short");
  expect(truncateName("界界界界", 6)).toBe("界界…");
  expect(truncateName("e\u0301e\u0301e\u0301e\u0301", 3)).toBe("e\u0301e\u0301…");
  // The project shares the status row when there is room and is cut with an ellipsis otherwise.
  const roomy = sidebarRows([{ key: "x", text: "Name\n▶ running", project: "Alpha" }], 30);
  expect(roomy).toHaveLength(2);
  expect(roomy[1]!.projectText).toBe(" · Alpha");
  const narrow = sidebarRows(
    [{ key: "x", text: "Name\n▶ running", project: "A very long project name", timeLabel: "5m" }],
    24,
  );
  expect(narrow).toHaveLength(2);
  expect(narrow[1]!.projectText.endsWith("…")).toBe(true);
  expect(narrow[1]!.timeText.endsWith("5m")).toBe(true);
  expect(
    narrow.every((r) => Bun.stringWidth(r.lead + r.text + r.projectText + r.timeText) <= 24),
  ).toBe(true);
});

test("project names use web's icon color: the saved icon, else one generated from the title", () => {
  const icon = { kind: "lucide", name: "monitor", color: "red" } as const;
  expect(projectColor({ title: "demo-hub", projectIcon: icon })).toBe("#ff6467");
  expect(
    projectColor({
      title: "Mobile App",
      projectIcon: { kind: "lucide", name: "smartphone", color: "purple" },
    }),
  ).toBe("#c27aff");
  expect(
    projectColor({ title: "mono", projectIcon: { kind: "monogram", text: "M", color: "blue" } }),
  ).toBe("#51a2ff");
  // Expected values come from apps/web's deriveProjectIdentity.
  expect(projectColor({ title: "demo-hub" })).toBe("#9ae600");
  expect(projectColor({ title: "mobile-app", projectIcon: null })).toBe("#ff8904");
  expect(projectColor({ title: "t3code" })).toBe("#00d5be");
  expect(projectColor({ title: "emoji", projectIcon: { kind: "emoji", emoji: "🚀" } })).toBe(
    "#9180ad",
  );
  const entries = sidebarEntries(flatFixture(), { now: fixtureNow });
  expect(entries.find((e) => e.project === "Alpha repo")?.projectColor).toBe("#ff6467");
  expect(entries.find((e) => e.project === "Beta repo")?.projectColor).toBe(
    projectColor({ title: "Beta repo" }),
  );
});

test("status glyphs include request priority, unread and limit reset", () => {
  expect(threadBadge({ ...base, status: "running" })).toContain("▶");
  expect(threadBadge({ ...base, status: "waiting" })).toContain("?");
  expect(threadBadge({ ...base, status: "failed" })).toContain("×");
  expect(
    threadBadge({
      ...base,
      latestVisibleMessage: {
        id: messageId("msg"),
        role: "assistant",
        text: "done",
        updatedAt: at,
      },
    }),
  ).toContain("●");
  expect(
    threadBadge({
      ...base,
      lastErrorClass: "usage_limit",
      usageLimitResetAt: "2026-11-08T13:00:00Z",
    }),
  ).toContain("reset 2026-11-08T13:00:00Z");
});
test.each([
  [120, 40],
  [80, 24],
])(
  "sidebar rows are one line, click/Enter opens and settled/filter toggle at %ix%i",
  async (width, height) => {
    const client = fakeClient();
    client.registry.set(client.snapshot, fixture());
    client.registry.set(client.status, "live");
    const view = await testRender(<AppFrame client={client} />, {
      width,
      height,
      kittyKeyboard: true,
      exitOnCtrlC: false,
    });
    const click = async (x: number, y: number) => {
      await act(async () => {
        await view.mockMouse.click(x, y);
      });
      await view.flush();
    };
    const key = async (name: string) => {
      await act(async () => {
        view.mockInput.pressKey(name);
      });
      await view.flush();
    };
    try {
      await view.flush();
      expect(view.captureCharFrame()).toContain("Project");
      expect(view.captureCharFrame()).toContain("Pinned older");
      const yOf = (text: string) =>
        view
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes(text));
      await click(5, yOf("Pinned older"));
      expect(client.registry.get(client.selectedThreadId)).toBe(threadId("one"));
      await key("ARROW_DOWN");
      await key("RETURN");
      expect(client.registry.get(client.selectedThreadId)).toBe(threadId("mcp"));
      await key("h");
      expect(view.captureCharFrame()).toContain("Human only");
      expect(view.captureCharFrame()).not.toContain("Machine server");
      await click(5, yOf("A long thread"));
      expect(client.registry.get(client.selectedThreadId)).toBe(threadId("two"));
      expect(view.captureCharFrame()).toContain("with an ellipsis");
      await key("END");
      const y = yOf("Settled (1)");
      expect(y).toBeGreaterThan(0);
      await click(5, y);
      // The revealed thread sits below the viewport until the cursor walks to it.
      await key("ARROW_DOWN");
      expect(view.captureCharFrame()).toContain("Hidden history");
      await key("ARROW_UP");
      await key("RETURN");
      expect(view.captureCharFrame()).not.toContain("Hidden history");
    } finally {
      await act(async () => view.renderer.destroy());
      await client.dispose();
    }
  },
);
test("l opens the thread under the cursor and moves focus to the transcript; Enter stays put", async () => {
  const client = fakeClient();
  client.now = () => Date.parse(fixtureNow);
  client.registry.set(client.snapshot, flatFixture());
  client.registry.set(client.status, "live");
  const view = await testRender(<AppFrame client={client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const key = async (name: string) => {
    await act(async () => {
      view.mockInput.pressKey(name);
    });
    await view.flush();
  };
  const frame = () => view.captureCharFrame();
  const selected = () => client.registry.get(client.selectedThreadId);
  const focusSidebar = () =>
    act(async () => {
      await view.mockMouse.click(
        5,
        frame()
          .split("\n")
          .findIndex((l) => l.includes("Alpha pinned")),
      );
    });
  try {
    await view.flush();
    await focusSidebar();
    await view.flush();
    expect(selected()).toBe(threadId("pin-a"));
    await key("j");
    await key("RETURN");
    expect(selected()).toBe(threadId("pin-b"));
    expect(frame()).toContain(`● ${paneGlyphs.sidebar} Threads`);
    await key("j");
    await key("l");
    expect(selected()).toBe(threadId("machine"));
    expect(frame()).toContain(`● ${paneGlyphs.transcript} Transcript`);
    // Focus left the sidebar, so a second l is no longer an open.
    await key("k");
    await key("l");
    expect(selected()).toBe(threadId("machine"));
    await focusSidebar();
    await view.flush();
    await key("ARROW_RIGHT");
    expect(selected()).toBe(threadId("pin-a"));
    expect(frame()).toContain(`● ${paneGlyphs.transcript} Transcript`);
  } finally {
    await act(async () => view.renderer.destroy());
    await client.dispose();
  }
});
test("a palette jump moves the sidebar highlight to the opened thread", async () => {
  const client = fakeClient();
  client.now = () => Date.parse(fixtureNow);
  client.registry.set(client.snapshot, flatFixture());
  client.registry.set(client.status, "live");
  const view = await testRender(<AppFrame client={client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const press = async (name: string, modifiers?: { ctrl?: boolean }) => {
    await act(async () => {
      view.mockInput.pressKey(name, modifiers);
    });
    await view.flush();
  };
  const highlighted = () => {
    const want = parseColor(theme.highlight);
    return view
      .captureSpans()
      .lines.filter((line) =>
        line.spans.some((s) => s.text.trim() && s.bg.a > 0 && s.bg.equals(want)),
      )
      .map((line) => line.spans.map((s) => s.text).join(""));
  };
  try {
    await view.flush();
    await act(async () => {
      await view.mockMouse.click(
        5,
        view
          .captureCharFrame()
          .split("\n")
          .findIndex((l) => l.includes("Alpha pinned")),
      );
    });
    await view.flush();
    await press("j");
    expect(highlighted().join("\n")).toContain("Beta pinned second");
    await press("p", { ctrl: true });
    await act(async () => {
      await view.mockInput.typeText("Alpha newest");
    });
    await view.flush();
    await press("RETURN");
    expect(client.registry.get(client.selectedThreadId)).toBe(threadId("active-a-new"));
    const rows = highlighted().join("\n");
    expect(rows).toContain("Alpha newest active thread");
    expect(rows).not.toContain("Beta pinned second");
  } finally {
    await act(async () => view.renderer.destroy());
    await client.dispose();
  }
});
test("keyboard walks the flat list, opens threads, toggles shelves and shows more", async () => {
  const client = fakeClient();
  client.now = () => Date.parse(fixtureNow);
  client.registry.set(client.snapshot, flatFixture());
  client.registry.set(client.status, "live");
  const view = await testRender(<AppFrame client={client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const key = async (name: string, times = 1) => {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        view.mockInput.pressKey(name);
      });
      await view.flush();
    }
  };
  const frame = () => view.captureCharFrame();
  const selected = () => client.registry.get(client.selectedThreadId);
  try {
    await view.flush();
    await act(async () => {
      await view.mockMouse.click(
        5,
        frame()
          .split("\n")
          .findIndex((l) => l.includes("Alpha pinned")),
      );
    });
    await view.flush();
    expect(selected()).toBe(threadId("pin-a"));
    // pin-a, pin-b, machine, snooze-woken, then the interleaved active threads.
    await key("ARROW_DOWN", 2);
    await key("RETURN");
    expect(selected()).toBe(threadId("machine"));
    await key("ARROW_DOWN", 2);
    await key("RETURN");
    expect(selected()).toBe(threadId("active-a-new"));
    await key("ARROW_DOWN");
    await key("RETURN");
    expect(selected()).toBe(threadId("active-b-new"));
    expect(frame()).not.toContain("Settled history");
    await key("END");
    // active-a-old, active-b-old, Snoozed header.
    await key("ARROW_DOWN", 3);
    await key("RETURN");
    expect(frame()).toContain("Beta snoozed for an hour");
    expect(frame()).toContain("▾ Snoozed");
    await key("RETURN");
    expect(frame()).not.toContain("Beta snoozed for an hour");
    expect(frame()).toContain("▸ Snoozed (2)");
    await key("ARROW_DOWN");
    await key("RETURN");
    expect(frame()).toContain("▾ Settled");
    await key("END");
    expect(frame()).toContain("+ Show 2 more");
    await key("ARROW_DOWN", 11);
    await key("RETURN");
    expect(frame()).not.toContain("Show 2 more");
    // Show more moved the cursor onto the first revealed thread; walking down scrolls to it.
    await key("ARROW_DOWN");
    expect(frame()).toContain("Settled history 10");
    await key("ARROW_UP");
    await key("RETURN");
    expect(selected()).toBe(threadId("settled-10"));
    await key("END");
    expect(frame()).toContain("Settled history 11");
  } finally {
    await act(async () => view.renderer.destroy());
    await client.dispose();
  }
});
const integration = process.env.TERCET_SANDBOX_TEST === "1" ? test : test.skip;
integration(
  "sandbox snapshot lists, wraps, collapses and opens real threads",
  async () => {
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
      const snapshot = client.registry.get(client.snapshot)!;
      const entries = sidebarEntries(snapshot);
      const first = entries.find((e) => e.thread);
      expect(first).toBeDefined();
      const settledSnapshot = {
        ...snapshot,
        threads: snapshot.threads.map((t) => ({ ...t, settledOverride: "settled" as const })),
      };
      const collapsed = sidebarEntries(settledSnapshot);
      expect(collapsed.some((e) => e.shelf === "settled" && e.text.includes("Settled ("))).toBe(
        true,
      );
      expect(collapsed.some((e) => e.thread)).toBe(false);
      const view = await testRender(<AppFrame client={client} />, {
        width: 120,
        height: 40,
        exitOnCtrlC: false,
      });
      try {
        await view.flush();
        expect(view.captureCharFrame()).toContain(entries[0]!.text.slice(0, 16));
        const rows = sidebarRows(entries, 28);
        const y = rows.findIndex((row) => row.entry === first) + 4;
        await act(async () => {
          await view.mockMouse.click(5, y);
        });
        await view.flush();
        expect(client.registry.get(client.selectedThreadId)).toBe(first!.thread!.id);
        expect(wrapName(first!.thread!.title, 12).join("")).toBe(first!.thread!.title);
      } finally {
        await act(async () => view.renderer.destroy());
      }
    } finally {
      await client.dispose();
    }
  },
  30_000,
);

test("5,000 thread rows stay virtualized and pointer scroll works without sidebar focus", async () => {
  const client = fakeClient();
  const snapshot = fixture();
  const threads = Array.from({ length: 5_000 }, (_, i) => ({
    ...base,
    id: threadId(`row-${String(i).padStart(4, "0")}`),
    title: `Virtual thread ${String(i).padStart(4, "0")}`,
  }));
  client.registry.set(client.snapshot, { ...snapshot, threads });
  client.registry.set(client.status, "live");
  const view = await testRender(<AppFrame client={client} />, {
    width: 120,
    height: 40,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await view.flush();
    expect(view.captureCharFrame()).toContain("Virtual thread 0000");
    const countNodes = (node: {
      getChildren(): ReturnType<typeof view.renderer.root.getChildren>;
    }): number => 1 + node.getChildren().reduce((total, child) => total + countNodes(child), 0);
    expect(countNodes(view.renderer.root)).toBeLessThan(100);
    await act(async () => {
      await view.mockMouse.scroll(5, 8, "down");
    });
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("Virtual thread 0000");
    expect(view.captureCharFrame()).toContain("Focus: sidebar");
    await act(async () => {
      await view.mockMouse.click(2, 1);
    });
    await act(async () => {
      view.mockInput.pressKey("END");
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Virtual thread 4999");
    expect(countNodes(view.renderer.root)).toBeLessThan(100);
  } finally {
    await act(async () => view.renderer.destroy());
    await client.dispose();
  }
});

// Same windows and fixed clock as the web sidebar's usage fixture.
import { claude, usageNow } from "./usage-fixture";
test.each([
  [120, 40],
  [80, 24],
])("usage footer and selected context survive scroll at %ix%i", async (width, height) => {
  const client = fakeClient();
  const snapshot = fixture();
  const one = {
    ...base,
    activeProviderThreadId: "provider-one" as never,
    modelSelection: { ...base.modelSelection, options: [{ id: "reasoningEffort", value: "high" }] },
  };
  const two = { ...base, id: threadId("two"), activeProviderThreadId: "provider-two" as never };
  // Upstream reports context usage on the thread's active provider thread.
  const usage = (id: string, usedTokens: number, maxTokens: number, providerTurns: unknown[] = []) => ({
    ...client.getThread(id),
    projection: {
      turnItems: [],
      visibleTurnItems: [],
      runtimeRequests: [],
      runs: [],
      messages: [],
      providerThreads: [{ id: `provider-${id}`, contextUsage: { usedTokens, maxTokens } }],
      providerTurns,
    } as never,
  });
  // The newest turn report carries the cache split and the compact threshold.
  const turnReport = {
    providerThreadId: "provider-one",
    tokenUsage: {
      usedTokens: 430_000,
      maxTokens: 1_000_000,
      inputTokens: 428_000,
      cachedInputTokens: 400_000,
      outputTokens: 2_000,
      autoCompactThreshold: 900_000,
      updatedAt: "2026-10-22T12:00:00.000Z",
    },
    turnTokenUsage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 1_200_000,
      cachedInputTokens: 1_100_000,
      outputTokens: 9_000,
    },
  };
  client.registry.set(
    client.transcripts,
    new Map([
      [one.id as string, usage(one.id, 430_000, 1_000_000, [turnReport])],
      [two.id as string, usage(two.id, 800, 200_000)],
    ]),
  );
  client.registry.set(client.snapshot, {
    ...snapshot,
    threads: [
      one,
      two,
      ...Array.from({ length: 5000 }, (_, i) => ({
        ...base,
        id: threadId(`meter-${i}`),
        title: `Thread ${i}`,
      })),
    ],
  });
  client.registry.set(client.providers, [
    claude([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 42,
        windowDurationMins: 300,
        resetsAt: "2026-10-22T15:00:00.000Z",
      },
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 18.4,
        windowDurationMins: 10080,
        resetsAt: "2026-10-26T12:00:00.000Z",
      },
    ]),
  ]);
  client.now = () => usageNow;
  client.openThread(one.id);
  const view = await testRender(<AppFrame client={client} />, {
    width,
    height,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  try {
    await view.flush();
    let frame = view.captureCharFrame();
    expect(frame).toContain("5h [");
    expect(frame).toContain("42% 2-");
    expect(frame).toContain("7d [");
    expect(frame).toContain("18% 25+");
    expect(frame).toContain("gpt-6.1-sol · effort high");
    expect(frame).toContain("Context 43%");
    expect(frame).toContain("430k / 1M");
    const footerY = frame.split("\n").findIndex((line) => line.includes("5h ["));
    expect(footerY).toBeGreaterThan(height / 2);
    // The context chip sits at the right end of the top row; a click drops the breakdown down.
    const top = frame.split("\n")[0]!;
    expect(top.trimEnd().endsWith("430k / 1M ▾")).toBe(true);
    await act(async () => view.mockMouse.click(top.indexOf("Context 43%") + 2, 0));
    await view.flush();
    frame = view.captureCharFrame();
    expect(frame).toContain("Context window");
    expect(frame).toContain("Cached input");
    expect(frame).toContain("Compacts at 900,000 tokens.");
    expect(frame).toContain("1.2M in · 1.1M cached · 9k out");
    await act(async () => view.mockInput.pressEscape());
    await view.flush();
    expect(view.captureCharFrame()).not.toContain("Cached input");
    await act(async () => view.mockInput.pressKey("u", { meta: true }));
    await view.flush();
    expect(view.captureCharFrame()).toContain("Cached input");
    await act(async () => view.mockInput.pressKey("u", { meta: true }));
    await view.flush();
    frame = view.captureCharFrame();
    expect(frame).not.toContain("Cached input");
    await act(async () => {
      await view.mockMouse.scroll(5, 8, "down");
      client.openThread(two.id);
    });
    await view.flush();
    frame = view.captureCharFrame();
    expect(frame).toContain("Context <1%");
    expect(frame).not.toContain("Context 43%");
    expect(frame.split("\n")[footerY]).toContain("5h [");
    const count = (node: {
      getChildren(): ReturnType<typeof view.renderer.root.getChildren>;
    }): number => 1 + node.getChildren().reduce((n, child) => n + count(child), 0);
    expect(count(view.renderer.root)).toBeLessThan(100);
  } finally {
    await act(async () => view.renderer.destroy());
    await client.dispose();
  }
});
