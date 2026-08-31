'use client';

import React, { useEffect, useState } from 'react';
import { CustomRuleForm } from '@/components/rules/custom-rule-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Trash2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

interface Rule {
  id: string;
  name: string;
  description: string;
  regexPattern: string;
  isActive: boolean;
}

export default function RulesDashboardPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRules = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/rules/custom');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setRules(data.rules || []);
    } catch (error) {
      toast.error('Failed to load custom rules');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  return (
    <div className="container mx-auto py-8 px-4 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
            Custom Regex Rules
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            Define, test, and manage project-specific secret detection patterns.
          </p>
        </div>
        <Button onClick={fetchRules} variant="outline" disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <CustomRuleForm />

      <Card className="bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
        <CardHeader>
          <CardTitle className="text-xl">Active Rules</CardTitle>
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">No custom rules defined yet.</p>
          ) : (
            <div className="space-y-4">
              {rules.map((rule) => (
                <div key={rule.id} className="flex items-start justify-between p-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900 dark:text-gray-100">{rule.name}</h3>
                      <Badge variant={rule.isActive ? 'default' : 'secondary'}>
                        {rule.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">{rule.description}</p>
                    <code className="text-xs bg-gray-200 dark:bg-gray-800 px-2 py-1 rounded text-purple-600 dark:text-purple-400 font-mono">
                      {rule.regexPattern}
                    </code>
                  </div>
                  <Button variant="ghost" size="icon" className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
