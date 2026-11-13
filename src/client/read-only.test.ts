import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { connectionConfig } from "./config";
import { platform } from "./platform";
import { READ_ONLY_ERROR, READ_ONLY_POLICY, blockWrites } from "./read-only";
import type { Actions } from "../actions";

test("read-only blocks dispatch and every remote write before I/O, without managed auth/autostart", async () => {
  const config = await connectionConfig(
    ["--read-only", "--url", "http://127.0.0.1:1"],
    async () => undefined,
    "/absent",
  );
  expect(config.managedToken).toBe(false);
  expect(config.autostart).toBe(false);
  const boundary = platform(config);
  // Invalid payloads deliberately prove rejection happens before decoding or network I/O.
  for (const action of [
    boundary.dispatch,
    boundary.uploadImage,
    boundary.answerSecret,
    boundary.pageUrl,
    boundary.issueToken,
  ]) {
    const result = await Effect.runPromiseExit((action as () => Effect.Effect<unknown, unknown>)());
    expect(result._tag).toBe("Failure");
    expect(String(result)).toContain("Read-only: action blocked");
  }
  await boundary.drafts.write({ example: "must not persist" });
  expect(await boundary.drafts.read()).toEqual({});
});

test("--read-only blocks every write host action and drops server-backed previews", async () => {
  const calls: string[] = [];
  const effects = Object.fromEntries(
    Object.keys(READ_ONLY_POLICY).map((name) => [
      name,
      name === "targets"
        ? [{ name: "desk" }]
        : async () => {
            calls.push(name);
            return "ran";
          },
    ]),
  ) as unknown as Actions;
  const before = { ...effects } as Record<string, unknown>;
  blockWrites(effects);
  const after = effects as unknown as Record<string, unknown>;
  const rules = Object.entries(READ_ONLY_POLICY);
  // Every write is classified, and the dangerous ones are all blocked.
  for (const name of ["shell", "editor", "tmux", "run", "send", "copyTo", "openUrl", "play"])
    expect(READ_ONLY_POLICY[name as keyof typeof READ_ONLY_POLICY]).toBe("block");
  for (const [name, rule] of rules) {
    if (rule === "drop") expect(after[name]).toBeUndefined();
    if (rule === "allow") expect(after[name]).toBe(before[name]);
    if (rule === "block") {
      expect(after[name]).toBeFunction();
      expect((after[name] as () => Promise<unknown>)()).rejects.toThrow(READ_ONLY_ERROR);
    }
  }
  await Bun.sleep(0);
  expect(calls).toEqual([]);
  // An action that is absent stays absent: read-only draws no extra buttons.
  const sparse: Actions = { copy: () => {} };
  blockWrites(sparse);
  expect(
    Object.entries(sparse)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k),
  ).toEqual(["copy"]);
  // main.tsx applies this table and nothing else.
  const main = await Bun.file(`${import.meta.dir}/../main.tsx`).text();
  expect(main).toContain("if (config.readOnly) blockWrites(effects);");
});
