"use client";

import { useCallback, useRef, useState } from "react";

type StreamEvent =
  | { type: "chunk"; explanation: string }
  | {
      type: "done";
      result: {
        explanation: string;
        remediationSuggestions: string;
        promptInjectionSuspected: boolean;
      };
    }
  | { type: "error"; message: string };

interface StreamingExplanationState {
  /** True from the moment `start` is called until a `done` or `error` event arrives. */
  isStreaming: boolean;
  /** Live-updating explanation text; grows as chunks arrive, then is replaced by the final,
   * fully-validated text on `done`. */
  explanation: string;
  /** Only populated once the stream finishes successfully. */
  remediationSuggestions: string | null;
  promptInjectionSuspected: boolean;
  error: string | null;
}

const initialState: StreamingExplanationState = {
  isStreaming: false,
  explanation: "",
  remediationSuggestions: null,
  promptInjectionSuspected: false,
  error: null,
};

/**
 * Consumes the /api/findings/[id]/explain-stream Server-Sent Events endpoint, exposing the
 * live-updating explanation text plus a `start()` trigger. Cancels any in-flight stream if
 * `start` is called again (e.g. the user clicks "Re-analyze" twice) or the component unmounts.
 */
export function useStreamingExplanation(findingId: string) {
  const [state, setState] = useState<StreamingExplanationState>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const start = useCallback(async () => {
    stop();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...initialState, isStreaming: true });

    try {
      const res = await fetch(`/api/findings/${findingId}/explain-stream`, {
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const message = res.status === 401
          ? "Session expired - refresh and try again."
          : `Analysis request failed (${res.status}).`;
        setState((prev) => ({ ...prev, isStreaming: false, error: message }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        // The last element may be an incomplete event still waiting on more bytes; keep it in
        // the buffer for the next read rather than trying to parse a partial line.
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const dataLine = line.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(dataLine.slice("data: ".length));
          } catch {
            continue;
          }

          if (event.type === "chunk") {
            setState((prev) => ({ ...prev, explanation: event.explanation }));
          } else if (event.type === "done") {
            setState({
              isStreaming: false,
              explanation: event.result.explanation,
              remediationSuggestions: event.result.remediationSuggestions,
              promptInjectionSuspected: event.result.promptInjectionSuspected,
              error: null,
            });
          } else if (event.type === "error") {
            setState((prev) => ({ ...prev, isStreaming: false, error: event.message }));
          }
        }
      }
    } catch (err) {
      // AbortError means a newer `start()` call (or unmount) superseded this one - not a
      // user-facing error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setState((prev) => ({
        ...prev,
        isStreaming: false,
        error: err instanceof Error ? err.message : "Connection failed.",
      }));
    }
  }, [findingId, stop]);

  return { ...state, start, stop };
}
