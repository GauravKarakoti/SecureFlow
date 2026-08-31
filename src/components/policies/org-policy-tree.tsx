'use client';

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Shield, Building2, GitBranch, AlertTriangle } from 'lucide-react';

interface PolicyNode {
  name: string;
  isEnabled: boolean;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  source: 'DEFAULT' | 'ORGANIZATION' | 'REPOSITORY';
}

interface OrgPolicyTreeProps {
  policies: PolicyNode[];
}

const severityColors = {
  LOW: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  MEDIUM: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  HIGH: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  CRITICAL: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

const sourceIcons = {
  DEFAULT: <Shield className="w-4 h-4 text-gray-500" />,
  ORGANIZATION: <Building2 className="w-4 h-4 text-purple-500" />,
  REPOSITORY: <GitBranch className="w-4 h-4 text-green-500" />,
};

/**
 * OrgPolicyTree Component
 * Visualizes the hierarchical inheritance of security policies.
 * Supports both light and dark mode via Tailwind `dark:` classes.
 */
export function OrgPolicyTree({ policies }: OrgPolicyTreeProps) {
  if (policies.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-10 text-gray-500 dark:text-gray-400">
          <AlertTriangle className="w-10 h-10 mb-2" />
          <p>No policies configured for this scope.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {policies.map((policy, index) => (
        <Card 
          key={index} 
          className={`transition-all duration-200 hover:shadow-md ${
            !policy.isEnabled ? 'opacity-60 bg-gray-50 dark:bg-gray-900' : 'bg-white dark:bg-gray-950'
          }`}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {sourceIcons[policy.source]}
                <CardTitle className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {policy.name}
                </CardTitle>
              </div>
              <Badge className={severityColors[policy.severity]}>
                {policy.severity}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">
                Inherited from: <span className="font-medium text-gray-900 dark:text-gray-200">{policy.source}</span>
              </span>
              <span className={`font-medium ${policy.isEnabled ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {policy.isEnabled ? 'Enforced' : 'Disabled'}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
