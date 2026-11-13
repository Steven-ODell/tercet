import { theme } from "./theme";
import { hintFor } from "./keymap";
import { useEffect, useState } from "react";
import { flushSync, useKeyboard } from "@opentui/react";
import {
  CommandId,
  type ModelSelection,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
  type ClientSettings,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import { modelIcon } from "./icons";
import type { Client } from "./runtime";
import { useClientAtom } from "./screen";

import { defaultRuntimeMode, selectionFor } from "./model-defaults";
export { selectionFor } from "./model-defaults";

export function catalogRows(
  providers: readonly ServerProvider[],
  favorites: ClientSettings["favorites"],
  query: string,
) {
  const rows = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      provider,
      model,
      favorite: favorites.some((f) => f.provider === provider.instanceId && f.model === model.slug),
    })),
  );
  const matches = rows.filter((row) =>
    `${resolveProviderInstanceDisplayName(row.provider)} ${row.model.name} ${row.model.slug}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return [
    ...matches
      .filter((r) => r.favorite)
      .sort(
        (a, b) =>
          favorites.findIndex(
            (f) => f.provider === a.provider.instanceId && f.model === a.model.slug,
          ) -
          favorites.findIndex(
            (f) => f.provider === b.provider.instanceId && f.model === b.model.slug,
          ),
      ),
    ...matches.filter((r) => !r.favorite),
  ];
}
export function selectable(provider: ServerProvider) {
  return (
    provider.enabled &&
    provider.status !== "disabled" &&
    provider.status !== "error" &&
    provider.availability !== "unavailable" &&
    provider.supportsTextGeneration !== false
  );
}

export function ModelPicker({
  client,
  effort,
  close,
  width,
  height,
}: {
  client: Client;
  effort: boolean;
  close: () => void;
  width: number;
  height: number;
}) {
  const providers = useClientAtom(client, client.providers);
  const snapshot = useClientAtom(client, client.snapshot);
  const id = useClientAtom(client, client.selectedThreadId);
  const thread = snapshot?.threads.find((t) => t.id === id);
  const [favorites, setFavorites] = useState<ClientSettings["favorites"]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  // j/k/h/l move the cursor until the filter is started (/ or any other letter); then they type,
  // and the arrow keys still move.
  const [filtering, setFiltering] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [selection, setSelection] = useState<ModelSelection | undefined>(
    effort
      ? (thread?.modelSelection ?? client.registry.get(client.newModelSelection) ?? undefined)
      : undefined,
  );
  const [mode, setMode] = useState<RuntimeMode>(
    thread?.runtimeMode ?? client.registry.get(client.newRuntimeMode) ?? "approval-required",
  );
  useEffect(() => {
    let stale = false;
    void client.boundary
      .modelFavorites?.()
      .then((value) => {
        if (!stale) setFavorites(value);
      })
      .catch(() => {
        if (!stale) setError("Favorites could not be loaded");
      });
    return () => {
      stale = true;
    };
  }, [client]);
  const preferences = useClientAtom(client, client.modelPreferences);
  const rows = catalogRows(
    providers,
    resolveModelPreferences(preferences, { favorites }).favorites,
    query,
  );
  const provider = providers.find((p) => p.instanceId === selection?.instanceId);
  const model = provider?.models.find((m) => m.slug === selection?.model);
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const modes = provider?.supportedRuntimeModes ?? [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ];
  const index = Math.min(
    cursor,
    Math.max(0, (selection ? descriptors.length + 3 : rows.length) - 1),
  );
  function choose(row: (typeof rows)[number]) {
    if (busy) return;
    if (!selectable(row.provider)) {
      setError("Provider unavailable or disabled");
      return;
    }
    const chosen = selectionFor(row.provider, row.model);
    const runtimeMode = defaultRuntimeMode(row.provider);
    if (!effort) {
      void apply(chosen, runtimeMode, row.provider, row.model);
      return;
    }
    setSelection(chosen);
    setMode(runtimeMode);
    setCursor(0);
    setQuery("");
    setError("");
  }
  async function activate(position: number) {
    if (busy) return;
    if (!selection) {
      if (rows[position]) choose(rows[position]);
      return;
    }
    const d = descriptors[position];
    if (d) {
      const current = selection.options?.find((o) => o.id === d.id)?.value ?? d.currentValue;
      const values = d.type === "boolean" ? [false, true] : d.options.map((o) => o.id);
      const value = values[(values.findIndex((v) => v === current) + 1) % values.length];
      if (value !== undefined)
        setSelection({
          ...selection,
          options: [...(selection.options ?? []).filter((o) => o.id !== d.id), { id: d.id, value }],
        });
    } else if (position === descriptors.length) {
      setMode(modes[(modes.indexOf(mode) + 1) % modes.length] ?? "approval-required");
    } else if (position === descriptors.length + 1) {
      setSelection(undefined);
      setCursor(0);
    } else {
      if (!provider || !model || !selectable(provider)) {
        setError("Model unavailable; choose an available model");
        return;
      }
      if (!modes.includes(mode)) {
        setError("Choose a supported runtime mode");
        return;
      }
      await apply(selection, mode, provider, model);
    }
  }
  async function apply(
    chosen: ModelSelection,
    runtimeMode: RuntimeMode,
    chosenProvider: ServerProvider,
    chosenModel: ServerProviderModel,
  ) {
    setBusy(true);
    setError("");
    try {
      const valid = selectionFor(chosenProvider, chosenModel, chosen);
      if (id) {
        await client.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: id,
          modelSelection: valid,
        });
        await client.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: id,
          runtimeMode: runtimeMode,
        });
      }
      client.registry.set(client.newModelSelection, valid);
      client.registry.set(client.newRuntimeMode, runtimeMode);
      close();
    } catch {
      setError("Selection could not be applied. Retry.");
    } finally {
      setBusy(false);
    }
  }
  useKeyboard((key) => {
    if (key.defaultPrevented || key.ctrl || key.meta) return;
    const typing = !selection && filtering;
    const printable =
      key.sequence?.length === 1 && key.sequence >= " " && key.sequence !== "\x7f" && !key.option;
    if (key.name === "escape") {
      key.preventDefault();
      close();
    } else if (!selection && !typing && printable && !"jkhl".includes(key.sequence!)) {
      // Typing anything but a movement key still starts the filter, as before. Commit at once:
      // the rest of a burst (one stdin chunk, or keys sent faster than a frame) must reach the
      // now-focused input, not this handler with a stale `filtering`.
      key.preventDefault();
      const first = key.sequence!;
      flushSync(() => {
        setFiltering(true);
        setCursor(0);
        if (first !== "/") setQuery(first);
      });
    } else if (
      ["up", "down", "return", "tab"].includes(key.name) ||
      (!typing && ["j", "k", "l", "h", "right", "left"].includes(key.name))
    ) {
      key.preventDefault();
      const name = key.name;
      if (name === "return" || name === "l" || name === "right") void activate(index);
      else if (name === "h" || name === "left") {
        // Back to the model list from the options page.
        if (selection) {
          setSelection(undefined);
          setCursor(0);
        }
      } else
        setCursor(
          name === "up" || name === "k"
            ? Math.max(0, index - 1)
            : Math.min((selection ? descriptors.length + 3 : rows.length) - 1, index + 1),
        );
    }
  });
  const labels = selection
    ? [
        ...descriptors.map(
          (d) =>
            `${d.label}: ${String(selection.options?.find((o) => o.id === d.id)?.value ?? d.currentValue ?? "default")}`,
        ),
        `Runtime: ${mode}`,
        "[ Choose another model ]",
        "[ Apply selection ]",
      ]
    : [];
  const notices = selection
    ? []
    : providers.flatMap((p) => {
        const notice = formatProviderUpdateRequiredNotice(p, query);
        return notice ? [{ id: p.instanceId, notice }] : [];
      });
  // The scrollbox is what is left of the box after its border (2), the title, the footer (error
  // line + close button) and, on the model list, the filter input and two hint lines. Rows are
  // windowed by hand to that height so the cursor row can never sit under the footer.
  const boxHeight = Math.max(8, height - 6);
  const chrome = 2 + 1 + 2 + (selection ? 0 : 3);
  const extra = selection ? 0 : (rows.length ? 0 : 1) + notices.length;
  const visibleRows = Math.max(1, boxHeight - chrome - extra);
  const start = Math.max(0, index - visibleRows + 1);
  return (
    <box
      position="absolute"
      left={Math.max(0, Math.floor((width - Math.min(76, width)) / 2))}
      top={1}
      width={Math.min(76, width)}
      height={boxHeight}
      border
      borderColor={theme.accent}
      backgroundColor={theme.canvas}
      flexDirection="column"
    >
      <text fg={theme.accent}>
        {selection
          ? `Effort and options · ${modelIcon(provider?.driver, selection.model).glyph} ${selection.model}`
          : effort
            ? "Effort · choose model"
            : "Model · Favorites first"}
      </text>
      {!selection && (
        <input
          focused={filtering}
          value={query}
          placeholder="Press / or type to filter all providers…"
          onInput={(value) => {
            setQuery(value);
            setCursor(0);
          }}
        />
      )}
      {!selection && (
        <text fg={theme.muted}>High where supported · Fast off · Claude/Codex full access</text>
      )}
      {!selection && (
        <text fg={theme.muted}>
          OpenCode asks · change permissions afterward with {hintFor("effort")}
        </text>
      )}
      <scrollbox flexGrow={1} scrollY scrollX={false}>
        {selection
          ? labels.slice(start, start + visibleRows).map((label, offset) => {
              const i = start + offset;
              return (
                <text
                  key={label}
                  fg={index === i ? theme.strong : theme.text}
                  bg={index === i ? theme.highlight : undefined}
                  onMouseUp={(e) => {
                    if (e.button === 0) void activate(i);
                  }}
                >
                  {index === i ? "› " : "  "}
                  {label}
                </text>
              );
            })
          : rows.slice(start, start + visibleRows).map((row, offset) => (
              <text
                key={`${row.provider.instanceId}:${row.model.slug}`}
                fg={selectable(row.provider) ? theme.text : theme.muted}
                bg={index === start + offset ? theme.highlight : undefined}
                onMouseUp={(e) => {
                  if (e.button === 0) choose(row);
                }}
              >
                {index === start + offset ? "› " : "  "}
                <span fg={modelIcon(row.provider.driver, row.model.slug).color}>
                  {modelIcon(row.provider.driver, row.model.slug).glyph}{" "}
                </span>
                {row.favorite ? "★ Favorites" : resolveProviderInstanceDisplayName(row.provider)} ·{" "}
                {row.model.name}
                {selectable(row.provider) ? "" : " (unavailable)"}
              </text>
            ))}
        {!selection && !rows.length && <text fg={theme.plain}>No matching models</text>}
        {notices.map((n) => (
          <text fg={theme.plain} key={n.id}>
            {n.notice}
          </text>
        ))}
      </scrollbox>
      <text fg={theme.red}>
        {error || (busy ? "Applying…" : "j/k or ↑/↓ select · l/Enter choose/apply · h back")}
      </text>
      <text
        fg={theme.accent}
        onMouseUp={(e) => {
          if (e.button === 0) close();
        }}
      >
        [ Esc Close ]
      </text>
    </box>
  );
}
