import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** What the resolver needs from the machine; tests replace all of it. */
export interface T3Host {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
  /** Full path of a program on PATH, or null. */
  which(program: string): string | null;
  exists(path: string): boolean;
}

export type T3Found =
  | { found: true; path: string; via: "setting" | "PATH" | "usual folder" }
  | { found: false; message: string };

/** Folders where `t3` usually lands when PATH does not list them (npm, bun, mise, Homebrew). */
export function t3Folders(host: T3Host): string[] {
  const { env, home } = host;
  const join = host.platform === "win32" ? win32.join : posix.join;
  if (host.platform === "win32") {
    return [
      env.APPDATA && join(env.APPDATA, "npm"),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "pnpm"),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "t3"),
      join(home, ".bun", "bin"),
    ].filter((folder): folder is string => !!folder);
  }
  return [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".local", "share", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/** Every file `findT3` will try after PATH, in order. Windows installs `t3.cmd` (npm) or `t3.exe`. */
export function t3Candidates(host: T3Host): string[] {
  const join = host.platform === "win32" ? win32.join : posix.join;
  const names = host.platform === "win32" ? ["t3.cmd", "t3.exe"] : ["t3"];
  return t3Folders(host).flatMap((folder) => names.map((name) => join(folder, name)));
}

/**
 * Finds the `t3` command: the `server.t3Command` setting first (a path, or a name looked up on
 * PATH), then PATH, then the usual install folders. A missing command says what was tried.
 */
export function findT3(setting: string | undefined, host: T3Host): T3Found {
  if (setting) {
    const path = /[\\/]/.test(setting) ? (host.exists(setting) ? setting : null) : host.which(setting);
    return path
      ? { found: true, path, via: "setting" }
      : {
          found: false,
          message: `server.t3Command is "${setting}", but that is not ${/[\\/]/.test(setting) ? "a file" : "on PATH"}. Point it at your t3 file (on Windows it is t3.cmd, often in %APPDATA%\\npm).`,
        };
  }
  const onPath = host.which("t3");
  if (onPath) return { found: true, path: onPath, via: "PATH" };
  const usual = t3Candidates(host).find((path) => host.exists(path));
  if (usual) return { found: true, path: usual, via: "usual folder" };
  return {
    found: false,
    message:
      `tercet could not find the t3 command, which it uses to issue a token. Install T3 (npm i -g t3), ` +
      `or set server.t3Command in your settings file to the full path of t3` +
      `${host.platform === "win32" ? " (t3.cmd)" : ""}. Looked on PATH and in ${t3Folders(host).join(", ")}.` +
      ` To skip this, issue a token yourself and set server.tokenFile.`,
  };
}

export function systemT3Host(): T3Host {
  const env = process.env as Record<string, string | undefined>;
  return {
    platform: process.platform,
    env,
    home: homedir(),
    which: (program) => Bun.which(program, { PATH: env.PATH ?? "" }),
    exists: existsSync,
  };
}
