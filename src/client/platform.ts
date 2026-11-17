import { assertGitPolicy } from "./git-workflows.ts";
import type { GitBoundary, GitOperation, GitInput, GitOutput } from "./git-workflows.ts";
import {
  ModelFavorites,
  OrchestrationV2ThreadHistoryPage,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { isLoopback, type Config } from "./config";
import { messageTagFor } from "./settings";
import { findT3, systemT3Host } from "./t3-command";
import { speechStatus, transcribeSpeech } from "./speech";
import {
  listPreviews,
  terminalSession,
  deviceState,
  webThreadUrl,
  workspaceRefs,
  uploadImage,
  type UploadMeta,
  fileMethods,
  diffMethods,
  gitMethods,
  pageUrl,
  mediaUrl,
  answerSecret,
  searchThreads,
  followShell,
  followThread,
  getTurnItem,
  dispatchCommand,
  completeComposer,
} from "./connection";
import * as Effect from "effect/Effect";

export async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Older installed CLIs may print startup notices even with --token-only. */
export function issuedToken(output: string) {
  const candidates = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(line)) return false;
      try {
        const claims = JSON.parse(Buffer.from(line.split(".")[0]!, "base64url").toString("utf8"));
        return claims?.kind === "session" && claims?.method === "bearer-access-token";
      } catch {
        return false;
      }
    });
  if (candidates.length !== 1) throw new Error("Token issuance returned no unique bearer token");
  return candidates[0]!;
}

export function tokenIssueArgs(config: Config) {
  return [
    "auth",
    "session",
    "issue",
    "--base-dir",
    config.baseDir,
    "--token-only",
    "--label",
    "tercet",
    ...AuthStandardClientScopes.flatMap((scope) => ["--scope", scope]),
  ];
}

export function platform(
  config: Config,
  /** The SSH client address of whoever types (see `sshHostLookup`); none when typing locally. */
  sshHost?: () => Promise<string | undefined>,
) {
  const draftPath = `${config.tokenFile}.drafts-${Bun.hash(config.url).toString(16)}.json`;
  const git: GitBoundary = <K extends GitOperation>(token: string, operation: K, input: GitInput<K>) =>
    Effect.suspend(() => {
      try { assertGitPolicy(operation, config.readOnly); }
      catch (error) { return Effect.fail(error); }
      // The mapped operation keeps each input and output paired at the public boundary.
      const method = gitMethods[operation] as (url: string, token: string, input: GitInput<K>) => Effect.Effect<GitOutput<K>, unknown>;
      return method(config.url, token, input);
    });
  const boundary = {
    git,
    workspaceRefs: (token: string, cwd: string) => workspaceRefs(config.url, token, cwd),
    uploadImage: (token: string, bytes: Uint8Array, meta?: UploadMeta) =>
      uploadImage(config.url, token, bytes, meta),
    speech: {
      status: (token: string) => speechStatus(config.url, token),
      transcribe: (
        token: string,
        pcm: Uint8Array,
        options: Partial<import("@t3tools/contracts").SpeechTranscriptionOptions>,
        signal?: AbortSignal,
      ) =>
        transcribeSpeech(
          config.url,
          token,
          pcm,
          { speechLanguage: config.settings.dictation.language, ...options },
          signal,
        ),
    },
    diffs: {
      full: (token: string, input: Parameters<typeof diffMethods.full>[2]) =>
        diffMethods.full(config.url, token, input),
      turn: (token: string, input: Parameters<typeof diffMethods.turn>[2]) =>
        diffMethods.turn(config.url, token, input),
    },
    files: {
      list: (token: string, input: Parameters<typeof fileMethods.list>[2]) =>
        fileMethods.list(config.url, token, input),
      find: (token: string, input: Parameters<typeof fileMethods.find>[2]) =>
        fileMethods.find(config.url, token, input),
      search: (token: string, input: Parameters<typeof fileMethods.search>[2]) =>
        fileMethods.search(config.url, token, input),
      read: (token: string, input: Parameters<typeof fileMethods.read>[2]) =>
        fileMethods.read(config.url, token, input),
    },
    answerSecret: (token: string, input: import("@t3tools/contracts").SecretRequestAnswerInput) =>
      answerSecret(config.url, token, input),
    modelFavorites: async () =>
      Schema.decodeUnknownSync(ModelFavorites)(config.settings.defaults.favorites),
    search: (token: string, query: string) => searchThreads(config.url, token, query),
    drafts: {
      async read() {
        const parsed: unknown = JSON.parse((await readOptional(draftPath)) ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Invalid drafts");
        return Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      },
      async write(drafts: Record<string, string>) {
        await mkdir(dirname(draftPath), { recursive: true, mode: 0o700 });
        const temporary = `${draftPath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(drafts), { mode: 0o600 });
        await rename(temporary, draftPath);
      },
    },
    sendShortcut: async () => config.settings.defaults.sendShortcut,
    messageTag: async () => {
      const tag = config.settings.messageTag;
      if (!tag.local && !tag.ssh) return undefined;
      // The lookup reads tmux and /proc; a failure means "typing here".
      const host = tag.ssh ? await sshHost?.().catch(() => undefined) : undefined;
      return messageTagFor(tag, host);
    },
    sidebarWorkingShelf: async () => config.settings.defaults.sidebarWorkingShelf,
    showHints: async () => config.settings.defaults.hints,
    newThreadDefaults: {
      provider: config.settings.defaults.provider,
      model: config.settings.defaults.model,
      mode: config.settings.defaults.mode,
    },
    terminal: (
      token: string,
      input: Parameters<typeof terminalSession>[2],
      receive: Parameters<typeof terminalSession>[3],
      bind: Parameters<typeof terminalSession>[4],
    ) => terminalSession(config.url, token, input, receive, bind),
    previews: (token: string, threadId: ThreadId) => listPreviews(config.url, token, threadId),
    devices: (token: string) => deviceState(config.url, token),
    webThreadUrl: (threadId: string) => webThreadUrl(config.url, threadId),
    mediaUrl: (token: string, threadId: ThreadId, path: string) =>
      mediaUrl(config.url, token, threadId, path),
    pageUrl: (token: string, id: string, mimeType?: string) =>
      pageUrl(config.url, token, id, mimeType),
    dispatch: (token: string, command: import("@t3tools/contracts").OrchestrationV2Command) =>
      dispatchCommand(config.url, token, command),
    complete: (
      token: string,
      cwd: string,
      prefix: string,
      query: string,
      instanceId: import("@t3tools/contracts").ProviderInstanceId,
    ) => completeComposer(config.url, token, cwd, prefix, query, instanceId),
    readToken: () =>
      Effect.tryPromise(async () => {
        const token = await readOptional(config.tokenFile);
        if (token !== undefined && config.managedToken) await chmod(config.tokenFile, 0o600);
        return token?.trim();
      }),
    issueToken: () =>
      Effect.tryPromise(async () => {
        if (!config.managedToken) throw new Error("Supply a fresh --token-file");
        if (!isLoopback(new URL(config.url).hostname))
          throw new Error("Remote servers require --token-file");
        const t3 = findT3(config.settings.server.t3Command, systemT3Host());
        if (!t3.found) throw new Error(t3.message);
        const child = Bun.spawn([t3.path, ...tokenIssueArgs(config)], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [token, , exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exit !== 0 || !token.trim())
          throw new Error(`Token issuance failed (${t3.path}); check that t3 runs and --base-dir`);
        const credential = issuedToken(token);
        await mkdir(dirname(config.tokenFile), { recursive: true, mode: 0o700 });
        const temporary = `${config.tokenFile}.${process.pid}.tmp`;
        await writeFile(temporary, credential, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, config.tokenFile);
        return credential;
      }),
    wake: () =>
      Effect.tryPromise(async () => {
        if (!config.autostart) return;
        // t3-autostart accepts document loads only. Never invoke tmux or services here.
        await fetch(config.url, {
          headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" },
          signal: AbortSignal.timeout(3000),
        });
      }),
    follow: (
      token: string,
      receive: Parameters<typeof followShell>[2],
      receiveConfig: Parameters<typeof followShell>[3],
      receiveArchive: Parameters<typeof followShell>[4],
    ) => followShell(config.url, token, receive, receiveConfig, receiveArchive),
    followThread: (token: string, id: ThreadId, receive: Parameters<typeof followThread>[3]) =>
      followThread(config.url, token, id, receive),
    itemDetail: (
      token: string,
      input: import("@t3tools/contracts").OrchestrationV2GetTurnItemInput,
    ) => getTurnItem(config.url, token, input),
    historyPage: (token: string, id: ThreadId, cursor: string) =>
      Effect.tryPromise(async () => {
        const url = new URL(
          `/api/orchestration/threads/${encodeURIComponent(id)}/history`,
          config.url,
        );
        url.searchParams.set("cursor", cursor);
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "x-t3-orchestration-protocol": String(ORCHESTRATION_PROTOCOL_VERSION_TEXT),
          },
          signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) throw new Error("History request failed");
        return Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage))(
          await response.json(),
        );
      }),
    pause: () => Effect.sleep("2 seconds"),
  };
  if (config.readOnly) {
    const blocked = () => Effect.fail(new Error("Read-only: action blocked"));
    return {
      ...boundary,
      dispatch: blocked,
      uploadImage: blocked,
      speech: undefined,
      answerSecret: blocked,
      terminal: undefined,
      pageUrl: blocked,
      mediaUrl: blocked,
      issueToken: blocked,
      wake: () => Effect.void,
      drafts: { read: async () => ({}), write: async () => {} },
    };
  }
  return boundary;
}
