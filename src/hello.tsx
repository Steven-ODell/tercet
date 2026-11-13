import { useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useSelectionHandler } from "@opentui/react";
import type { Actions } from "./actions";
import { theme } from "./client/theme";

export const sample = "Drag this text to copy";

export function Hello({ actions }: { actions: Actions }) {
  const [clicks, setClicks] = useState(0);
  const [copied, setCopied] = useState(false);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const renderer = useRenderer();
  const copy = (text: string) => {
    if (!text) return;
    actions.copy(text);
    setCopied(true);
  };
  useSelectionHandler((selection) => {
    if (!selection.isDragging) copy(selection.getSelectedText());
  });
  useKeyboard((key) => {
    if (key.name === "return" || key.name === "space") setClicks((n) => n + 1);
    if (key.name === "j" || key.name === "down") scroll.current?.scrollBy(3);
    if (key.name === "k" || key.name === "up") scroll.current?.scrollBy(-3);
    if (key.name === "y") copy(renderer.getSelection()?.getSelectedText() || sample);
    if (key.name === "q") renderer.destroy();
  });
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.surface}>
      <text fg={theme.accent}>
        tercet hello — Enter/Space: click | j/k: scroll | y: copy | q: quit
      </text>
      <box
        height={1}
        width={32}
        onMouseUp={(event) => {
          if (event.button === 0) setClicks((n) => n + 1);
        }}
      >
        <text selectable={false} fg={theme.accent}>
          [ click me ] clicks={clicks}
        </text>
      </box>
      <text fg={theme.plain} selectable>
        {sample}
      </text>
      <text fg={theme.plain} selectable={false}>
        {copied ? "copy=ok" : "copy=ready"}
      </text>
      <scrollbox ref={scroll} height={12} width={60} scrollY scrollX={false}>
        {Array.from({ length: 100 }, (_, i) => (
          <text fg={theme.plain} key={i} height={1}>
            Row {String(i).padStart(3, "0")} — scroll list
          </text>
        ))}
      </scrollbox>
    </box>
  );
}
