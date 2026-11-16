import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TranscriptViewport } from "./transcript-viewport";
import {
  activeClientPid,
  failureText,
  LinkCopied,
  sshHostFromEnviron,
  type Actions,
} from "../actions";
import { blockActions, measureMarkdown, type BlockAction } from "./markdown";

test("measured blocks retain exact commands and distinct inline/link targets through wrapping", () => {
  const rows = measureMarkdown(
    {
      id: "a",
      kind: "assistant",
      text: "```sh\n  echo hi\n pwd\n```\n`ls -al` [source](src/main.ts) [page](https://example.com)\n[open](tercet-page:page%2Fid)",
    },
    12,
  );
  expect(rows.find((r) => r.target?.kind === "code")?.target?.text).toBe("  echo hi\n pwd");
  expect(rows.flatMap((r) => r.spans).find((s) => s.target?.kind === "inline")?.target?.text).toBe(
    "ls -al",
  );
  expect(rows.flatMap((r) => r.spans).find((s) => s.target?.kind === "file")?.target?.text).toBe(
    "src/main.ts",
  );
});

test("bare URLs in prose are link targets and trailing punctuation stays outside them", () => {
  const rows = measureMarkdown(
    {
      id: "a",
      kind: "assistant",
      text: "Open http://127.0.0.1:3773/, or (https://github.com/pingdotgg/t3code). See `src/main.ts` and [x](https://example.com/a).",
    },
    200,
  );
  const spans = rows.flatMap((r) => r.spans);
  const urls = spans.filter((s) => s.target?.kind === "url");
  expect(urls.map((s) => s.target?.text)).toEqual([
    "http://127.0.0.1:3773/",
    "https://github.com/pingdotgg/t3code",
    "https://example.com/a",
  ]);
  expect(urls[0]!.text).toBe("http://127.0.0.1:3773/");
  expect(spans.find((s) => s.target?.kind === "file")?.target?.text).toBe("src/main.ts");
  expect(spans.map((s) => s.text).join("")).toContain("t3code).");
});

test("OpenTUI buttons and focused keys call fake Actions exactly; drag copies and errors stay visible", async () => {
  const calls: unknown[] = [];
  let finish: (() => void) | undefined;
  const effects: Actions = {
    copy: (text) => {
      calls.push(["copy", text]);
    },
    tmux: async (input) => {
      calls.push(["tmux", input]);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    send: async (input) => {
      calls.push(["send", input]);
    },
    openPage: async (id) => {
      calls.push(["page", id]);
    },
    openUrl: async (url) => {
      calls.push(["url", url]);
    },
  };
  const view = await testRender(
    <TranscriptViewport
      effects={effects}
      cwd="/fixture"
      openFile={(path) => {
        calls.push(["file", path]);
      }}
      items={[
        {
          id: "a",
          kind: "assistant",
          text: "hello world\n```sh\necho hi\n```\n`pwd`\n[file](src/main.ts)\n[page](https://example.com)\n[open](tercet-page:page%2Fid)",
        },
      ]}
      width={100}
      height={22}
    />,
    { width: 100, height: 22 },
  );
  // Wait for a frame containing `text`: an async update can land a pass or two after the click.
  const frameWith = async (text: string) => {
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        return await view.waitForFrame((f) => f.includes(text));
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  };
  const click = async (label: string) => {
    const lines = (await frameWith(label)).split("\n");
    // Bottom up: the status row's buttons act on the current target.
    const y = lines.findLastIndex((l) => l.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
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
    await view.waitForFrame((f) => f.includes("hello world"));
    await key("]");
    await key("Y");
    expect(calls.at(-1)).toEqual([
      "copy",
      "hello world\n```sh\necho hi\n```\n`pwd`\n[file](src/main.ts)\n[page](https://example.com)\n[open](tercet-page:page%2Fid)",
    ]);
    await click("hello world");
    await click("[copy]");
    expect(calls.at(-1)).toEqual([
      "copy",
      "hello world\n```sh\necho hi\n```\n`pwd`\n[file](src/main.ts)\n[page](https://example.com)\n[open](tercet-page:page%2Fid)",
    ]);
    await click("echo hi");
    await click("[copy]");
    expect(calls.at(-1)).toEqual(["copy", "echo hi"]);
    await click("[send]");
    expect(calls.at(-1)).toEqual(["send", { kind: "text", text: "echo hi" }]);
    await key("Y");
    expect(calls.at(-1)).toEqual(["copy", "echo hi"]);
    await key("T");
    expect(calls.at(-1)).toEqual(["tmux", { cwd: "/fixture", command: "echo hi" }]);
    expect(await frameWith("◌ tmux")).toContain("◌ tmux");
    await act(async () => {
      finish!();
    });
    await view.flush();
    expect(await frameWith("✓ tmux")).toContain("✓ tmux");
    await click("[tmux]");
    await act(async () => {
      finish!();
    });
    await view.flush();
    await click("pwd");
    expect(calls.at(-1)).toEqual(["tmux", { cwd: "/fixture", command: "pwd" }]);
    await act(async () => {
      finish!();
    });
    await view.flush();
    await click("file (src/main.ts)");
    expect(calls.at(-1)).toEqual(["file", "src/main.ts"]);
    await click("[copy path]");
    expect(calls.at(-1)).toEqual(["copy", "src/main.ts"]);
    await click("[send]");
    expect(calls.at(-1)).toEqual(["send", { kind: "file", path: "/fixture/src/main.ts" }]);
    await click("[open]");
    expect(calls.at(-1)).toEqual(["file", "src/main.ts"]);
    await click("page (https://example.com)");
    expect(calls.at(-1)).toEqual(["url", "https://example.com"]);
    await click("[open]");
    expect(calls.at(-1)).toEqual(["url", "https://example.com"]);
    effects.openUrl = async () => {
      throw new Error("private detail");
    };
    await click("[open]");
    expect(await frameWith("X open failed; retry")).toContain("X open failed; retry");
    expect(view.captureCharFrame()).not.toContain("private detail");
    await click("open (tercet-page:page%2Fid)");
    expect(calls.at(-1)).toEqual(["page", "page/id"]);
    // A re-render can make opentui resend "over" with the pointer still on the link; the
    // link must stay the target (this raced under full-suite load before).
    await act(async () => {
      const renderer = view.renderer as unknown as {
        lastOverRenderable?: unknown;
        recheckHoverState(): void;
      };
      renderer.lastOverRenderable = undefined;
      renderer.recheckHoverState();
    });
    await view.flush();
    expect(await frameWith("[open]")).toContain("[open]");
    await click("[open]");
    expect(calls.at(-1)).toEqual(["page", "page/id"]);
    await act(async () => {
      await view.mockMouse.drag(0, 1, 10, 1);
    });
    await view.flush();
    expect(calls.at(-1)).toEqual(["copy", "hello world"]);
  } finally {
    await act(async () => {
      await view.dispose();
    });
  }
});

test("the SSH host follows the tmux client that was used last; a copied link says so", () => {
  expect(failureText(new LinkCopied(), "generic")).toBe("Browser failed; link copied");
  expect(failureText(new Error("other"), "generic")).toBe("generic");
  expect(activeClientPid("1794177000 148341\n1794177313 148521\n")).toBe("148521");
  expect(activeClientPid("")).toBeUndefined();
  expect(sshHostFromEnviron("A=1\0SSH_CONNECTION=203.0.113.7 35860 198.51.100.4 22\0B=2")).toBe(
    "203.0.113.7",
  );
  expect(sshHostFromEnviron("A=1\0B=2")).toBeUndefined();
});

test("code block buttons follow web: nothing reaches a terminal early, only shell blocks run", () => {
  const offered = ["pc", "laptop", "tmux", "run", "send"];
  const all: BlockAction[] = ["copy", ...offered];
  expect(blockActions("bash", "ls -la", true, offered)).toEqual(all);
  expect(blockActions("python", "print(1)", true, offered)).toEqual([
    "copy",
    "pc",
    "laptop",
    "tmux",
    "send",
  ]);
  expect(blockActions("", "ls", true, offered)).not.toContain("run");
  expect(blockActions("bash", "ls -la", false, offered)).toEqual(["copy"]);
  expect(blockActions("bash", "ls \\", true, offered)).not.toContain("run");
  expect(blockActions("bash", "  \n ", true, offered)).toEqual([]);
  const hidden = blockActions("bash", "ls\u202e -la", true, offered);
  expect(hidden).not.toContain("run");
  expect(hidden).not.toContain("tmux");
  expect(blockActions("bash", "a\nb", true, offered)).toContain("run");
  // Nothing set up: a block only copies.
  expect(blockActions("bash", "ls -la", true)).toEqual(["copy"]);
});
test("the holder stays inside its width and moves buttons to their own rows when narrow", () => {
  const measure = (width: number) =>
    measureMarkdown(
      { id: "a", kind: "assistant", text: "```bash\nssh user@host 'ls -la /var/www/'\n```" },
      width,
      12,
      ["pc", "laptop", "tmux", "run", "send"],
    ).map((row) => row.spans.map((span) => span.text).join(""));
  const wide = measure(80);
  expect(wide[1]).toContain("╭─ bash");
  expect(wide[1]).toContain("[copy] [pc] [laptop] [tmux] [run] [send]");
  expect(wide.at(-1)).toStartWith("╰");
  for (const width of [80, 50, 30, 16])
    for (const row of measure(width).slice(1))
      expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
  const narrow = measure(30);
  expect(narrow[1]).not.toContain("[copy]");
  expect(narrow.join("\n")).toContain("[send]");
});
test("holder buttons call the exact action, and a drag copies code without the borders", async () => {
  const calls: unknown[] = [];
  const effects: Actions = {
    copy: (text) => {
      calls.push(["copy", text]);
    },
    targets: [{ name: "pc" }, { name: "laptop" }],
    copyTo: async (machine, text) => {
      calls.push([machine, text]);
    },
    tmux: async (input) => {
      calls.push(["tmux", input]);
    },
    run: async (input) => {
      calls.push(["run", input]);
    },
    send: async (input) => {
      calls.push(["send", input]);
    },
  };
  const view = await testRender(
    <TranscriptViewport
      effects={effects}
      cwd="/fixture"
      items={[{ id: "a", kind: "assistant", text: "```bash\necho hi\npwd\n```" }]}
      width={80}
      height={14}
    />,
    { width: 80, height: 14 },
  );
  const press = async (label: string) => {
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(label));
    await act(async () => {
      await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  };
  try {
    await view.waitForFrame((f) => f.includes("[run]"));
    const command = { cwd: "/fixture", command: "echo hi\npwd" };
    for (const [label, expected] of [
      ["[copy]", ["copy", "echo hi\npwd"]],
      ["[pc]", ["pc", "echo hi\npwd"]],
      ["[laptop]", ["laptop", "echo hi\npwd"]],
      ["[tmux]", ["tmux", command]],
      ["[run]", ["run", command]],
      ["[send]", ["send", { kind: "text", text: "echo hi\npwd" }]],
    ] as const) {
      await press(label);
      expect(calls.at(-1)).toEqual([...expected]);
    }
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("echo hi"));
    const x = lines[y]!.indexOf("echo hi");
    await act(async () => {
      await view.mockMouse.drag(x, y, x + 4, y + 1);
    });
    await view.flush();
    const copied = calls.at(-1) as [string, string];
    expect(copied[0]).toBe("copy");
    expect(copied[1]).toContain("echo");
    expect(copied[1]).not.toContain("│");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});
