import { act } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { terminalActions } from "./actions";
import { Hello, sample } from "./hello";

test("mouse click, wheel, drag selection and keyboard equivalents", async () => {
  const copies: string[] = [];
  const view = await testRender(<Hello actions={{ copy: (text) => { copies.push(text); } }} />, {
    width: 120,
    height: 40,
  });
  try {
    await view.waitForFrame((frame) => frame.includes("clicks=0"));
    await act(async () => {
      await view.mockMouse.click(5, 1);
    });
    await view.waitForFrame((frame) => frame.includes("clicks=1"));
    await act(async () => {
      view.mockInput.pressEnter();
    });
    await view.waitForFrame((frame) => frame.includes("clicks=2"));
    const before = view.captureCharFrame();
    await act(async () => {
      await view.mockMouse.scroll(10, 8, "down");
    });
    await view.flush();
    expect(view.captureCharFrame()).not.toBe(before);
    expect(view.captureCharFrame()).not.toContain("Row 000");
    await act(async () => {
      await view.mockMouse.drag(0, 2, sample.length - 1, 2);
    });
    await view.waitForFrame((frame) => frame.includes("copy=ok"));
    expect(copies.at(-1)).toBe(sample);
    await act(async () => {
      view.mockInput.pressKey("y");
    });
    await view.flush();
    expect(copies.at(-1)).toBe(sample);
    await act(async () => {
      view.mockInput.pressKey("k");
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Row 000");
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});

test("OSC 52 encodes Unicode without executing embedded terminal escapes", () => {
  let bytes = "";
  terminalActions((chunk) => {
    bytes += chunk;
  }).copy("hello λ\x1b[31m");
  expect(bytes).toBe(`\x1b]52;c;${Buffer.from("hello λ\x1b[31m").toString("base64")}\x07`);
});
