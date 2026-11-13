// Windows and clock from the web sidebar fixture.
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
export const usageNow = Date.parse("2026-10-22T12:00:00.000Z");

export function claude(
  windows: NonNullable<ServerProvider["usageLimits"]>["windows"],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-22T11:59:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-10-22T11:59:00.000Z", windows },
  };
}
