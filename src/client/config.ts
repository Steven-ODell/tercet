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
  /** Start even when the server's version is outside `supportedRange` or missing. */
  ignoreVersion: boolean;
  settings: Settings;
  /** Where the settings file is or would be, and whether it exists. */
  settingsPath: string;
  settingsFound: boolean;
}

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
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      flags.set(flag, value);
    } else throw new Error(`Unknown option: ${flag}`);
  }
  const { settings, dir, path, found } =
    loaded ?? (await loadSettings(settingsDir(env, home), read, home));
  const baseDir = resolve(flags.get("--base-dir") ?? settings.server.baseDir ?? join(home, ".t3"));
  let origin = settings.server.url ?? "http://127.0.0.1:3773";
  if (!flags.has("--url") && !settings.server.url) {
    const persisted = await read(join(baseDir, "userdata/server-runtime.json"));
    if (persisted) {
      const state: unknown = JSON.parse(persisted);
      if (
        typeof state === "object" &&
        state !== null &&
        "origin" in state &&
        typeof state.origin === "string"
      )
        origin = state.origin;
    }
  }
  const url = new URL(flags.get("--url") ?? origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Expected an HTTP server origin without credentials or a path");
  return {
    url: url.origin,
    baseDir,
    tokenFile: resolve(
      flags.get("--token-file") ?? settings.server.tokenFile ?? join(dir, "token"),
    ),
    // A token file the user named is theirs: tercet reads it but never rewrites or chmods it.
    managedToken: !readOnly && !flags.has("--token-file") && !settings.server.tokenFile,
    autostart: !readOnly && url.origin === "http://127.0.0.1:3773",
    dumpStatus,
    hello,
    readOnly,
    ignoreVersion,
    settings,
    settingsPath: path,
    settingsFound: found,
  };
}
