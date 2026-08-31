'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TourOverlay } from '@/components/onboarding/tour-overlay';
import { Button } from '@/components/ui/button';
import { Shield, AlertTriangle, GitBranch, TrendingUp } from 'lucide-react';

interface OnboardingProgress {
  currentStep: number;
  isCompleted: boolean;
  lastViewedStep: string;
}

export default function DashboardPage() {
  const [showTour, setShowTour] = useState(false);
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingProgress | null>(null);
  const [stats, setStats] = useState({
    totalPRs: 0,
    criticalFindings: 0,
    reposScanned: 0,
    armorScore: 85
  });

  useEffect(() => {
    async function checkOnboardingStatus() {
      try {
        const res = await fetch('/api/onboarding/progress');
        if (res.ok) {
          const data = await res.json();
          setOnboardingProgress(data.progress);
          
          // Show tour if not completed or if first visit
          if (!data.progress?.isCompleted) {
            setShowTour(true);
          }
        }
      } catch (error) {
        console.error('Failed to check onboarding status', error);
      }
    }
    checkOnboardingStatus();
  }, []);

  const handleTourComplete = async () => {
    setShowTour(false);
    try {
      await fetch('/api/onboarding/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentStep: 4,
          lastViewedStep: 'armor-score',
          isCompleted: true
        })
      });
    } catch (error) {
      console.error('Failed to save onboarding progress', error);
    }
  };

  const handleStepUpdate = async (stepIndex: number, stepId: string) => {
    try {
      await fetch('/api/onboarding/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentStep: stepIndex,
          lastViewedStep: stepId,
          isCompleted: false
        })
      });
    } catch (error) {
      console.error('Failed to update step', error);
    }
  };

  const restartTour = () => {
    setShowTour(true);
  };

  return (
    <div className="container mx-auto py-8 px-4 space-y-8">
      {/* Tour Overlay Component - Now Integrated */}
      <TourOverlay 
        isActive={showTour} 
        onComplete={handleTourComplete}
        onStepUpdate={handleStepUpdate}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 
            className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100"
            data-tour-id="tour-dashboard-overview"
          >
            Mission Control
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            Welcome back, {onboardingProgress ? 'Agent' : 'Operator'}. Here's your security overview.
          </p>
        </div>
        {!onboardingProgress?.isCompleted && (
          <Button onClick={restartTour} variant="outline" size="sm">
            Restart Tutorial
          </Button>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-400">
              Total PRs Scanned
            </CardTitle>
            <GitBranch className="h-4 w-4 text-gray-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.totalPRs}</div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">This month</p>
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-400">
              Critical Findings
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600 dark:text-red-400">{stats.criticalFindings}</div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Requires immediate attention</p>
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-400">
              Repositories
            </CardTitle>
            <Shield className="h-4 w-4 text-gray-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.reposScanned}</div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Under protection</p>
          </CardContent>
        </Card>

        <Card 
          className="bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800"
          data-tour-id="tour-armor-iq-score"
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-gray-600 dark:text-gray-400">
              ArmorIQ Score
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">{stats.armorScore}</div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Security health rating</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Sections */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4 bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
          <CardHeader>
            <CardTitle>Recent Breach Attempts</CardTitle>
          </CardHeader>
          <CardContent>
            <div 
              className="text-sm text-gray-500 dark:text-gray-400"
              data-tour-id="tour-findings-list"
            >
              Loading recent findings...
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-3 bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
          <CardHeader>
            <CardTitle 
              data-tour-id="tour-policies-engine"
            >
              Active Policies
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Loading policy status...
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
