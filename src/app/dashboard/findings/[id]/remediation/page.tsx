'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { PatchDiffViewer } from '@/components/findings/patch-diff-viewer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

export default function RemediationPage() {
  const params = useParams();
  const findingId = params.id as string;

  const [loading, setLoading] = useState(false);
  const [patchData, setPatchData] = useState<{ patchDiff: string; explanation: string } | null>(null);

  const generatePatch = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/findings/${findingId}/remediate`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to generate patch');

      const data = await res.json();
      setPatchData({ patchDiff: data.patch.patchDiff, explanation: data.explanation });
      toast.success('Remediation patch generated successfully');
    } catch (error) {
      toast.error('Failed to generate remediation patch');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-6 h-6 text-orange-500" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">AI Remediation</h1>
      </div>

      {!patchData ? (
        <Card className="bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
          <CardContent className="py-12 text-center space-y-4">
            <p className="text-gray-600 dark:text-gray-400">
              Click the button below to let The Professor analyze the finding and generate a secure code patch.
            </p>
            <Button onClick={generatePatch} disabled={loading} size="lg">
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {loading ? 'Analyzing...' : 'Generate Remediation Patch'}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <PatchDiffViewer patchDiff={patchData.patchDiff} explanation={patchData.explanation} />
      )}
    </div>
  );
}

