import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TERCET_VERSION } from "./doctor";
import { PINNED_SERVER_VERSION, supportedRange } from "./client/compat";

/** `owner/name` of the repository whose releases carry the binaries. */
export const REPO = "Steven-ODell/tercet";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}
export interface Release {
  tag_name: string;
  body?: string | null;
  assets: ReleaseAsset[];
}

/** `tercet-linux-x64`, `tercet-darwin-arm64`, `tercet-windows-x64.exe`; null on an unlisted CPU. */
export function assetName(platform = process.platform, arch = process.arch): string | null {
  const os = ({ linux: "linux", darwin: "darwin", win32: "windows" } as Record<string, string>)[platform];
  const cpu = ({ x64: "x64", arm64: "arm64" } as Record<string, string>)[arch];
  return os && cpu ? `tercet-${os}-${cpu}${os === "windows" ? ".exe" : ""}` : null;
}

/** The hash `SHA256SUMS` lists for `file` (the `sha256sum` format: "<hex>  <name>"). */
export function checksumFor(sums: string, file: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match && match[2] === file) return match[1]!.toLowerCase();
  }
  return null;
}

/** True when `latest` is a newer release than `current` (Bun's semver; unparseable means no). */
export function isNewer(latest: string, current: string): boolean {
  try {
    return Bun.semver.order(latest.replace(/^v/, ""), current.replace(/^v/, "")) === 1;
  } catch {
    return false;
  }
}

/** A running binary is `compiled`; a Bun install or a checkout is told how to update instead. */
export const isCompiled = () => Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN");

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export const UPGRADE_USAGE = `Usage: tercet upgrade [--check]

Replace this tercet binary with the newest release from GitHub, after checking its SHA-256
against the release's SHA256SUMS. --check only says whether a newer release exists.
A tercet installed with Bun (or run from a checkout) updates the way it was installed:
see docs/install.md.`;

export async function runUpgrade(
  args: string[],
  fetcher: typeof fetch = fetch,
  self: string = process.execPath,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(UPGRADE_USAGE);
    return 0;
  }
  const checkOnly = args.includes("--check");
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length) {
    console.error(`tercet upgrade: unknown option ${unknown[0]}; see tercet upgrade --help`);
    return 2;
  }
  if (!isCompiled()) {
    console.error(
      "tercet upgrade: this tercet runs from Bun or a checkout, not from a release binary.\n" +
        "Update it the way you installed it: `bun install -g github:" + REPO + "` or `git pull && bun run build` (docs/install.md).",
    );
    return 1;
  }
  const wanted = assetName();
  if (!wanted) {
    console.error(`tercet upgrade: no release binary for ${process.platform}/${process.arch}`);
    return 1;
  }
  try {
    // A generic client name only: the request says nothing about this machine or its owner.
    const headers = { "User-Agent": "tercet-upgrade", Accept: "application/vnd.github+json" };
    const response = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for the latest release`);
    const release = (await response.json()) as Release;
    if (!isNewer(release.tag_name, TERCET_VERSION)) {
      console.log(`tercet ${TERCET_VERSION} is the newest release (${release.tag_name}).`);
      return 0;
    }
    console.log(`tercet ${release.tag_name} is available; you have ${TERCET_VERSION}.`);
    if (checkOnly) return 0;
    const asset = release.assets.find((item) => item.name === wanted);
    const sums = release.assets.find((item) => item.name === "SHA256SUMS");
    if (!asset || !sums) throw new Error(`release ${release.tag_name} has no ${wanted} or no SHA256SUMS`);
    const expected = checksumFor(
      await (await fetcher(sums.browser_download_url, { headers, signal: AbortSignal.timeout(30_000) })).text(),
      wanted,
    );
    if (!expected) throw new Error(`SHA256SUMS has no line for ${wanted}`);
    const download = await fetcher(asset.browser_download_url, { headers, signal: AbortSignal.timeout(300_000) });
    if (!download.ok) throw new Error(`download answered ${download.status}`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (sha256(bytes) !== expected) throw new Error("the download does not match SHA256SUMS; nothing was changed");
    // Next to the target so the rename stays on one filesystem. A running Windows exe cannot be
    // overwritten but can be renamed out of the way.
    const next = join(dirname(self), `.${wanted}.new`);
    writeFileSync(next, bytes);
    if (process.platform !== "win32") chmodSync(next, 0o755);
    const old = `${self}.old`;
    if (process.platform === "win32") {
      rmSync(old, { force: true });
      renameSync(self, old);
    }
    renameSync(next, self);
    if (existsSync(old)) rmSync(old, { force: true });
    console.log(`Updated ${self} to ${release.tag_name}.`);
    console.log(`T3 server: ${supportedRange}, tested on ${PINNED_SERVER_VERSION} (for the old build; run tercet --version for the new).`);
    return 0;
  } catch (error) {
    console.error(`tercet upgrade: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
