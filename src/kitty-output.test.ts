import { test, expect } from "bun:test";
import {
  KITTY_CLEAR_PLACEMENTS,
  KittyPlacementOutput,
  clearKittyBeforeSwitch,
} from "./kitty-output";
const cup = "\x1b[7;49H";
const place = "\x1bPtmux;\x1b\x1b_Ga=p,i=42,c=40,r=8,C=1\x1b\x1b\\\x1b\\";
const expected = cup + "\x1bPtmux;" + cup.replaceAll("\x1b", "\x1b\x1b") + place.slice(7);
test("tmux placement moves the outer cursor to the transcript, atomically with placement", () => {
  expect(new KittyPlacementOutput().push(Buffer.from(cup + place)).toString()).toBe(expected);
});
test("every split of a cursor/placement pair preserves bytes and correct placement", () => {
  const input = Buffer.from(cup + place + "界");
  for (let i = 0; i <= input.length; i++) {
    const out = new KittyPlacementOutput();
    expect(
      Buffer.concat([out.push(input.subarray(0, i)), out.push(input.subarray(i))]).toString(),
    ).toBe(expected + "界");
  }
});
test("uploads, deletes and ordinary output retain their order and bytes", () => {
  const upload = place.replace("a=p", "a=t");
  const del = place.replace("a=p", "a=d");
  const input = Buffer.from(cup + upload + cup + del + "hello\x1b[0m");
  expect(new KittyPlacementOutput().push(input)).toEqual(input);
});
test("session-switching actions clear placements first and repaint when focus returns", async () => {
  const events: string[] = [];
  const out = {
    write: (bytes: string, done: () => void) => {
      events.push(bytes === KITTY_CLEAR_PLACEMENTS ? "clear" : "other");
      done();
      return true;
    },
  };
  let focus = () => {};
  const guard = clearKittyBeforeSwitch(
    out,
    () => events.push("repaint"),
    (listener) => (focus = listener),
  );
  await guard(async (name: string) => events.push("switch " + name))("shell");
  expect(events).toEqual(["clear", "switch shell"]);
  focus();
  focus();
  expect(events).toEqual(["clear", "switch shell", "repaint"]);
  await expect(
    guard(async () => {
      throw new Error("no tmux client");
    })(),
  ).rejects.toThrow("no tmux client");
  expect(events.slice(3)).toEqual(["clear", "repaint"]);
});
test("a placement delete is dropped when the same write places it again, and kept otherwise", () => {
  const wrap = (g: string) => `\x1bPtmux;${g.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
  const del = (i: number, p: number) => wrap(`\x1b_Ga=d,d=i,i=${i},p=${p},q=2\x1b\\`);
  const put = (i: number, p: number) => wrap(`\x1b_Ga=p,i=${i},p=${p},c=4,r=2,q=2\x1b\\`);
  const run = (s: string) =>
    new KittyPlacementOutput().push(Buffer.from(s, "latin1")).toString("latin1");
  // Moved: only the re-place goes out, with the cursor inside its passthrough.
  expect(run(del(7, 1) + cup + put(7, 1))).toBe(run(cup + put(7, 1)));
  // A different placement, or a delete with nothing after it, is a real delete.
  expect(run(del(7, 2) + cup + put(7, 1))).toContain("a=d,d=i,i=7,p=2");
  expect(run(del(7, 1) + "text")).toContain("a=d,d=i,i=7,p=1");
  // Deleting the whole image (d=I) is never dropped.
  const image = wrap("\x1b_Ga=d,d=I,i=7,q=2\x1b\\");
  expect(run(image + cup + put(7, 1))).toContain("d=I");
});
