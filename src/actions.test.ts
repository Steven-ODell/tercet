import { expect, test } from "bun:test";
import { clipboardLocalLookup } from "./actions";

test("clipboard routing follows the active tmux client, failing closed on lookup errors", async () => {
  let client = "SSH_CONNECTION=10.0.0.2 1 10.0.0.1 22\0";
  const paths: string[] = [];
  const local = clipboardLocalLookup(
    { TMUX: "tmux", SSH_CONNECTION: "stale pane SSH" },
    async () => "100 11\n300 33\n200 22\n",
    async (path) => { paths.push(path); return client; },
  );
  expect(await local()).toBe(false);
  client = "DISPLAY=:0\0";
  expect(await local()).toBe(true);
  expect(paths).toEqual(["/proc/33/environ", "/proc/33/environ"]);
  for (const env of [{ TMUX: "tmux" }, { TMUX: "tmux", SSH_CONNECTION: "stale" }]) {
    expect(await clipboardLocalLookup(env, async () => { throw Error("failed"); }, async () => "")()).toBe(false);
    expect(await clipboardLocalLookup(env, async () => "", async () => "")()).toBe(false);
  }
});

test("direct SSH indicators suppress local clipboard access on every platform", async () => {
  for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
    expect(await clipboardLocalLookup({ [name]: "ssh" }, async () => "", async () => "")()).toBe(false);
  }
  expect(await clipboardLocalLookup({}, async () => "", async () => "")()).toBe(true);
});
