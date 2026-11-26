import {
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * The banners above the panes besides the server-version warning: a provider update on offer
 * (web's provider update popup) and the selected thread's usage limit with its auto-resume toggle
 * (web's composer banner). Pure logic here; `notices.tsx` holds the state and the requests.
 */

export type UpdateCandidate = ServerProvider & {
  readonly versionAdvisory: NonNullable<ServerProvider["versionAdvisory"]> & {
    readonly latestVersion: string;
  };
};

export const providerName = (provider: Pick<ServerProvider, "driver" | "displayName">) =>
  provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;

const version = (value: string) => (value.startsWith("v") ? value : `v${value}`);

/** Web's rule: enabled, behind the latest release, and the latest is not flagged broken. */
export function isUpdateCandidate(provider: ServerProvider): provider is UpdateCandidate {
  return (
    provider.enabled &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "broken" &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "unsupported" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.latestVersion !== null
  );
}

const isActive = (provider: Pick<ServerProvider, "updateState">) =>
  provider.updateState?.status === "queued" || provider.updateState?.status === "running";

/** One candidate per driver (the default instance wins), like web's notification. */
export function updateCandidates(providers: readonly ServerProvider[]): UpdateCandidate[] {
  const byDriver = new Map<string, UpdateCandidate>();
  for (const provider of providers.filter(isUpdateCandidate)) {
    const current = byDriver.get(provider.driver);
    if (!current || (provider.instanceId as string) === provider.driver) byDriver.set(provider.driver, provider);
  }
  return [...byDriver.values()];
}

/**
 * The server can run the update itself: it has an update command, and every outdated instance of
 * the driver shares it (one installer), so one request updates them all. Not while one runs.
 */
export function canOneClick(candidate: UpdateCandidate, providers: readonly ServerProvider[]) {
  if (isActive(candidate) || !candidate.versionAdvisory.canUpdate) return false;
  if (!candidate.versionAdvisory.updateCommand) return false;
  const commands = new Set<string>();
  for (const provider of providers.filter((p) => p.driver === candidate.driver)) {
    if (!isUpdateCandidate(provider)) continue;
    if (!provider.versionAdvisory.canUpdate || !provider.versionAdvisory.updateCommand) return false;
    commands.add(provider.versionAdvisory.updateCommand);
  }
  return commands.size === 1;
}

/** Same key as web (`driver:latest`, sorted): a dismissal holds until a newer release appears. */
export function updateKey(candidates: readonly UpdateCandidate[]): string | null {
  const parts = candidates.map((c) => `${c.driver}:${c.versionAdvisory.latestVersion}`).sort();
  return parts.length ? parts.join("|") : null;
}

export function offerText(candidates: readonly UpdateCandidate[], oneClick: boolean) {
  const list = candidates
    .map((c) => {
      const from = c.versionAdvisory.currentVersion ?? c.version;
      return `${providerName(c)} ${from ? `${version(from)} → ` : ""}${version(c.versionAdvisory.latestVersion)}`;
    })
    .join(", ");
  return `Provider update available: ${list}${oneClick ? "" : " (update it from T3's provider settings)"}`;
}

export type UpdateRun = {
  /** Instance ids sent to `server.updateProvider`. */
  readonly ids: readonly string[];
  /** Request failures, as text; set once every request has settled. */
  readonly errors: readonly string[];
  readonly settled: boolean;
};

export type UpdateOutcome = { phase: "running" | "succeeded" | "failed" | "unchanged"; text: string };

/** Where a run stands, from the live provider list (the config stream carries `updateState`). */
export function updateOutcome(run: UpdateRun, providers: readonly ServerProvider[]): UpdateOutcome {
  const sent = providers.filter((p) => run.ids.includes(p.instanceId));
  const names = (list: readonly ServerProvider[]) => [...new Set(list.map(providerName))].join(", ");
  const failed = sent.filter((p) => p.updateState?.status === "failed");
  if (run.errors.length || failed.length) {
    const detail = run.errors[0] ?? failed[0]?.updateState?.message ?? "the update command failed";
    return { phase: "failed", text: `${names(failed.length ? failed : sent) || "Provider"} update failed: ${detail}` };
  }
  if (!run.settled || sent.some(isActive)) {
    return { phase: "running", text: `Updating ${names(sent) || "providers"}…` };
  }
  const unchanged = sent.filter((p) => p.updateState?.status === "unchanged");
  if (unchanged.length)
    return { phase: "unchanged", text: `${names(unchanged)} still needs an update; see T3's provider settings.` };
  const done = sent
    .map((p) => (p.version ? `${providerName(p)} ${version(p.version)}` : providerName(p)))
    .filter((text, i, all) => all.indexOf(text) === i)
    .join(", ");
  return { phase: "succeeded", text: `Updated ${done || "providers"}. New sessions use the new version.` };
}

export type LimitNotice = {
  readonly threadId: OrchestrationV2ThreadShell["id"];
  readonly runId: RunId;
  /** Null when the provider gave no reset time: nothing to schedule. */
  readonly resetAt: string | null;
  /** The reset is after the stop, so a resume at reset can be scheduled. */
  readonly canSchedule: boolean;
  /** The server will continue the run at the reset. */
  readonly scheduled: boolean;
};

/** The selected thread stopped on a usage limit (web shows its recovery banner then). */
export function limitNotice(thread: OrchestrationV2ThreadShell | undefined): LimitNotice | null {
  if (!thread || thread.lastErrorClass !== "usage_limit" || !thread.latestRunId) return null;
  const resetAt = thread.usageLimitResetAt ?? null;
  const stopped = DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt);
  const recovery = thread.limitRecovery;
  return {
    threadId: thread.id,
    runId: thread.latestRunId,
    resetAt,
    canSchedule: resetAt !== null && Date.parse(resetAt) > stopped,
    scheduled:
      !!recovery &&
      recovery.runId === thread.latestRunId &&
      recovery.resetAt === resetAt &&
      recovery.autoResume,
  };
}

/** "3:40 PM" today, "Thu 3:40 PM" within a week, else the date too. */
export function resetText(resetAt: string, now = Date.now()) {
  const at = new Date(resetAt);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === new Date(now).toDateString()) return time;
  if (Math.abs(at.getTime() - now) < 6 * 86_400_000)
    return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function limitText(notice: LimitNotice, now = Date.now()) {
  if (!notice.resetAt) return "Usage limit reached · reset time unavailable; retry manually";
  const reset = `resets ${resetText(notice.resetAt, now)}`;
  if (!notice.canSchedule) return `Usage limit reached · ${reset}`;
  return `Usage limit reached · ${reset} · auto-continue ${notice.scheduled ? "on" : "off"}`;
}
