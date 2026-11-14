import { expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import { planWindows, shellQuote, takeFlags, type TmuxWindow } from "./cli";
import {
  formatTable,
  isActive,
  resolveThread,
  threadRows,
  threadState,
  type ThreadRow,
} from "./threads";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const shell = (over: Record<string, unknown> = {}) =>
  ({
    id: "11111111-aaaa-bbbb-cccc-000000000001",
    projectId: "p1",
    title: "Fix the parser",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    branch: "main",
    lineage: { relationshipToParent: "root" },
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    lastErrorClass: null,
    pinnedAt: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: at("2026-11-14T10:00:00Z"),
    ...over,
  }) as never;
const snapshot = (...threads: unknown[]) =>
  ({ projects: [{ id: "p1", title: "demo-app" }], threads }) as never;

test("threadState reads the activity run first, like the sidebar badge", () => {
  expect(threadState(shell())).toBe("idle");
  expect(threadState(shell({ status: "completed", activityRunStatus: "running" }))).toBe("running");
  expect(threadState(shell({ activityRunStatus: "waiting" }))).toBe("waiting");
  expect(threadState(shell({ pendingRuntimeRequest: { kind: "approval" } }))).toBe("waiting");
  expect(threadState(shell({ status: "failed" }))).toBe("failed");
  expect(threadState(shell({ lastErrorClass: "usage_limit" }))).toBe("limited");
  expect(isActive("running") && isActive("waiting")).toBe(true);
  expect(isActive("failed") || isActive("idle") || isActive("limited")).toBe(false);
});

test("threadRows hides deleted, archived and sub-agent threads unless asked, newest first", () => {
  const snap = snapshot(
    shell({ id: "t-old", updatedAt: at("2026-11-14T09:00:00Z") }),
    shell({ id: "t-new", title: "Newer", updatedAt: at("2026-11-14T11:00:00Z"), pinnedAt: at("2026-11-14T08:00:00Z") }),
    shell({ id: "t-arch", archivedAt: at("2026-11-14T08:00:00Z") }),
    shell({ id: "t-del", deletedAt: at("2026-11-14T08:00:00Z") }),
    shell({ id: "t-sub", lineage: { relationshipToParent: "subagent" } }),
  );
  const rows = threadRows(snap);
  expect(rows.map((row) => row.id)).toEqual(["t-new", "t-old"]);
  expect(rows[0]).toMatchObject({
    shortId: "t-new",
    project: "demo-app",
    pinned: true,
    archived: false,
    provider: "codex",
    model: "gpt-5.5",
    branch: "main",
    updatedAt: "2026-11-14T11:00:00.000Z",
  });
  expect(threadRows(snap, { all: true }).map((row) => row.id)).toContain("t-arch");
  expect(threadRows(snap, { all: true }).map((row) => row.id)).not.toContain("t-del");
});

const rows = (...specs: Array<[string, string]>): ThreadRow[] =>
  threadRows(snapshot(...specs.map(([id, title]) => shell({ id, title }))), { all: true });

test("resolveThread takes an id, a unique id prefix or a unique title piece", () => {
  const list = rows(["abc12345-1", "Fix the parser"], ["abd99999-2", "Parser docs"], ["zzz00000-3", "Other"]);
  expect(resolveThread(list, "zzz00000-3")).toMatchObject({ kind: "found" });
  expect(resolveThread(list, "abc1")).toMatchObject({ kind: "found", row: { id: "abc12345-1" } });
  expect(resolveThread(list, "OTHER")).toMatchObject({ kind: "found", row: { id: "zzz00000-3" } });
  expect(resolveThread(list, "parser")).toMatchObject({ kind: "ambiguous" });
  expect(resolveThread(list, "ab")).toMatchObject({ kind: "ambiguous" });
  expect(resolveThread(list, "nothing")).toEqual({ kind: "none" });
  expect(resolveThread(list, "  ")).toEqual({ kind: "none" });
});

test("formatTable lines up the columns and never cuts a title", () => {
  const long = "A very long thread title that keeps going well past any sane terminal width";
  const text = formatTable(rows(["abc12345-1", long], ["xyz98765-2", "Short"]));
  const lines = text.split("\n");
  expect(lines[0]).toMatch(/^ID\s+STATE\s+PROJECT\s+TITLE$/);
  expect(lines.some((line) => line.endsWith(long))).toBe(true);
  expect(formatTable([])).toBe("No threads.");
});

const row = (id: string, state: ThreadRow["state"]): ThreadRow => ({
  ...rows([id, id])[0]!,
  state,
});
const win = (id: string, threadId: string, viewed = false): TmuxWindow => ({ id, threadId, viewed });
const base = { idleMs: new Map<string, number>(), dismissed: new Set<string>(), graceMs: 30_000, prune: true };

test("planWindows opens a window for each active thread that has none", () => {
  const plan = planWindows(
    [row("a", "running"), row("b", "waiting"), row("c", "idle"), row("d", "running")],
    [win("@1", "d")],
    base,
  );
  expect(plan.open.map((r) => r.id)).toEqual(["a", "b"]);
  expect(plan.close).toEqual([]);
});

test("planWindows leaves a window the user closed alone while the thread still works", () => {
  const plan = planWindows([row("a", "running")], [], { ...base, dismissed: new Set(["a"]) });
  expect(plan.open).toEqual([]);
});

test("planWindows closes idle windows after the grace period, never the one on screen", () => {
  const list = [row("a", "idle"), row("b", "idle"), row("c", "idle"), row("d", "running")];
  const windows = [win("@1", "a"), win("@2", "b", true), win("@3", "c"), win("@4", "d"), win("@5", "")];
  const idleMs = new Map([["a", 31_000], ["b", 99_000], ["c", 5_000]]);
  expect(planWindows(list, windows, { ...base, idleMs }).close.map((w) => w.id)).toEqual(["@1"]);
  expect(planWindows(list, windows, { ...base, idleMs, prune: false }).close).toEqual([]);
});

test("planWindows closes the window of a thread that is gone, unless it is on screen", () => {
  const windows = [win("@1", "gone"), win("@2", "gone2", true)];
  expect(planWindows([], windows, base).close.map((w) => w.id)).toEqual(["@1"]);
});

test("takeFlags separates a command's flags from the connection options", () => {
  const { found, values, rest } = takeFlags(
    ["--watch", "--session", "work", "--url", "http://x", "--socket=s1", "--keep"],
    ["--watch", "--keep"] as const,
    ["--session", "--socket"] as const,
  );
  expect([...found].sort()).toEqual(["--keep", "--watch"]);
  expect(values.get("--session")).toBe("work");
  expect(values.get("--socket")).toBe("s1");
  expect(rest).toEqual(["--url", "http://x"]);
  expect(() => takeFlags(["--session"], [] as const, ["--session"] as const)).toThrow(/missing value/);
});

test("shellQuote keeps plain words and quotes the rest", () => {
  expect(shellQuote("attach")).toBe("attach");
  expect(shellQuote("/usr/bin/bun")).toBe("/usr/bin/bun");
  expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
  expect(shellQuote("a b")).toBe("'a b'");
});
