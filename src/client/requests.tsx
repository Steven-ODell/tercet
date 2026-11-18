import { theme } from "./theme";
import { hintFor } from "./keymap";
import { useEffect, useRef, useState } from "react";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { decodePasteBytes, type ScrollBoxRenderable } from "@opentui/core";
import { CommandId, type OrchestrationV2ThreadProjection, type ThreadId } from "@t3tools/contracts";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  secretRequestAnswerInput,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import { secretRequestCopy } from "../ext/secret-request";
import type { Client } from "./runtime";

type Requests = ReturnType<typeof derivePendingThreadRequests>;
export type RequestCard =
  | { kind: "secret"; item: SecretRequestItem }
  | { kind: "question"; item: Requests["userInputs"][number] }
  | { kind: "approval"; item: Requests["approvals"][number] };
export function pendingCard(
  projection: OrchestrationV2ThreadProjection | null,
): RequestCard | undefined {
  if (!projection) return;
  const secret = projection.visibleTurnItems.find(
    (row) =>
      row.visibility === "local" &&
      row.item.type === "secret_request" &&
      row.item.secretStatus === "pending",
  );
  if (secret?.item.type === "secret_request") return { kind: "secret", item: secret.item };
  const requests = derivePendingThreadRequests({
    runtimeRequests: projection.runtimeRequests ?? [],
    turnItems: projection.turnItems ?? [],
  });
  if (requests.userInputs[0]) return { kind: "question", item: requests.userInputs[0] };
  if (requests.approvals[0]) return { kind: "approval", item: requests.approvals[0] };
}
export function requestKey(card: RequestCard) {
  return card.kind === "secret" ? card.item.id : card.item.requestId;
}

/** Sensitive input lives only in this ref, never in a renderable, atom or draft store. */
export function RequestPanel({
  client,
  id,
  card,
  enabled,
  onEscape,
}: {
  client: Client;
  id: ThreadId;
  card: RequestCard;
  enabled: boolean;
  /** Esc with nothing typed to clear: the agent view uses it to go back. */
  onEscape?: () => void;
}) {
  const value = useRef(
    card.kind === "question" ? (card.item.questions[0]?.initialAnswer ?? "") : "",
  );
  const [customText, setCustomText] = useState(
    card.kind === "question" ? (card.item.questions[0]?.initialAnswer ?? "") : "",
  );
  const [entered, setEntered] = useState(false);
  const [other, setOther] = useState(
    card.kind === "question" && card.item.questions[0]?.initialAnswer !== undefined,
  );
  const [index, setIndex] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const answers = useRef<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const scroll = useRef<ScrollBoxRenderable>(null);
  // Arrow keys move the highlight, so keep the highlighted row inside the scrolled view.
  useEffect(() => scroll.current?.scrollChildIntoView(`row-${index}`), [index]);
  useEffect(
    () => () => {
      value.current = "";
    },
    [],
  );
  const question = card.kind === "question" ? card.item.questions[questionIndex] : undefined;
  const available = card.kind === "secret" || card.item.responseCapability !== "not_resumable";
  const editable = enabled && !busy && !done && available;
  const options =
    card.kind === "approval"
      ? (card.item.options ?? [
          { decision: "accept" as const, label: "Approve" },
          { decision: "decline" as const, label: "Deny" },
        ])
      : [];
  const labels =
    card.kind === "secret"
      ? [secretRequestCopy(card.item).submitLabel, "Decline"]
      : card.kind === "approval"
        ? options.map((o) => o.label + (o.warning ? ` · ${o.warning}` : ""))
        : [
            ...(question?.options.map((o) => o.label) ?? []),
            ...(question?.allowCustomAnswer !== false ? ["Other"] : []),
            "Submit answer",
          ];
  async function submit(choice: number) {
    if (!editable || sending.current) return;
    if (card.kind === "question" && question) {
      if (choice < question.options.length) {
        const option = question.options[choice]!;
        const answer = option.value ?? option.label;
        setOther(false);
        setSelected((previous) =>
          question.multiSelect
            ? previous.includes(answer)
              ? previous.filter((v) => v !== answer)
              : [...previous, answer]
            : [answer],
        );
        setIndex(choice);
        return;
      }
      if (labels[choice] === "Other") {
        setOther(true);
        setIndex(choice);
        return;
      }
      const answer = other ? value.current : selected;
      if (
        question.required !== false &&
        !(other ? value.current.trim() || question.initialAnswer !== undefined : selected.length)
      ) {
        setError("Choose an option or enter Other.");
        return;
      }
      answers.current[question.id] = answer;
      if (questionIndex + 1 < card.item.questions.length) {
        setQuestionIndex(questionIndex + 1);
        setSelected([]);
        setOther(card.item.questions[questionIndex + 1]?.initialAnswer !== undefined);
        value.current = card.item.questions[questionIndex + 1]?.initialAnswer ?? "";
        setCustomText(value.current);
        setEntered(false);
        setIndex(0);
        setError("");
        return;
      }
    }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      if (card.kind === "secret") {
        const input = secretRequestAnswerInput(
          card.item,
          choice === 0 ? { type: "save", secret: value.current } : { type: "decline" },
        );
        if (!input) return;
        value.current = "";
        setCustomText("");
        setEntered(false);
        await client.answerSecret(input);
      } else {
        await client.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: id,
          requestId: card.item.requestId,
          ...(card.kind === "approval"
            ? { decision: options[choice]!.decision }
            : { answers: answers.current }),
        });
      }
      setDone(true);
    } catch {
      // Even an error that echoes the entire RPC payload must not escape this boundary.
      setError("Could not answer. Re-enter if needed and retry when connected.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  function append(text: string) {
    value.current += text;
    setEntered(value.current.length > 0);
    if (other) setCustomText(value.current);
  }
  usePaste((event) => {
    if (!editable || (card.kind !== "secret" && !other)) return;
    event.preventDefault();
    append(decodePasteBytes(event.bytes));
  });
  useKeyboard((key) => {
    if (!enabled || done) return;
    // Consume text and routing keys while answering; pane Tab is retained via Ctrl+g.
    if (key.ctrl && ["g", "h", "j", "k", "l"].includes(key.name)) return;
    if (key.ctrl && key.name === "c") return;
    key.preventDefault();
    if (!editable) return;
    if (key.name === "escape") {
      if (!other && !value.current) onEscape?.();
      value.current = "";
      setCustomText("");
      setEntered(false);
      setOther(false);
      return;
    }
    if (key.name === "down" || key.name === "tab" || key.name === "up") {
      setIndex((i) => (i + (key.name === "up" ? labels.length - 1 : 1)) % labels.length);
      return;
    }
    if (key.name === "return") {
      void submit(other ? labels.length - 1 : index);
      return;
    }
    if (card.kind === "secret" || other) {
      if (key.name === "backspace") {
        value.current = Array.from(value.current).slice(0, -1).join("");
        setEntered(!!value.current);
        if (other) setCustomText(value.current);
      } else if (key.ctrl && key.name === "u") {
        value.current = "";
        setCustomText("");
        setEntered(false);
      } else if (
        !key.ctrl &&
        !key.meta &&
        key.sequence &&
        Array.from(key.sequence).every(
          (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
        )
      )
        append(key.sequence);
    } else if (/^[1-9]$/.test(key.sequence)) {
      const n = Number(key.sequence) - 1;
      if (n < labels.length) void submit(n);
    }
  });
  const pinned = card.kind === "question" ? labels.length - 1 : -1;
  // Phone sizes: the card keeps its 12 rows while the screen has room, then gives rows back (the
  // choices scroll, [send] stays pinned) and the hint line fits one row.
  const screen = useTerminalDimensions();
  const narrow = screen.width < 70;
  const cardHeight = Math.min(12, Math.max(7, screen.height - 8));
  const row = (label: string, n: number) => (
    <text
      key={label}
      id={`row-${n}`}
      flexShrink={0}
      fg={index === n ? theme.accent : theme.muted}
      onMouseUp={(event) => {
        if (event.button === 0) {
          setIndex(n);
          void submit(n);
        }
      }}
    >
      {index === n ? "› " : "  "}[{n + 1} {label}]
    </text>
  );
  return (
    <box
      height={cardHeight}
      flexShrink={0}
      border
      borderColor={theme.accent}
      flexDirection="column"
    >
      <scrollbox ref={scroll} scrollY scrollX={false} flexGrow={1}>
        <text fg={theme.accent}>
          {card.kind === "secret"
            ? card.item.label
            : card.kind === "question"
              ? `Question ${questionIndex + 1}/${card.item.questions.length}: ${question?.question}`
              : `Approval: ${card.item.detail ?? card.item.requestKind}`}
        </text>
        {done ? (
          <text fg={theme.plain}>Answer sent; waiting for server update.</text>
        ) : (
          <>
            {card.kind === "secret" && (
              <>
                <text fg={theme.plain}>{card.item.reason}</text>
                <text fg={theme.plain}>{secretRequestCopy(card.item).privacyNote}</text>
                <text fg={theme.plain}>
                  {entered ? "Secret entered (hidden)" : "Type or paste secret (no echo)"}
                </text>
              </>
            )}
            {question && (
              <text fg={theme.plain}>
                {other ? `Other: ${customText}` : `Selected: ${selected.join(", ") || "none"}`}
              </text>
            )}
            {labels.map((label, n) => (n === pinned ? null : row(label, n)))}
          </>
        )}
      </scrollbox>
      {/* A four-option question overflows the panel; the submit row must never scroll away. */}
      {!done && pinned >= 0 && row(labels[pinned]!, pinned)}
      <text fg={theme.plain} height={1} flexShrink={0}>
        {!available
          ? "Request cannot be resumed."
          : busy
            ? "Sending…"
            : error ||
              (narrow
                ? "↑↓ select · Enter answer · Esc clear"
                : `↑/↓ Tab select · Enter answer · Esc clear · Ctrl+g composer · ${hintFor("focusLeft")} / ${hintFor("focusRight")} panes`)}
      </text>
    </box>
  );
}
