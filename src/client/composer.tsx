import { hasDictation } from "../actions";
import { createDictation, type Dictation } from "./dictation";
import { theme } from "./theme";
import { commandForKey, hintFor } from "./keymap";
import { InlineImage } from "./image-preview";
import { pendingCard, requestKey, RequestPanel } from "./requests";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { useSpellCheck } from "./spell-ui";
import { decodePasteBytes, type BoxRenderable, type TextareaRenderable } from "@opentui/core";
import type { RunId, ThreadId } from "@t3tools/contracts";
import { createComposer, completionTrigger, requiresModifier } from "./composer-state";
import { emojiChoices } from "./emoji";
import { fileIcon } from "./icons";
import { useClientAtom } from "./screen";
import type { Client } from "./runtime";

/** Rows a wrapping run of buttons needs: labels pack left to right with one space between. */
export function wrapRows(width: number, labels: readonly string[]): number {
  if (!labels.length) return 0;
  let rows = 1;
  let used = 0;
  for (const label of labels) {
    if (used && used + 1 + label.length > Math.max(1, width)) {
      rows++;
      used = label.length;
    } else used += (used ? 1 : 0) + label.length;
  }
  return rows;
}
const textRows = (width: number, text: string) =>
  text ? Math.ceil(text.length / Math.max(1, width)) : 0;
/** Tap buttons of the compact media row; empty when the host offers no media action. */
export function compactMediaLabels(
  effects?: import("../actions").Actions,
  micLabel = "mic",
): string[] {
  return [
    ...(effects?.pasteClipboard ? ["[Paste]"] : []),
    ...(effects?.pasteImage ? ["[Paste image]"] : []),
    ...(effects?.pickFiles ? ["[Attach]"] : []),
    ...(hasDictation(effects) ? [`[${micLabel}]`] : []),
  ];
}
/** Tap buttons under the draft: send, steer, stop, and leaving a queued edit. */
export function compactActionLabels(busy: boolean, edit: boolean): string[] {
  return [
    busy ? "[sending…]" : edit ? "[save edit]" : "[send]",
    "[steer]",
    "[stop]",
    ...(edit ? ["[leave edit]"] : []),
  ];
}
/** Tap buttons for the selected queued message; [next] only when there is another to pick. */
export function compactQueueLabels(count: number): string[] {
  return [...(count > 1 ? ["[next]"] : []), "[steer]", "[edit]", "[cancel]"];
}
/**
 * Rows the compact composer needs at `width` with a one-row draft. The frame adds the rest of the
 * draft's height. `notes` are texts that wrap under the buttons (status, errors).
 */
export function compactComposerRows(
  width: number,
  o: {
    collapsed?: boolean;
    media?: readonly string[];
    actions?: readonly string[];
    queued?: number;
    images?: number;
    choices?: boolean;
    notes?: readonly string[];
    draftRows?: number;
  },
): number {
  const notes = (o.notes ?? []).reduce((sum, note) => sum + textRows(width, note), 0);
  if (o.collapsed) return 1 + notes;
  return (
    (o.queued ? 1 + wrapRows(width, compactQueueLabels(o.queued)) : 0) +
    (o.images ? 3 : 0) +
    wrapRows(width, o.media ?? []) +
    (o.draftRows ?? 1) +
    (o.choices ? 2 : 0) +
    wrapRows(width, o.actions ?? []) +
    notes
  );
}

export function ThreadComposer({
  client,
  effects,
  dictation: suppliedDictation,
  enabled,
  pasteEnabled = false,
  collapsed = false,
  compact = false,
  width,
  onRows,
  onInputFocus,
  onSent,
}: {
  client: Client;
  effects?: import("../actions").Actions;
  dictation?: Dictation;
  enabled: boolean;
  /** A paste made from another pane lands here and moves focus here. */
  pasteEnabled?: boolean;
  /** Show only the draft line: no queue, image, button or hint rows. A pending card still shows. */
  collapsed?: boolean;
  /** Phone layout: short tap buttons that wrap, one selected queued message, no key hints. */
  compact?: boolean;
  /** Columns the composer gets (default: the terminal's), used to count wrapped rows. */
  width?: number;
  /** Rows the compact composer needs now, with a one-row draft (see `compactComposerRows`). */
  onRows?: (rows: number) => void;
  /** Reveal the composer when typing or pasted text arrives. */
  onInputFocus?: () => void;
  /** A message or queued edit went out. */
  onSent?: () => void;
}) {
  const composer = useMemo(() => createComposer(client, client.boundary.drafts), [client]);
  const localDictation = useMemo(() => createDictation(client, effects), [client, effects]);
  const dictation = suppliedDictation ?? localDictation;
  useEffect(() => () => localDictation.dispose(), [localDictation]);
  useEffect(() => dictation.setFallback((origin, text) => {
    const draft = client.registry.get(composer.drafts)[origin] ?? "";
    composer.setDraft(origin, draft + (draft && !/\s$/.test(draft) ? " " : "") + text);
  }), [client, composer, dictation]);
  useClientAtom(client, client.transcripts);
  const [leaveCard, setLeaveCard] = useState<string>();
  const id = useClientAtom(client, client.selectedThreadId);
  const card = id ? pendingCard(client.getThread(id).projection) : undefined;
  const cardKey = card && `${id}:${requestKey(card)}`;
  const answering = !!card && leaveCard !== cardKey;
  useKeyboard((key) => {
    if (enabled && key.ctrl && key.name === "g" && card) {
      key.preventDefault();
      setLeaveCard(answering ? cardKey : undefined);
    }
  });
  useEffect(() => {
    void client.boundary
      .sendShortcut?.()
      .then((value) => client.registry.set(composer.shortcut, value))
      .catch(() => {});
    return () => {
      void composer.flush();
    };
  }, [client, composer]);
  if (!id) return <text fg={theme.muted}>Select a thread to write a message.</text>;
  return (
    <box flexDirection="column" height="100%">
      {card && (
        <RequestPanel
          key={cardKey}
          client={client}
          id={id}
          card={card}
          enabled={enabled && answering}
        />
      )}
      <Editor
        key={id}
        client={client}
        effects={effects}
        composer={composer}
        dictation={dictation}
        id={id}
        enabled={enabled && !answering}
        pasteFromPane={!enabled && pasteEnabled && !answering}
        collapsed={collapsed && !card}
        compact={compact}
        width={width}
        onRows={onRows}
        onInputFocus={onInputFocus}
        onSent={onSent}
      />
    </box>
  );
}
function Editor({
  client,
  composer,
  dictation,
  effects,
  id,
  enabled,
  pasteFromPane,
  collapsed,
  compact,
  width,
  onRows,
  onInputFocus,
  onSent,
}: {
  client: Client;
  composer: ReturnType<typeof createComposer>;
  dictation: Dictation;
  effects?: import("../actions").Actions;
  id: ThreadId;
  enabled: boolean;
  pasteFromPane: boolean;
  collapsed: boolean;
  compact: boolean;
  width?: number;
  onRows?: (rows: number) => void;
  onInputFocus?: () => void;
  onSent?: () => void;
}) {
  const terminal = useTerminalDimensions();
  const images = useClientAtom(client, composer.images)[id] ?? [];
  const [mediaStatus, setMediaStatus] = useState("");
  const [mediaBusy, setMediaBusy] = useState(false);
  const mediaLock = useRef(false);
  const micState = useSyncExternalStore(dictation.subscribe, dictation.getSnapshot);
  const micMessage = useSyncExternalStore(dictation.subscribe, dictation.getMessage);
  const recording = micState === "recording";
  const micLabel = recording
    ? effects?.toggleDictation
      ? "Stop mic"
      : "Recording"
    : micState === "transcribing"
      ? "Transcribing"
      : "mic";
  async function media(kind: "paste" | "clipboard" | "mic" | "files") {
    if (kind === "mic") {
      setMediaStatus("");
      onInputFocus?.();
      await dictation.toggle(id);
      return;
    }
    if (mediaLock.current || busy) return;
    mediaLock.current = true;
    setMediaBusy(true);
    setMediaStatus("");
    try {
      if (kind === "clipboard") {
        if (!effects?.pasteClipboard) throw new Error("unavailable");
        const value = await effects.pasteClipboard();
        if (value.type === "image") composer.attach(id, value.bytes);
        else if (editor.current) {
          editor.current.insertText(value.text);
          publish(editor.current.plainText);
        }
      } else if (kind === "files") {
        if (!effects?.pickFiles) throw new Error("unavailable");
        const picked = await effects.pickFiles(cwd);
        if (!picked.length) {
          setMediaStatus("");
          return;
        }
        for (const file of picked) composer.attachFile(id, file);
      } else if (kind === "paste") {
        if (!effects?.pasteImage) throw new Error("unavailable");
        composer.attach(id, await effects.pasteImage());
      }
      setMediaStatus("✓");
    } catch (error) {
      const reason = error instanceof Error && error.message !== "unavailable" ? error.message : "";
      setMediaStatus(
        kind === "files"
          ? `Attach failed${reason && ` (${reason})`}.`
          : `Paste unavailable${reason && ` (${reason})`}: copy text or a PNG up to 2000px / 10 MB.`,
      );
    } finally {
      mediaLock.current = false;
      setMediaBusy(false);
    }
  }
  const drafts = useClientAtom(client, composer.drafts);
  const error = useClientAtom(client, composer.error);
  const busy = useClientAtom(client, composer.busy);
  const shortcut = useClientAtom(client, composer.shortcut);
  useClientAtom(client, client.transcripts);
  const snapshot = useClientAtom(client, client.snapshot);
  const editor = useRef<TextareaRenderable>(null);
  /** The last draft the editor itself stored; see the sync effect below. */
  const published = useRef(client.registry.get(composer.drafts)[id] ?? "");
  const publish = (value: string) => {
    published.current = value;
    composer.setDraft(id, value);
  };
  useEffect(() => dictation.register(id, (value) => {
    if (editor.current) {
      editor.current.insertText(value);
      publish(editor.current.plainText);
    }
  }), [dictation, composer, id]);
  const [edit, setEdit] = useState<RunId>();
  const [choices, setChoices] = useState<readonly string[]>([]);
  const [choice, setChoice] = useState(0);
  const [completionError, setCompletionError] = useState("");
  const [queuedIndex, setQueuedIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const text = drafts[id] ?? "";
  const root = useRef<BoxRenderable>(null);
  // Collapsed and unfocused, the row previews how the draft starts. The textarea would show the
  // wrapped row holding the caret, so a long dictation looked like it had lost its first words. It
  // stays mounted and only hidden, keeping its caret for when the composer opens again.
  const preview = collapsed && !enabled && text.length > 0;
  const spell = useSpellCheck({
    spell: effects?.spell,
    editor,
    root,
    text,
    caret: cursor,
    textActions: () => {
      const target = editor.current;
      const update = (action: () => void) => { action(); if (target) publish(target.plainText); };
      const selected = target?.getSelectedText() ?? "";
      const selection = target?.editorView.getSelection();
      const original = target?.plainText;
      const copy = async (cut: boolean) => {
        try {
          await effects!.copy(selected);
          // Async clipboard commands must never delete a newer draft or selection.
          const current = target?.editorView.getSelection();
          if (cut && target && target.plainText === original &&
              current?.start === selection?.start && current?.end === selection?.end) {
            update(() => { target.deleteSelection(); });
          }
        } catch (error) {
          setMediaStatus(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      return [
        { label: "Copy", note: !selected || !effects?.copy, run: () => { void copy(false); } },
        { label: "Cut", note: !selected || !effects?.copy || busy, run: () => { void copy(true); } },
        { label: "Paste", note: !effects?.pasteClipboard || busy || mediaBusy, run: () => { void media("clipboard"); } },
        { label: "Select all", note: !target?.plainText, run: () => { target?.selectAll(); } },
        { label: "Undo", note: busy || !target?.editBuffer.canUndo(), run: () => update(() => { target?.undo(); }) },
        { label: "Redo", note: busy || !target?.editBuffer.canRedo(), run: () => update(() => { target?.redo(); }) },
      ];
    },
    replaceDraft: (next, caret) => {
      editor.current?.replaceText(next);
      if (editor.current) editor.current.cursorOffset = caret;
      publish(next);
    },
  });
  const thread = snapshot?.threads.find((thread) => thread.id === id);
  const project = snapshot?.projects.find((project) => project.id === thread?.projectId);
  const instanceId = thread?.modelSelection.instanceId;
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;
  useEffect(() => {
    // The editor reports its changes a tick late, and keys that arrive in a burst (dictation typed
    // by voxtype) outrun both that report and React's render. Writing such a stale draft back into
    // the editor resets its caret and scroll to the top and drops the newest characters. Only a
    // draft the editor did not write itself (a queued edit, a send clearing it) replaces its text.
    const latest = client.registry.get(composer.drafts)[id] ?? "";
    if (latest === published.current) return;
    published.current = latest;
    if (editor.current && editor.current.plainText !== latest) editor.current.setText(latest);
  }, [client, composer, id, text]);
  useEffect(() => {
    let cancelled = false;
    const trigger = completionTrigger(text, cursor);
    // Invalidate remote results as soon as the cursor or query changes.
    // eslint-disable-next-line react/set-state-in-effect
    setChoices([]);
    setChoice(0);
    setCompletionError("");
    if (!enabled || !trigger) return;
    // Emoji are local, so they need neither a project nor the debounce.
    if (trigger.prefix === ":") {
      setChoices(emojiChoices(trigger.query));
      return;
    }
    if (!cwd || !instanceId) return;
    const cancel = (
      client.boundary.scheduleCompletion ??
      ((callback: () => void) => {
        const timer = setTimeout(callback, 120);
        return () => clearTimeout(timer);
      })
    )(() => {
      void client
        .complete(cwd, trigger.prefix, trigger.query, instanceId)
        .then((values) => {
          if (!cancelled) setChoices(values);
        })
        .catch(() => {
          if (!cancelled) setCompletionError("Completion unavailable; keep typing or retry.");
        });
    });
    return () => {
      cancelled = true;
      cancel();
    };
  }, [client, text, cursor, enabled, cwd, instanceId]);
  function accept(value: string) {
    const target = editor.current;
    if (!target) return;
    const trigger = completionTrigger(target.plainText, target.cursorOffset);
    if (!trigger) return;
    // An emoji choice reads "🔥 fire"; only the character goes in the draft.
    const inserted = trigger.prefix === ":" ? value.split(" ")[0]! : value;
    const next = text.slice(0, trigger.start) + inserted + " " + text.slice(trigger.end);
    publish(next);
    target.setText(next);
    target.cursorOffset = trigger.start + inserted.length + 1;
    setChoices([]);
  }
  async function send(alternate = false) {
    if (await composer.send(id, alternate, edit)) {
      setEdit(undefined);
      onSent?.();
    }
  }
  /** With nothing typed, steering means pushing the selected queued message into the turn. */
  function steer() {
    const queued = composer.queued(id);
    const selected = queued[queuedIndex % Math.max(1, queued.length)];
    // Read the store, not render state: a paste and this key can land before the next render.
    const typed = client.registry.get(composer.drafts)[id]?.trim();
    const attached = client.registry.get(composer.images)[id]?.length;
    if (selected && !typed && !attached) void composer.promote(id, selected.id);
    else void send(true);
  }
  // The focused textarea takes its own bracketed pastes; this catches the unfocused case.
  usePaste((event) => {
    if (!pasteFromPane || !editor.current) return;
    event.preventDefault();
    editor.current.insertText(decodePasteBytes(event.bytes));
    publish(editor.current.plainText);
    onInputFocus?.();
  });
  useKeyboard((key) => {
    if (pasteFromPane && key.ctrl && key.name === "v") {
      key.preventDefault();
      onInputFocus?.();
      void media("clipboard");
      return;
    }
    // Attach, like a paste, works from another pane and brings focus here.
    if ((enabled || pasteFromPane) && commandForKey(key) === "attach" && effects?.pickFiles) {
      key.preventDefault();
      if (!enabled) onInputFocus?.();
      void media("files");
      return;
    }
    if (!enabled) return;
    if (key.ctrl && key.name === "c" && editor.current?.hasSelection()) {
      key.preventDefault();
      const selected = editor.current.getSelectedText();
      void Promise.resolve().then(() => effects?.copy(selected)).catch((error) =>
        setMediaStatus(`Copy failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (spell.onKey(key)) return;
    if (commandForKey(key) === "spell" && effects?.spell) {
      if (spell.openAtCaret()) key.preventDefault();
      return;
    }
    const micBusy = recording || micState === "transcribing";
    if (key.name === "escape" && !effects?.toggleDictation && micBusy) {
      key.preventDefault();
      dictation.cancel();
      return;
    }
    if (commandForKey(key) === "dictation" && hasDictation(effects)) {
      key.preventDefault();
      void media("mic");
      return;
    }
    if (key.ctrl && key.name === "v" && effects?.pasteClipboard) {
      key.preventDefault();
      void media("clipboard");
      return;
    }
    if (
      key.meta &&
      (key.name === "backspace" ||
        (key.name === "p" && effects?.pasteImage))
    ) {
      key.preventDefault();
      if (key.name === "backspace") {
        const image = images.at(-1);
        if (image) composer.removeImage(id, image.key);
      } else void media(key.name === "p" ? "paste" : "mic");
      return;
    }
    const queued = composer.queued(id);
    const selectedQueue = queued[queuedIndex % Math.max(1, queued.length)];
    if (key.ctrl && key.name === "s") {
      key.preventDefault();
      void composer.stop(id);
      return;
    }
    if (key.ctrl && ["u", "x", "g", "j"].includes(key.name)) {
      key.preventDefault();
      if (key.name === "j") setQueuedIndex((index) => index + 1);
      if (key.name === "g") setEdit(undefined);
      if (selectedQueue && key.name === "u") {
        setEdit(selectedQueue.id);
        composer.setDraft(
          id,
          client
            .getThread(id)
            .projection?.messages.find((message) => message.id === selectedQueue.userMessageId)
            ?.text ?? "",
        );
      }
      if (selectedQueue && key.name === "x") {
        void composer.cancel(id, selectedQueue.id);
        if (edit === selectedQueue.id) setEdit(undefined);
      }
      return;
    }
    if (
      choices.length &&
      ["tab", "up", "down", "return", "escape"].includes(key.name) &&
      !key.ctrl &&
      !key.meta
    ) {
      key.preventDefault();
      if (key.name === "escape") setChoices([]);
      else if (key.name === "up" || key.name === "down")
        setChoice(
          (index) => (index + (key.name === "up" ? choices.length - 1 : 1)) % choices.length,
        );
      else accept(choices[choice]!);
      return;
    }
    if (
      key.name === "return" &&
      !key.shift &&
      (key.meta || key.ctrl || !requiresModifier(shortcut, text))
    ) {
      key.preventDefault();
      if (key.meta) steer();
      else void send();
    }
  });
  const queued = composer.queued(id);
  const columns = width ?? terminal.width;
  const status = mediaBusy ? "…" : mediaStatus || micMessage;
  const mediaLabels = compactMediaLabels(effects, micLabel);
  const actionLabels = compactActionLabels(busy, !!edit);
  const notes = [status, error || completionError || spell.notice || ""].filter(Boolean);
  const compactRows = compactComposerRows(columns, {
    collapsed,
    media: mediaLabels,
    actions: actionLabels,
    queued: queued.length,
    images: images.length,
    choices: choices.length > 0,
    notes,
  });
  useEffect(() => {
    if (compact) onRows?.(compactRows);
  }, [compact, compactRows, onRows]);
  const queuedRun = queued.length ? queued[queuedIndex % queued.length] : undefined;
  const queuedText = (run: NonNullable<typeof queuedRun>) =>
    client.getThread(id).projection?.messages.find((message) => message.id === run.userMessageId)
      ?.text ?? "";
  const tap = (action: () => void) => (event: { button: number }) => {
    if (event.button === 0) action();
  };
  return (
    <box ref={root} flexDirection="column" width="100%" flexGrow={1} minHeight={0}>
      {!collapsed && compact && queuedRun && (
        <box flexShrink={0} height={1 + wrapRows(columns, compactQueueLabels(queued.length))}>
          <text height={1} wrapMode="none" truncate fg={theme.plain}>
            {`Queued ${(queuedIndex % queued.length) + 1}/${queued.length}: `}
            {queuedText(queuedRun)}
          </text>
          <box
            flexDirection="row"
            flexWrap="wrap"
            columnGap={1}
            height={wrapRows(columns, compactQueueLabels(queued.length))}
          >
            {queued.length > 1 && (
              <text
                flexShrink={0}
                fg={theme.plain}
                onMouseUp={tap(() => setQueuedIndex((index) => index + 1))}
              >
                [next]
              </text>
            )}
            <text
              flexShrink={0}
              fg={theme.plain}
              onMouseUp={tap(() => void composer.promote(id, queuedRun.id))}
            >
              [steer]
            </text>
            <text
              flexShrink={0}
              fg={theme.plain}
              onMouseUp={tap(() => {
                setEdit(queuedRun.id);
                composer.setDraft(id, queuedText(queuedRun));
              })}
            >
              [edit]
            </text>
            <text
              flexShrink={0}
              fg={theme.plain}
              onMouseUp={tap(() => {
                void composer.cancel(id, queuedRun.id);
                if (edit === queuedRun.id) setEdit(undefined);
              })}
            >
              [cancel]
            </text>
          </box>
        </box>
      )}
      {!collapsed && !compact && (
        <scrollbox height={queued.length ? 2 : 0} scrollY scrollX={false}>
          {queued.map((run, index) => (
            <box key={run.id} flexDirection="row">
              <text
                fg={theme.plain}
                flexGrow={1}
              >{`${index === queuedIndex % queued.length ? "› " : ""}Queued (Ctrl+j next): ${client.getThread(id).projection?.messages.find((message) => message.id === run.userMessageId)?.text ?? ""}`}</text>
              <text
                fg={theme.plain}
                onMouseUp={(event) => {
                  if (event.button === 0) void composer.promote(id, run.id);
                }}
              >
                [steer]
              </text>
              <text
                fg={theme.plain}
                onMouseUp={(event) => {
                  if (event.button === 0) {
                    setEdit(run.id);
                    composer.setDraft(
                      id,
                      client
                        .getThread(id)
                        .projection?.messages.find((message) => message.id === run.userMessageId)
                        ?.text ?? "",
                    );
                  }
                }}
              >
                [Ctrl+u edit]
              </text>
              <text
                fg={theme.plain}
                onMouseUp={(event) => {
                  if (event.button === 0) {
                    void composer.cancel(id, run.id);
                    if (edit === run.id) setEdit(undefined);
                  }
                }}
              >
                [Ctrl+x cancel]
              </text>
            </box>
          ))}
        </scrollbox>
      )}
      {!collapsed && (
        <scrollbox
          height={images.length ? 3 : 0}
          flexShrink={0}
          scrollY={false}
          scrollX
          contentOptions={{ flexDirection: "row", gap: 1 }}
        >
          {images.map((image, index) => (
            <box
              key={`${id}:${image.key}`}
              height={3}
              width={27}
              flexShrink={0}
              flexDirection="row"
              backgroundColor={theme.highlight}
              overflow="hidden"
            >
              {image.upload?.type === "file" ? (
                <box width={6} height={3} justifyContent="center" alignItems="center">
                  <text selectable={false} fg={fileIcon(image.upload.name).color}>
                    {fileIcon(image.upload.name).glyph}
                  </text>
                </box>
              ) : (
                <InlineImage bytes={image.bytes} width={6} height={3} />
              )}
              <box flexDirection="column" width={21} height={3}>
                <text selectable={false} fg={theme.accent} wrapMode="none">
                  {image.upload?.name ?? `clipboard.png ${index + 1}`}
                </text>
                <text
                  fg={theme.plain}
                  selectable={false}
                >{`${Math.ceil(image.bytes.length / 1024)} KB`}</text>
                <text
                  selectable={false}
                  fg={theme.accent}
                  onMouseUp={(event) => {
                    if (event.button === 0) composer.removeImage(id, image.key);
                  }}
                >
                  × remove
                </text>
              </box>
            </box>
          ))}
        </scrollbox>
      )}
      {!collapsed && compact && mediaLabels.length > 0 && (
        <box
          height={wrapRows(columns, mediaLabels)}
          flexShrink={0}
          flexDirection="row"
          flexWrap="wrap"
          columnGap={1}
        >
          {effects?.pasteClipboard && (
            <text flexShrink={0} fg={theme.accent} onMouseUp={tap(() => void media("clipboard"))}>
              [Paste]
            </text>
          )}
          {effects?.pasteImage && (
            <text flexShrink={0} fg={theme.accent} onMouseUp={tap(() => void media("paste"))}>
              [Paste image]
            </text>
          )}
          {effects?.pickFiles && (
            <text flexShrink={0} fg={theme.accent} onMouseUp={tap(() => void media("files"))}>
              [Attach]
            </text>
          )}
          {hasDictation(effects) && (
            <text flexShrink={0} fg={theme.accent} onMouseUp={tap(() => void media("mic"))}>
              [{micLabel}]
            </text>
          )}
        </box>
      )}
      {compact && status && (
        <text flexShrink={0} fg={theme.plain}>
          {status}
        </text>
      )}
      {!collapsed && !compact && (
        <box height={1} flexDirection="row">
          {effects?.pasteClipboard && (
            <text
              fg={theme.accent}
              onMouseUp={(event) => {
                if (event.button === 0) void media("clipboard");
              }}
            >
              [Ctrl+v Paste]{" "}
            </text>
          )}
          {effects?.pasteImage && (
            <text
              fg={theme.accent}
              onMouseUp={(event) => {
                if (event.button === 0) void media("paste");
              }}
            >
              [Alt+p Paste image]{" "}
            </text>
          )}
          {effects?.pickFiles && (
            <text
              fg={theme.accent}
              onMouseUp={(event) => {
                if (event.button === 0) void media("files");
              }}
            >
              [{hintFor("attach") === "none" ? "" : `${hintFor("attach")} `}Attach]{" "}
            </text>
          )}
          {hasDictation(effects) && (
            <text
              fg={theme.accent}
              onMouseUp={(event) => {
                if (event.button === 0) void media("mic");
              }}
            >
              [{hintFor("dictation")} {micLabel}]
            </text>
          )}
          <text fg={theme.plain}>{mediaBusy ? " …" : mediaStatus || micMessage}</text>
        </box>
      )}
      {preview && (
        <text height={1} flexShrink={0} marginRight={1} wrapMode="none" truncate fg={theme.input}>
          {text.replace(/\s+/g, " ").trim()}
        </text>
      )}
      <textarea
        ref={editor}
        visible={!preview}
        flexGrow={1}
        minHeight={1}
        // OpenTUI places the caret one cell past a full wrapped row. Keep it off the border.
        marginRight={1}
        focused={enabled}
        // The collapsed line opens the editor; it must not reposition its caret.
        selectable={!collapsed}
        initialValue={text}
        backgroundColor={theme.canvas}
        textColor={theme.input}
        // The default caret is white: invisible on the light presets.
        cursorColor={theme.strong}
        placeholderColor={theme.muted}
        placeholder="Message · @file · /skill · :emoji"
        keyBindings={[{ name: "return", shift: true, action: "newline" }]}
        onContentChange={() => {
          if (editor.current) {
            if (editor.current.plainText !== text) {
              publish(editor.current.plainText);
              if (enabled && collapsed && editor.current.plainText) onInputFocus?.();
            }
            setCursor(editor.current.cursorOffset);
          }
        }}
        onCursorChange={() => setCursor(editor.current?.cursorOffset ?? 0)}
        onMouseUp={spell.onMouseUp}
      />
      {spell.node}
      {choices.length > 0 && (
        <scrollbox height={2} scrollY>
          {choices.slice(Math.max(0, choice - 1), Math.max(0, choice - 1) + 2).map((value) => (
            <text
              key={value}
              fg={value === choices[choice] ? theme.accent : theme.muted}
              onMouseUp={(event) => {
                if (event.button === 0) accept(value);
              }}
            >
              {value === choices[choice] ? "› " : "  "}
              {value.startsWith("@") && (
                <span fg={fileIcon(value, value.endsWith("/") ? "directory" : "file").color}>
                  {fileIcon(value, value.endsWith("/") ? "directory" : "file").glyph}{" "}
                </span>
              )}
              {value}
            </text>
          ))}
        </scrollbox>
      )}
      {!collapsed && compact && (
        <box
          height={wrapRows(columns, actionLabels)}
          flexShrink={0}
          flexDirection="row"
          flexWrap="wrap"
          columnGap={1}
        >
          <text flexShrink={0} fg={theme.accent} onMouseUp={tap(() => !busy && void send())}>
            {actionLabels[0]}
          </text>
          <text flexShrink={0} fg={theme.plain} onMouseUp={tap(steer)}>
            [steer]
          </text>
          <text flexShrink={0} fg={theme.plain} onMouseUp={tap(() => void composer.stop(id))}>
            [stop]
          </text>
          {edit && (
            <text flexShrink={0} fg={theme.plain} onMouseUp={tap(() => setEdit(undefined))}>
              [leave edit]
            </text>
          )}
        </box>
      )}
      {!collapsed && !compact && (
        <box height={1} flexDirection="row">
          <text
            fg={theme.accent}
            onMouseUp={(event) => {
              if (event.button === 0 && !busy) void send();
            }}
          >
            {busy
              ? "[sending…]"
              : edit
                ? "[save queued edit]"
                : `[${requiresModifier(shortcut, text) ? "Ctrl+Enter" : "Enter"} send / queue]`}
          </text>
          <text
            fg={theme.plain}
            onMouseUp={(event) => {
              if (event.button === 0) steer();
            }}
          >
            {" "}
            [Alt+Enter steer]
          </text>
          <text
            fg={theme.plain}
            onMouseUp={(event) => {
              if (event.button === 0) void composer.stop(id);
            }}
          >
            {" "}
            [Ctrl+s stop]
          </text>
          {edit && (
            <text fg={theme.plain} onMouseUp={() => setEdit(undefined)}>
              {" "}
              [Ctrl+g leave edit]
            </text>
          )}
        </box>
      )}
      {(error || completionError || spell.notice) && (
        <text fg={theme.red}>{error || completionError || spell.notice}</text>
      )}
    </box>
  );
}

