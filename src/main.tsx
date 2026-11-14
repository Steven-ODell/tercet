import { editorAction } from "./embedded-editor";
import {
  KITTY_CLEAR_DIRECT,
  KITTY_CLEAR_PLACEMENTS,
  clearKittyBeforeSwitch,
  kittyStdout,
} from "./kitty-output";
import { loadPreviewImage, attachmentSource, isRemoteSource } from "./client/image-preview-source";
import { imageOpenAction, resolveMediaTarget } from "./client/image-open";
import {
  decideMedia,
  media,
  mediaKind,
  mpvOutput,
  queryTerminal,
  setMedia,
  tmuxMedia,
} from "./client/media";
import { homedir } from "node:os";
import { join } from "node:path";
import { terminalLifecycle } from "./terminal-lifecycle";
import { createCliRenderer } from "@opentui/core";
import * as Effect from "effect/Effect";
import { createRoot } from "@opentui/react";
import { sshHostLookup, terminalActions } from "./actions";
import { hostActions, systemHost } from "./portable";
import { Hello } from "./hello";
import { ConfigError, USAGE, connectionConfig, isLoopback } from "./client/config";
import { SettingsError, migrateLegacyDir, settingsDir } from "./client/settings";
import { TERCET_VERSION, runDoctor } from "./doctor";
import { platform, readOptional } from "./client/platform";
import {
  PINNED_SERVER_VERSION,
  blocksStart,
  checkServer,
  compatMessage,
  compatWarning,
  supportedRange,
} from "./client/compat";
import { ServerGate } from "./client/screen";
import { blockWrites } from "./client/read-only";
import { createClient, waitForLive } from "./client/runtime";
import { AppFrame } from "./client/frame";
import { applyLook } from "./client/look";
import { asciiFrame, iconMode } from "./client/icons";
import { theme } from "./client/theme";
import { runKeys } from "./keys";
import { attachWhenReady, runList, runTmux } from "./cli";
import { runUpgrade } from "./upgrade";

const args = process.argv.slice(2);
if ((args.includes("--help") || args.includes("-h")) && !["list", "tmux", "upgrade"].includes(args[0] ?? "")) {
  console.log(USAGE);
  process.exit(0);
}
// Before anything reads the settings directory, so doctor and keys see the moved one too.
const migrated = args.includes("--version") ? undefined : migrateLegacyDir(process.env, homedir());
if (migrated) process.stderr.write(`${migrated}\n`);

if (process.argv[2] === "doctor") process.exit(await runDoctor(process.argv.slice(3)));
if (process.argv[2] === "keys") process.exit(await runKeys());
if (process.argv[2] === "upgrade") process.exit(await runUpgrade(process.argv.slice(3)));
if (process.argv[2] === "list") process.exit(await runList(process.argv.slice(3)));
if (process.argv[2] === "tmux") process.exit(await runTmux(process.argv.slice(3)));
// `tercet attach THREAD [options]`: the app on one thread, without the thread list.
const attachTo = process.argv[2] === "attach" ? process.argv[3] : undefined;
if (process.argv[2] === "attach" && (!attachTo || attachTo.startsWith("-"))) {
  console.error("usage: tercet attach THREAD [options]   (THREAD: id, short id or part of the title)");
  process.exit(2);
}
const appArgs = process.argv.slice(attachTo ? 4 : 2);
if (process.argv.includes("--version")) {
  // Bun fixes NODE_ENV when it transpiles: dist/tercet.js is built as production, a checkout is not.
  const build = process.env.NODE_ENV === "production" ? "" : " (development build)";
  console.log(`tercet ${TERCET_VERSION}${build}`);
  console.log(`T3 server: ${supportedRange}, tested on ${PINNED_SERVER_VERSION}`);
  process.exit(0);
}

let activeRenderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined;
try {
  const config = await connectionConfig(appArgs, readOptional);
  // Printed before the TUI takes the screen, so it is there in scrollback after quitting.
  if (!config.settingsFound && !config.dumpStatus)
    process.stderr.write(
      `tercet: no settings file at ${config.settingsPath}; using defaults. Run \`tercet doctor\` to check your setup.\n`,
    );
  applyLook(config.settings);
  const boundary = config.hello ? undefined : platform(config);
  const client = boundary && createClient(boundary, config.managedToken);
  // The version gate (client/compat.ts). A local autostart holder gets the document load that
  // wakes the real server, then the next check finds it.
  const check = async () => {
    const result = await checkServer(config.url);
    if (result.kind === "unreachable" && boundary)
      await Effect.runPromise(boundary.wake()).catch(() => {});
    return result;
  };
  const firstCheck = client ? await check() : undefined;
  if (config.dumpStatus && client && firstCheck && blocksStart(firstCheck, config.ignoreVersion)) {
    const { title, lines } = compatMessage(firstCheck, config.url);
    console.error(`tercet: ${title}\n${lines.join("\n")}`);
    process.exitCode = 1;
  } else if (config.dumpStatus && client) {
    const warning = firstCheck && compatWarning(firstCheck);
    if (warning) console.error(`tercet: warning: ${warning}`);
    try {
      client.start();
      // A rejected token will not turn live by waiting; report it now instead of after 30 s.
      let unsubscribe = () => {};
      const rejected = new Promise<never>((_, reject) => {
        unsubscribe = client.registry.subscribe(client.status, (status) => {
          if (status === "rejected") reject(new Error("rejected"));
        });
      });
      try {
        await Promise.race([waitForLive(client), rejected]);
      } catch {
        console.error(
          `tercet: ${client.registry.get(client.status)}: ${client.registry.get(client.message)}`,
        );
        process.exit(1);
      } finally {
        unsubscribe();
      }
      console.log(
        `${client.registry.get(client.status)} threads=${client.registry.get(client.threadCount)}`,
      );
    } finally {
      await client.dispose();
    }
  } else {
    // The media ladder, decided before the renderer owns the terminal (see client/media.ts).
    const probe = async (args: string[]) => {
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore", timeout: 3000 });
      const stdout = await new Response(child.stdout).text();
      return { code: await child.exited, stdout };
    };
    const inTmux = !!process.env.TMUX;
    const setting = config.settings.media.protocol;
    setMedia(
      decideMedia({
        setting,
        env: process.env,
        replies:
          setting === "auto" && !inTmux ? await queryTerminal(process.stdin, process.stdout) : null,
        tmux: inTmux
          ? await tmuxMedia(probe).catch(() => ({ inside: true, passthrough: null, client: null }))
          : { inside: false, passthrough: null, client: null },
        ascii: iconMode() === "ascii",
      }),
      config.settings.media.video,
    );
    const stdout = process.env.TMUX ? kittyStdout() : process.stdout;
    const renderer = await createCliRenderer({
      stdout,
      remote: false,
      exitOnCtrlC: config.hello,
      useMouse: true,
      kittyImageTransport: "zlib",
    });
    activeRenderer = renderer;
    renderer.setBackgroundColor(theme.canvas);
    if (iconMode() === "ascii") renderer.addPostProcessFn(asciiFrame);
    if (process.env.TMUX) {
      // opentui only follows SIGWINCH when it draws to process.stdout itself; the kitty wrapper
      // stream is not, so without this the layout stays at its first size after a resize.
      const resize = () => renderer.requestResize(process.stdout.columns, process.stdout.rows);
      process.on("SIGWINCH", resize);
      renderer.once("destroy", () => process.off("SIGWINCH", resize));
    }
    // Kitty placements outlive the program in the outer terminal; the exit reset deletes them.
    const kittyReset =
      media().rung !== "kitty"
        ? ""
        : process.env.TMUX
          ? KITTY_CLEAR_PLACEMENTS
          : KITTY_CLEAR_DIRECT;
    const embedded = editorAction(config.url, config.settings.commands.embeddedEditor);
    terminalLifecycle(
      renderer,
      async () => {
        embedded.dispose();
        await client?.dispose();
      },
      kittyReset,
    );
    const output = async (args: string[]) => {
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(child.stdout).text();
      if ((await child.exited) !== 0) throw new Error(`${args[0]} failed`);
      return text;
    };
    const loadImage = (source: string, cwd?: string) =>
      loadPreviewImage(source, cwd, (id, mime) => client!.pageUrl(id, mime));
    const effects = hostActions({
      settings: config.settings,
      host: systemHost(),
      localWorkspace: isLoopback(new URL(config.url).hostname),
      writeTerminal: (bytes) => process.stdout.write(bytes),
      sshHost: sshHostLookup(process.env, output, (path) => Bun.file(path).text()),
      loadImage,
      personalDictionary: join(settingsDir(process.env, homedir()), "dictionary.txt"),
    });
    // Shell, editor, tmux and run commands may switch tmux to another session (a launcher like
    // `tmux new-window` or a script around `switch-client`); see clearKittyBeforeSwitch.
    const switchesSession = process.env.TMUX
      ? clearKittyBeforeSwitch(
          stdout,
          () => {
            // A same-size resize does not repaint; passing through another size forces a full one.
            const { columns, rows } = process.stdout;
            renderer.requestResize(columns + 1, rows);
            renderer.requestResize(columns, rows);
          },
          (listener) => renderer.on("focus", listener),
        )
      : <A extends unknown[], R>(run: (...args: A) => Promise<R>) => run;
    for (const name of ["shell", "editor", "tmux", "run"] as const) {
      const action = effects[name] as ((input: never) => Promise<unknown>) | undefined;
      if (action) effects[name] = switchesSession(action) as never;
    }
    effects.loadImage = loadImage;
    if (effects.openUrl) {
      const openUrl = effects.openUrl;
      effects.openThread = async ({ threadId }) => openUrl(await client!.webThreadUrl(threadId));
      effects.openPage = async (id) => openUrl(await client!.pageUrl(id));
      effects.openUrl = async (source) => {
        const attachment = attachmentSource(source);
        return openUrl(attachment ? await client!.pageUrl(attachment.id, attachment.mime) : source);
      };
    }
    const attachmentsDir = isLoopback(new URL(config.url).hostname)
      ? `${config.baseDir}/userdata/attachments`
      : undefined;
    if (effects.openPath)
      effects.openImage = imageOpenAction(loadImage, attachmentsDir, effects.openPath);
    const mediaTarget = (source: string, cwd?: string) =>
      resolveMediaTarget(source, cwd, attachmentsDir, (id, mime) => client!.pageUrl(id, mime));
    const playable = (source: string) => ["video", "audio"].includes(mediaKind(source));
    // A missing ffmpeg leaves probeMedia out: the card shows name and size, never an error.
    // A transcript's own http(s) URL is never probed: ffmpeg would fetch it, redirects and all.
    effects.inspectMedia = async (source, cwd) => {
      const { target, size } = await mediaTarget(source, cwd);
      const probed =
        playable(source) && effects.probeMedia && !isRemoteSource(source)
          ? await effects.probeMedia(target).catch(() => ({}))
          : {};
      return { ...probed, size };
    };
    const { play, playHere, openPath } = effects;
    if (play || playHere || openPath)
      effects.openMedia = async (source, cwd) => {
        const { target } = await mediaTarget(source, cwd);
        if (!playable(source)) {
          if (!openPath) throw new Error("No opener found");
          await openPath(target);
          return "opened file";
        }
        if (media().video === "terminal" && playHere) {
          await renderer.suspend();
          try {
            await playHere(target, mpvOutput(media().rung, !!process.env.TMUX));
          } finally {
            await renderer.resume();
          }
          return "played";
        }
        if (!play) throw new Error("No player found");
        await play(target);
        return "launched player";
      };
    effects.embeddedEditor = embedded.open;
    if (config.readOnly) blockWrites(effects);
    createRoot(renderer).render(
      client && firstCheck ? (
        <ServerGate
          url={config.url}
          initial={firstCheck}
          check={check}
          ignoreVersion={config.ignoreVersion}
          hideWarning={config.hideWarning}
          onReady={() => {
            client.start();
            if (attachTo)
              attachWhenReady(client, attachTo, (message) => {
                renderer.destroy();
                console.error(`tercet: ${message}`);
                process.exitCode = 1;
              });
          }}
          onQuit={() => renderer.destroy()}
        >
          <AppFrame client={client} effects={effects} attached={!!attachTo} />
        </ServerGate>
      ) : (
        <Hello actions={terminalActions((bytes) => process.stdout.write(bytes))} />
      ),
    );
  }
} catch (error) {
  activeRenderer?.destroy();
  console.error(
    error instanceof SettingsError || error instanceof ConfigError
      ? `tercet: ${error.message}`
      : "tercet: connection/configuration failed; check --url, --base-dir and --token-file.",
  );
  process.exitCode = 1;
}
