"use client";

import React, { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Shield,
  Lock,
  Unlock,
  Save,
  Sliders,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import { updateInstallationSettings } from "@/lib/actions/installation-settings";
import type { InstallationSettingsDto } from "@/lib/scanner/installation-settings";

interface InstallationSettingsClientProps {
  initialSettings: InstallationSettingsDto;
}

const GATE_LEVELS = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"] as const;
const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;

export default function InstallationSettingsClient({
  initialSettings,
}: InstallationSettingsClientProps) {
  const [settings, setSettings] = useState<InstallationSettingsDto>(initialSettings);
  const [skipAuthorsInput, setSkipAuthorsInput] = useState<string>(
    (initialSettings.skipAuthors || []).join(", "),
  );
  const [isPending, startTransition] = useTransition();

  const isLocked = (key: string) => (settings.lockedSettings || []).includes(key);

  const toggleLock = (key: string) => {
    const currentLocked = settings.lockedSettings || [];
    const updated = currentLocked.includes(key)
      ? currentLocked.filter((k) => k !== key)
      : [...currentLocked, key];
    setSettings((prev) => ({ ...prev, lockedSettings: updated }));
  };

  const handleSave = () => {
    startTransition(async () => {
      try {
        const authorsList = skipAuthorsInput
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const res = await updateInstallationSettings(settings.installationId || "default", {
          ...settings,
          skipAuthors: authorsList,
        });

        if (res.ok) {
          toast.success("Installation default settings updated and audited successfully.");
          if (res.settings) {
            setSettings(res.settings);
            setSkipAuthorsInput((res.settings.skipAuthors || []).join(", "));
          }
        } else {
          toast.error(res.error || "Failed to update settings.");
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to update settings.");
      }
    });
  };

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <span className="text-sm font-medium uppercase tracking-widest text-primary">
          Governance &amp; Baseline Controls
        </span>
        <h1 className="mt-1 font-headline text-3xl font-bold tracking-tight">
          Installation Baseline Settings
        </h1>
        <p className="mt-2 text-muted-foreground text-sm">
          Configure default gate severity, confidence thresholds, and skip rules inherited by all
          repositories in this installation. Lock specific settings to prevent repositories from
          weakening organizational security policies in their <code>.secureflow.json</code>.
        </p>
      </div>

      <div className="grid gap-6">
        {/* Gate Block Threshold */}
        <Card className="glass-card">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base font-semibold">
                    Gate Blocking Threshold (blockOn)
                  </CardTitle>
                  {isLocked("gateBlockOn") ? (
                    <Badge
                      variant="outline"
                      className="border-red-500/30 text-red-400 bg-red-500/10 gap-1 text-[10px]"
                    >
                      <Lock className="w-3 h-3" /> Locked
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-white/20 text-muted-foreground gap-1 text-[10px]"
                    >
                      <Unlock className="w-3 h-3" /> Overridable
                    </Badge>
                  )}
                </div>
                <CardDescription className="text-xs">
                  Minimum finding severity that causes a pull request scan check to BLOCK merge.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs font-mono"
                onClick={() => toggleLock("gateBlockOn")}
              >
                {isLocked("gateBlockOn") ? (
                  <Unlock className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                {isLocked("gateBlockOn") ? "Unlock" : "Lock Baseline"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={!settings.gateBlockOn ? "secondary" : "outline"}
                className="text-xs font-mono"
                onClick={() => setSettings((p) => ({ ...p, gateBlockOn: null }))}
              >
                Built-in Default (CRITICAL)
              </Button>
              {GATE_LEVELS.map((level) => (
                <Button
                  key={level}
                  size="sm"
                  variant={settings.gateBlockOn === level ? "default" : "outline"}
                  className="text-xs font-mono"
                  onClick={() => setSettings((p) => ({ ...p, gateBlockOn: level }))}
                >
                  {level}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Gate Review Threshold */}
        <Card className="glass-card">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base font-semibold">
                    Gate Review Threshold (reviewOn)
                  </CardTitle>
                  {isLocked("gateReviewOn") ? (
                    <Badge
                      variant="outline"
                      className="border-red-500/30 text-red-400 bg-red-500/10 gap-1 text-[10px]"
                    >
                      <Lock className="w-3 h-3" /> Locked
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-white/20 text-muted-foreground gap-1 text-[10px]"
                    >
                      <Unlock className="w-3 h-3" /> Overridable
                    </Badge>
                  )}
                </div>
                <CardDescription className="text-xs">
                  Minimum finding severity that requests security review on a PR.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs font-mono"
                onClick={() => toggleLock("gateReviewOn")}
              >
                {isLocked("gateReviewOn") ? (
                  <Unlock className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                {isLocked("gateReviewOn") ? "Unlock" : "Lock Baseline"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={!settings.gateReviewOn ? "secondary" : "outline"}
                className="text-xs font-mono"
                onClick={() => setSettings((p) => ({ ...p, gateReviewOn: null }))}
              >
                Built-in Default (MEDIUM)
              </Button>
              {GATE_LEVELS.map((level) => (
                <Button
                  key={level}
                  size="sm"
                  variant={settings.gateReviewOn === level ? "default" : "outline"}
                  className="text-xs font-mono"
                  onClick={() => setSettings((p) => ({ ...p, gateReviewOn: level }))}
                >
                  {level}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Confidence Threshold */}
        <Card className="glass-card">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base font-semibold">
                    Minimum Confidence Threshold
                  </CardTitle>
                  {isLocked("minCommentConfidence") ? (
                    <Badge
                      variant="outline"
                      className="border-red-500/30 text-red-400 bg-red-500/10 gap-1 text-[10px]"
                    >
                      <Lock className="w-3 h-3" /> Locked
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-white/20 text-muted-foreground gap-1 text-[10px]"
                    >
                      <Unlock className="w-3 h-3" /> Overridable
                    </Badge>
                  )}
                </div>
                <CardDescription className="text-xs">
                  Findings with confidence below this threshold are filtered out of PR comments.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs font-mono"
                onClick={() => toggleLock("minCommentConfidence")}
              >
                {isLocked("minCommentConfidence") ? (
                  <Unlock className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                {isLocked("minCommentConfidence") ? "Unlock" : "Lock Baseline"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={!settings.minCommentConfidence ? "secondary" : "outline"}
                className="text-xs font-mono"
                onClick={() => setSettings((p) => ({ ...p, minCommentConfidence: null }))}
              >
                Built-in Default (MEDIUM)
              </Button>
              {CONFIDENCE_LEVELS.map((level) => (
                <Button
                  key={level}
                  size="sm"
                  variant={settings.minCommentConfidence === level ? "default" : "outline"}
                  className="text-xs font-mono"
                  onClick={() => setSettings((p) => ({ ...p, minCommentConfidence: level }))}
                >
                  {level}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Built-in Ignore Defaults */}
        <Card className="glass-card">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base font-semibold">
                    Default Ignore Patterns (includeDefaults)
                  </CardTitle>
                  {isLocked("includeDefaults") ? (
                    <Badge
                      variant="outline"
                      className="border-red-500/30 text-red-400 bg-red-500/10 gap-1 text-[10px]"
                    >
                      <Lock className="w-3 h-3" /> Locked
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-white/20 text-muted-foreground gap-1 text-[10px]"
                    >
                      <Unlock className="w-3 h-3" /> Overridable
                    </Badge>
                  )}
                </div>
                <CardDescription className="text-xs">
                  Automatically ignore compiled binaries, minified bundles, lockfiles, and
                  documentation.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs font-mono"
                onClick={() => toggleLock("includeDefaults")}
              >
                {isLocked("includeDefaults") ? (
                  <Unlock className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                {isLocked("includeDefaults") ? "Unlock" : "Lock Baseline"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-2 flex items-center justify-between">
            <span className="text-sm font-medium">Enable Default Ignore Patterns</span>
            <Switch
              checked={settings.includeDefaults ?? true}
              onCheckedChange={(checked) =>
                setSettings((p) => ({ ...p, includeDefaults: checked }))
              }
              aria-label="Toggle includeDefaults"
            />
          </CardContent>
        </Card>

        {/* Skip Draft PRs */}
        <Card className="glass-card">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base font-semibold">
                    Skip Draft Pull Requests (skipDrafts)
                  </CardTitle>
                  {isLocked("skipDrafts") ? (
                    <Badge
                      variant="outline"
                      className="border-red-500/30 text-red-400 bg-red-500/10 gap-1 text-[10px]"
                    >
                      <Lock className="w-3 h-3" /> Locked
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-white/20 text-muted-foreground gap-1 text-[10px]"
                    >
                      <Unlock className="w-3 h-3" /> Overridable
                    </Badge>
                  )}
                </div>
                <CardDescription className="text-xs">
                  Automatically skip scanning PRs marked as Draft to save inference budget.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs font-mono"
                onClick={() => toggleLock("skipDrafts")}
              >
                {isLocked("skipDrafts") ? (
                  <Unlock className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                {isLocked("skipDrafts") ? "Unlock" : "Lock Baseline"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-2 flex items-center justify-between">
            <span className="text-sm font-medium">Skip Draft PR Scans</span>
            <Switch
              checked={settings.skipDrafts ?? false}
              onCheckedChange={(checked) => setSettings((p) => ({ ...p, skipDrafts: checked }))}
              aria-label="Toggle skipDrafts"
            />
          </CardContent>
        </Card>

        {/* Skip Authors */}
        <Card className="glass-card">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base font-semibold">
                    Skip Authors Baseline (skipAuthors)
                  </CardTitle>
                  {isLocked("skipAuthors") ? (
                    <Badge
                      variant="outline"
                      className="border-red-500/30 text-red-400 bg-red-500/10 gap-1 text-[10px]"
                    >
                      <Lock className="w-3 h-3" /> Locked
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-white/20 text-muted-foreground gap-1 text-[10px]"
                    >
                      <Unlock className="w-3 h-3" /> Overridable
                    </Badge>
                  )}
                </div>
                <CardDescription className="text-xs">
                  Comma-separated list of usernames or bot patterns (e.g.{" "}
                  <code>dependabot[bot], *bot*</code>) to bypass.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs font-mono"
                onClick={() => toggleLock("skipAuthors")}
              >
                {isLocked("skipAuthors") ? (
                  <Unlock className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                {isLocked("skipAuthors") ? "Unlock" : "Lock Baseline"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-2 space-y-2">
            <Input
              value={skipAuthorsInput}
              onChange={(e) => setSkipAuthorsInput(e.target.value)}
              placeholder="e.g. dependabot[bot], renovate[bot], *bot*"
              className="font-mono text-xs"
            />
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
        <Button onClick={handleSave} disabled={isPending} className="gap-2">
          <Save className="w-4 h-4" />
          {isPending ? "Saving..." : "Save Baseline Settings"}
        </Button>
      </div>
    </div>
  );
}
