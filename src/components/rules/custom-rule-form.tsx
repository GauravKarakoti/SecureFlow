'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { CheckCircle, XCircle, TestTube } from 'lucide-react';

/**
 * CustomRuleForm Component
 * Provides a UI to create and test custom regex rules against sample text.
 */
export function CustomRuleForm() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [regexPattern, setRegexPattern] = useState('');
  const [sampleText, setSampleText] = useState('');
  const [testResult, setTestResult] = useState<{ valid: boolean; matches: string[] } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleTest = () => {
    try {
      const regex = new RegExp(regexPattern, 'g');
      const matches = sampleText.match(regex) || [];
      setTestResult({ valid: true, matches });
    } catch (error) {
      setTestResult({ valid: false, matches: [] });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testResult?.valid) {
      toast.error('Please fix the regex pattern before saving.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/rules/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, regexPattern })
      });

      if (!res.ok) throw new Error('Failed to save rule');

      toast.success('Custom rule saved successfully!');
      setName(''); setDescription(''); setRegexPattern(''); setSampleText(''); setTestResult(null);
    } catch (error) {
      toast.error('Failed to save custom rule');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
      <CardHeader>
        <CardTitle className="text-xl text-gray-900 dark:text-gray-100">Create Custom Regex Rule</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Rule Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Internal API Key"
                required
                className="bg-gray-50 dark:bg-gray-900"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Regex Pattern</label>
              <Input
                value={regexPattern}
                onChange={(e) => {
                  setRegexPattern(e.target.value);
                  setTestResult(null);
                }}
                placeholder="e.g., API_KEY_[a-zA-Z0-9]{32}"
                required
                className="font-mono bg-gray-50 dark:bg-gray-900"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this rule detect?"
              className="bg-gray-50 dark:bg-gray-900"
            />
          </div>

          <div className="space-y-2 p-4 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-2">
              <TestTube className="w-4 h-4" /> Test Pattern
            </label>
            <Textarea
              value={sampleText}
              onChange={(e) => setSampleText(e.target.value)}
              placeholder="Paste sample code here to test the regex..."
              className="font-mono text-sm bg-white dark:bg-gray-950"
              rows={3}
            />
            <Button type="button" variant="outline" size="sm" onClick={handleTest}>
              Run Test
            </Button>

            {testResult && (
              <div className={`mt-2 text-sm flex items-center gap-2 ${testResult.valid ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {testResult.valid ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                {testResult.valid
                  ? `Valid. Found ${testResult.matches.length} match(es): ${testResult.matches.join(', ') || 'None'}`
                  : 'Invalid Regular Expression'}
              </div>
            )}
          </div>

          <Button type="submit" disabled={isSubmitting || !testResult?.valid} className="w-full md:w-auto">
            {isSubmitting ? 'Saving...' : 'Save Custom Rule'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default CustomRuleForm;
