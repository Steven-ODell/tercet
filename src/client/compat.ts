import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";

/** The T3 server release tercet is built and tested against (`vendor/t3/UPSTREAM`; a test checks). */
export const PINNED_SERVER_VERSION = "0.1.8";
/**
 * Server versions tercet treats as tested (Bun.semver syntax): patch releases of the pinned minor
 * keep the wire format. A version outside it still starts, under a warning banner; only another
 * orchestration protocol stops startup.
 */
export const supportedRange = ">=0.1.8 <0.2.0";

export type ServerCheck =
  /** Inside `supportedRange`; `tested` when it is the pinned release itself. */
  | { kind: "ok"; version: string; tested: boolean }
  /** Same protocol, version outside the range (newer minor, nightly, older, unparseable). */
  | { kind: "out-of-range"; version: string; protocol: number }
  /** Another orchestration protocol: client-runtime would refuse the connection. */
  | { kind: "protocol"; version: string; protocol: number }
  /** No serverVersion: client-runtime's descriptor decode requires one. */
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
  if (protocol !== ORCHESTRATION_PROTOCOL_VERSION) return { kind: "protocol", version, protocol };
  let inRange = false;
  try {
    inRange = Bun.semver.satisfies(version, supportedRange);
  } catch {}
  if (!inRange) return { kind: "out-of-range", version, protocol };
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

/**
 * True when a check stops startup: an unreachable server always, another protocol or a missing
 * version unless `--ignore-version`. A version outside the range never stops it (see
 * `compatWarning`).
 */
export function blocksStart(check: ServerCheck, ignoreVersion: boolean) {
  if (check.kind === "ok" || check.kind === "out-of-range") return false;
  if (check.kind === "unreachable") return true;
  return !ignoreVersion;
}

/**
 * The one-line warning for a server tercet opens on but was not built for, or null. The frame
 * shows it as a dismissable banner; `--dump-status` prints it on stderr.
 */
export function compatWarning(check: ServerCheck): string | null {
  switch (check.kind) {
    case "out-of-range":
      return `Built for T3 ${PINNED_SERVER_VERSION}, you're on ${check.version}: some things may not work.`;
    case "protocol":
      return `Built for orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}, this server speaks ${check.protocol} (--ignore-version): expect broken screens.`;
    case "no-version":
      return `This server reported no version (--ignore-version): some things may not work.`;
    default:
      return null;
  }
}

/** The full-screen message for a check that stops startup. ASCII only, so every icon set draws it. */
export function compatMessage(check: ServerCheck, url: string): { title: string; lines: string[] } {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
  switch (check.kind) {
    case "protocol":
      return {
        title: "Incompatible server protocol",
        lines: [
          `Server: ${url} runs T3 ${check.version}, orchestration protocol ${check.protocol}.`,
          `tercet speaks protocol ${ORCHESTRATION_PROTOCOL_VERSION} (built for T3 ${PINNED_SERVER_VERSION}).`,
          "What to do: update tercet, or run a server on its protocol",
          `(\`npx t3@${PINNED_SERVER_VERSION}\`). \`tercet --ignore-version\` continues at your own risk:`,
          "the connection will most likely be refused or screens will break.",
        ],
      };
    case "no-version":
      return {
        title: "The server did not report a version",
        lines: [
          `Server: ${url} answered without a serverVersion (protocol ${check.protocol}).`,
          `tercet is built for T3 ${PINNED_SERVER_VERSION}.`,
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
    case "out-of-range":
    case "ok": {
      const warning = compatWarning(check);
      return {
        title: "Server ok",
        lines: [`Server: ${url} runs T3 ${check.version}.`, ...(warning ? [warning] : [])],
      };
    }
  }
}
