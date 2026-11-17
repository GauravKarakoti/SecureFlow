"use client";

import React, { useState, useTransition, useSyncExternalStore } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  CheckCircle2,
  Circle,
  ExternalLink,
  ArrowRight,
  RefreshCw,
  Send,
  X,
  Sparkles,
  AlertCircle,
} from "lucide-react";
import { sendTestWebhookEvent, type OnboardingStatus } from "@/lib/actions/onboarding";

export const ONBOARDING_DISMISS_KEY = "secureflow:onboarding:dismissed";

const emptySubscribe = () => () => {};

function subscribeToStorage(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getDismissedSnapshot(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_DISMISS_KEY) === "true";
  } catch {
    return false;
  }
}

function getServerDismissedSnapshot(): boolean {
  return false;
}

export interface OnboardingChecklistProps {
  status: OnboardingStatus;
  githubAppUrl?: string;
  onSyncRepositories?: () => Promise<void>;
  isSyncing?: boolean;
  className?: string;
}

export default function OnboardingChecklist({
  status,
  githubAppUrl = "/setup",
  onSyncRepositories,
  isSyncing = false,
  className = "",
}: OnboardingChecklistProps) {
  const isMounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const [dismissedLocally, setDismissedLocally] = useState<boolean>(false);

  const isStoredDismissed = useSyncExternalStore(
    subscribeToStorage,
    getDismissedSnapshot,
    getServerDismissedSnapshot,
  );

  const isDismissed = dismissedLocally || isStoredDismissed;

  const [localWebhookReceived, setLocalWebhookReceived] = useState<boolean>(status.webhookReceived);
  const [isSendingTest, startSendTestTransition] = useTransition();
  const [testResult, setTestResult] = useState<{
    success?: boolean;
    message?: string;
    error?: string;
  } | null>(null);

  const handleDismiss = () => {
    setDismissedLocally(true);
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(ONBOARDING_DISMISS_KEY, "true");
      }
    } catch {
      // Ignore localStorage access issues
    }
    toast.info("Onboarding checklist dismissed.");
  };

  const handleSendTest = () => {
    setTestResult(null);
    startSendTestTransition(async () => {
      try {
        const result = await sendTestWebhookEvent();
        if (result.success) {
          setLocalWebhookReceived(true);
          setTestResult({
            success: true,
            message:
              result.message ||
              "Webhook delivery received and HMAC signature verified successfully!",
          });
          toast.success("Webhook test delivery verified successfully!");
        } else {
          setTestResult({
            success: false,
            error: result.error || "Failed to verify webhook delivery.",
          });
          toast.error(result.error || "Webhook test delivery failed.");
        }
      } catch (err: unknown) {
        const errMsg =
          err instanceof Error ? err.message : "Failed to dispatch test webhook event.";
        setTestResult({
          success: false,
          error: errMsg,
        });
        toast.error(errMsg);
      }
    });
  };

  // Check items state
  const isAppInstalled = status.appInstalled;
  const isRepoConnected = status.repoConnected;
  const isWebhookReceived = localWebhookReceived;
  const isPolicyEnabled = status.policyEnabled;
  const isFirstScanCompleted = status.firstScanCompleted;

  const allStepsComplete =
    isAppInstalled &&
    isRepoConnected &&
    isWebhookReceived &&
    isPolicyEnabled &&
    isFirstScanCompleted;

  // Hide automatically when every step is complete, or when dismissed
  if (allStepsComplete || (isMounted && isDismissed)) {
    return null;
  }

  const checklistItems = [
    {
      id: "app-installed",
      title: "GitHub App installed",
      description:
        "Install the SecureFlow GitHub App on your personal account or organization to enable scanning.",
      isComplete: isAppInstalled,
      fixHref: githubAppUrl,
      fixLabel: "Install App",
      action: !isAppInstalled ? (
        <Link href={githubAppUrl}>
          <Button
            size="sm"
            variant="default"
            className="text-xs font-bold uppercase h-8 gap-1.5 cursor-pointer"
          >
            Install App
            <ExternalLink className="w-3.5 h-3.5" />
          </Button>
        </Link>
      ) : null,
    },
    {
      id: "repo-connected",
      title: "At least one repository connected",
      description:
        "Grant repository access and sync repositories so SecureFlow can audit pull requests.",
      isComplete: isRepoConnected,
      fixHref: githubAppUrl,
      fixLabel: "Repository settings",
      action: !isRepoConnected ? (
        onSyncRepositories ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onSyncRepositories}
            disabled={isSyncing}
            className="text-xs font-bold uppercase h-8 gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`} />
            {isSyncing ? "Syncing..." : "Sync Repositories"}
          </Button>
        ) : (
          <Link href={githubAppUrl}>
            <Button
              size="sm"
              variant="outline"
              className="text-xs font-bold uppercase h-8 gap-1.5 cursor-pointer"
            >
              Select Repositories
              <ExternalLink className="w-3.5 h-3.5" />
            </Button>
          </Link>
        )
      ) : null,
    },
    {
      id: "webhook-received",
      title: "Webhook delivery received",
      description:
        "Confirm GitHub webhooks are reaching your SecureFlow deployment and HMAC signatures match.",
      isComplete: isWebhookReceived,
      fixHref: "/docs/runbook.md#1-webhook-deliveries-failing",
      fixLabel: "Webhook runbook",
      action: (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={isWebhookReceived ? "ghost" : "outline"}
            onClick={handleSendTestEvent}
            disabled={isSendingTest}
            className="text-xs font-bold uppercase h-8 gap-1.5 cursor-pointer"
          >
            <Send className={`w-3.5 h-3.5 ${isSendingTest ? "animate-spin" : ""}`} />
            {isSendingTest ? "Testing..." : "Send Test Event"}
          </Button>
          {!isWebhookReceived && (
            <Link
              href="/docs/runbook.md#1-webhook-deliveries-failing"
              className="text-xs text-muted-foreground hover:text-white underline font-medium"
            >
              Docs
            </Link>
          )}
        </div>
      ),
    },
    {
      id: "policy-enabled",
      title: "At least one policy enabled",
      description:
        "Activate security guardrails (e.g. Block Critical Secrets, Require Review) for pull requests.",
      isComplete: isPolicyEnabled,
      fixHref: "/dashboard/policies",
      fixLabel: "Defense Strategy",
      action: !isPolicyEnabled ? (
        <Link href="/dashboard/policies">
          <Button
            size="sm"
            variant="outline"
            className="text-xs font-bold uppercase h-8 gap-1.5 cursor-pointer"
          >
            Configure Policies
            <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </Link>
      ) : null,
    },
    {
      id: "first-scan",
      title: "First scan completed",
      description:
        "Open or synchronize a pull request in any connected repository to run your first automated scan.",
      isComplete: isFirstScanCompleted,
      fixHref: "/dashboard/findings",
      fixLabel: "Findings",
      action: !isFirstScanCompleted ? (
        <Link href="/dashboard/findings">
          <Button
            size="sm"
            variant="outline"
            className="text-xs font-bold uppercase h-8 gap-1.5 cursor-pointer"
          >
            View Scans
            <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </Link>
      ) : null,
    },
  ];

  function handleSendTestEvent() {
    handleSendTest();
  }

  const completedCount = checklistItems.filter((i) => i.isComplete).length;
  const progressPercent = Math.round((completedCount / checklistItems.length) * 100);

  return (
    <Card
      className={`glass-card border-primary/30 bg-gradient-to-br from-primary/10 via-background to-background relative overflow-hidden ${className}`}
      data-testid="onboarding-checklist"
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-primary/20 text-primary text-[11px] font-bold font-mono tracking-wider uppercase">
                <Sparkles className="w-3 h-3" /> Quick Setup
              </span>
              <Badge variant="outline" className="text-xs font-mono">
                {completedCount} of {checklistItems.length} Complete
              </Badge>
            </div>
            <CardTitle className="text-xl font-headline font-bold">
              Get Started with SecureFlow
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Complete these steps to verify your GitHub integration, webhook pipeline, and security
              guardrails.
            </CardDescription>
          </div>

          <Button
            size="icon"
            variant="ghost"
            onClick={handleDismiss}
            aria-label="Dismiss checklist"
            className="h-8 w-8 text-muted-foreground hover:text-white"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Progress Bar */}
        <div className="pt-2">
          <Progress value={progressPercent} className="h-1.5 bg-primary/20" />
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-1">
        {/* Test event result banner */}
        {testResult && (
          <div
            className={`p-3 rounded-lg border text-xs flex items-start gap-2.5 transition-all ${
              testResult.success
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                : "bg-red-500/10 border-red-500/30 text-red-300"
            }`}
            data-testid="test-event-result"
          >
            {testResult.success ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
            )}
            <div className="space-y-1 flex-1">
              <p className="font-semibold">
                {testResult.success ? "Test Event Verified" : "Test Event Failed"}
              </p>
              <p className="text-[11px] leading-relaxed opacity-90">
                {testResult.message || testResult.error}
              </p>
            </div>
          </div>
        )}

        {/* Checklist rows */}
        <div className="divide-y divide-border/40">
          {checklistItems.map((item) => (
            <div
              key={item.id}
              className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              data-testid={`checklist-item-${item.id}`}
            >
              <div className="flex items-start gap-3 min-w-0">
                <div className="mt-0.5 shrink-0">
                  {item.isComplete ? (
                    <CheckCircle2
                      className="w-5 h-5 text-emerald-400"
                      aria-label={`${item.title} completed`}
                    />
                  ) : (
                    <Circle
                      className="w-5 h-5 text-muted-foreground"
                      aria-label={`${item.title} pending`}
                    />
                  )}
                </div>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <p
                      className={`text-sm font-semibold ${
                        item.isComplete ? "text-foreground line-through opacity-75" : "text-white"
                      }`}
                    >
                      {item.title}
                    </p>
                    {item.isComplete ? (
                      <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wide">
                        ✓ Done
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wide">
                        Pending
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{item.description}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:self-center shrink-0">
                {item.action}
                {item.isComplete && (
                  <Link
                    href={item.fixHref}
                    className="text-xs text-muted-foreground hover:text-white underline font-medium"
                  >
                    View
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
