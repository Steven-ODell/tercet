import { theme } from "./theme";
import { useEffect, useState } from "react";
import type { Activity } from "./activity";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One row under the transcript. Owns its own tick so only this row repaints,
    and the timer exists only while the agent is busy. */
export function ActivityRow({ activity, width }: { activity: Activity | null; width: number }) {
  const [frame, setFrame] = useState(0);
  const active = activity !== null;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((n) => (n + 1) % FRAMES.length), 100);
    return () => clearInterval(timer);
  }, [active]);
  if (!activity) return <box height={1} flexShrink={0} />;
  const text = activity.kind === "thinking" ? "Thinking…" : `Running ${activity.label}`;
  const room = Math.max(1, width - 2);
  const clipped = Bun.stringWidth(text) > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text;
  return (
    <text fg={theme.plain} selectable={false} height={1} flexShrink={0} wrapMode="none">
      <span fg={theme.accent}>{FRAMES[frame]}</span>
      <span fg={theme.muted}> {clipped}</span>
    </text>
  );
}
