import { createContext, useContext } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { layoutFor, type Layout } from "./layout";

/** The frame's layout result, so a `layout` setting or TERCET_LAYOUT reaches panels and dialogs. */
export const LayoutContext = createContext<Layout | null>(null);

/** The frame's layout; outside a frame (tests, standalone panels) the auto layout of the screen. */
export function useLayout(): Layout {
  const injected = useContext(LayoutContext);
  const { width, height } = useTerminalDimensions();
  return injected ?? layoutFor({ width, height });
}

/** One view at a time: a narrow screen in compact mode ("full" keeps the desktop columns). */
export const oneViewOf = (layout: Layout) => layout.narrow && layout.compact;
