import * as Effect from "effect/Effect";
import { ConfigError, connectionConfig, type Config } from "./client/config";
import { blocksStart, checkServer, compatMessage, compatWarning } from "./client/compat";
import { platform, readOptional } from "./client/platform";
import { createClient, waitForLive, type Client } from "./client/runtime";
import { SettingsError } from "./client/settings";
import { formatTable, isActive, resolveThread, threadRows, type ThreadRow } from "./threads";

/** Connects without a screen: the version gate, the wake of an autostart holder, then live. */
export async function connectLive(
  config: Config,
): Promise<{ client: Client } | { error: string }> {
  const boundary = platform(config);
  const client = createClient(boundary, config.managedToken);
  let result = await checkServer(config.url);
  if (result.kind === "unreachable") {
    await Effect.runPromise(boundary.wake()).catch(() => {});
    result = await checkServer(config.url);
  }
  if (blocksStart(result, config.ignoreVersion)) {
    const { title, lines } = compatMessage(result, config.url);
    return { error: `${title}\n${lines.join("\n")}` };
  }
  const warning = compatWarning(result);
  if (warning) console.error(`tercet: warning: ${warning}`);
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
    const text = `${client.registry.get(client.status)}: ${client.registry.get(client.message)}`;
    await client.dispose();
    return { error: text };
  } finally {
    unsubscribe();
  }
  return { client };
}

/**
 * Pulls this command's own flags out of `args`: `bools` are switches, `valued` take a value as
 * `--flag VALUE` or `--flag=VALUE`. Whatever is left goes to `connectionConfig`.
 */
export function takeFlags<B extends string, V extends string>(
  args: string[],
  bools: readonly B[],
  valued: readonly V[] = [],
) {
  const found = new Set<B>();
  const values = new Map<V, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const bool = bools.find((flag) => flag === arg);
    if (bool) {
      found.add(bool);
      continue;
    }
    const name = valued.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (name) {
      const value = arg === name ? args[++i] : arg.slice(name.length + 1);
      if (!value || value.startsWith("--")) throw new ConfigError(`missing value for ${name}`);
      values.set(name, value);
      continue;
    }
    rest.push(arg);
  }
  return { found, values, rest };
}

async function withClient(
  args: string[],
  run: (client: Client, config: Config) => Promise<number>,
): Promise<number> {
  let config: Config;
  try {
    config = await connectionConfig(args, readOptional);
  } catch (error) {
    if (error instanceof SettingsError || error instanceof ConfigError) {
      console.error(`tercet: ${error.message}`);
      return 1;
    }
    throw error;
  }
  const live = await connectLive(config);
  if ("error" in live) {
    console.error(`tercet: ${live.error}`);
    return 1;
  }
  try {
    await waitForSnapshot(live.client);
    return await run(live.client, config);
  } finally {
    await live.client.dispose();
  }
}

/** Live is reported with the first snapshot, but this keeps `list` honest if that ever changes. */
async function waitForSnapshot(client: Client, timeoutMs = 5000) {
  const start = Date.now();
  while (!client.registry.get(client.snapshot) && Date.now() - start < timeoutMs)
    await Bun.sleep(25);
}

export const LIST_USAGE = `Usage: tercet list [--json] [--all] [connection options]

Print the threads on the server and exit. The default is a table; --json prints one JSON array
with id, shortId, title, project, state, pinned, archived, provider, model, branch and updatedAt.
Archived threads and sub-agent threads are left out unless --all is given.`;

export async function runList(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(LIST_USAGE);
    return 0;
  }
  const { found, rest } = takeFlags(args, ["--json", "--all"] as const);
  return withClient(rest, async (client) => {
    const snapshot = client.registry.get(client.snapshot);
    const rows = snapshot ? threadRows(snapshot, { all: found.has("--all") }) : [];
    console.log(found.has("--json") ? JSON.stringify(rows, null, 2) : formatTable(rows));
    return 0;
  });
}

// ---- tmux ----

export interface TmuxWindow {
  id: string;
  /** The `@tercet-thread` option tercet set when it opened the window, or "" for another one. */
  threadId: string;
  /** The window a client of the session is looking at right now. */
  viewed: boolean;
}

export interface WindowPlan {
  open: ThreadRow[];
  close: TmuxWindow[];
}

/**
 * What `tercet tmux` should do to reach "one window per active thread". Pure: `idleMs` says how
 * long each thread has been out of the active set, `dismissed` holds threads whose window the
 * user closed while the thread was still working (they stay closed until the thread settles).
 * A window is closed when its thread is gone from the list, or idle past `graceMs` and not the
 * one on screen: closing what someone is reading would be rude.
 */
export function planWindows(
  rows: readonly ThreadRow[],
  windows: readonly TmuxWindow[],
  options: {
    idleMs: ReadonlyMap<string, number>;
    dismissed: ReadonlySet<string>;
    graceMs: number;
    prune: boolean;
  },
): WindowPlan {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const have = new Set(windows.filter((w) => w.threadId).map((w) => w.threadId));
  const open = rows.filter(
    (row) => isActive(row.state) && !have.has(row.id) && !options.dismissed.has(row.id),
  );
  const close = options.prune
    ? windows.filter((w) => {
        if (!w.threadId) return false;
        const row = byId.get(w.threadId);
        if (!row) return !w.viewed;
        if (isActive(row.state)) return false;
        return !w.viewed && (options.idleMs.get(row.id) ?? 0) >= options.graceMs;
      })
    : [];
  return { open, close };
}

export const shellQuote = (word: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** How to start another tercet: the compiled binary itself, or `bun <script>` from a checkout. */
export function selfCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN");
  return compiled ? [process.execPath] : [process.execPath, Bun.main];
}

export const TMUX_USAGE = `Usage: tercet tmux [--watch] [--session NAME] [--socket NAME] [--keep] [connection options]

Put every active thread (running, or waiting for an answer) in its own window of a tmux session,
each running \`tercet attach THREAD\`, then exit. Windows already there are left alone.

  --watch           Stay running: open a window when a thread starts working and, unless --keep,
                    close it once the thread has been idle for 30 seconds and nobody is looking at it
  --session NAME    The tmux session (default tercet); it is created when the first window opens
  --socket NAME     Use \`tmux -L NAME\` instead of the default server
  --keep            Never close windows

Attach with \`tmux attach -t tercet\` (or \`tmux switch-client -t tercet\` from inside tmux).
A window you close while its thread still works stays closed until the thread settles.`;

type Tmux = (...args: string[]) => { code: number; out: string; err: string };

function tmuxRunner(socket: string | undefined): Tmux {
  return (...args) => {
    const result = Bun.spawnSync(["tmux", ...(socket ? ["-L", socket] : []), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      out: result.stdout.toString(),
      err: result.stderr.toString(),
    };
  };
}

function listWindows(tmux: Tmux, session: string): TmuxWindow[] | null {
  if (tmux("has-session", "-t", `=${session}`).code !== 0) return null;
  const listed = tmux(
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    "#{window_id}\t#{@tercet-thread}\t#{window_active}\t#{session_attached}",
  );
  if (listed.code !== 0) return null;
  return listed.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", threadId = "", active = "0", attached = "0"] = line.split("\t");
      return { id, threadId, viewed: active === "1" && Number(attached) > 0 };
    });
}

function openWindow(
  tmux: Tmux,
  session: string,
  row: ThreadRow,
  connArgs: string[],
  existing: boolean,
): string | null {
  const command = [...selfCommand(), "attach", row.id, ...connArgs].map(shellQuote).join(" ");
  const name = row.title.replace(/\s+/g, " ").slice(0, 24) || row.shortId;
  const made = existing
    ? tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${session}:`, "-n", name, command)
    : tmux("new-session", "-d", "-P", "-F", "#{window_id}", "-s", session, "-n", name, command);
  if (made.code !== 0) {
    console.error(`tercet: tmux: ${made.err.trim() || "could not open a window"}`);
    return null;
  }
  const id = made.out.trim();
  tmux("set-option", "-w", "-t", id, "@tercet-thread", row.id);
  return id;
}

export async function runTmux(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(TMUX_USAGE);
    return 0;
  }
  const { found, values, rest } = takeFlags(
    args,
    ["--watch", "--keep"] as const,
    ["--session", "--socket"] as const,
  );
  const connArgs = rest;
  const session = values.get("--session") ?? "tercet";
  const socket = values.get("--socket");
  const watch = found.has("--watch");
  const prune = !found.has("--keep");
  const tmux = tmuxRunner(socket);
  if (tmux("-V").code !== 0) {
    console.error("tercet: tmux is not on PATH, so there is nothing to put the windows in");
    return 1;
  }
  return withClient(connArgs, async (client) => {
      const idleSince = new Map<string, number>();
      const known = new Map<string, string>();
      const dismissed = new Set<string>();
      const sync = () => {
        const snapshot = client.registry.get(client.snapshot);
        if (!snapshot) return 0;
        const rows = threadRows(snapshot, { all: true });
        const now = Date.now();
        for (const row of rows) {
          if (isActive(row.state)) idleSince.delete(row.id);
          else if (!idleSince.has(row.id)) idleSince.set(row.id, now);
        }
        const windows = listWindows(tmux, session);
        const present = new Set((windows ?? []).map((w) => w.id));
        for (const [threadId, windowId] of known) {
          if (present.has(windowId)) continue;
          known.delete(threadId);
          const row = rows.find((r) => r.id === threadId);
          if (row && isActive(row.state) && !row.archived) dismissed.add(threadId);
        }
        for (const row of rows) if (!isActive(row.state)) dismissed.delete(row.id);
        const plan = planWindows(rows, windows ?? [], {
          idleMs: new Map([...idleSince].map(([id, at]) => [id, now - at])),
          dismissed,
          graceMs: 30_000,
          prune: prune && watch,
        });
        let opened = 0;
        let exists = windows !== null;
        for (const row of plan.open) {
          const id = openWindow(tmux, session, row, connArgs, exists);
          if (!id) continue;
          exists = true;
          known.set(row.id, id);
          opened++;
        }
        for (const window of windows ?? []) if (window.threadId) known.set(window.threadId, window.id);
        for (const window of plan.close) {
          tmux("kill-window", "-t", window.id);
          known.delete(window.threadId);
        }
        return opened;
      };
      const first = sync();
      const active = threadRows(client.registry.get(client.snapshot)!).filter((row) =>
        isActive(row.state),
      );
      console.log(
        active.length
          ? `tercet: ${first} new window${first === 1 ? "" : "s"} for ${active.length} active thread${active.length === 1 ? "" : "s"} in tmux session "${session}"`
          : `tercet: no active threads right now`,
      );
      if (!watch) {
        if (active.length)
          console.log(
            `Attach with: tmux ${socket ? `-L ${socket} ` : ""}attach -t ${session}`,
          );
        return 0;
      }
      console.log(
        `Watching. Windows open as threads start working; Ctrl+C stops (windows stay).`,
      );
      const unsubscribe = client.registry.subscribe(client.snapshot, () => sync());
      // Idle windows close on a timer, not only when the server sends something.
      const timer = setInterval(sync, 5000);
      await new Promise<void>((resolve) => {
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, resolve);
      });
      clearInterval(timer);
      unsubscribe();
      return 0;
    });
}

/** Opens `query` in the running app once the first snapshot is there; `fail` reports a miss. */
export function attachWhenReady(client: Client, query: string, fail: (message: string) => void) {
  let done = false;
  const unsubscribe = client.registry.subscribe(
    client.snapshot,
    (snapshot) => {
      if (done || !snapshot) return;
      done = true;
      queueMicrotask(() => unsubscribe());
      const rows = threadRows(snapshot, { all: true });
      const found = resolveThread(rows, query);
      if (found.kind === "found") client.openThread(found.row.id as never);
      else if (found.kind === "none") fail(`no thread matches "${query}"; \`tercet list\` shows them`);
      else
        fail(
          `"${query}" matches ${found.rows.length} threads:\n${found.rows
            .slice(0, 8)
            .map((row) => `  ${row.shortId}  ${row.title}`)
            .join("\n")}`,
        );
    },
    { immediate: true },
  );
}
