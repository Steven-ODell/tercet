import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
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
): Promise<Uint8Array> {
  const attachment = attachmentSource(source);
  if (attachment) source = await attachmentUrl(attachment.id, attachment.mime);
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
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
  if (!source.startsWith("file:") && /^[a-z][a-z0-9+.-]*:/i.test(source))
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
