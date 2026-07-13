"use client";

import { RadioTower, Loader2 } from "lucide-react";
import { useStreamingExplanation } from "@/hooks/use-streaming-explanation";

interface StreamingExplanationProps {
  findingId: string;
  storedExplanation: string;
}

/**
 * Displays a finding's explanation, defaulting to the already-stored (instant) text, with a
 * "Live Analysis" trigger that re-runs the AI explanation and streams it in token-by-token -
 * cutting perceived latency versus waiting for a full non-streamed response (issue #218).
 */
export default function StreamingExplanation({ findingId, storedExplanation }: StreamingExplanationProps) {
  const { isStreaming, explanation, error, start } = useStreamingExplanation(findingId);

  const displayText = isStreaming || explanation ? explanation : storedExplanation;

  return (
    <div className="bg-primary/5 border border-primary/20 rounded-xl p-6 relative overflow-hidden group">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-bold text-primary uppercase tracking-widest flex items-center gap-2">
          <Loader2 className={`w-3 h-3 ${isStreaming ? "animate-spin" : "hidden"}`} />
          Radio Comms
        </h4>
        <button
          type="button"
          onClick={start}
          disabled={isStreaming}
          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-primary/70 hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Re-run the AI analysis and stream the result live"
        >
          <RadioTower className="w-3 h-3" />
          {isStreaming ? "Receiving transmission..." : "Live analysis"}
        </button>
      </div>

      <p className="text-sm leading-relaxed text-foreground/90 italic">
        &quot;{displayText || "No explanation provided."}&quot;
        {isStreaming && (
          <span className="inline-block w-[2px] h-3 bg-primary ml-0.5 align-middle animate-pulse" />
        )}
      </p>

      {error && (
        <p className="mt-3 text-xs text-destructive">
          Transmission failed: {error}. Showing last known analysis.
        </p>
      )}
    </div>
  );
}
