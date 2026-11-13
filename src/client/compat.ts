import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";

/** The T3 server release tercet is built and tested against (`vendor/t3/UPSTREAM`; a test checks). */
export const PINNED_SERVER_VERSION = "0.1.8";
/**
 * Server versions tercet starts against without `--ignore-version` (Bun.semver syntax). Patch
 * releases of the pinned minor keep the wire format; a new minor may add or change items.
 */
export const supportedRange = ">=0.1.8 <0.2.0";

export type ServerCheck =
  | { kind: "ok"; version: string; tested: boolean }
  | { kind: "unsupported"; version: string; protocol: number; reason: string }
  | { kind: "no-version"; protocol: number }
  | { kind: "unreachable"; error: string };

/** The verdict on a `/.well-known/t3/environment` descriptor; doctor and startup share it. */
export function checkDescriptor(descriptor: unknown): ServerCheck {
  const record = (descriptor ?? {}) as Record<string, unknown>;
  const version =
    typeof record.serverVersion === "string" && record.serverVersion.trim()
      ? record.serverVersion.trim()
      : null;
  // Servers from before protocol negotiation speak version 1 (client-runtime does the same).
  const protocol =
    typeof record.orchestrationProtocolVersion === "number"
      ? record.orchestrationProtocolVersion
      : 1;
  if (!version) return { kind: "no-version", protocol };
  if (protocol !== ORCHESTRATION_PROTOCOL_VERSION)
    return {
      kind: "unsupported",
      version,
      protocol,
      reason: `tercet speaks orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}; this server speaks ${protocol}`,
    };
  let inRange = false;
  try {
    inRange = Bun.semver.satisfies(version, supportedRange);
  } catch {}
  if (!inRange)
    return {
      kind: "unsupported",
      version,
      protocol,
      reason: `tercet supports T3 ${supportedRange}`,
    };
  return { kind: "ok", version, tested: version === PINNED_SERVER_VERSION };
}

/** Reads the descriptor; any failure (refused, timeout, not JSON, HTTP error) is unreachable. */
export async function checkServer(
  origin: string,
  fetchDescriptor: (origin: string) => Promise<unknown> = environmentDescriptor,
): Promise<ServerCheck> {
  try {
    return checkDescriptor(await fetchDescriptor(origin));
  } catch (error) {
    return { kind: "unreachable", error: describeError(error) };
  }
}

export async function environmentDescriptor(origin: string): Promise<unknown> {
  const response = await fetch(new URL("/.well-known/t3/environment", origin), {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from /.well-known/t3/environment`);
  return response.json();
}

/** Error text without anything request-shaped: fetch errors never carry headers or tokens here. */
function describeError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|abort/i.test(text)) return "no answer within 3 s";
  if (/ECONNREFUSED|Unable to connect|connection refused/i.test(text)) return "connection refused";
  if (/JSON/i.test(text)) return "the reply is not a T3 environment descriptor";
  return text.slice(0, 120);
}

/** True when a check stops startup; `--ignore-version` lets version problems through. */
export function blocksStart(check: ServerCheck, ignoreVersion: boolean) {
  if (check.kind === "ok") return false;
  if (check.kind === "unreachable") return true;
  return !ignoreVersion;
}

/** The full-screen message for a check that stops startup. ASCII only, so every icon set draws it. */
export function compatMessage(check: ServerCheck, url: string): { title: string; lines: string[] } {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
  switch (check.kind) {
    case "unsupported":
      return {
        title: "Unsupported server version",
        lines: [
          `Server: ${url} runs T3 ${check.version} (protocol ${check.protocol}).`,
          `Supported: T3 ${supportedRange}, tested on ${PINNED_SERVER_VERSION}. ${check.reason}.`,
          "What to do: use a tercet release made for this server, or run a supported server",
          `(\`npx t3@${PINNED_SERVER_VERSION}\`). \`tercet --ignore-version\` continues at your own risk:`,
          "items this tercet does not know are dropped and screens may break.",
        ],
      };
    case "no-version":
      return {
        title: "The server did not report a version",
        lines: [
          `Server: ${url} answered without a serverVersion (protocol ${check.protocol}).`,
          `Supported: T3 ${supportedRange}, tested on ${PINNED_SERVER_VERSION}.`,
          "It may be a T3 build older than tercet knows, or not a T3 server at all.",
          "What to do: check --url, or run `tercet doctor`. `tercet --ignore-version` continues at",
          "your own risk.",
        ],
      };
    case "unreachable":
      return {
        title: "Cannot reach the T3 server",
        lines: [
          `Server: ${url}: ${check.error}.`,
          local
            ? "What to do: start the server (`t3`), or point tercet at it with --url."
            : "What to do: check --url and the network; for a remote machine, SSH there and run tercet.",
          "tercet checks again every 2 s and opens once the server answers.",
        ],
      };
    case "ok":
      return { title: "Server ok", lines: [`Server: ${url} runs T3 ${check.version}.`] };
  }
}
