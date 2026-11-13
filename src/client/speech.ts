// T3's speech service over HTTP, with the same bearer token the rest of tercet uses. Upstream's
// client-runtime has helpers for this (`voice-input/environment.ts`), but they sit on its HTTP API
// client and DPoP signer; two plain requests need neither, and the wire format comes from upstream's
// own `encodeSpeechPcmRequest`. Only the server's own speech model is supported: no cloud
// providers, no post-processing, no live streaming.
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  EnvironmentSpeechStatus,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import { encodeSpeechPcmRequest } from "@t3tools/shared/speech";
import * as Schema from "effect/Schema";

export type SpeechFailure = "setup" | "busy" | "auth" | "offline" | "failed";

/** A speech request that failed, with the one-line reason to show. */
export class SpeechError extends Error {
  override name = "SpeechError";
  constructor(
    readonly kind: SpeechFailure,
    message: string,
  ) {
    super(message);
  }
}

export const SPEECH_SETUP_ROUTE = "open T3's web app, Settings, Voice";

const decodeStatus = Schema.decodeUnknownSync(EnvironmentSpeechStatus);

/** The reason a server's speech cannot take a recording yet, or undefined when it can. */
export function speechSetupProblem(status: EnvironmentSpeechStatus): string | undefined {
  if (!status.supported) return `This T3 server cannot transcribe speech (${status.reason}).`;
  if (status.state === "missing-model")
    return `No speech model is installed on the T3 server: ${SPEECH_SETUP_ROUTE} to download one.`;
  return undefined;
}

const REASONS: Record<string, SpeechError> = {
  invalid_audio: new SpeechError(
    "failed",
    "The server rejected the audio (empty or over 5 minutes).",
  ),
  speech_unavailable: new SpeechError("setup", `This T3 server cannot transcribe speech.`),
  speech_busy: new SpeechError("busy", "The speech service is busy; try again in a moment."),
};

async function failure(response: Response) {
  if (response.status === 401)
    return new SpeechError("auth", "T3 rejected the token. Retry with a fresh token file (r).");
  if (response.status === 403)
    return new SpeechError("auth", "The token is not allowed to use speech on this T3 server.");
  if (response.status === 404)
    return new SpeechError("setup", "This T3 server has no speech service (update T3).");
  const body = (await response.json().catch(() => undefined)) as { reason?: unknown } | undefined;
  return (
    (typeof body?.reason === "string" ? REASONS[body.reason] : undefined) ??
    new SpeechError("failed", `Transcription failed (server answered ${response.status}).`)
  );
}

async function send(
  url: string,
  token: string,
  path: string,
  init: { method: "GET" | "POST"; body?: Uint8Array; signal?: AbortSignal },
) {
  let response: Response;
  try {
    response = await fetch(new URL(path, url), {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/octet-stream" } : {}),
      },
      body: init.body ? Buffer.from(init.body) : undefined,
      // The recording and the token never follow a redirect to another host.
      redirect: "error",
      signal: init.signal,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new SpeechError("offline", "Could not reach the T3 server; retry when connected.");
  }
  if (!response.ok) throw await failure(response);
  return response;
}

export async function speechStatus(url: string, token: string, signal?: AbortSignal) {
  const response = await send(url, token, "/api/voice/status", { method: "GET", signal });
  try {
    return decodeStatus(await response.json());
  } catch {
    throw new SpeechError("failed", "The server's speech status is unreadable (a newer T3?).");
  }
}

/** Sends 16 kHz mono float PCM and returns the transcript, trimmed. */
export async function transcribeSpeech(
  url: string,
  token: string,
  pcm: Uint8Array,
  options: Partial<SpeechTranscriptionOptions>,
  signal?: AbortSignal,
) {
  const body = encodeSpeechPcmRequest(pcm, {
    ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    speechRemoveFillerWords: false,
    ...options,
  });
  const response = await send(url, token, "/api/voice/transcribe", {
    method: "POST",
    body,
    signal,
  });
  const { text } = (await response.json().catch(() => ({}))) as { text?: unknown };
  if (typeof text !== "string")
    throw new SpeechError("failed", "The server's transcript is unreadable (a newer T3?).");
  return text.trim();
}
