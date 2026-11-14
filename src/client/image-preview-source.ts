import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Loopback, private, link-local, CGNAT, multicast and reserved ranges. IPv4-mapped IPv6 matches too. */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

export type HostLookup = (hostname: string) => Promise<string[]>;
const systemLookup: HostLookup = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Remote Markdown images may only reach public addresses, so a transcript cannot probe this machine or its network. */
export async function assertPublicUrl(url: URL, resolveHost: HostLookup = systemLookup) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported image source");
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const addresses = isIP(host) ? [host] : await resolveHost(host);
  if (
    !addresses.length ||
    addresses.some((address) => PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4"))
  )
    throw new Error("Image blocked: private network address");
}

/**
 * Follows redirects by hand so every hop is checked. A DNS answer that changes between the check
 * and the connection (rebinding) is not covered; the click-to-load gate in the card is the main defense.
 */
async function fetchPublic(source: string, signal: AbortSignal, resolveHost: HostLookup) {
  let url = new URL(source);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url, resolveHost);
    const response = await fetch(url, { redirect: "manual", signal });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) return response;
    await response.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error("Image unavailable: too many redirects");
}

/** An http(s) source from the transcript itself, not this server's attachment: untrusted. */
export const isRemoteSource = (source: string) => /^https?:\/\//i.test(source);
export function attachmentSource(source: string): { id: string; mime: string } | null {
  if (!source.startsWith("tercet-image:")) return null;
  const value: unknown = JSON.parse(decodeURIComponent(source.slice("tercet-image:".length)));
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("mime" in value) ||
    typeof value.id !== "string" ||
    typeof value.mime !== "string" ||
    !value.mime.startsWith("image/")
  )
    throw new Error("Invalid image attachment");
  return { id: value.id, mime: value.mime };
}
/** Bytes travel through the terminal, so over SSH the local machine is never asked to open a remote path. */
export async function loadPreviewImage(
  source: string,
  cwd: string | undefined,
  attachmentUrl: (id: string, mime: string) => Promise<string>,
  resolveHost: HostLookup = systemLookup,
): Promise<Uint8Array> {
  const attachment = attachmentSource(source);
  if (attachment) source = await attachmentUrl(attachment.id, attachment.mime);
  if (/^https?:\/\//i.test(source)) {
    const signal = AbortSignal.timeout(15000);
    // The configured server's signed attachment URL is trusted; anything else must be public.
    const response = attachment
      ? await fetch(source, { signal })
      : await fetchPublic(source, signal, resolveHost);
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
      await response.body?.cancel();
      throw new Error("Image unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty image");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_PREVIEW_BYTES) throw new Error("Image exceeds 32 MiB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  const file = source.startsWith("file:") ? fileURLToPath(source) : source;
  if (!/^[a-z]:[\\/]/i.test(source) && !source.startsWith("file:") && /^[a-z][a-z0-9+.-]*:/i.test(source))
    throw new Error("Unsupported image source");
  const handle = await open(
    resolve(cwd ?? process.cwd(), file),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PREVIEW_BYTES)
      throw new Error("Image unavailable or exceeds 32 MiB");
    // A bounded read also covers growth between stat and read.
    const bytes = Buffer.alloc(Number(info.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
