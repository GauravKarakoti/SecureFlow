"use client";

import React, { useState } from "react";
import { Terminal, Copy, Check, FileCode, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { maskSecrets } from "@/lib/armor/secret-masking";

export interface CodeContextViewerProps {
  codeSnippet?: string | null | undefined;
  lineStart?: number | null | undefined;
  lineEnd?: number | null | undefined;
  fileLocation?: string | null | undefined;
  className?: string;
}

/**
 * CodeContextViewer Component
 *
 * Renders source code context with line numbers and visually highlights
 * affected/vulnerable lines. Masks sensitive secrets and handles missing
 * code context gracefully with a fallback placeholder.
 */
export function CodeContextViewer({
  codeSnippet,
  lineStart,
  lineEnd,
  fileLocation,
  className = "",
}: CodeContextViewerProps) {
  const [copied, setCopied] = useState(false);

  // Missing code context handled gracefully
  const isSnippetEmpty =
    !codeSnippet ||
    !codeSnippet.trim() ||
    codeSnippet.trim().replace(/\\n/g, "").trim().length === 0;

  if (isSnippetEmpty) {
    return (
      <div
        data-testid="code-context-empty"
        className={`rounded-xl border border-white/10 bg-black/40 p-8 text-center text-muted-foreground flex flex-col items-center justify-center space-y-2 ${className}`}
      >
        <FileCode className="w-8 h-8 opacity-40 mb-1" />
        <p className="text-sm font-medium">Code snippet unavailable.</p>
        <p className="text-xs text-muted-foreground/70 max-w-sm">
          No source code context was captured for this finding during the scan.
        </p>
      </div>
    );
  }

  // Mask secrets in code before display
  const maskedSnippet = maskSecrets(codeSnippet);
  const rawLines = maskedSnippet.split("\n");

  const startLineNum = typeof lineStart === "number" && lineStart > 0 ? lineStart : 1;
  const endLineNum =
    typeof lineEnd === "number" && lineEnd >= startLineNum ? lineEnd : startLineNum;

  const handleCopy = () => {
    navigator.clipboard.writeText(codeSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fileName = fileLocation ? fileLocation.split("/").pop() : "Source Code";

  return (
    <div
      data-testid="code-context-viewer"
      className={`rounded-xl border border-white/10 bg-black/70 overflow-hidden shadow-lg ${className}`}
    >
      {/* Code Header Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-white/[0.03] border-b border-white/10 text-xs">
        <div className="flex items-center gap-2 font-mono text-muted-foreground truncate">
          <Terminal className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-foreground/90 font-medium truncate">{fileName}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground gap-1.5"
          aria-label="Copy source code snippet"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-green-400" />
              <span className="text-green-400 font-medium">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy Code</span>
            </>
          )}
        </Button>
      </div>

      {/* Code Lines with Gutter and Highlighted Lines */}
      <div className="p-2 overflow-x-auto font-mono text-xs leading-relaxed">
        <table className="w-full border-collapse">
          <tbody>
            {rawLines.map((line, index) => {
              const currentLineNumber = startLineNum + index;
              const isHighlighted =
                typeof lineStart === "number"
                  ? currentLineNumber >= startLineNum && currentLineNumber <= endLineNum
                  : true; // highlight all lines if no specific lineStart is given

              return (
                <tr
                  key={index}
                  data-highlighted={isHighlighted ? "true" : "false"}
                  className={`transition-colors ${
                    isHighlighted
                      ? "bg-red-500/15 border-l-4 border-red-500 font-semibold"
                      : "border-l-4 border-transparent hover:bg-white/[0.02]"
                  }`}
                >
                  {/* Line Number Gutter */}
                  <td
                    className={`select-none text-right pr-4 pl-2 py-0.5 w-12 shrink-0 text-[11px] font-mono align-top ${
                      isHighlighted ? "text-red-400 font-bold" : "text-muted-foreground/40"
                    }`}
                  >
                    {currentLineNumber}
                  </td>

                  {/* Indicator Icon for Affected Lines */}
                  <td className="w-4 select-none py-0.5 text-center align-top">
                    {isHighlighted && (
                      <span
                        className="inline-flex text-red-400 text-[11px]"
                        title="Vulnerable line"
                        aria-label="Vulnerable line"
                      >
                        <AlertTriangle className="w-3 h-3 inline mt-0.5" />
                      </span>
                    )}
                  </td>

                  {/* Code Line Content */}
                  <td
                    className={`py-0.5 pr-4 pl-2 whitespace-pre font-mono text-[11.5px] align-top ${
                      isHighlighted ? "text-red-200" : "text-gray-300"
                    }`}
                  >
                    {line || " "}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
export default CodeContextViewer;
