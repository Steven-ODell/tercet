import { CommandId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { hintFor, type Command } from "./keymap";
import {
  canOneClick,
  limitNotice,
  limitText,
  offerText,
  updateCandidates,
  updateKey,
  updateOutcome,
  type UpdateRun,
} from "./notice-logic";
import type { Client } from "./runtime";
import { useClientAtom } from "./screen";
import { wrapName } from "./sidebar";
import { theme } from "./theme";

export type NoticeButton = { label: string; command?: Command; run: () => void };
export type Notice = {
  id: string;
  text: string;
  tone: "warning" | "error" | "success" | "info";
  buttons: NoticeButton[];
  /** Alt+x and the Dismiss button; absent when the notice cannot be dismissed. */
  dismiss?: () => void;
};

const SUCCESS_MS = 4000;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "request failed";

/** The provider update offer, then its progress and outcome, like web's update popup. */
export function useProviderUpdateNotice(client: Client): Notice | null {
  const providers = useClientAtom(client, client.providers);
  const candidates = useMemo(() => updateCandidates(providers), [providers]);
  const key = updateKey(candidates);
  const oneClick = candidates.filter((c) => canOneClick(c, providers));
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [run, setRun] = useState<UpdateRun | null>(null);
  const store = client.boundary.noticeDismissals;
  useEffect(() => {
    void store
      ?.read()
      .then((keys) => setDismissed((now) => new Set([...now, ...keys])))
      .catch(() => {});
  }, [store]);
  const dismissKey = (k: string | null) => {
    if (!k) return;
    setDismissed((now) => {
      const next = new Set(now).add(k);
      void store?.write([...next]).catch(() => {});
      return next;
    });
  };
  const outcome = run ? updateOutcome(run, providers) : null;
  // A success says so briefly, then leaves.
  useEffect(() => {
    if (outcome?.phase !== "succeeded") return;
    const timer = setTimeout(() => setRun(null), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [outcome?.phase]);
  const started = useRef(false);
  const startUpdate = () => {
    if (started.current || oneClick.length === 0) return;
    started.current = true;
    const ids = oneClick.map((c) => c.instanceId);
    setRun({ ids, errors: [], settled: false });
    void Promise.allSettled(
      oneClick.map((c) => client.updateProvider({ provider: c.driver, instanceId: c.instanceId })),
    ).then((results) => {
      started.current = false;
      setRun({
        ids,
        settled: true,
        errors: results.flatMap((r) => (r.status === "rejected" ? [errorText(r.reason)] : [])),
      });
    });
  };
  if (run && outcome) {
    const close = () => {
      setRun(null);
      dismissKey(key);
    };
    return {
      id: "provider-update",
      text: outcome.text,
      tone: outcome.phase === "failed" ? "error" : outcome.phase === "succeeded" ? "success" : "info",
      buttons: [],
      ...(outcome.phase === "running" ? {} : { dismiss: close }),
    };
  }
  if (!key || dismissed.has(key)) return null;
  return {
    id: "provider-update",
    text: offerText(candidates, oneClick.length > 0),
    tone: "warning",
    buttons: oneClick.length > 0 ? [{ label: "Update", command: "updateProviders", run: startUpdate }] : [],
    dismiss: () => dismissKey(key),
  };
}

/** The selected thread's usage limit with web's "Resume at reset" toggle (auto-continue). */
export function useLimitNotice(
  client: Client,
  thread: OrchestrationV2ThreadShell | undefined,
): Notice | null {
  const limit = limitNotice(thread);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = limit?.runId;
  useEffect(() => setError(null), [runId]);
  // A minute clock so "resets 3:40 PM" turns into "Thu …" style text at midnight.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!limit) return;
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [!!limit]);
  if (!limit) return null;
  const toggle = () => {
    if (pending || !limit.canSchedule || !limit.resetAt) return;
    setPending(true);
    setError(null);
    client
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(crypto.randomUUID()),
        threadId: limit.threadId,
        limitRecovery: { runId: limit.runId, resetAt: limit.resetAt, autoResume: !limit.scheduled },
      })
      .catch((cause) => setError(`Could not change auto-continue: ${errorText(cause)}`))
      .finally(() => setPending(false));
  };
  return {
    id: `usage-limit:${limit.runId}`,
    text: error ?? limitText(limit),
    tone: error ? "error" : "warning",
    buttons: limit.canSchedule
      ? [
          {
            label: pending ? "Saving…" : limit.scheduled ? "Turn off auto-continue" : "Auto-continue at reset",
            command: "autoContinue",
            run: toggle,
          },
        ]
      : [],
  };
}

const glyph = { warning: "!", error: "✗", success: "✓", info: "…" } as const;

const buttonText = (label: string, command?: Command) => {
  const key = command ? hintFor(command) : "none";
  return `[ ${label}${key === "none" ? "" : ` (${key})`} ]`;
};

function buttonsOf(notice: Notice) {
  return [
    ...notice.buttons,
    ...(notice.dismiss ? [{ label: "Dismiss", command: "dismissNotice" as Command, run: notice.dismiss }] : []),
  ].map((button) => ({ ...button, text: buttonText(button.label, button.command) }));
}

/**
 * Text rows and a button row per notice. The buttons share the last text row when they fit,
 * otherwise they get a row of their own, so the frame can count the rows it gives away.
 */
export function noticeLayout(notices: readonly Notice[], width: number) {
  return notices.map((notice) => {
    const buttons = buttonsOf(notice);
    const strip = buttons.map((b) => b.text).join(" ");
    const lines = wrapName(`${glyph[notice.tone]} ${notice.text}`, width);
    const last = lines.at(-1) ?? "";
    const inline = !strip || last.length + 1 + strip.length <= width;
    return { notice, buttons, lines, inline, rows: lines.length + (inline ? 0 : 1) };
  });
}

export function NoticeRows({ layout }: { layout: ReturnType<typeof noticeLayout> }) {
  return (
    <>
      {layout.map(({ notice, buttons, lines, inline }) => {
        const fg =
          notice.tone === "error"
            ? theme.red
            : notice.tone === "success"
              ? theme.green
              : notice.tone === "info"
                ? theme.accent
                : theme.yellow;
        const strip = (
          <>
            {buttons.map((button, i) => (
              <text
                key={button.text}
                fg={theme.accent}
                selectable={false}
                onMouseUp={(event) => {
                  if (event.button === 0) button.run();
                }}
              >
                {`${i || inline ? " " : ""}${button.text}`}
              </text>
            ))}
          </>
        );
        return (
          <box key={notice.id} flexDirection="column" flexShrink={0}>
            {lines.map((line, i) => (
              <box key={i} height={1} flexDirection="row">
                <text fg={fg}>{line}</text>
                {inline && i === lines.length - 1 && strip}
              </box>
            ))}
            {!inline && (
              <box height={1} flexDirection="row">
                {strip}
              </box>
            )}
          </box>
        );
      })}
    </>
  );
}
