// All external effects enter through this boundary; tests supply a memory sink. The real ones
// come from `hostActions` in portable.ts. An absent optional action hides its button and key.
export interface Actions {
  shell?(input: { cwd: string }): Promise<unknown>;
  openThread?(input: { threadId: string }): Promise<unknown>;
  pasteClipboard?(): Promise<{ type: "image"; bytes: Uint8Array } | { type: "text"; text: string }>;
  pasteImage?(): Promise<Uint8Array>;
  toggleDictation?(): Promise<{ recording: boolean }>;
  editor?(input: { cwd: string; path: string }): Promise<unknown>;
  /** OSC 52, plus the local clipboard tool when there is one. */
  copy(text: string): void;
  /** Named clipboards from settings `targets`, in file order. */
  targets?: readonly { name: string; key?: string }[];
  copyTo?(target: string, text: string): Promise<unknown>;
  /** Types the command into a terminal without running it. */
  tmux?(input: { cwd: string; command: string }): Promise<unknown>;
  /** Like `tmux`, but the command runs at once. */
  run?(input: { cwd: string; command: string }): Promise<unknown>;
  /** Sends text or a file somewhere else (settings `commands.send`). */
  send?(input: { kind: "file"; path: string } | { kind: "text"; text: string }): Promise<unknown>;
  copyImage?(source: string, cwd?: string): Promise<unknown>;
  copyImageTo?(target: string, source: string, cwd?: string): Promise<unknown>;
  openImage?(source: string, cwd?: string): Promise<unknown>;
  loadImage?(source: string, cwd?: string): Promise<Uint8Array>;
  openPage?(attachmentId: string): Promise<unknown>;
  openUrl?(url: string): Promise<unknown>;
  /** Opens a local file with the opener. */
  openPath?(path: string): Promise<unknown>;
  /** Plays a video or audio file or URL with the player chain (`launchers.player`, mpv, opener). */
  play?(target: string): Promise<unknown>;
  /** mpv inside this terminal with `--vo=<vo>`; the caller suspends the renderer around it. */
  playHere?(target: string, vo: string): Promise<unknown>;
  /** Poster frame, duration and dimensions from ffmpeg; absent when ffmpeg is not installed. */
  probeMedia?(target: string): Promise<import("./client/media").MediaProbe>;
  /** What a preview shows for a video, audio or other file source: probe details plus size. */
  inspectMedia?(
    source: string,
    cwd?: string,
  ): Promise<import("./client/media").MediaProbe & { size?: number }>;
  /** Opens a video, audio or other file source outside tercet (player or opener). */
  openMedia?(source: string, cwd?: string): Promise<unknown>;
}

export function terminalActions(write: (bytes: string) => void): Actions {
  return {
    copy(text) {
      write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    },
  };
}

/** Target names that can take text, in button order. */
export const targetNames = (effects?: Actions) =>
  effects?.copyTo ? (effects.targets ?? []).map((t) => t.name) : [];

/** Image buttons: copy and target copies when the clipboard takes images, and open. */
export const imageActions = (effects?: Actions) => [
  ...(effects?.copyImage ? ["copy"] : []),
  ...(effects?.copyImageTo ? targetNames(effects) : []),
  ...(effects?.openImage ? ["open"] : []),
];

/** A media card's buttons: an image's, or just open for video, audio and other files. */
export const mediaActions = (effects: Actions | undefined, kind: string) =>
  kind === "image" ? imageActions(effects) : effects?.openMedia ? ["open"] : [];

/** The optional text actions these effects can do, in button order after "copy". */
export const offeredActions = (effects?: Actions) => [
  ...targetNames(effects),
  ...(effects?.tmux ? ["tmux"] : []),
  ...(effects?.run ? ["run"] : []),
  ...(effects?.send ? ["send"] : []),
];

/** Transcript capitals for each available target action: Y T X F O and the targets' own keys. */
export function targetKeys(effects?: Actions) {
  const keys: Record<string, string> = { Y: "copy", O: "open" };
  if (effects?.tmux) keys.T = "tmux";
  if (effects?.run) keys.X = "run";
  if (effects?.send) keys.F = "send";
  if (effects?.copyTo)
    for (const target of effects.targets ?? []) if (target.key) keys[target.key] = target.name;
  return keys;
}

/** The hint row's "T tmux · C pc" part, for the keys that exist. */
export const keyHints = (effects?: Actions, without: string[] = []) =>
  Object.entries(targetKeys(effects))
    .filter(([key, action]) => !["Y", "O"].includes(key) && !without.includes(action))
    .map(([key, action]) => ` · ${key} ${action}`)
    .join("");

/** The browser could not be opened, but the link is on the clipboard. */
export class LinkCopied extends Error {}

/** Status text for a failed action, which must say so when the link was copied instead. */
export const failureText = (error: unknown, fallback: string) =>
  error instanceof LinkCopied ? "Browser failed; link copied" : fallback;

/** The client address in an `SSH_CONNECTION` value. */
export const sshClientHost = (connection: string | undefined) =>
  connection?.trim().split(/\s+/)[0] || undefined;

/** The `SSH_CONNECTION` client address in a NUL-separated `/proc/<pid>/environ`. */
export const sshHostFromEnviron = (environ: string) =>
  sshClientHost(
    environ
      .split("\0")
      .find((entry) => entry.startsWith("SSH_CONNECTION="))
      ?.slice("SSH_CONNECTION=".length),
  );

/**
 * The most recently active client in `tmux list-clients -F '#{client_activity} #{client_pid}'`.
 * A pane's own SSH_CONNECTION only says who started it, and sessions are shared between machines.
 */
export function activeClientPid(listClients: string) {
  return listClients
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([activity, pid]) => activity && pid)
    .sort(([a], [b]) => Number(b) - Number(a))[0]?.[1];
}

/**
 * The machine the user types from when that is not this one, for `{sshHost}`: inside tmux the
 * last active client's SSH_CONNECTION (Linux /proc), otherwise this process's own.
 */
export function sshHostLookup(
  env: Record<string, string | undefined>,
  output: (args: string[]) => Promise<string>,
  read: (path: string) => Promise<string>,
) {
  return async () => {
    try {
      if (!env.TMUX) throw new Error("Not in tmux");
      const clients = await output([
        "tmux",
        "list-clients",
        "-F",
        "#{client_activity} #{client_pid}",
      ]);
      return sshHostFromEnviron(await read(`/proc/${activeClientPid(clients)}/environ`));
    } catch {
      return sshClientHost(env.SSH_CONNECTION);
    }
  };
}

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Matches routes/_chat.$environmentId.$threadId.tsx (the layout has no URL segment). */
export function threadWebUrl(origin: string, environmentId: string, threadId: string) {
  return new URL(`/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`, origin)
    .href;
}
