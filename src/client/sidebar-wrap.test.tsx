import { act } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ThreadSidebar, sidebarEntries, sidebarRows, type SidebarEntry } from "./sidebar";
import { baseThread as base, fixtureNow, flatFixture } from "./sidebar-fixture";
import { createClient } from "./runtime";

const WORDS = Array.from({ length: 17 }, (_, i) => `word${String(i).padStart(2, "0")}`);
const TITLE = `${WORDS.join(" ")}ab`; // 120 chars of short words
const flat = () => sidebarEntries(flatFixture(), { now: fixtureNow });
const cells = (row: { lead: string; text: string; projectText: string; timeText: string }) =>
  row.lead + row.text + row.projectText + row.timeText;
const entry = (extra: Partial<SidebarEntry> = {}): SidebarEntry => ({
  key: "t",
  thread: base,
  text: `${TITLE}\n▶ running`,
  project: "A project with a very long descriptive name",
  timeLabel: "5m",
  ...extra,
});

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

test("wrapNames at width 48 shows every word of a 120-char title and no ellipsis", () => {
  const rows = sidebarRows([entry()], 48, { wrapNames: true });
  const text = rows.map(cells);
  for (const row of text) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(48);
  expect(TITLE).toHaveLength(120);
  expect(text.some((row) => row.includes("…"))).toBe(false);
  const joined = text.join(" ");
  for (const word of WORDS) expect(joined).toContain(word);
  const title = rows
    .filter((row) => !row.projectText && !row.timeText && !row.lead && !row.text.includes("▶"))
    .map((row) => row.text.trim())
    .join("");
  expect(title.replaceAll(" ", "")).toBe(TITLE.replaceAll(" ", ""));
  // Rows break between words: no word0N is cut in two.
  expect(text.every((row) => !/word\d?$/.test(row.trim()))).toBe(true);
});

test("the project and the age stay whole, on their own rows when they do not fit", () => {
  const rows = sidebarRows([entry()], 48, { wrapNames: true });
  const project = rows
    .filter((row) => row.projectText)
    .map((row) => row.projectText.trim())
    .join(" ");
  expect(project.replace(/^· /, "")).toBe("A project with a very long descriptive name");
  expect(rows.some((row) => row.projectText && !row.lead && row.text.trim() === "")).toBe(true);
  const timed = rows.filter((row) => row.timeText.trim() === "5m");
  expect(timed).toHaveLength(1);
  expect(Bun.stringWidth(cells(timed[0]!))).toBe(48);
  // A short project rides on the status row as on desktop.
  const short = sidebarRows([entry({ project: "Alpha" })], 48, { wrapNames: true });
  expect(short.find((row) => row.projectText)?.projectText).toBe(" · Alpha");
});

test("without wrapNames the rows are exactly today's", () => {
  const entries = flat();
  for (const width of [20, 28, 40]) {
    expect(sidebarRows(entries, width, {})).toEqual(sidebarRows(entries, width));
    expect(sidebarRows(entries, width, { wrapNames: false, menuKey: entries[0]!.key })).toEqual(
      sidebarRows(entries, width),
    );
    expect(sidebarRows(entries, width).every((row) => row.menuText === undefined)).toBe(true);
  }
  const truncated = sidebarRows([entry()], 48);
  expect(truncated).toHaveLength(2);
  expect(truncated[0]!.text.endsWith("…")).toBe(true);
});

test("only the menuKey thread gets a […] cell, on its first row", () => {
  const entries = flat();
  const key = entries.find((e) => e.thread)!.key;
  const rows = sidebarRows(entries, 40, { wrapNames: true, menuKey: key });
  const withMenu = rows.filter((row) => row.menuText !== undefined);
  expect(withMenu).toHaveLength(1);
  expect(withMenu[0]!.entry.key).toBe(key);
  expect(withMenu[0]!.menuText).toBe("[…]");
  expect(rows.find((row) => row.entry.key === key)).toBe(withMenu[0]!);
  // Room is reserved for it, so the first title row never overflows.
  expect(Bun.stringWidth(cells(withMenu[0]!)) + 4).toBeLessThanOrEqual(40);
});

test("wrapNames renders every word, and tapping […] calls onMenu without opening the thread", async () => {
  const client = fakeClient();
  const snapshot = {
    ...flatFixture(),
    threads: [
      {
        ...base,
        title: TITLE,
        latestUserMessageAt: DateTime.subtract(base.createdAt, { minutes: 5 }),
      },
    ],
  };
  client.registry.set(client.snapshot, snapshot);
  const opened: string[] = [];
  const width = 48;
  const view = await testRender(
    <ThreadSidebar
      client={client}
      width={width}
      height={20}
      enabled
      keyboardEnabled
      wrapNames
      onMenu={(id) => opened.push(id)}
    />,
    { width, height: 20 },
  );
  try {
    await view.flush();
    const lines = view.captureCharFrame().split("\n");
    expect(lines.some((line) => line.includes("[…]"))).toBe(true);
    const titleLines = lines.filter((line) => /word\d\d/.test(line));
    expect(titleLines.length).toBeGreaterThan(2);
    const y = lines.findIndex((line) => line.includes("[…]"));
    const x = lines[y]!.indexOf("[…]") + 1;
    await act(async () => {
      await view.mockMouse.click(x, y);
    });
    expect(opened).toEqual([base.id]);
    expect(client.registry.get(client.selectedThreadId)).not.toBe(base.id);
    // Desktop (no wrapNames) draws no menu cell.
  } finally {
    await act(async () => view.renderer.destroy());
    await client.dispose();
  }
  const plain = fakeClient();
  plain.registry.set(plain.snapshot, snapshot);
  const desktop = await testRender(
    <ThreadSidebar
      client={plain}
      width={width}
      height={20}
      enabled
      keyboardEnabled
      onMenu={() => {}}
    />,
    { width, height: 20 },
  );
  try {
    await desktop.flush();
    expect(desktop.captureCharFrame()).not.toContain("[…]");
  } finally {
    await act(async () => desktop.renderer.destroy());
    await plain.dispose();
  }
});
