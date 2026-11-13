import { theme, type Color } from "./theme";
import { useEffect, useState } from "react";
import type { Client } from "./runtime";
import { useClientAtom } from "./screen";
import { sidebarLimitProviders, type SidebarLimitWindow } from "./usage";

/** A minute clock like web's: no animation or continuously repainting meter. */
export function useUsageLimits(client: Client) {
  const providers = useClientAtom(client, client.providers);
  const [now, setNow] = useState(() => Math.floor(client.now() / 60_000) * 60_000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(client.now() / 60_000) * 60_000), 60_000);
    return () => clearInterval(timer);
  }, [client]);
  return sidebarLimitProviders(providers, now);
}

export interface LimitPart {
  readonly text: string;
  /** Undefined keeps the footer's default color. */
  readonly color?: Color;
}

/** Green while there is room, amber past 70%, red past 90%, like the context meter levels. */
export function usedColor(usedPercent: number) {
  return usedPercent >= 90 ? theme.red : usedPercent >= 70 ? theme.yellow : theme.green;
}

/** One limit row as colored runs; the filled part is a half-height block (full cells were too tall). */
export function limitParts(limit: SidebarLimitWindow, width: number): LimitPart[] {
  const gap =
    limit.paceGap === null ? "?" : `${Math.abs(limit.paceGap)}${limit.paceGap >= 0 ? "+" : "-"}`;
  const suffix = ` ${limit.usedPercent}% ${gap}`;
  const cells = Math.max(1, width - Bun.stringWidth(limit.shortLabel + suffix) - 3);
  const filled = Math.round((Math.min(100, Math.max(0, limit.usedPercent)) / 100) * cells);
  const tick =
    limit.elapsedPercent === null
      ? -1
      : Math.min(cells - 1, Math.floor((limit.elapsedPercent / 100) * cells));
  const parts: LimitPart[] = [{ text: `${limit.shortLabel} [` }];
  const fill = usedColor(limit.usedPercent);
  for (let i = 0; i < cells; i++) {
    const part: LimitPart =
      i === tick
        ? { text: "│" }
        : i < filled
          ? { text: "▄", color: fill }
          : { text: "▁", color: theme.muted };
    const last = parts[parts.length - 1]!;
    if (last.color === part.color && i > 0 && last.text !== "│" && part.text !== "│")
      parts[parts.length - 1] = { text: last.text + part.text, color: last.color };
    else parts.push(part);
  }
  parts.push({ text: `]${suffix}` });
  return parts;
}

export const limitLine = (limit: SidebarLimitWindow, width: number) =>
  limitParts(limit, width)
    .map((part) => part.text)
    .join("");
