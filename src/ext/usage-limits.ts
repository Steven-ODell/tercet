import { isProviderAvailable, type ServerProvider } from "@t3tools/contracts";

// Copied from upstream packages/shared/src/usageLimits.ts (module-private at v0.1.8).
export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}
