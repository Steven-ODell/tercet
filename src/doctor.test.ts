import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PINNED_SERVER_VERSION,
  doctorReport,
  formatReport,
  runDoctor,
  type DoctorProbes,
} from "./doctor";

/** A made-up machine: nothing here touches the real one, its PATH, tmux or port 3773. */
function machine(overrides: Partial<DoctorProbes> & { files?: Record<string, string> } = {}) {
  const files: Record<string, string> = {
    "/etc/os-release": 'NAME="Test"\nPRETTY_NAME="Test Linux 1"\n',
    ...overrides.files,
  };
  // A fake PATH holding the Wayland clipboard and opener, so the chains report them.
  const installed = new Set(["tmux", "wl-copy", "wl-paste", "xdg-open", "ffmpeg"]);
  const runs: string[][] = [];
  const fetched: string[] = [];
  const probes: DoctorProbes = {
    env: {
      TERM: "tmux-256color",
      TERM_PROGRAM: "tmux",
      COLORTERM: "truecolor",
      TMUX: "/tmp/tmux-1000/fake,1,0",
      WAYLAND_DISPLAY: "wayland-1",
    },
    home: "/home/u",
    platform: "linux",
    release: "6.1.0",
    arch: "x64",
    read: async (path) => files[path],
    exists: async (path) => path in files,
    which: (program) => (installed.has(program) ? `/usr/bin/${program}` : null),
    run: async (args) => {
      runs.push(args);
      const out: Record<string, string> = {
        "tmux -V": "tmux 3.5a\n",
        "tmux show-options -Apv allow-passthrough": "off\n",
        "tmux display-message -p #{client_termname}": "xterm-ghostty\n",
      };
      const stdout = out[args.join(" ")];
      return stdout === undefined ? { code: 1, stdout: "" } : { code: 0, stdout };
    },
    environment: async (origin) => {
      fetched.push(origin);
      return { serverVersion: "0.1.8", orchestrationProtocolVersion: 2, label: "box" };
    },
    terminal: async () => null,
    ...overrides,
  };
  return { probes, runs, fetched };
}

test("the pinned server version matches vendor/t3/UPSTREAM", () => {
  const upstream = readFileSync(new URL("../vendor/t3/UPSTREAM", import.meta.url), "utf8");
  expect(upstream).toContain(`tag=v${PINNED_SERVER_VERSION}\n`);
});

test("doctor reports a tmux machine with passthrough off and a supported server", async () => {
  const { probes, fetched } = machine({
    files: { "/home/u/.t3/userdata/server-runtime.json": '{"origin":"http://127.0.0.1:3775"}' },
  });
  const report = await doctorReport([], probes);
  expect(fetched).toEqual(["http://127.0.0.1:3775"]);
  expect(report.os).toEqual({
    platform: "linux",
    name: "Test Linux 1",
    release: "6.1.0",
    arch: "x64",
  });
  expect(report.settings).toEqual({
    path: "/home/u/.config/tercet/settings.json",
    status: "missing",
  });
  expect(report.terminal.outer).toBe("xterm-ghostty");
  expect(report.tmux).toEqual({
    inside: true,
    version: "tmux 3.5a",
    allowPassthrough: "off",
    hint: "images need it: add `set -g allow-passthrough on` to tmux.conf",
  });
  // Half-blocks until passthrough is on, and the same hint the status line shows once.
  expect(report.images).toMatchObject({
    protocol: "blocks",
    hint: "images need it: add `set -g allow-passthrough on` to tmux.conf",
  });
  expect(report.clipboard).toEqual({
    write: ["OSC 52", "wl-copy"],
    read: ["wl-paste"],
    images: true,
  });
  expect(report.opener).toEqual({ configured: null, found: "xdg-open" });
  expect(report.tools).toEqual({ tmux: "/usr/bin/tmux", ffmpeg: "/usr/bin/ffmpeg", mpv: null });
  expect(report.server).toMatchObject({
    url: "http://127.0.0.1:3775",
    reachable: true,
    serverVersion: "0.1.8",
    protocolVersion: 2,
    supported: "yes",
    token: "issued on first start",
  });
  const action = (name: string) => report.actions.find((a) => a.name === name);
  expect(action("copy text")).toEqual({
    name: "copy text",
    available: true,
    detail: "OSC 52 (the terminal must allow clipboard writes) and wl-copy",
  });
  expect(action("paste image")?.available).toBe(true);
  expect(action("open links and files")?.detail).toBe("xdg-open");
  // Nothing personal is built in: without settings these are off and say how to turn them on.
  expect(action("shell")).toEqual({
    name: "shell",
    available: null,
    detail: "not set up (add commands.shell to settings)",
  });
  for (const name of ["editor", "type into a terminal", "run code block", "send", "dictation"])
    expect(action(name)?.available).toBeNull();
  const text = formatReport(report);
  expect(text).toContain("settings");
  expect(text).toMatch(/!! tmux +tmux 3\.5a, inside, allow-passthrough off; images need it/);
  expect(text).toMatch(/ok server version +0\.1\.8, protocol 2: yes/);
  expect(text).toMatch(/!! mpv +not found/);
  expect(text.split("\n").every((line) => /^(ok|!!|- ) /.test(line))).toBe(true);
});

test("outside tmux on a kitty terminal with settings, a flagged URL and an untested server", async () => {
  const { probes, runs } = machine({
    env: { TERM: "xterm-kitty", KITTY_WINDOW_ID: "1", XDG_CONFIG_HOME: "/xdg" },
    files: {
      "/xdg/tercet/settings.json": JSON.stringify({
        launchers: { opener: ["firefox"], editor: "code" },
        commands: { tmux: ["/opt/typer", "{text}"], send: ["sender", "{path}"] },
        targets: { desk: { copy: ["ssh", "desk", "remote-copy"], key: "D" } },
      }),
      "/opt/typer": "",
      "/tok": "secret",
    },
    environment: async () => ({ serverVersion: "0.1.9", orchestrationProtocolVersion: 2 }),
  });
  const report = await doctorReport(
    ["--json", "--url", "https://box:3773", "--token-file", "/tok"],
    probes,
  );
  expect(runs.map((r) => r.join(" "))).toEqual(["tmux -V"]);
  expect(report.settings.status).toBe("found");
  expect(report.tmux).toEqual({ inside: false, version: "tmux 3.5a", allowPassthrough: null });
  expect(report.images).toMatchObject({
    protocol: "kitty",
    reason: "xterm-kitty supports Kitty graphics",
  });
  expect(report.opener.configured).toBe("firefox");
  expect(report.server).toMatchObject({
    url: "https://box:3773",
    supported: "untested",
    token: "present",
  });
  const action = (name: string) => report.actions.find((a) => a.name === name);
  // No display: the installed wl-clipboard is not used, so writes are OSC 52 only.
  expect(report.clipboard).toEqual({ write: ["OSC 52"], read: [], images: false });
  expect(action("open links and files")).toMatchObject({
    available: true,
    detail: "launchers.opener",
  });
  expect(action("editor")).toMatchObject({
    available: false,
    detail: "launchers.editor: code not found",
  });
  expect(action("type into a terminal")).toMatchObject({
    available: true,
    detail: "commands.tmux: /opt/typer",
  });
  expect(action("send")).toMatchObject({
    available: false,
    detail: "commands.send: sender not found",
  });
  expect(action("copy to desk")).toMatchObject({
    available: false,
    detail: "targets.desk.copy: ssh not found",
  });
  expect(action("paste text")).toMatchObject({
    available: false,
    detail: "no clipboard reader found",
  });
});

test("a TERM_PROGRAM left over from tmux is not the terminal once outside it", async () => {
  const { probes } = machine({
    env: {
      TERM: "xterm-256color",
      TERM_PROGRAM: "tmux",
      GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty",
    },
  });
  const report = await doctorReport([], probes);
  expect(report.terminal.outer).toBe("xterm-256color");
  expect(report.images.reason).toBe("ghostty supports Kitty graphics");
  // Outside tmux, doctor says nothing about tmux at all.
  expect(formatReport(report)).not.toMatch(/^.. tmux /m);
});

test("a bad settings file, bad flags and an unreachable or newer server still give a report", async () => {
  const { probes } = machine({
    files: { "/home/u/.config/tercet/settings.json": '{\n  "media": { "protocol": "iterm" }\n}' },
    environment: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  const report = await doctorReport(["--wat"], probes);
  expect(report.settings.status).toBe("invalid");
  expect(report.settings.error).toContain("settings.json:2: media.protocol: expected one of");
  expect(report.server).toMatchObject({
    url: "http://127.0.0.1:3773",
    reachable: false,
    supported: "unknown",
    error: "connect ECONNREFUSED",
  });
  const text = formatReport(report);
  expect(text).toContain("media.protocol: expected one of");
  expect(text).toContain("unreachable: connect ECONNREFUSED");

  const flagged = await doctorReport(["--wat"], machine().probes);
  expect(flagged.settings.error).toBe("ignored arguments: unknown option --wat; see tercet --help");

  const newer = await doctorReport(
    [],
    machine({
      environment: async () => ({ serverVersion: "9.0.0", orchestrationProtocolVersion: 3 }),
    }).probes,
  );
  expect(newer.server.supported).toBe("no");
  expect(newer.server.detail).toContain("this server speaks orchestration protocol 3");
  expect(newer.server.detail).toContain("--ignore-version");

  // A newer minor on the same protocol starts, under a banner, and doctor says so.
  const minor = await doctorReport(
    [],
    machine({
      environment: async () => ({ serverVersion: "0.2.0", orchestrationProtocolVersion: 2 }),
    }).probes,
  );
  expect(minor.server.supported).toBe("untested");
  expect(minor.server.detail).toContain("starts with a warning banner");
  const nameless = await doctorReport(
    [],
    machine({ environment: async () => ({ orchestrationProtocolVersion: 2 }) }).probes,
  );
  expect(nameless.server.supported).toBe("no");
  expect(nameless.server.detail).toContain("no version reported");
});

test("doctor exits 0 and prints JSON even when a probe blows up", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    expect(await runDoctor(["--json"], machine().probes)).toBe(0);
    expect(JSON.parse(lines[0]!).server.supported).toBe("yes");
    const broken = machine({
      which: () => {
        throw new Error("PATH exploded");
      },
    }).probes;
    expect(await runDoctor([], broken)).toBe(0);
    expect(lines[1]).toBe("tercet doctor: could not finish the report: PATH exploded");
  } finally {
    console.log = log;
  }
});
