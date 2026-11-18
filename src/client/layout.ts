/**
 * Layout mode for small terminals (a phone over SSH). Two independent axes, then one flag:
 * `narrow` (width < 70, the threshold the frame already uses to hide the sidebar) and `short`
 * (height < 24, so 80x24 stays desktop). `compact` is either. Neither = today's desktop layout.
 */
export const LAYOUT_MODES = ["auto", "compact", "full"] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export const NARROW_WIDTH = 70;
export const SHORT_HEIGHT = 24;

export type Layout = { narrow: boolean; short: boolean; compact: boolean };

export function layoutFor({
  width,
  height,
  mode = "auto",
}: {
  width: number;
  height: number;
  mode?: LayoutMode;
}): Layout {
  const narrow = width < NARROW_WIDTH;
  const short = height < SHORT_HEIGHT;
  if (mode === "full") return { narrow, short, compact: false };
  return { narrow, short, compact: mode === "compact" || narrow || short };
}

/** TERCET_LAYOUT=auto|compact|full wins over the `layout` setting; anything else is ignored. */
export const layoutModeFromEnv = (
  env: Record<string, string | undefined>,
  setting: LayoutMode = "auto",
): LayoutMode => {
  const value = env.TERCET_LAYOUT;
  return LAYOUT_MODES.find((mode) => mode === value) ?? setting;
};
