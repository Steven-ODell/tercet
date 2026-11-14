import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentSource } from "./image-preview-source";
import { fileSource } from "./media";

/**
 * Where a video, audio or file source lives, for ffmpeg, the player or the opener: this server's
 * attachment file when it is on this machine, else a signed URL; a local path; or an http(s) URL.
 */
export async function resolveMediaTarget(
  source: string,
  cwd: string | undefined,
  attachmentsDir: string | undefined,
  url: (id: string, mime: string) => Promise<string>,
): Promise<{ target: string; size?: number }> {
  const file = fileSource(source);
  const attachment = file ?? attachmentSource(source);
  if (attachment) {
    if (!/^[\w-]+$/.test(attachment.id)) throw Error("Invalid attachment id");
    const size = file?.size;
    const files = attachmentsDir ? await readdir(attachmentsDir).catch(() => []) : [];
    const name = files.find((name) => name.startsWith(`${attachment.id}.`));
    if (name && attachmentsDir) return { target: join(attachmentsDir, name), size };
    return { target: await url(attachment.id, attachment.mime), size };
  }
  if (/^https?:\/\//i.test(source)) return { target: source };
  if (!/^[a-z]:[\\/]/i.test(source) && !source.startsWith("file:") && /^[a-z][a-z0-9+.-]*:/i.test(source))
    throw Error("Unsupported media source");
  const path = source.startsWith("file:")
    ? fileURLToPath(source)
    : resolve(cwd ?? process.cwd(), source);
  const info = await stat(path);
  if (!info.isFile()) throw Error("Not a file");
  return { target: path, size: info.size };
}

/**
 * Opens an image with the opener chain. Local files and this server's attachments open in place
 * (never copied or changed); anything else is loaded and written to a private temp file first.
 */
export function imageOpenAction(
  load: (source: string, cwd?: string) => Promise<Uint8Array>,
  attachmentsDir: string | undefined,
  openPath: (path: string) => Promise<unknown>,
  tmp = "/tmp/tercet-images",
) {
  return async (source: string, cwd?: string) => {
    const attachment = attachmentSource(source);
    let path: string | undefined;
    if (attachment && attachmentsDir && /^[\w-]+$/.test(attachment.id)) {
      const files = await readdir(attachmentsDir).catch(() => []);
      const name = files.find((name) => name.startsWith(`${attachment.id}.`));
      if (name) path = join(attachmentsDir, name);
    } else if (!attachment && !/^https?:/i.test(source)) {
      if (!/^[a-z]:[\\/]/i.test(source) && !source.startsWith("file:") && /^[a-z][a-z0-9+.-]*:/i.test(source))
        throw Error("Unsupported image source");
      path = source.startsWith("file:")
        ? fileURLToPath(source)
        : resolve(cwd ?? process.cwd(), source);
    }
    if (path && !(await stat(path)).isFile()) throw Error("Image is not a file");
    if (!path) {
      const bytes = await load(source, cwd);
      await mkdir(tmp, { recursive: true, mode: 0o700 });
      path = join(await mkdtemp(join(tmp, "image-")), "image.png");
      await writeFile(path, bytes, { mode: 0o600 });
    }
    await openPath(path);
    return "launched image viewer";
  };
}
