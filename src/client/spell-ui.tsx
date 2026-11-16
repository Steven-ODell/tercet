import {
  SyntaxStyle,
  type KeyEvent,
  type MouseEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { Misspelling, SpellChecker } from "./spell";
import { theme } from "./theme";

const HIGHLIGHT_REF = 4242;
const MAX_SUGGESTIONS = 5;

export interface TextMenuItem {
  label: string;
  run: () => void;
  /** A note, not a choice: drawn dim, skipped by the keys, never numbered. */
  note?: boolean;
}
export interface TextMenu {
  items: TextMenuItem[];
  index: number;
  /** Screen position the menu hangs from: the click, or the start of the word. */
  x: number;
  y: number;
}

/** Where `text` has the word the caret is in or touching, else the next one after it, else the first. */
export function misspellingForCaret(found: readonly Misspelling[], caret: number) {
  return (
    found.find((m) => m.start <= caret && caret <= m.end) ??
    found.find((m) => m.start > caret) ??
    found[0]
  );
}

/**
 * Underlines misspelled words and combines text actions with a menu of corrections:
 * right-click a word, or press the `spell` key for the word at (or next after) the caret.
 */
export function useSpellCheck({
  spell,
  editor,
  root,
  text,
  caret,
  replaceDraft,
  textActions,
}: {
  textActions?: () => TextMenuItem[];
  spell: SpellChecker | undefined;
  editor: RefObject<TextareaRenderable | null>;
  root: RefObject<{ x: number; y: number } | null>;
  text: string;
  caret: number;
  replaceDraft: (next: string, caret: number) => void;
}) {
  const renderer = useRenderer();
  const { width: screenWidth, height: screenHeight } = useTerminalDimensions();
  const [version, setVersion] = useState(0);
  const [menu, setMenu] = useState<TextMenu>();
  // Why the last "Add to dictionary" was not saved; cleared by the next edit.
  const [notice, setNotice] = useState("");
  useEffect(() => spell?.subscribe(() => setVersion((v) => v + 1)), [spell]);
  const style = useMemo(
    () =>
      spell
        ? SyntaxStyle.fromStyles(
            { misspelled: { fg: theme.red, underline: true } },
            renderer.nativeScene,
          )
        : undefined,
    [spell, renderer],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const found = useMemo(() => spell?.check(text) ?? [], [spell, text, version]);
  // The word being typed is not flagged until the caret leaves it.
  const open = menu ? undefined : found.find((m) => m.start <= caret && caret <= m.end);
  useEffect(() => {
    const target = editor.current;
    if (!target || !style) return;
    target.syntaxStyle = style;
    target.removeHighlightsByRef(HIGHLIGHT_REF);
    const styleId = style.getStyleId("misspelled");
    if (styleId === null) return;
    // Highlight offsets do not count newlines; caret and text offsets do.
    const flat = (offset: number) => offset - (text.slice(0, offset).split("\n").length - 1);
    for (const m of found)
      if (m !== open)
        target.addHighlightByCharRange({
          start: flat(m.start),
          end: flat(m.end),
          styleId,
          priority: 10,
          hlRef: HIGHLIGHT_REF,
        });
  }, [editor, style, found, open, text]);
  // The menu belongs to the text it was opened on.
  useEffect(() => {
    setMenu(undefined);
    setNotice("");
  }, [text]);

  const show = useCallback(
    (m: Misspelling | undefined, x: number, y: number, editing = false) => {
      const replace = (value: string) => {
        if (!m || editor.current?.plainText.slice(m.start, m.end) !== m.word) return;
        const current = editor.current.plainText;
        replaceDraft(
          current.slice(0, m.start) + value + current.slice(m.end),
          m.start + value.length,
        );
      };
      const suggestions = m && spell ? spell.suggest(m.word).slice(0, MAX_SUGGESTIONS) : [];
      const actions = editing ? (textActions?.() ?? []) : [];
      setMenu({
        x,
        y,
        index: m
          ? suggestions.length
            ? 0
            : 1
          : Math.max(
              0,
              actions.findIndex((item) => !item.note),
            ),
        items: [
          ...(m && spell
            ? [
                ...suggestions.map((value) => ({ label: value, run: () => replace(value) })),
                ...(suggestions.length
                  ? []
                  : [{ label: "No suggestions", run: () => {}, note: true }]),
                {
                  label: "Add to dictionary",
                  // The word is already known for this session; only saving it to the file failed.
                  run: () =>
                    void spell!.add(m!.word).catch((error: unknown) => {
                      const code = (error as { code?: unknown } | null)?.code;
                      setNotice(
                        `Could not save "${m.word}" to the dictionary${typeof code === "string" ? ` (${code})` : ""}; ` +
                          "it is known until tercet exits.",
                      );
                    }),
                },
                { label: "Ignore", run: () => spell!.ignore(m!.word) },
              ]
            : []),
          ...actions,
        ],
      });
    },
    [spell, editor, replaceDraft, textActions],
  );
  const choose = (index: number) => {
    const item = menu?.items[index];
    if (!item || item.note) return;
    setMenu(undefined);
    item.run();
  };

  return {
    open: !!menu,
    /** A failed save from the menu, for the composer's error line. */
    notice,
    /**
     * Right-click offers text actions and spelling suggestions, preserving any selection.
     * Any click on the textarea closes an open menu; picks land on the menu's own rows.
     */
    onMouseUp(event: MouseEvent) {
      setMenu(undefined);
      if (event.button !== 2 || !editor.current) return;
      const target = editor.current;
      // A context click must not move the caret or replace an existing selection.
      // Only hit-test the word when there is no selection to preserve.
      if (!target.hasSelection()) {
        target.editorView.setLocalSelection(
          Math.max(0, event.x - target.x),
          Math.max(0, event.y - target.y),
          Math.max(0, event.x - target.x),
          Math.max(0, event.y - target.y),
          undefined,
          undefined,
          true,
          false,
        );
        target.editorView.resetLocalSelection();
      }
      const at = target.cursorOffset;
      const m = found.find((word) => word.start <= at && at <= word.end);
      show(m, event.x, event.y, true);
    },
    /** The `spell` key: the word at the caret, else the next flagged one. */
    openAtCaret() {
      const target = editor.current;
      const m = target && misspellingForCaret(found, target.cursorOffset);
      if (!target || !m) return false;
      target.cursorOffset = m.start;
      const cursor = target.visualCursor;
      show(m, target.x + cursor.visualCol, target.y + cursor.visualRow);
      return true;
    },
    /** Returns true when the menu took the key. Any other key closes it and goes on to the editor. */
    onKey(key: KeyEvent) {
      if (!menu) return false;
      const count = menu.items.length;
      const move = (by: number) => {
        let index = menu.index;
        do index = (index + by + count) % count;
        while (menu.items[index]?.note && index !== menu.index);
        setMenu({ ...menu, index });
      };
      // 1-9 pick among the real choices, so the note row does not shift the numbers.
      const choices = menu.items.flatMap((item, at) => (item.note ? [] : [at]));
      if (key.name === "escape") setMenu(undefined);
      else if (key.name === "up" || (key.ctrl && key.name === "p")) move(-1);
      else if (key.name === "down" || key.name === "tab" || (key.ctrl && key.name === "n")) move(1);
      else if (key.name === "return") choose(menu.index);
      else if (
        /^[1-9]$/.test(key.name) &&
        !key.ctrl &&
        !key.meta &&
        Number(key.name) <= choices.length
      )
        choose(choices[Number(key.name) - 1]!);
      else {
        setMenu(undefined);
        return false;
      }
      key.preventDefault();
      return true;
    },
    node: menu && (
      <>
        <box
          position="absolute"
          left={-(root.current?.x ?? 0)}
          top={-(root.current?.y ?? 0)}
          width={screenWidth}
          height={screenHeight}
          zIndex={19}
          onMouseDown={() => setMenu(undefined)}
        />
        <TextContextMenu
          menu={menu}
          root={root}
          screenWidth={screenWidth}
          screenHeight={screenHeight}
          onPick={choose}
        />
      </>
    ),
  };
}

export function TextContextMenu({
  menu,
  root,
  screenWidth,
  screenHeight,
  onPick,
}: {
  menu: TextMenu;
  root: RefObject<{ x: number; y: number } | null>;
  screenWidth: number;
  screenHeight: number;
  onPick: (index: number) => void;
}) {
  const width = Math.min(screenWidth, Math.max(...menu.items.map((item) => item.label.length)) + 6);
  const height = Math.min(screenHeight, menu.items.length + 2);
  const origin = root.current ?? { x: 0, y: 0 };
  // Above the word when there is room, so the word stays visible; else just below it.
  const above = menu.y - height >= 0;
  const left = Math.max(0, Math.min(menu.x, screenWidth - width)) - origin.x;
  const top =
    Math.max(0, Math.min(screenHeight - height, above ? menu.y - height : menu.y + 1)) - origin.y;
  return (
    <scrollbox
      scrollY
      position="absolute"
      left={left}
      top={top}
      width={width}
      height={height}
      border
      borderStyle="rounded"
      borderColor={theme.accent}
      backgroundColor={theme.canvas}
      flexDirection="column"
      zIndex={20}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {menu.items.map((item, i) => {
        const number = menu.items.slice(0, i).filter((other) => !other.note).length + 1;
        return (
          <text
            key={i}
            height={1}
            selectable={false}
            fg={item.note ? theme.muted : i === menu.index ? theme.accent : theme.text}
            bg={i === menu.index ? theme.highlight : undefined}
            onMouseUp={(event) => {
              if (event.button === 0) onPick(i);
            }}
          >
            {` ${item.note || number > 9 ? " " : number} ${item.label}`}
          </text>
        );
      })}
    </scrollbox>
  );
}
