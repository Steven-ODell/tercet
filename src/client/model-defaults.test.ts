import { expect, test } from "bun:test";
import { claude } from "./usage-fixture";
import { selectionFor } from "./model-defaults";

const provider = claude([]);
const model = {
  slug: "opus-5.5",
  name: "Opus 5.5",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select" as const,
        options: [
          { id: "high", label: "High", isDefault: true },
          { id: "medium", label: "Medium" },
          { id: "max", label: "Max" },
        ],
      },
      { id: "fastMode", label: "Fast", type: "boolean" as const, currentValue: false },
    ],
  },
};
const previous = (options: { id: string; value: string | boolean }[]) => ({
  instanceId: provider.instanceId,
  model: model.slug,
  options,
});
const values = (favoriteOptions?: Record<string, string | boolean>) =>
  Object.fromEntries(
    selectionFor(provider, model, undefined, favoriteOptions).options!.map((o) => [o.id, o.value]),
  );

test("a favorite's option beats the built-in default", () => {
  expect(values({ reasoningEffort: "medium", fastMode: true })).toEqual({
    reasoningEffort: "medium",
    fastMode: true,
  });
  expect(values()).toEqual({ reasoningEffort: "high", fastMode: false });
});

test("a previous selection beats the favorite", () => {
  const selection = selectionFor(provider, model, previous([{ id: "reasoningEffort", value: "max" }]), {
    reasoningEffort: "medium",
  });
  expect(selection.options).toEqual([
    { id: "reasoningEffort", value: "max" },
    { id: "fastMode", value: false },
  ]);
});

test("invalid favorite values fall back to the built-in default", () => {
  expect(values({ reasoningEffort: "turbo", fastMode: "yes" })).toEqual({
    reasoningEffort: "high",
    fastMode: false,
  });
});

test("favorite option ids that match no descriptor are ignored", () => {
  expect(values({ bogus: "x" })).toEqual(values());
});
