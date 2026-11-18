import { theme } from "./theme";
import type { ColorInput } from "@opentui/core";
import { hintFor } from "./keymap";
import { Fragment, useEffect, useState, type ReactNode } from "react";
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
import type { Boundary, Client } from "./runtime";
import type { FavoriteEntry } from "./favorites-file";
import { useClientAtom } from "./screen";
import { wrapName } from "./sidebar";

import { defaultRuntimeMode, selectionFor } from "./model-defaults";
export { selectionFor } from "./model-defaults";

export type FavoriteRef = { provider: string; model: string };

/** Phone sizes: the same cut as the frame (narrow < 70 columns, short < 24 rows). */
export const pickerCompact = (width: number, height: number) => width < 70 || height < 24;

/** Wraps at spaces; a word wider than the row is cut by cells. Lines are in text order. */
export function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let row = "";
    for (const word of paragraph.split(" ")) {
      const joined = row ? `${row} ${word}` : word;
      if (Bun.stringWidth(joined) <= width) {
        row = joined;
        continue;
      }
      if (row) out.push(row);
      const pieces = wrapName(word, width);
      out.push(...pieces.slice(0, -1));
      row = pieces.at(-1)!;
    }
    out.push(row);
  }
  return out;
}

/**
 * Wraps each row whole at `width` cells and picks the rows that fit in `budget` lines with the
 * cursor row fully inside (as far down as the budget allows, like a list scrolled to the cursor).
 */
export function windowLines(
  texts: readonly string[],
  cursor: number,
  width: number,
  budget: number,
): { start: number; rows: string[][] } {
  const wrapped = texts.map((text) => wrapWords(text, width));
  const at = Math.min(cursor, Math.max(0, wrapped.length - 1));
  let start = at;
  let end = at + 1;
  let used = wrapped[at]?.length ?? 0;
  while (start > 0 && used + wrapped[start - 1]!.length <= budget) used += wrapped[--start]!.length;
  while (end < wrapped.length && used + wrapped[end]!.length <= budget)
    used += wrapped[end++]!.length;
  return { start, rows: wrapped.slice(start, end) };
}

/** `windowLines` that gives up the hint lines when they would leave fewer than three rows. */
export function windowWithHint(
  texts: readonly string[],
  cursor: number,
  width: number,
  budget: number,
  hintLines: number,
) {
  const win = windowLines(texts, cursor, width, budget - hintLines);
  if (!hintLines || win.rows.length >= Math.min(3, texts.length))
    return { win, hint: hintLines > 0 };
  return { win: windowLines(texts, cursor, width, budget), hint: false };
}

/** A wrapped row's lines joined for one `<text>`: cursor mark on the first, indent on the rest. */
export function rowText(lines: readonly string[], active: boolean) {
  return lines.map((line, i) => (i ? "  " : active ? "› " : "  ") + line).join("\n");
}

/** `line` (which starts at `offset` of the whole text) split into colored runs. */
function colored(line: string, offset: number, marks: readonly [number, number, ColorInput][]) {
  const cuts = new Set([0, line.length]);
  for (const [from, to] of marks)
    for (const cut of [from - offset, to - offset]) if (cut > 0 && cut < line.length) cuts.add(cut);
  const points = [...cuts].sort((a, b) => a - b);
  return points.slice(0, -1).map((from, i) => {
    const to = points[i + 1]!;
    const mark = marks.find(([a, b]) => offset + from >= a && offset + to <= b);
    return (
      <span key={from} fg={mark?.[2]}>
        {line.slice(from, to)}
      </span>
    );
  });
}

/** Config favorites (with their saved options) win; the resolved preference list is the fallback. */
export function effectiveFavorites(
  entries: readonly FavoriteEntry[],
  resolved: readonly FavoriteRef[],
): FavoriteEntry[] {
  return entries.length > 0
    ? [...entries]
    : resolved.map((f) => ({ provider: f.provider, model: f.model }));
}

export function favoriteEntry(entries: readonly FavoriteEntry[], provider: string, model: string) {
  return entries.find((e) => e.provider === provider && e.model === model);
}

/** A favorite's short suffix, e.g. " · medium"; boolean false is left out. */
export function favoriteSuffix(entry: FavoriteEntry | undefined) {
  const values = Object.values(entry?.options ?? {})
    .filter((v) => v !== false)
    .map(String);
  return values.length ? ` · ${values.join("/")}` : "";
}

/** The selection's option values in the shape the settings file stores. */
export function optionValues(selection: ModelSelection): Record<string, string | boolean> {
  return Object.fromEntries((selection.options ?? []).map((o) => [o.id, o.value]));
}

/**
 * Adds (`on`, with the selection's current option values) or removes one favorite. Resolves to the
 * saved list, or undefined when the boundary cannot save favorites.
 */
export async function saveFavoriteEdit(
  boundary: Pick<Boundary, "saveFavorite">,
  selection: ModelSelection,
  on: boolean,
  seed: FavoriteEntry[],
): Promise<FavoriteEntry[] | undefined> {
  const base = { provider: selection.instanceId, model: selection.model };
  return boundary.saveFavorite?.(on ? { ...base, options: optionValues(selection) } : base, on, seed);
}

export function catalogRows(
  providers: readonly ServerProvider[],
  favorites: readonly FavoriteRef[],
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
  const [entries, setEntries] = useState<FavoriteEntry[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  // j/k/h/l move the cursor until the filter is started (/ or any other letter); then they type,
  // and the arrow keys still move.
  const [filtering, setFiltering] = useState(false);
  const [cursor, setCursor] = useState(0);
  // The options page is either choosing a model's options or editing its favorite (right-click).
  const [editing, setEditing] = useState(false);
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
    const fail = () => {
      if (!stale) setError("Favorites could not be loaded");
    };
    void client.boundary
      .modelFavorites?.()
      .then((value) => {
        if (!stale) setFavorites(value);
      })
      .catch(fail);
    void client.boundary
      .favoriteEntries?.()
      .then((value) => {
        if (!stale) setEntries(value);
      })
      .catch(fail);
    return () => {
      stale = true;
    };
  }, [client]);
  const preferences = useClientAtom(client, client.modelPreferences);
  const favoriteList = effectiveFavorites(
    entries,
    resolveModelPreferences(preferences, { favorites }).favorites,
  );
  const rows = catalogRows(providers, favoriteList, query);
  const provider = providers.find((p) => p.instanceId === selection?.instanceId);
  const model = provider?.models.find((m) => m.slug === selection?.model);
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const modes = provider?.supportedRuntimeModes ?? [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ];
  // Options page: one row per option, then three action rows (see `labels`).
  const pageRows = selection ? descriptors.length + 3 : rows.length;
  const index = Math.min(cursor, Math.max(0, pageRows - 1));
  const isFavorite =
    !!selection &&
    favoriteList.some((f) => f.provider === selection.instanceId && f.model === selection.model);
  const suffixOf = (row: (typeof rows)[number]) =>
    favoriteSuffix(favoriteEntry(entries, row.provider.instanceId, row.model.slug));
  function choose(row: (typeof rows)[number]) {
    if (busy) return;
    if (!selectable(row.provider)) {
      setError("Provider unavailable or disabled");
      return;
    }
    const entry = favoriteEntry(entries, row.provider.instanceId, row.model.slug);
    const chosen = selectionFor(row.provider, row.model, undefined, entry?.options);
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
    setNotice("");
  }
  // Right-click: the options page for this model as its favorite editor. Works for unavailable
  // providers too, since it only edits the config.
  function editFavorite(row: (typeof rows)[number]) {
    if (busy) return;
    const entry = favoriteEntry(entries, row.provider.instanceId, row.model.slug);
    setSelection(selectionFor(row.provider, row.model, undefined, entry?.options));
    setEditing(true);
    setCursor(0);
    setQuery("");
    setError("");
    setNotice("");
  }
  function leaveOptions() {
    setSelection(undefined);
    setEditing(false);
    setCursor(0);
  }
  async function saveFavorite(chosen: ModelSelection, on: boolean) {
    if (busy) return;
    if (!client.boundary.saveFavorite) {
      setError("Favorites cannot be saved here");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const seed = favoriteList.map((f) => ({ provider: f.provider, model: f.model }));
      const saved = await saveFavoriteEdit(client.boundary, chosen, on, seed);
      if (saved) setEntries(saved);
      const name = model?.name ?? chosen.model;
      setNotice(on ? `Saved: ${name} favorite defaults` : `Removed: ${name} from favorites`);
    } catch {
      setError("Favorite could not be saved");
    } finally {
      setBusy(false);
    }
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
    } else if (editing) {
      if (position === descriptors.length) await saveFavorite(selection, !isFavorite);
      else if (position === descriptors.length + 1) await saveFavorite(selection, true);
      else leaveOptions();
    } else if (position === descriptors.length) {
      setMode(modes[(modes.indexOf(mode) + 1) % modes.length] ?? "approval-required");
    } else if (position === descriptors.length + 1) {
      leaveOptions();
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
    } else if (key.name === "tab" && !selection) {
      // Tab twin of right-click: the highlighted model's favorite editor.
      key.preventDefault();
      if (rows[index]) editFavorite(rows[index]);
    } else if (
      ["up", "down", "return", "tab"].includes(key.name) ||
      (!typing && ["j", "k", "l", "h", "right", "left"].includes(key.name))
    ) {
      key.preventDefault();
      const name = key.name;
      if (name === "return" || name === "l" || name === "right") void activate(index);
      else if (name === "h" || name === "left") {
        // Back to the model list from the options page.
        if (selection) leaveOptions();
      } else
        setCursor(
          name === "up" || name === "k"
            ? Math.max(0, index - 1)
            : Math.min(pageRows - 1, index + 1),
        );
    }
  });
  const favoriteLabel = isFavorite ? "Favorite: ★ yes" : "Favorite: no";
  const labels = selection
    ? [
        ...descriptors.map(
          (d) =>
            `${d.label}: ${String(selection.options?.find((o) => o.id === d.id)?.value ?? d.currentValue ?? "default")}`,
        ),
        ...(editing
          ? [favoriteLabel, "[ Save as favorite defaults ]", "[ Choose another model ]"]
          : [`Runtime: ${mode}`, "[ Choose another model ]", "[ Apply selection ]"]),
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
  const title = selection
    ? `${editing ? "Favorite" : "Effort and options"} · ${modelIcon(provider?.driver, selection.model).glyph} ${selection.model}`
    : effort
      ? "Effort · choose model"
      : "Model · Favorites first";
  if (pickerCompact(width, height)) {
    // Phone sizes: the box takes the whole screen; every row is wrapped whole and counted, so
    // the filter, at least three rows and the close line always show.
    const bw = Math.min(76, width);
    const inner = bw - 2;
    const hint = editing
      ? "j/k or ↑/↓ select · l/Enter toggle/save · h back"
      : selection
        ? "j/k or ↑/↓ select · l/Enter choose · h back"
        : "j/k or ↑/↓ select · Enter choose · Tab edit favorite · h back";
    const status = error || (busy ? (editing ? "Saving…" : "Applying…") : notice);
    const statusLines = status ? wrapWords(status, inner) : [];
    const hintLines = wrapWords(hint, inner);
    const titleLines = wrapWords(title, inner);
    const noticeLines = notices.flatMap((n) => wrapWords(n.notice, inner));
    const empty = !selection && !rows.length ? 1 : 0;
    const fixed =
      titleLines.length + (selection ? 0 : 1) + 1 + empty + noticeLines.length + statusLines.length;
    const texts = selection
      ? labels
      : rows.map((row) => {
          const icon = modelIcon(row.provider.driver, row.model.slug);
          return `${icon.glyph} ${row.favorite ? "★ Favorites" : resolveProviderInstanceDisplayName(row.provider)} · ${row.model.name}${suffixOf(row)}${selectable(row.provider) ? "" : " (unavailable)"}`;
        });
    const { win, hint: withHint } = windowWithHint(
      texts,
      index,
      inner - 2,
      Math.max(1, height - 2 - fixed),
      status ? 0 : hintLines.length,
    );
    const shownHint = withHint ? hintLines : [];
    const lineBox = (children: ReactNode, lines: number, key?: string) => (
      <text key={key} height={lines} wrapMode="none" fg={theme.plain}>
        {children}
      </text>
    );
    return (
      <box
        position="absolute"
        left={Math.max(0, Math.floor((width - bw) / 2))}
        top={0}
        width={bw}
        height={height}
        border
        borderColor={theme.accent}
        backgroundColor={theme.canvas}
        flexDirection="column"
      >
        <text fg={theme.accent} height={titleLines.length} wrapMode="none">
          {titleLines.join("\n")}
        </text>
        {!selection && (
          <input
            focused={filtering}
            value={query}
            placeholderColor={theme.muted}
            placeholder="Press / or type to filter all providers…"
            onInput={(value) => {
              setQuery(value);
              setCursor(0);
            }}
          />
        )}
        <box flexGrow={1} flexDirection="column">
          {win.rows.map((lines, offset) => {
            const i = win.start + offset;
            const row = selection ? undefined : rows[i];
            const active = index === i;
            const onMouseUp = (e: { button: number; preventDefault?: () => void }) => {
              if (selection) {
                if (e.button === 0) void activate(i);
              } else if (row) {
                if (e.button === 0) choose(row);
                else if (e.button === 2) {
                  e.preventDefault?.();
                  editFavorite(row);
                }
              }
            };
            if (!row) {
              return (
                <text
                  key={`${i}:${texts[i]}`}
                  height={lines.length}
                  wrapMode="none"
                  fg={active ? theme.strong : theme.text}
                  bg={active ? theme.highlight : undefined}
                  onMouseUp={onMouseUp}
                >
                  {rowText(lines, active)}
                </text>
              );
            }
            const icon = modelIcon(row.provider.driver, row.model.slug);
            const whole = texts[i]!;
            const bodyEnd =
              whole.length - suffixOf(row).length - (selectable(row.provider) ? 0 : 14);
            const marks: [number, number, ColorInput][] = [
              [0, icon.glyph.length + 1, icon.color],
              [icon.glyph.length + 1, bodyEnd, selectable(row.provider) ? theme.text : theme.muted],
              [bodyEnd, whole.length, theme.muted],
            ];
            let searched = 0;
            return (
              <text
                key={`${row.provider.instanceId}:${row.model.slug}`}
                height={lines.length}
                wrapMode="none"
                fg={selectable(row.provider) ? theme.text : theme.muted}
                bg={active ? theme.highlight : undefined}
                onMouseUp={onMouseUp}
              >
                {lines.map((line, k) => {
                  const from = whole.indexOf(line, searched);
                  searched = from + line.length;
                  return (
                    <Fragment key={k}>
                      {k ? "\n  " : active ? "› " : "  "}
                      {colored(line, from, marks)}
                    </Fragment>
                  );
                })}
              </text>
            );
          })}
          {empty > 0 && lineBox("No matching models", 1)}
          {notices.map((n) =>
            lineBox(wrapWords(n.notice, inner).join("\n"), wrapWords(n.notice, inner).length, n.id),
          )}
        </box>
        {statusLines.length > 0 && (
          <text
            fg={error || !notice ? theme.red : theme.green}
            height={statusLines.length}
            wrapMode="none"
          >
            {statusLines.join("\n")}
          </text>
        )}
        {shownHint.length > 0 && (
          <text fg={theme.red} height={shownHint.length} wrapMode="none">
            {shownHint.join("\n")}
          </text>
        )}
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
      <text fg={theme.accent}>{title}</text>
      {!selection && (
        <input
          focused={filtering}
          value={query}
          placeholderColor={theme.muted}
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
                  else if (e.button === 2) {
                    e.preventDefault?.();
                    editFavorite(row);
                  }
                }}
              >
                {index === start + offset ? "› " : "  "}
                <span fg={modelIcon(row.provider.driver, row.model.slug).color}>
                  {modelIcon(row.provider.driver, row.model.slug).glyph}{" "}
                </span>
                {row.favorite ? "★ Favorites" : resolveProviderInstanceDisplayName(row.provider)} ·{" "}
                {row.model.name}
                <span fg={theme.muted}>{suffixOf(row)}</span>
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
      <text fg={error || !notice ? theme.red : theme.green}>
        {error ||
          (busy
            ? editing
              ? "Saving…"
              : "Applying…"
            : notice ||
              (editing
                ? "j/k or ↑/↓ select · l/Enter toggle/save · h back"
                : "j/k or ↑/↓ select · l/Enter choose · right-click favorite · h back"))}
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
