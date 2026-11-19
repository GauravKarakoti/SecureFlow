"use client";

import { useEffect } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function RepositoriesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Repository Overview Error:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] text-center p-6 bg-card/40 border border-white/5 rounded-lg">
      <AlertCircle className="w-12 h-12 text-destructive mb-4" />
      <h2 className="text-xl font-bold font-headline uppercase tracking-wider text-foreground mb-2">
        Failed to load repository overview
      </h2>
      <p className="text-sm font-mono text-muted-foreground max-w-md mb-6">
        An error occurred while calculating repository security health metrics. Please retry or contact support.
      </p>
      <Button
        onClick={() => reset()}
        variant="outline"
        className="font-mono text-xs gap-2 border-zinc-700 bg-zinc-900 hover:bg-zinc-800"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Retry
      </Button>
    </div>
  );
}
