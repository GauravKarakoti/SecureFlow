'use client';

import React, { useState, useEffect } from 'react';
import { OrgPolicyTree } from '@/components/policies/org-policy-tree';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Plus, RefreshCw } from 'lucide-react';

interface PolicyData {
  name: string;
  isEnabled: boolean;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  source: 'DEFAULT' | 'ORGANIZATION' | 'REPOSITORY';
}

export default function OrganizationsPage() {
  const [orgId, setOrgId] = useState('');
  const [repoId, setRepoId] = useState('');
  const [policies, setPolicies] = useState<PolicyData[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchPolicies = async () => {
    if (!orgId && !repoId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (orgId) params.append('orgId', orgId);
      if (repoId) params.append('repoId', repoId);

      const res = await fetch(`/api/policies/organization?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch policies');

      const data = await res.json();
      setPolicies(data.policies || []);
    } catch (error) {
      console.error(error);
      toast.error('Failed to load policies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPolicies();
  }, [orgId, repoId]);

  return (
    <div className="container mx-auto py-8 px-4 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
            Organization Policy Inheritance
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            Manage and visualize hierarchical security policies across your organization.
          </p>
        </div>
        <Button onClick={fetchPolicies} disabled={loading} variant="outline">
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Card className="bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
        <CardHeader>
          <CardTitle className="text-xl">Scope Configuration</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Organization ID</label>
            <Input
              placeholder="org_..."
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              className="bg-gray-50 dark:bg-gray-900 border-gray-300 dark:border-gray-700"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Repository ID (Optional Override)</label>
            <Input
              placeholder="repo_..."
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className="bg-gray-50 dark:bg-gray-900 border-gray-300 dark:border-gray-700"
            />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Effective Policy Tree</h2>
          <Button size="sm" variant="secondary">
            <Plus className="w-4 h-4 mr-2" />
            Add Org Policy
          </Button>
        </div>
        <OrgPolicyTree policies={policies} />
      </div>
    </div>
  );
}
