'use client';

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SbomScanResult, VulnerabilityMatch } from '@/types/sbom';
import { AlertCircle, CheckCircle, Package, ShieldAlert } from 'lucide-react';

interface SbomReportCardProps {
  result: SbomScanResult;
}

const severityColors = {
  LOW: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  MEDIUM: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  HIGH: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  CRITICAL: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

const statusColors = {
  CLEAN: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-green-500',
  WARNING: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 border-yellow-500',
  VULNERABLE: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 border-red-500',
  ERROR: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200 border-gray-500',
};

/**
 * SbomReportCard Component
 * Displays the results of an SBOM dependency vulnerability scan.
 * Fully supports dark mode via Tailwind `dark:` classes.
 */
export function SbomReportCard({ result }: SbomReportCardProps) {
  const isClean = result.status === 'CLEAN';
  const borderColor = statusColors[result.status]?.split(' ').pop() || 'border-gray-500';
  const badgeClass = statusColors[result.status] || statusColors.ERROR;

  return (
    <Card className={`border-l-4 ${borderColor} bg-white dark:bg-gray-950`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold flex items-center gap-2 text-gray-900 dark:text-gray-100">
            <Package className="w-5 h-5 text-purple-500" />
            SBOM Dependency Scan
          </CardTitle>
          <Badge variant="outline" className={badgeClass}>
            {result.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm text-gray-600 dark:text-gray-400">
          Scanned <span className="font-semibold text-gray-900 dark:text-gray-200">{result.totalDependencies}</span> dependencies.
        </div>

        {!isClean && result.vulnerabilities.length > 0 && (
          <div className="space-y-3">
            {result.vulnerabilities.map((vuln, idx) => (
              <div key={idx} className="p-3 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
                <div className="flex items-start justify-between mb-1">
                  <span className="font-mono text-sm font-bold text-gray-900 dark:text-gray-100">
                    {vuln.dependency.name}@{vuln.dependency.version}
                  </span>
                  <Badge className={severityColors[vuln.severity]}>
                    {vuln.severity}
                  </Badge>
                </div>
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">{vuln.description}</p>
                <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <AlertCircle className="w-3 h-3" />
                  <span>CVE: {vuln.cveId}</span>
                  {vuln.patchedVersion && (
                    <>
                      <span>→</span>
                      <span className="text-green-600 dark:text-green-400 font-medium">
                        Patch: {vuln.patchedVersion}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {isClean && (
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
            <CheckCircle className="w-4 h-4" />
            <span>No known vulnerabilities detected in dependencies.</span>
          </div>
        )}

        {/* Handle case where status is WARNING/VULNERABLE but no specific vulns mapped yet */}
        {!isClean && result.vulnerabilities.length === 0 && (
           <div className="flex items-center gap-2 text-sm text-yellow-600 dark:text-yellow-400">
            <ShieldAlert className="w-4 h-4" />
            <span>Potential issues detected, but details are pending analysis.</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default SbomReportCard;
