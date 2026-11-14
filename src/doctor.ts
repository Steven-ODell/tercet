import { recorderStatus } from "./dictation";
import { access } from "node:fs/promises";
import { homedir, release } from "node:os";
import { connectionConfig, isLoopback, type Config } from "./client/config";
import { readOptional } from "./client/platform";
import {
  SettingsError,
  defaultSettings,
  loadSettings,
  settingsDir,
  settingsFile,
  type CommandSpec,
  type LoadedSettings,
  type Settings,
} from "./client/settings";
import {
  expand,
  clipboardChain,
  openerChain,
  playerChain,
  type ClipboardTool,
  type Host,
} from "./portable";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { PINNED_SERVER_VERSION, checkDescriptor, supportedRange } from "./client/compat";
import { decideMedia, queryTerminal, type Replies, type Rung } from "./client/media";

import { version } from "../package.json";

/** From package.json, so `scripts/release` bumps it in one place. The bundle inlines it. */
export const TERCET_VERSION: string = version;
export { PINNED_SERVER_VERSION } from "./client/compat";

/** Everything doctor looks at. Tests replace all of it; nothing here may start or stop a server. */
export interface DoctorProbes {
  env: Record<string, string | undefined>;
  home: string;
  platform: string;
  release: string;
  arch: string;
  read(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
  /** Full path of a program on PATH, or null. */
  which(program: string): string | null;
  /** Runs argv with a short timeout; never throws. */
  run(args: string[]): Promise<{ code: number; stdout: string }>;
  /** GET the server's public descriptor; throws when unreachable. */
  environment(origin: string): Promise<unknown>;
  /** The terminal's replies to the Kitty query and DA1; null outside a terminal or in tmux. */
  terminal(): Promise<Replies | null>;
}

type Found = string | null;

export interface DoctorReport {
  tercet: string;
  os: { platform: string; name: string | null; release: string; arch: string };
  settings: { path: string; status: "found" | "missing" | "invalid"; error?: string };
  terminal: {
    term: string | null;
    program: string | null;
    colorterm: string | null;
    outer: string | null;
  };
  tmux: { inside: boolean; version: string | null; allowPassthrough: string | null; hint?: string };
  images: { protocol: Rung; setting: string; reason: string; hint?: string };
  /** Where Enter plays video and audio, and what draws a poster. */
  video: { mode: string; player: string | null; poster: boolean };
  /** The tools the clipboard chain picked (see portable.ts); writes always add OSC 52. */
  clipboard: { write: string[]; read: string[]; images: boolean };
  opener: { configured: string | null; found: Found };
  tools: Record<"tmux" | "ffmpeg" | "mpv", Found>;
  server: {
    url: string;
    reachable: boolean;
    error?: string;
    serverVersion: string | null;
    protocolVersion: number | null;
    supported: "yes" | "untested" | "no" | "unknown";
    detail: string;
    tokenFile: string;
    token: "present" | "missing" | "issued on first start";
  };
  actions: { name: string; available: boolean | null; detail: string }[];
  look: {
    theme: string;
    icons: "nerd" | "unicode" | "ascii";
    /** With `nerd`: false when the glyphs likely won't render, null when tercet can't tell. */
    glyphs: boolean | null;
    hint?: string;
  };
}

/**
 * Whether Nerd Font glyphs will likely draw. tercet can't see the terminal's font, so this reads the
 * signs: the Linux console has no such font, over SSH the font is on the other machine, and
 * locally fc-list shows whether any Nerd Font is installed.
 */
async function glyphsReport(
  settings: Config["settings"],
  probes: DoctorProbes,
  fcList: Found,
): Promise<DoctorReport["look"]> {
  const theme = `${settings.theme.preset ?? "cyberdream"}${settings.theme.accent ? `, accent ${settings.theme.accent}` : ""}`;
  const icons = settings.icons;
  if (icons !== "nerd") return { theme, icons, glyphs: null };
  const unicode = 'set "icons": "unicode" if you see boxes';
  if (probes.env.TERM === "linux")
    return { theme, icons, glyphs: false, hint: `the Linux console can't draw them; ${unicode}` };
  if (probes.env.SSH_CONNECTION)
    return {
      theme,
      icons,
      glyphs: null,
      hint: `over SSH they need a Nerd Font on the machine you type on; ${unicode}`,
    };
  if (!fcList) return { theme, icons, glyphs: null, hint: `fc-list not found to check fonts` };
  const fonts = await probes.run([fcList, ":", "family"]);
  if (fonts.code === 0 && /Nerd Font|\bNF\b/.test(fonts.stdout))
    return { theme, icons, glyphs: true };
  return { theme, icons, glyphs: false, hint: `no Nerd Font installed (fc-list); ${unicode}` };
}

const commandName = (spec: string | readonly string[] | undefined) =>
  spec === undefined ? null : typeof spec === "string" ? spec : spec.join(" ");

async function osName(probes: DoctorProbes) {
  if (probes.platform === "darwin") {
    const result = await probes.run(["sw_vers", "-productVersion"]);
    return result.code === 0 ? `macOS ${result.stdout.trim()}` : "macOS";
  }
  const release = await probes.read("/etc/os-release").catch(() => undefined);
  const name = release?.match(/^PRETTY_NAME="?([^"\n]*)"?$/m)?.[1];
  return name || null;
}

async function tmuxReport(
  probes: DoctorProbes,
  tmuxPath: Found,
): Promise<DoctorReport["tmux"] & { client: string | null }> {
  const inside = !!probes.env.TMUX;
  if (!tmuxPath) return { inside, version: null, allowPassthrough: null, client: null };
  const version = await probes.run(["tmux", "-V"]);
  if (!inside)
    return {
      inside,
      version: version.code === 0 ? version.stdout.trim() : null,
      allowPassthrough: null,
      client: null,
    };
  // Inside tmux these read the running server through $TMUX, the pane's effective value included.
  const [passthrough, client] = await Promise.all([
    probes.run(["tmux", "show-options", "-Apv", "allow-passthrough"]),
    probes.run(["tmux", "display-message", "-p", "#{client_termname}"]),
  ]);
  const value = passthrough.code === 0 ? passthrough.stdout.trim() || "off" : null;
  return {
    inside,
    version: version.code === 0 ? version.stdout.trim() : null,
    allowPassthrough: value,
    client: client.code === 0 ? client.stdout.trim() || null : null,
    ...(value === "off"
      ? { hint: "images need it: add `set -g allow-passthrough on` to tmux.conf" }
      : {}),
  };
}

const imagesReport = (
  { rung, ...decision }: ReturnType<typeof decideMedia>,
  setting: string,
): DoctorReport["images"] => ({ protocol: rung, setting, ...decision });

async function serverReport(config: Config, probes: DoctorProbes): Promise<DoctorReport["server"]> {
  const tokenPresent = await probes.exists(config.tokenFile);
  const local = isLoopback(new URL(config.url).hostname);
  const token = tokenPresent
    ? "present"
    : config.managedToken && local
      ? "issued on first start"
      : "missing";
  const base = { url: config.url, tokenFile: config.tokenFile, token } as const;
  let descriptor: unknown;
  try {
    descriptor = await probes.environment(config.url);
  } catch (error) {
    return {
      ...base,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
      serverVersion: null,
      protocolVersion: null,
      supported: "unknown",
      detail: local
        ? "is the T3 server running? Start it with `t3`"
        : "check --url and the network",
    };
  }
  const check = checkDescriptor(descriptor);
  const record = (descriptor ?? {}) as Record<string, unknown>;
  const serverVersion = typeof record.serverVersion === "string" ? record.serverVersion : null;
  const protocolVersion =
    check.kind === "protocol" || check.kind === "out-of-range" || check.kind === "no-version"
      ? check.protocol
      : (record.orchestrationProtocolVersion as number);
  // Same verdict as startup (client/compat.ts): only another protocol (or no version) is "no".
  const supported =
    check.kind === "protocol" || check.kind === "no-version"
      ? "no"
      : check.kind === "ok" && check.tested
        ? "yes"
        : "untested";
  return {
    ...base,
    reachable: true,
    serverVersion,
    protocolVersion,
    supported,
    detail:
      check.kind === "protocol"
        ? `this server speaks orchestration protocol ${check.protocol} and tercet speaks ${ORCHESTRATION_PROTOCOL_VERSION}; tercet stops here unless \`--ignore-version\``
        : check.kind === "no-version"
          ? `no version reported; tercet stops unless \`--ignore-version\``
          : check.kind === "out-of-range"
            ? `outside ${supportedRange}, tested on ${PINNED_SERVER_VERSION}; tercet starts with a warning banner and some things may not work`
            : check.kind === "ok" && check.tested
              ? `tercet is tested against ${PINNED_SERVER_VERSION}`
              : `within ${supportedRange}, but tercet is tested against ${PINNED_SERVER_VERSION}`,
  };
}

/** A command's program: found on PATH, or an existing absolute path. */
async function programOf(spec: CommandSpec, probes: DoctorProbes) {
  const program = typeof spec === "string" ? spec : spec[0]!;
  const ok = program.includes("/") ? await probes.exists(program) : !!probes.which(program);
  return { program, ok };
}

/** What each action will use on this machine, by the same chains and settings tercet runs with. */
async function actionsReport(
  settings: Settings,
  host: Host,
  probes: DoctorProbes,
  readOnly: boolean,
): Promise<DoctorReport["actions"]> {
  const chain = clipboardChain(settings, host);
  const opener = openerChain(settings, host);
  const rows: DoctorReport["actions"] = [];
  const add = (name: string, available: boolean | null, detail: string) =>
    rows.push(
      readOnly && name !== "copy text" && name !== "spell check"
        ? { name, available: false, detail: "blocked by --read-only" }
        : { name, available, detail },
    );
  const command = async (name: string, key: string, spec: CommandSpec | undefined) => {
    if (!spec) return add(name, null, `not set up (add ${key} to settings)`);
    const { program, ok } = await programOf(spec, probes);
    add(name, ok, ok ? `${key}: ${program}` : `${key}: ${program} not found`);
  };
  add(
    "copy text",
    true,
    `OSC 52 (the terminal must allow clipboard writes)${chain.write ? ` and ${toolName(chain.write, "writer")}` : ""}`,
  );
  add(
    "paste text",
    !!chain.read,
    chain.read ? toolName(chain.read, "reader") : "no clipboard reader found",
  );
  add(
    "paste image",
    !!chain.read?.images,
    chain.read?.images
      ? toolName(chain.read, "reader")
      : chain.read
        ? `${toolName(chain.read, "reader")} is text only`
        : "no clipboard reader found",
  );
  add(
    "copy image",
    !!chain.write?.images,
    chain.write?.images
      ? toolName(chain.write, "writer")
      : chain.write
        ? `${toolName(chain.write, "writer")} is text only`
        : "no clipboard writer found",
  );
  add("open links and files", !!opener, opener?.name ?? "no opener found");
  for (const [name, target] of Object.entries(settings.targets))
    await command(`copy to ${name}`, `targets.${name}.copy`, target.copy);
  if (settings.commands.shell || !settings.launchers.terminal)
    await command("shell", "commands.shell", settings.commands.shell);
  else await command("shell", "launchers.terminal", settings.launchers.terminal);
  if (settings.commands.editor || !settings.launchers.editor)
    await command("editor", "commands.editor", settings.commands.editor);
  else await command("editor", "launchers.editor", settings.launchers.editor);
  await command("type into a terminal", "commands.tmux", settings.commands.tmux);
  await command("run code block", "commands.run", settings.commands.run);
  await command("send", "commands.send", settings.commands.send);
  if (settings.commands.dictation) await command("dictation", "commands.dictation", settings.commands.dictation);
  else {
    const recorder = recorderStatus(host, settings.dictation.recorder ? expand(settings.dictation.recorder, {}) : undefined);
    add("dictation", recorder.ready, recorder.ready ? `${recorder.name}; T3 web app → Settings → Voice must have a model installed` : recorder.reason);
  }
  await command("link mapping", "commands.mapUrl", settings.commands.mapUrl);
  add(
    "spell check",
    settings.spell.enabled ? true : null,
    settings.spell.enabled
      ? "built-in English (US); words you add go to the personal dictionary file"
      : "off (spell.enabled is false)",
  );
  return rows;
}

const toolName = (tool: ClipboardTool, side: "writer" | "reader") =>
  side in tool ? (tool as unknown as Record<string, string>)[side]! : tool.name;

export async function doctorReport(args: string[], probes: DoctorProbes): Promise<DoctorReport> {
  const flags = args.filter((arg) => arg !== "--json");
  const dir = settingsDir(probes.env, probes.home);
  let loaded: LoadedSettings;
  let settings: DoctorReport["settings"];
  try {
    loaded = await loadSettings(dir, probes.read, probes.home);
    settings = { path: loaded.path, status: loaded.found ? "found" : "missing" };
  } catch (error) {
    const path = settingsFile(dir);
    loaded = { dir, path, found: true, settings: defaultSettings() };
    settings = {
      path,
      status: "invalid",
      error: error instanceof SettingsError ? error.message : String(error),
    };
  }
  let config: Config;
  try {
    config = await connectionConfig(flags, probes.read, probes.home, probes.env, loaded);
  } catch (error) {
    // A bad flag or runtime file still gets a report, for the default connection.
    config = await connectionConfig([], async () => undefined, probes.home, probes.env, loaded);
    settings.error ??= `ignored arguments: ${error instanceof Error ? error.message : String(error)}`;
  }
  const programs = new Map<string, Found>();
  const found = (program: string) => {
    if (!programs.has(program)) programs.set(program, probes.which(program));
    return programs.get(program)!;
  };
  const env = probes.env;
  const host: Host = { env, platform: probes.platform, which: found };
  const chain = clipboardChain(config.settings, host);
  const [name, tmux, server, replies] = await Promise.all([
    osName(probes).catch(() => null),
    tmuxReport(probes, found("tmux")),
    serverReport(config, probes),
    // Inside tmux the replies would be tmux's own, so only names count there.
    config.settings.media.protocol === "auto" && !env.TMUX
      ? probes.terminal().catch(() => null)
      : null,
  ]);
  const { client, ...tmuxPublic } = tmux;
  // Outside tmux a TERM_PROGRAM of "tmux" is left over from a parent shell, not the terminal.
  const program = env.TERM_PROGRAM === "tmux" && !tmux.inside ? undefined : env.TERM_PROGRAM;
  const outer = tmux.inside ? client : (program ?? env.TERM ?? null);
  return {
    tercet: TERCET_VERSION,
    os: { platform: probes.platform, name, release: probes.release, arch: probes.arch },
    settings,
    terminal: {
      term: env.TERM ?? null,
      program: env.TERM_PROGRAM
        ? `${env.TERM_PROGRAM}${env.TERM_PROGRAM_VERSION ? ` ${env.TERM_PROGRAM_VERSION}` : ""}`
        : null,
      colorterm: env.COLORTERM ?? null,
      outer,
    },
    tmux: tmuxPublic,
    images: imagesReport(
      decideMedia({
        setting: config.settings.media.protocol,
        env: { ...env, TERM_PROGRAM: program },
        replies,
        tmux: { inside: tmux.inside, passthrough: tmux.allowPassthrough, client },
        ascii: config.settings.icons === "ascii",
      }),
      config.settings.media.protocol,
    ),
    video: {
      mode: config.settings.media.video,
      player: playerChain(config.settings, host)?.name ?? null,
      poster: !!found("ffmpeg"),
    },
    clipboard: {
      write: ["OSC 52", ...(chain.write ? [toolName(chain.write, "writer")] : [])],
      read: chain.read ? [toolName(chain.read, "reader")] : [],
      images: !!(chain.write?.images && chain.read?.images),
    },
    opener: {
      configured: commandName(config.settings.launchers.opener),
      found: openerChain({ ...config.settings, launchers: {} }, host)?.name ?? null,
    },
    tools: { tmux: found("tmux"), ffmpeg: found("ffmpeg"), mpv: found("mpv") },
    server,
    actions: await actionsReport(config.settings, host, probes, config.readOnly),
    look: await glyphsReport(config.settings, probes, found("fc-list")),
  };
}

const mark = (ok: boolean | null) => (ok === null ? "-" : ok ? "ok" : "!!");

/** The human report: one fact per line, `ok`, `!!` (needs attention) or `-` (informational). */
export function formatReport(report: DoctorReport) {
  const rows: [boolean | null, string, string][] = [];
  const row = (ok: boolean | null, label: string, value: string) => rows.push([ok, label, value]);
  const { os, settings, terminal, tmux, images, server } = report;
  row(null, "tercet", report.tercet);
  row(null, "os", [os.name, `${os.platform} ${os.release} ${os.arch}`].filter(Boolean).join(", "));
  row(
    settings.status !== "invalid",
    "settings",
    settings.status === "found"
      ? settings.path
      : settings.status === "missing"
        ? `${settings.path} (none yet; using defaults)`
        : `${settings.error} (using defaults)`,
  );
  if (settings.status !== "invalid" && settings.error) row(false, "arguments", settings.error);
  row(
    null,
    "terminal",
    [
      terminal.outer,
      terminal.term && `TERM=${terminal.term}`,
      terminal.colorterm && `COLORTERM=${terminal.colorterm}`,
    ]
      .filter(Boolean)
      .join(", ") || "unknown",
  );
  row(null, "theme", report.look.theme);
  row(
    report.look.glyphs,
    "icons",
    [report.look.icons, report.look.hint].filter(Boolean).join("; "),
  );
  // tmux is optional: the row only shows when tercet runs inside it.
  if (tmux.inside)
    row(
      tmux.allowPassthrough !== "off",
      "tmux",
      `${tmux.version ?? "version unknown"}, inside, allow-passthrough ${tmux.allowPassthrough ?? "unknown"}${tmux.hint ? `; ${tmux.hint}` : ""}`,
    );
  row(
    images.hint ? false : ["kitty", "sixel"].includes(images.protocol) ? true : null,
    "images",
    `${images.protocol} (${images.reason}; media.protocol=${images.setting})`,
  );
  const { video } = report;
  row(
    !!video.player,
    "video",
    `${video.mode === "terminal" ? "mpv in this terminal" : `player ${video.player ?? "none found"}`}; ${video.poster ? "posters by ffmpeg" : "no ffmpeg: name and size only"}`,
  );
  row(true, "clipboard write", report.clipboard.write.join(", "));
  row(
    report.clipboard.read.length > 0,
    "clipboard read",
    report.clipboard.read.join(", ") || "no tool found",
  );
  row(
    !!(report.opener.configured || report.opener.found),
    "opener",
    [
      report.opener.configured && `configured ${report.opener.configured}`,
      report.opener.found ? `found ${report.opener.found}` : "none found",
    ]
      .filter(Boolean)
      .join(", "),
  );
  for (const [tool, path] of Object.entries(report.tools))
    if (tool !== "tmux") row(!!path, tool, path ?? "not found");
  row(
    server.reachable,
    "server",
    server.reachable ? server.url : `${server.url} unreachable: ${server.error}; ${server.detail}`,
  );
  if (server.reachable)
    row(
      server.supported === "yes" ? true : server.supported === "no" ? false : null,
      "server version",
      `${server.serverVersion ?? "unknown"}, protocol ${server.protocolVersion}: ${server.supported} (${server.detail})`,
    );
  row(server.token !== "missing", "token", `${server.tokenFile} (${server.token})`);
  for (const action of report.actions)
    row(action.available, `action: ${action.name}`, action.detail);
  const width = Math.max(...rows.map(([, label]) => label.length));
  return rows
    .map(([ok, label, value]) => `${mark(ok).padEnd(2)} ${label.padEnd(width)}  ${value}`)
    .join("\n");
}

/** Real probes for `tercet doctor`. Each command gets a 3 second limit; failures become "not found". */
export function systemProbes(): DoctorProbes {
  return {
    env: process.env,
    home: homedir(),
    platform: process.platform,
    release: release(),
    arch: process.arch,
    read: readOptional,
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    which: (program) => Bun.which(program),
    async run(args) {
      try {
        const child = Bun.spawn(args, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          timeout: 3000,
        });
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        return { code, stdout };
      } catch {
        return { code: 127, stdout: "" };
      }
    },
    async environment(origin) {
      const response = await fetch(new URL("/.well-known/t3/environment", origin), {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    terminal: () => queryTerminal(process.stdin, process.stdout),
  };
}

/** `tercet doctor [--json] [--url ...] [--base-dir ...] [--token-file ...]`. Always exits 0. */
export async function runDoctor(args: string[], probes = systemProbes()) {
  try {
    const report = await doctorReport(args, probes);
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  } catch (error) {
    console.log(
      `tercet doctor: could not finish the report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return 0;
}
