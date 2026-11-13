import type {
  ModelSelection,
  RuntimeMode,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";

/** Defaults for a fresh model choice; editing options preserves the explicit selection. */
export function selectionFor(
  provider: ServerProvider,
  model: ServerProviderModel,
  previous?: ModelSelection,
): ModelSelection {
  return {
    instanceId: provider.instanceId,
    model: model.slug,
    options: (model.capabilities?.optionDescriptors ?? []).flatMap((d) => {
      const old =
        previous?.instanceId === provider.instanceId && previous.model === model.slug
          ? previous.options?.find((o) => o.id === d.id)?.value
          : undefined;
      let value: string | boolean | undefined;
      if (d.type === "boolean") {
        value = typeof old === "boolean" ? old : d.id === "fastMode" ? false : d.currentValue;
      } else {
        const preferred = ["reasoningEffort", "effort", "variant"].includes(d.id)
          ? "high"
          : d.id === "serviceTier"
            ? "default"
            : undefined;
        value =
          typeof old === "string" && d.options.some((o) => o.id === old)
            ? old
            : (d.options.find((o) => o.id === preferred)?.id ??
              d.currentValue ??
              d.options.find((o) => o.isDefault)?.id);
      }
      return value === undefined ? [] : [{ id: d.id, value }];
    }),
  };
}

export function defaultRuntimeMode(provider: ServerProvider): RuntimeMode {
  const wanted =
    provider.driver === "codex" || provider.driver === "claudeAgent"
      ? "full-access"
      : "approval-required";
  return !provider.supportedRuntimeModes || provider.supportedRuntimeModes.includes(wanted)
    ? wanted
    : (provider.supportedRuntimeModes[0] ?? "approval-required");
}

export interface NewThreadDefaults {
  provider?: string;
  model?: string;
  mode?: RuntimeMode;
}

/** The settings default model, if a usable provider offers it; otherwise undefined. */
export function defaultSelection(
  providers: readonly ServerProvider[],
  defaults: NewThreadDefaults | undefined,
): Pick<ModelSelection, "instanceId" | "model"> | undefined {
  if (!defaults?.model) return undefined;
  const provider = providers.find(
    (p) =>
      p.enabled &&
      p.status !== "disabled" &&
      p.status !== "error" &&
      (!defaults.provider || p.instanceId === defaults.provider) &&
      p.models.some((m) => m.slug === defaults.model),
  );
  return provider && { instanceId: provider.instanceId, model: defaults.model };
}

/** The settings default mode when the provider supports it, else the provider's own default. */
export function runtimeModeFor(provider: ServerProvider, wanted: RuntimeMode | undefined) {
  return wanted &&
    (!provider.supportedRuntimeModes || provider.supportedRuntimeModes.includes(wanted))
    ? wanted
    : defaultRuntimeMode(provider);
}
