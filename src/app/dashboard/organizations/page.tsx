'use client';

import React, { useEffect, useState } from 'react';
import { OrgPolicyTree } from '@/components/policies/org-policy-tree';
import { AddOrgPolicyModal } from '@/components/policies/add-org-policy-modal';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Building2, Plus, RefreshCw, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Organization {
  id: string;
  name: string;
  githubOrgId: string;
}

interface Policy {
  id: string;
  name: string;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  isEnabled: boolean;
  source: 'ORGANIZATION' | 'DEFAULT' | 'REPOSITORY';
}

export default function OrganizationsPage() {
  // State for Organizations
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);

  // State for Policies
  const [policies, setPolicies] = useState<Policy[]>([]);

  // State for Repository Inheritance View
  const [repoId, setRepoId] = useState('');
  const [effectivePolicies, setEffectivePolicies] = useState<Policy[]>([]);

  // UI State
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'org' | 'repo'>('org');

  // 1. Fetch Organizations
  useEffect(() => {
    async function fetchOrgs() {
      try {
        // Assuming an API endpoint /api/organizations exists or we mock data for now
        // In a real scenario, this would fetch the user's installed organizations
        const res = await fetch('/api/organizations');
        if (res.ok) {
          const data = await res.json();
          setOrgs(data.organizations || []);
          if (data.organizations?.length > 0) {
             setSelectedOrg(data.organizations[0]);
          }
        } else {
           // Mock fallback if API doesn't exist yet
           setOrgs([
             { id: 'org_demo_1', name: 'Demo Corp', githubOrgId: 'gh_demo_1' },
             { id: 'org_demo_2', name: 'SecureFlow Labs', githubOrgId: 'gh_demo_2' }
           ]);
           setSelectedOrg({ id: 'org_demo_1', name: 'Demo Corp', githubOrgId: 'gh_demo_1' });
        }
      } catch (err) {
        console.error('Failed to fetch orgs', err);
      } finally {
        setLoading(false);
      }
    }
    fetchOrgs();
  }, []);

  // 2. Fetch Policies when Org changes
  useEffect(() => {
    if (!selectedOrg || viewMode !== 'org') return;

    async function fetchPolicies() {
      setLoading(true);
      try {
        const res = await fetch(`/api/policies/organization?orgId=${selectedOrg?.id}`);
        if (res.ok) {
           const data = await res.json();
           // Map DB fields to UI fields
           const mapped = (data.policies || []).map((p: any) => ({
             ...p,
             source: 'ORGANIZATION'
           }));
           setPolicies(mapped);
        }
      } catch (err) {
        console.error('Failed to fetch policies');
      } finally {
        setLoading(false);
      }
    }
    fetchPolicies();
  }, [selectedOrg, viewMode]);

  // 3. Fetch Effective Policies when Repo ID is entered
  const handleResolvePolicies = async () => {
    if (!repoId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/policies/organization?repoId=${repoId}&orgId=${selectedOrg?.id}`);
      if (res.ok) {
         const data = await res.json();
         setEffectivePolicies(data.policies || []);
         setViewMode('repo');
      }
    } catch (err) {
      console.error('Failed to resolve');
    } finally {
      setLoading(false);
    }
  };

  if (loading && orgs.length === 0) {
    return <div className="p-8">Loading organizations...</div>;
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] bg-gray-50 dark:bg-gray-950">
      {/* Sidebar: Organization List */}
      <div className="w-64 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 flex flex-col">
        <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-gray-900 dark:text-gray-100">
          <Building2 className="w-5 h-5" /> Organizations
        </h2>
        <ScrollArea className="flex-1">
          <div className="space-y-1">
            {orgs.map((org) => (
              <Button
                key={org.id}
                variant={selectedOrg?.id === org.id ? 'secondary' : 'ghost'}
                className={cn(
                  "w-full justify-start h-auto py-2 px-3",
                  selectedOrg?.id === org.id && "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                )}
                onClick={() => {
                  setSelectedOrg(org);
                  setViewMode('org');
                }}
              >
                <span className="truncate">{org.name}</span>
              </Button>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 p-8 overflow-auto">
        <div className="max-w-5xl mx-auto space-y-8">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
                {selectedOrg?.name || 'Select Organization'}
              </h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1">
                Manage security policies and inheritance rules.
              </p>
            </div>

            <div className="flex gap-2">
               <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                 <RefreshCw className="w-4 h-4 mr-2" /> Refresh
               </Button>

               {selectedOrg && viewMode === 'org' && (
                 <AddOrgPolicyModal
                   orgId={selectedOrg.id}
                   onSuccess={() => {
                      // Trigger refresh of policies
                      const res = fetch(`/api/policies/organization?orgId=${selectedOrg.id}`).then(r => r.json()).then(d => {
                         setPolicies(d.policies?.map((p: any) => ({...p, source: 'ORGANIZATION'})) || []);
                      });
                   }}
                   trigger={
                     <Button size="sm">
                       <Plus className="w-4 h-4 mr-2" /> Add Policy
                     </Button>
                   }
                 />
               )}
            </div>
          </div>

          {/* Organization View */}
          {viewMode === 'org' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Organization Policies</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {loading ? (
                       <div className="space-y-4">
                          <Skeleton className="h-20 w-full" />
                          <Skeleton className="h-20 w-full" />
                       </div>
                    ) : (
                       <OrgPolicyTree policies={policies} />
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="lg:col-span-1">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <GitBranch className="w-5 h-5" /> Test Inheritance
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Enter a Repository ID to visualize how policies from this organization cascade down.
                    </p>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Repository ID</label>
                      <Input
                        value={repoId}
                        onChange={(e) => setRepoId(e.target.value)}
                        placeholder="repo_xyz..."
                      />
                    </div>
                    <Button
                      className="w-full"
                      onClick={handleResolvePolicies}
                      disabled={!repoId || loading}
                    >
                      View Effective Policies
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* Repository View (Result of Test) */}
          {viewMode === 'repo' && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Effective Policies for Repo: {repoId}</CardTitle>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Showing merged of Org defaults and Repo overrides.
                  </p>
                </div>
                <Button variant="outline" onClick={() => setViewMode('org')}>
                  Back to Org View
                </Button>
              </CardHeader>
              <CardContent>
                {loading ? (
                   <Skeleton className="h-40 w-full" />
                ) : (
                   <OrgPolicyTree policies={effectivePolicies} />
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
