import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Rendered pages (T3's html_render) drawn as a picture in the transcript: the page is shot with
 * headless chromium and the PNG goes through the image rungs like a photo. On by default;
 * `media.pageShots: false` turns them off, and TERCET_PAGE_SHOTS=0 or =1 wins over the file.
 */
export const PAGE_SCHEME = "tercet-page:";
const on = { value: false };
export const setPageShots = (value: boolean) => void (on.value = value);
export const pageShotsOn = () => on.value;
export const pageShotsFromEnv = (env: Record<string, string | undefined>, setting = true) =>
  env.TERCET_PAGE_SHOTS === "0" ? false : env.TERCET_PAGE_SHOTS === "1" ? true : setting;

export const pageSource = (id: string) => `${PAGE_SCHEME}${encodeURIComponent(id)}`;
export const isPageSource = (source: string) => source.startsWith(PAGE_SCHEME);
export const pageId = (source: string) => decodeURIComponent(source.slice(PAGE_SCHEME.length));

export const PAGE_SHOT_SIZE = { width: 1280, height: 720 };

/** Off-screen and silent: no window, no audio, a throwaway profile. */
export function chromiumArgs(url: string, out: string, profile: string) {
  return [
    "chromium",
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--disable-extensions",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=4000",
    `--window-size=${PAGE_SHOT_SIZE.width},${PAGE_SHOT_SIZE.height}`,
    `--screenshot=${out}`,
    url,
  ];
}

/** Runs a command, resolving its exit code; killed after `timeoutMs`. */
export type Run = (args: string[], timeoutMs: number) => Promise<number>;

export async function shootPage(
  url: string,
  run: Run,
  tmp = "/tmp/tercet-pages",
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<Uint8Array> {
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(tmp, "shot-"));
  try {
    const out = join(dir, "page.png");
    const code = await run(chromiumArgs(url, out, join(dir, "profile")), 20000);
    if (code !== 0) throw new Error("Page render failed");
    return await read(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Shots are kept for the session so scrolling away and back does not start chromium again. */
export function cachedShots(shoot: (id: string) => Promise<Uint8Array>) {
  const shots = new Map<string, Promise<Uint8Array>>();
  return (id: string) => {
    let shot = shots.get(id);
    if (!shot) {
      shot = shoot(id);
      shots.set(id, shot);
      shot.catch(() => shots.delete(id));
    }
    return shot;
  };
}
