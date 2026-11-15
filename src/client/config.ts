import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadSettings, settingsDir, type LoadedSettings, type Settings } from "./settings";

export interface Config {
  url: string;
  baseDir: string;
  tokenFile: string;
  managedToken: boolean;
  autostart: boolean;
  dumpStatus: boolean;
  hello: boolean;
  readOnly: boolean;
  /** Start even when the server's version is outside `supportedRange` or missing (flag or setting). */
  ignoreVersion: boolean;
  /** Never show the server warning banner (`server.hideWarning`). */
  hideWarning: boolean;
  settings: Settings;
  /** Where the settings file is or would be, and whether it exists. */
  settingsPath: string;
  settingsFound: boolean;
}

/** A bad flag or server address. Its message is safe to print as is: it never echoes a URL's credentials. */
export class ConfigError extends Error {}

/** On this machine. WHATWG URLs normalize `127.1` and friends to dotted form first. */
export const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);

export const USAGE = `Usage: tercet [options]
       tercet doctor [--json] [options]
       tercet keys
       tercet list [--json] [--all] [options]
       tercet attach THREAD [options]
       tercet tmux [--watch] [--session NAME] [options]
       tercet upgrade [--check]
       tercet readback setup|status [--yes] [--dry-run] [--home DIR]

Options:
  --url ORIGIN        The T3 server, e.g. http://127.0.0.1:3773
  --base-dir DIR      The server's data directory (default ~/.t3)
  --token-file PATH   Read the token from this file; required for a server on another machine
  --read-only         Block sending, shell, run, open and copy-to actions
  --ignore-version    Start on a server with another protocol or no version
  --dump-status       Connect, print "live threads=N" and exit
  --hello             A server-free demo screen for checking the terminal
  --version           Print tercet's version and the supported T3 versions
  -h, --help          Print this help`;

/**
 * Flags win over the settings file, which wins over `server-runtime.json` and the defaults.
 * `env` supplies XDG_CONFIG_HOME; tests pass `{}` so the developer's real settings are never read.
 * `loaded` skips reading the settings file (doctor passes defaults when the file is bad).
 */
export async function connectionConfig(
  args: string[],
  read: (path: string) => Promise<string | undefined>,
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
  loaded?: LoadedSettings,
): Promise<Config> {
  const flags = new Map<string, string>();
  let dumpStatus = false;
  let hello = false;
  let readOnly = false;
  let ignoreVersion = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--dump-status") dumpStatus = true;
    else if (flag === "--read-only") readOnly = true;
    else if (flag === "--hello") hello = true;
    else if (flag === "--ignore-version") ignoreVersion = true;
    else if (["--url", "--base-dir", "--token-file"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new ConfigError(`missing value for ${flag}`);
      flags.set(flag, value);
    } else throw new ConfigError(`unknown option ${flag}; see tercet --help`);
  }
  const { settings, dir, path, found } =
    loaded ?? (await loadSettings(settingsDir(env, home), read, home));
  const baseDir = resolve(flags.get("--base-dir") ?? settings.server.baseDir ?? join(home, ".t3"));
  let origin = settings.server.url ?? "http://127.0.0.1:3773";
  let source = flags.has("--url") ? "--url" : settings.server.url ? "server.url" : "default";
  if (!flags.has("--url") && !settings.server.url) {
    const runtimePath = join(baseDir, "userdata/server-runtime.json");
    const persisted = await read(runtimePath);
    if (persisted) {
      let state: unknown;
      try {
        state = JSON.parse(persisted);
      } catch {
        throw new ConfigError(`${runtimePath} is not valid JSON`);
      }
      if (
        typeof state === "object" &&
        state !== null &&
        "origin" in state &&
        typeof state.origin === "string"
      ) {
        origin = state.origin;
        source = runtimePath;
      }
    }
  }
  let url: URL;
  try {
    url = new URL(flags.get("--url") ?? origin);
  } catch {
    throw new ConfigError(`${source} is not a valid URL`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ConfigError(
      `${source}: expected an http(s) server origin without credentials or a path`,
    );
  // The default token file holds this machine's server credential; it never goes anywhere else.
  const explicitToken = flags.has("--token-file") || !!settings.server.tokenFile;
  if (!isLoopback(url.hostname)) {
    if (url.protocol !== "https:")
      throw new ConfigError(
        `${url.origin} is not on this machine, so it needs https:// (the token would travel in the clear)`,
      );
    if (!explicitToken)
      throw new ConfigError(
        `${url.origin} is not on this machine: pass --token-file or set server.tokenFile to a token issued for it`,
      );
  }
  return {
    url: url.origin,
    baseDir,
    tokenFile: resolve(
      flags.get("--token-file") ?? settings.server.tokenFile ?? join(dir, "token"),
    ),
    // A token file the user named is theirs: tercet reads it but never rewrites or chmods it.
    managedToken: !readOnly && !explicitToken,
    autostart: !readOnly && url.origin === "http://127.0.0.1:3773",
    dumpStatus,
    hello,
    readOnly,
    ignoreVersion: ignoreVersion || settings.server.ignoreVersion === true,
    hideWarning: settings.server.hideWarning === true,
    settings,
    settingsPath: path,
    settingsFound: found,
  };
}
