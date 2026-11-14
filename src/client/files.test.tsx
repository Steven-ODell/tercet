import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import { FilesPanel, type FilesApi } from "./files";
import { fileIcon } from "./icons";

const shut = fileIcon("x", "directory").glyph;
const open = fileIcon("x", "directory", true).glyph;
import { fileMethods } from "./connection";
import { sandboxUrl, tokenPath } from "../spikes/connect";

async function exercise(source: FilesApi, cwd: string) {
  const pending = new Set<Promise<unknown>>();
  const track = <T,>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const api: FilesApi = {
    list: (input) => track(source.list(input)),
    read: (input) => track(source.read(input)),
    find: (input) => track(source.find(input)),
    search: (input) => track(source.search(input)),
  };
  const calls: unknown[] = [];
  const edits: string[] = [];
  const view = await testRender(
    <FilesPanel
      api={api}
      edit={(path) => edits.push(path)}
      cwd={cwd}
      enabled
      height={32}
      close={() => calls.push("close")}
      effects={{
        copy() {},
        editor: async (input) => {
          calls.push(input);
        },
      }}
    />,
    { width: 80, height: 32, kittyKeyboard: true, exitOnCtrlC: false },
  );
  const wait = (predicate: (frame: string) => boolean) =>
    view.waitForFrame(
      async (frame) => {
        await act(async () => {
          await Promise.all(pending);
        });
        return predicate(frame);
      },
      { maxPasses: 50 },
    );
  const key = async (name: string) => {
    await act(async () => {
      view.mockInput.pressKey(name);
    });
    await view.flush();
  };
  const click = async (label: string) => {
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((l) => l.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
    });
    await view.flush();
  };
  try {
    await wait((f) => f.includes(`▸ ${shut} src`));
    await key("RETURN");
    await wait((f) => f.includes("hello.ts"));
    await key("ARROW_DOWN");
    await key("RETURN");
    await wait((f) => f.includes("const greeting"));
    await key("o");
    expect(calls.at(-1)).toEqual({ cwd, path: "src/hello.ts" });
    await click("[o External editor]");
    expect(calls).toHaveLength(2);
    await key("e");
    await click("[e Edit here]");
    expect(edits).toEqual(["src/hello.ts", "src/hello.ts"]);
    await key("ESCAPE");
    await key("/");
    await act(async () => {
      await view.mockInput.typeText("hlo");
    });
    await key("RETURN");
    await wait((f) => f.includes("src/hello.ts"));
    await key("RETURN");
    await wait((f) => f.includes("const greeting"));
    await click("[s Search]");
    await act(async () => {
      await view.mockInput.typeText("needle");
    });
    await click("[Enter results]");
    await wait((f) => f.includes("src/hello.ts:2"));
    await click("src/hello.ts:2");
    await wait((f) => f.includes("2 // needle"));
    await click("[b Tree]");
    await wait((f) => f.includes(`▾ ${open} src`));
    await click(`▾ ${open} src`);
    await wait((f) => f.includes(`▸ ${shut} src`));
    await click(`▸ ${shut} src`);
    await wait((f) => f.includes("hello.ts"));
    await click("hello.ts");
    await wait((f) => f.includes("const greeting"));
    await click("[Esc Back]");
    await key("ESCAPE"); // at the top level Esc is the frame's, which leaves the panel but keeps it open
    expect(calls.at(-1)).not.toBe("close");
  } finally {
    await view.dispose();
  }
}
const fixture: FilesApi = {
  list: async (input) => ({
    entries: input.directoryPath
      ? [{ path: "src/hello.ts", kind: "file" }]
      : [{ path: "src", kind: "directory" }],
    truncated: false,
  }),
  read: async () => ({
    relativePath: "src/hello.ts",
    contents: 'const greeting = "hello";\n// needle\n',
    byteLength: 40,
    truncated: false,
  }),
  find: async () => ({ entries: [{ path: "src/hello.ts", kind: "file" }], truncated: false }),
  search: async () => ({
    matches: [
      {
        path: "src/hello.ts",
        lineNumber: 2,
        lineContent: "// needle",
        matchRanges: [{ start: 3, end: 9 }],
      },
    ],
    truncated: false,
  }),
};
test("files tree, colored preview, fuzzy find, content search and editor by keys and mouse", async () => {
  await exercise(fixture, "/fixture");
});

test("files j/k/l/h navigate, and opening a folder keeps the cursor and lists only that folder", async () => {
  const listed: string[] = [];
  const api: FilesApi = {
    ...fixture,
    list: async (input) => {
      listed.push(input.directoryPath ?? "");
      return {
        entries: input.directoryPath
          ? [{ path: `${input.directoryPath}/inner.ts`, kind: "file" as const }]
          : ["a", "b", "c", "d"].map((path) => ({ path, kind: "directory" as const })),
        truncated: false,
      };
    },
  };
  const view = await testRender(
    <FilesPanel api={api} cwd="/fixture" enabled height={32} close={() => {}} />,
    { width: 80, height: 32, kittyKeyboard: true, exitOnCtrlC: false },
  );
  const key = async (name: string) => {
    await act(async () => {
      view.mockInput.pressKey(name);
    });
    await view.flush();
  };
  const wait = (predicate: (frame: string) => boolean) =>
    view.waitForFrame(predicate, { maxPasses: 50 });
  try {
    await wait((f) => f.includes(`▸ ${shut} c`));
    await key("j");
    await key("j");
    await key("l"); // expand c
    await wait((f) => f.includes("inner.ts"));
    expect(view.captureCharFrame()).toContain(`› ▾ ${open} c`);
    await key("j");
    await key("l"); // open inner.ts
    await wait((f) => f.includes("const greeting"));
    await key("h"); // close the file
    expect(view.captureCharFrame()).toContain("› ");
    expect(view.captureCharFrame()).toContain("inner.ts");
    await key("h"); // from the file row to its folder
    expect(view.captureCharFrame()).toContain(`› ▾ ${open} c`);
    await key("h"); // collapse
    await wait((f) => f.includes(`› ▸ ${shut} c`) && !f.includes("inner.ts"));
    await key("k");
    expect(view.captureCharFrame()).toContain(`› ▸ ${shut} b`);
    expect(listed).toEqual(["", "c"]);
  } finally {
    await view.dispose();
  }
});

test.skipIf(process.env.TERCET_SANDBOX_TEST !== "1")(
  "sandbox fixture files browse, preview and search through real RPC by keys and mouse",
  async () => {
    const cwd = await NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/tercet-files-`);
    try {
      await NodeFSP.mkdir(`${cwd}/src`);
      await NodeFSP.writeFile(`${cwd}/src/hello.ts`, 'const greeting = "hello";\n// needle\n');
      const token = (await NodeFSP.readFile(tokenPath, "utf8")).trim();
      const api: FilesApi = {
        // OpenTUI's own test runtime drives this bounded, read-only sandbox RPC boundary.
        // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- OpenTUI owns the UI test runtime; this runs read-only sandbox RPCs.
        list: (input) => Effect.runPromise(fileMethods.list(sandboxUrl, token, input)),
        // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- OpenTUI owns the UI test runtime; this runs read-only sandbox RPCs.
        find: (input) => Effect.runPromise(fileMethods.find(sandboxUrl, token, input)),
        // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- OpenTUI owns the UI test runtime; this runs read-only sandbox RPCs.
        search: (input) => Effect.runPromise(fileMethods.search(sandboxUrl, token, input)),
        // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- OpenTUI owns the UI test runtime; this runs read-only sandbox RPCs.
        read: (input) => Effect.runPromise(fileMethods.read(sandboxUrl, token, input)),
      };
      await exercise(api, cwd);
    } finally {
      await NodeFSP.rm(cwd, { recursive: true, force: true });
    }
  },
  30000,
);

test("routed files preview directly, failed reads retry without raw errors, and empty projects stay usable", async () => {
  let attempts = 0;
  const api: FilesApi = {
    ...fixture,
    read: async (input) => {
      if (++attempts === 1) throw new Error("private transport detail");
      return fixture.read(input);
    },
  };
  const view = await testRender(
    <FilesPanel
      api={api}
      cwd="/fixture"
      path="src/hello.ts:2"
      enabled
      height={24}
      close={() => {}}
    />,
    { width: 60, height: 24 },
  );
  try {
    await view.waitForFrame((f) => f.includes("Preview unavailable"));
    expect(view.captureCharFrame()).not.toContain("private transport detail");
    await act(async () => {
      view.mockInput.pressKey("r");
    });
    await view.waitForFrame((f) => f.includes("2 // needle"));
    await act(async () => {
      view.mockInput.pressKey("ARROW_UP");
    });
    await view.waitForFrame((f) => f.includes("const greeting"));
    expect(attempts).toBe(2);
    expect(view.captureCharFrame()).toContain("src/hello.ts");
  } finally {
    await view.dispose();
  }
  const empty = await testRender(
    <FilesPanel
      api={{ ...fixture, list: async () => ({ entries: [], truncated: false }) }}
      cwd="/empty"
      enabled
      height={24}
      close={() => {}}
    />,
    { width: 60, height: 24 },
  );
  try {
    await empty.waitForFrame((f) => f.includes("No files"));
  } finally {
    await empty.dispose();
  }
});

test("the row under the cursor previews below the list: text, images through Kitty, p toggles", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  const loaded: string[] = [];
  const pending = new Set<Promise<unknown>>();
  const track = <T,>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const source = {
    list: async () => ({
      entries: [
        { path: "a.ts", kind: "file" },
        { path: "pic.png", kind: "file" },
        { path: "src", kind: "directory" },
      ],
      truncated: false,
    }),
    read: async ({ relativePath }: { relativePath: string }) => ({
      relativePath,
      contents: "const peeked = 1;\nsecond line",
      truncated: false,
    }),
    find: async () => ({ entries: [], truncated: false }),
    search: async () => ({ matches: [], truncated: false }),
  } as unknown as FilesApi;
  const api: FilesApi = {
    list: (input) => track(source.list(input)),
    read: (input) => track(source.read(input)),
    find: (input) => track(source.find(input)),
    search: (input) => track(source.search(input)),
  };
  const view = await testRender(
    <FilesPanel
      api={api}
      cwd="/repo"
      enabled
      height={32}
      width={60}
      peekDelay={0}
      close={() => {}}
      effects={{
        copy() {},
        loadImage: (path, cwd) => {
          loaded.push(`${cwd}:${path}`);
          return track(Promise.resolve(png));
        },
      }}
    />,
    { width: 60, height: 32, kittyKeyboard: true, exitOnCtrlC: false },
  );
  const wait = (predicate: (frame: string) => boolean) =>
    view.waitForFrame(
      async (frame) => {
        await act(async () => {
          await Promise.all(pending);
        });
        return predicate(frame);
      },
      { maxPasses: 50 },
    );
  const key = async (name: string) => {
    await act(async () => {
      view.mockInput.pressKey(name);
    });
    await view.flush();
  };
  try {
    // Folders sort first, so the cursor starts on one.
    await wait((f) => f.includes("Folder: Enter or l opens it"));
    await key("j");
    await wait((f) => f.includes("── a.ts ─") && f.includes("1 const peeked = 1;"));
    expect(view.captureCharFrame()).toContain("2 second line");
    await key("j");
    await wait((f) => f.includes("── pic.png ─") && !f.includes("const peeked"));
    expect(loaded).toEqual(["/repo:pic.png"]);
    await key("p");
    await wait((f) => f.includes("[p Preview off]") && !f.includes("── pic.png"));
    await key("p");
    await wait((f) => f.includes("── pic.png ─"));
    // Back over a file already read: no second load.
    await key("k");
    await key("j");
    await wait((f) => f.includes("── pic.png ─"));
    expect(loaded).toEqual(["/repo:pic.png"]);
    await key("g");
    await wait((f) => f.includes("Folder: Enter or l opens it"));
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("external editor setup is explained and saved changes refresh on return", async () => {
  let contents = "before";
  const api = {
    list: async () => ({ entries: [{ path: "file.txt", kind: "file" }], truncated: false }),
    read: async () => ({
      relativePath: "file.txt",
      contents,
      byteLength: contents.length,
      truncated: false,
    }),
    find: async () => ({ entries: [], truncated: false }),
    search: async () => ({ matches: [], truncated: false }),
  } as FilesApi;
  const view = await testRender(
    <FilesPanel
      api={api}
      cwd="/fixture"
      path="file.txt"
      enabled
      height={30}
      width={100}
      close={() => {}}
    />,
    { width: 110, height: 30 },
  );
  try {
    await view.waitForFrame((f) => f.includes("before"));
    await act(async () => {
      view.mockInput.pressKey("o");
    });
    await view.waitForFrame((f) => f.includes("No editor set"));
    contents = "saved externally";
    await act(async () => {
      view.renderer.emit("focus");
    });
    await view.waitForFrame((f) => f.includes("saved externally"));
  } finally {
    await view.dispose();
  }
});
