import { expect, test } from "bun:test";
import { currentActivity } from "./activity";
import type { WorkRow } from "./work-log";

const running = { status: "running", activeRunId: "run" } as never;
const row = (type: string, status: string, values: object = {}): WorkRow =>
  ({
    sourceThreadId: "t",
    sourceItemId: type,
    item: { id: type, type, status, runId: "run", ...values },
  }) as unknown as WorkRow;

test("idle thread shows no activity", () => {
  expect(
    currentActivity({ runtime: { status: "idle", activeRunId: null } as never }, []),
  ).toBeNull();
  expect(currentActivity(undefined, [])).toBeNull();
});

test("waiting on the user shows no activity", () => {
  expect(currentActivity({ runtime: running, hasPendingApprovals: true }, [])).toBeNull();
  expect(currentActivity({ runtime: running, hasPendingUserInput: true }, [])).toBeNull();
});

test("an active run with no running tool is thinking", () => {
  expect(currentActivity({ runtime: running }, [])).toEqual({ kind: "thinking" });
  expect(
    currentActivity({ runtime: running }, [row("command_execution", "completed", { input: "ls" })]),
  ).toEqual({ kind: "thinking" });
});

test("a running tool in the active run shows its label", () => {
  expect(
    currentActivity({ runtime: running }, [
      row("reasoning", "completed"),
      row("dynamic_tool", "running", { toolName: "Read" }),
    ]),
  ).toEqual({ kind: "tool", label: "Read" });
});

test("a tool from an older run does not count", () => {
  const old = row("dynamic_tool", "running", { toolName: "Read" });
  (old.item as { runId: string }).runId = "old";
  expect(currentActivity({ runtime: running }, [old])).toEqual({ kind: "thinking" });
});
