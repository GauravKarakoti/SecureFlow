'use client';

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Copy, Check } from 'lucide-react';

interface PatchDiffViewerProps {
  patchDiff: string;
  explanation: string;
}

/**
 * PatchDiffViewer Component
 * Renders a unified diff securely with syntax highlighting concepts and copy functionality.
 * Supports dark mode via Tailwind.
 */
export function PatchDiffViewer({ patchDiff, explanation }: PatchDiffViewerProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(patchDiff);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Simple diff coloring logic for demonstration
  const renderDiff = (diff: string) => {
    return diff.split('\n').map((line, i) => {
      let className = 'text-gray-300 dark:text-gray-400';
      if (line.startsWith('+')) className = 'text-green-400 dark:text-green-300 bg-green-900/20';
      if (line.startsWith('-')) className = 'text-red-400 dark:text-red-300 bg-red-900/20';
      if (line.startsWith('@@')) className = 'text-blue-400 dark:text-blue-300 font-bold';

      return (
        <div key={i} className={`px-2 font-mono text-sm ${className}`}>
          {line || ' '}
        </div>
      );
    });
  };

  return (
    <Card className="bg-gray-950 border-gray-800 text-gray-100">
      <CardHeader className="pb-2 border-b border-gray-800">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-gray-200">Suggested Remediation Patch</CardTitle>
          <Button variant="ghost" size="sm" onClick={handleCopy} className="text-gray-400 hover:text-white">
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            <span className="ml-2">{copied ? 'Copied' : 'Copy'}</span>
          </Button>
        </div>
        <p className="text-sm text-gray-400 mt-2">{explanation}</p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <pre className="p-4">
          {renderDiff(patchDiff)}
        </pre>
      </CardContent>
    </Card>
  );
}
