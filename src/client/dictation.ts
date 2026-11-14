import type { ThreadId } from "@t3tools/contracts";
import type { Actions, Recording } from "../actions";
import type { Client } from "./runtime";
import { speechSetupProblem } from "./speech";
import { hintFor } from "./keymap";

export type DictationState = "idle" | "recording" | "transcribing" | "error";

/** How long a finished session's message ("Mic transcript added ✓", an error) stays shown. */
export const MESSAGE_MS = 6000;

/** One session owns its destination even when the selected thread changes. */
export function createDictation(
  client: Pick<Client, "speechStatus" | "transcribe">,
  effects: Actions | undefined,
  notice: (text: string) => void = () => {},
  messageMs = MESSAGE_MS,
) {
  let state: DictationState = "idle";
  let message = "";
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let capture: Recording | undefined;
  let request: AbortController | undefined;
  let origin: ThreadId | undefined;
  let pending = false;
  let disposed = false;
  let fallback: ((id: ThreadId, text: string) => void) | undefined;
  const editors = new Map<ThreadId, (text: string) => void>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const update = (next: DictationState, text: string) => {
    state = next;
    message = text;
    notice(text);
    clearTimeout(clearTimer);
    clearTimer = undefined;
    // A live session keeps its message; a finished one clears after a while.
    if (text && (next === "idle" || next === "error")) {
      clearTimer = setTimeout(() => {
        clearTimer = undefined;
        message = "";
        emit();
      }, messageMs);
      clearTimer.unref?.();
    }
    emit();
  };
  /** The recorder died while recording: drop the capture and say why. */
  const failed = (error: Error) => {
    capture?.cancel();
    capture = undefined;
    update("error", error.message);
  };
  function cancel() {
    if (effects?.toggleDictation) return;
    generation++;
    pending = false;
    capture?.cancel();
    capture = undefined;
    request?.abort();
    request = undefined;
    update("idle", "Mic cancelled");
  }
  async function toggle(id?: ThreadId) {
    if (disposed) return;
    if (effects?.toggleDictation) {
      if (pending) return;
      pending = true;
      try {
        const result = await effects.toggleDictation();
        if (!disposed)
          update(
            result.recording ? "recording" : "idle",
            result.recording ? `Mic recording · ${hintFor("dictation")} stop` : "Mic stopped ✓",
          );
      } catch {
        if (!disposed) update("error", "Mic unavailable; retry when connected.");
      } finally {
        pending = false;
      }
      return;
    }
    if (state === "transcribing" || pending) {
      cancel();
      return;
    }
    const run = ++generation;
    try {
      if (state === "recording" && capture) {
        const recording = capture;
        request = new AbortController();
        const signal = request.signal;
        update("transcribing", "Mic transcribing · press mic again to cancel");
        const pcm = await recording.stop();
        if (generation !== run || disposed) return;
        capture = undefined;
        const text = await client.transcribe(pcm, {}, signal);
        if (generation !== run || disposed) return;
        request = undefined;
        if (text && origin) {
          const insert = editors.get(origin);
          if (insert) insert(text);
          else fallback?.(origin, text);
        }
        update("idle", text ? "Mic transcript added ✓" : "No speech detected");
      } else {
        if (!id || !effects?.record) return;
        origin = id;
        pending = true;
        const problem = speechSetupProblem(await client.speechStatus());
        if (generation !== run || disposed) return;
        if (problem) throw new Error(problem);
        let reachedLimit = false;
        let died: Error | undefined;
        // Both fire only while this session is recording, never once its stop has begun.
        const live = () => generation === run && !disposed && state === "recording";
        const recording = await effects.record({
          onLimit: () => {
            reachedLimit = true;
            if (!pending && live()) void toggle();
          },
          onFailure: (error) => {
            died = error;
            if (!pending && live()) failed(error);
          },
        });
        if (generation !== run || disposed) {
          recording.cancel();
          return;
        }
        capture = recording;
        pending = false;
        update("recording", `Mic recording · ${hintFor("dictation")} stop`);
        if (died) failed(died);
        else if (reachedLimit) void toggle();
      }
    } catch (error) {
      if (generation === run && !disposed) {
        capture?.cancel();
        capture = undefined;
        request = undefined;
        update("error", error instanceof Error ? error.message : "Dictation failed");
      }
    } finally {
      if (generation === run) pending = false;
    }
  }
  return {
    toggle,
    cancel,
    getSnapshot: () => state,
    getMessage: () => message,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setFallback(sink: (id: ThreadId, text: string) => void) {
      fallback = sink;
      return () => {
        if (fallback === sink) fallback = undefined;
      };
    },
    register(id: ThreadId, insert: (text: string) => void) {
      editors.set(id, insert);
      return () => {
        if (editors.get(id) === insert) editors.delete(id);
      };
    },
    dispose() {
      cancel();
      clearTimeout(clearTimer);
      disposed = true;
      editors.clear();
      fallback = undefined;
      listeners.clear();
    },
  };
}
export type Dictation = ReturnType<typeof createDictation>;
