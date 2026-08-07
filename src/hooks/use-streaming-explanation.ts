"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";

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

/** Stream idle timeout in milliseconds (30 seconds without data). */
const STREAM_IDLE_TIMEOUT_MS = 30000;

/**
 * Consumes the /api/findings/[id]/explain-stream Server-Sent Events endpoint, exposing the
 * live-updating explanation text plus a `start()` trigger. Cancels any in-flight stream if
 * `start` is called again (e.g. the user clicks "Re-analyze" twice) or the component unmounts.
 */
export function useStreamingExplanation(findingId: string) {
  const [state, setState] = useState<StreamingExplanationState>(initialState);
  const abortRef = useRef<AbortController | null>(null);
  const isTimeoutRef = useRef<boolean>(false);
  const { toast } = useToast();

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const start = useCallback(async () => {
    stop();
    isTimeoutRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...initialState, isStreaming: true });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        isTimeoutRef.current = true;
        controller.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    try {
      resetIdleTimeout();

      const res = await fetch(`/api/findings/${findingId}/explain-stream`, {
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        if (timeoutId) clearTimeout(timeoutId);
        const isRateLimit = res.status === 429;
        const message = isRateLimit
          ? "AI provider rate limit reached (429). Please wait a moment and try again."
          : res.status === 401
          ? "Session expired - refresh and try again."
          : `Analysis request failed (${res.status}).`;
        setState((prev) => ({ ...prev, isStreaming: false, error: message }));
        toast({
          variant: "destructive",
          title: isRateLimit ? "AI Provider Rate Limit Exceeded" : "Explanation Stream Failed",
          description: message,
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let hasFinishedStream = false;

      while (true) {
        resetIdleTimeout();
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
            hasFinishedStream = true;
            if (timeoutId) clearTimeout(timeoutId);
            setState({
              isStreaming: false,
              explanation: event.result.explanation,
              remediationSuggestions: event.result.remediationSuggestions,
              promptInjectionSuspected: event.result.promptInjectionSuspected,
              error: null,
            });
          } else if (event.type === "error") {
            hasFinishedStream = true;
            if (timeoutId) clearTimeout(timeoutId);
            const isRateLimit = /429|rate limit|quota|too many requests|overloaded/i.test(event.message || "");
            setState((prev) => ({ ...prev, isStreaming: false, error: event.message }));
            toast({
              variant: "destructive",
              title: isRateLimit ? "AI Provider Rate Limit Exceeded" : "Explanation Stream Failed",
              description: event.message || "An error occurred during AI analysis.",
            });
          }
        }
      }

      if (timeoutId) clearTimeout(timeoutId);

      if (!hasFinishedStream) {
        const message = "Connection closed before the explanation completed.";
        setState((prev) => ({ ...prev, isStreaming: false, error: message }));
        toast({
          variant: "destructive",
          title: "Explanation Stream Interrupted",
          description: "The connection to the AI service was lost mid-stream. Please try again.",
        });
      }
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);

      if (err instanceof DOMException && err.name === "AbortError") {
        if (isTimeoutRef.current) {
          const timeoutMsg = "Stream timed out waiting for AI response.";
          setState((prev) => ({ ...prev, isStreaming: false, error: timeoutMsg }));
          toast({
            variant: "destructive",
            title: "Explanation Stream Timeout",
            description: "The connection to the AI service timed out. Please try again.",
          });
        }
        return;
      }

      const errorMessage = err instanceof Error ? err.message : "Connection failed.";
      const isRateLimit = /429|rate limit|quota|too many requests|overloaded/i.test(errorMessage);
      setState((prev) => ({
        ...prev,
        isStreaming: false,
        error: errorMessage,
      }));
      toast({
        variant: "destructive",
        title: isRateLimit ? "AI Provider Rate Limit Exceeded" : "Explanation Stream Error",
        description: isRateLimit
          ? "The AI service rate limit was exceeded. Please wait a moment before retrying."
          : `Failed to receive security explanation: ${errorMessage}`,
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }, [findingId, stop, toast]);

  return { ...state, start, stop };
}
