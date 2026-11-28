"use client";

import React, { useState, useEffect, useCallback, useId } from "react";
import Link from "next/link";
import {
  FolderGit2,
  Shield,
  Sliders,
  FileCode,
  Key,
  CheckCircle2,
  Copy,
  Check,
  RefreshCw,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  ExternalLink,
  RotateCcw,
  AlertTriangle,
  Info,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  generateWorkflowYaml,
  WORKFLOW_FILE_PATH,
  type WorkflowOptions,
} from "@/lib/repositories/workflow-generator";
import {
  checkRepositoryScanStatus,
  recordSimulatedScan,
  type ConnectableRepository,
  type RepositoryScanStatus,
} from "@/lib/actions/connect-repo";

export const WIZARD_STORAGE_KEY = "secureflow:connect-repo-wizard:state";

export interface WizardFormState {
  step: number;
  repository: string;
  severity: "low" | "medium" | "high" | "critical";
  failThreshold: "none" | "low" | "medium" | "high" | "critical";
  prComments: boolean;
  aiRemediation: boolean;
  paths: string;
  workflowBranch: string;
}

export const DEFAULT_WIZARD_STATE: WizardFormState = {
  step: 1,
  repository: "",
  severity: "low",
  failThreshold: "high",
  prComments: true,
  aiRemediation: false,
  paths: ".",
  workflowBranch: "main",
};

export interface ConnectRepositoryWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialRepositories?: ConnectableRepository[];
  defaultRepository?: string;
  onScanConfirmed?: (repoName: string) => void;
}

export function ConnectRepositoryWizard({
  open,
  onOpenChange,
  initialRepositories = [],
  defaultRepository = "",
  onScanConfirmed,
}: ConnectRepositoryWizardProps) {
  const [state, setState] = useState<WizardFormState>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem(WIZARD_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          return { ...DEFAULT_WIZARD_STATE, ...parsed };
        }
      } catch {
        // fallback to defaults
      }
    }
    return {
      ...DEFAULT_WIZARD_STATE,
      repository: defaultRepository || (initialRepositories[0]?.fullName ?? ""),
    };
  });

  const [copiedYaml, setCopiedYaml] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState<string | null>(null);

  const [isCheckingScan, setIsCheckingScan] = useState(false);
  const [scanStatus, setScanStatus] = useState<RepositoryScanStatus | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);

  const repoSelectId = useId();
  const repoInputId = useId();
  const severitySelectId = useId();
  const failSelectId = useId();
  const pathsInputId = useId();
  const branchInputId = useId();

  // Save state to localStorage whenever it changes
  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(state));
      }
    } catch {
      // Ignore storage write issues
    }
  }, [state]);

  // Set default repo if none selected and repos arrive
  useEffect(() => {
    if (!state.repository && initialRepositories.length > 0) {
      setState((prev) => ({
        ...prev,
        repository: initialRepositories[0].fullName,
      }));
    }
  }, [initialRepositories, state.repository]);

  const updateField = useCallback(
    <K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleReset = () => {
    const fresh = {
      ...DEFAULT_WIZARD_STATE,
      repository: initialRepositories[0]?.fullName ?? "",
    };
    setState(fresh);
    setScanStatus(null);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(WIZARD_STORAGE_KEY);
      }
    } catch {
      // Ignore storage cleanup issues
    }
  };

  const generatedYaml = React.useMemo(() => {
    const opts: WorkflowOptions = {
      repository: state.repository,
      severity: state.severity,
      failThreshold: state.failThreshold,
      prComments: state.prComments,
      aiRemediation: state.aiRemediation,
      paths: state.paths.trim() || ".",
      workflowBranch: state.workflowBranch.trim() || "main",
      uploadSarif: true,
    };
    return generateWorkflowYaml(opts);
  }, [state]);

  const handleCopyYaml = async () => {
    try {
      await navigator.clipboard.writeText(generatedYaml);
      setCopiedYaml(true);
      setTimeout(() => setCopiedYaml(false), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(WORKFLOW_FILE_PATH);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const handleCopySecret = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      setCopiedSecret(name);
      setTimeout(() => setCopiedSecret(null), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const handleCheckScan = async () => {
    if (!state.repository) return;
    setIsCheckingScan(true);
    try {
      const res = await checkRepositoryScanStatus(state.repository);
      setScanStatus(res);
      if (res.hasScan) {
        onScanConfirmed?.(state.repository);
      }
    } catch {
      setScanStatus({ hasScan: false });
    } finally {
      setIsCheckingScan(false);
    }
  };

  const handleSimulateScan = async () => {
    if (!state.repository) return;
    setIsSimulating(true);
    try {
      await recordSimulatedScan(state.repository);
      const res = await checkRepositoryScanStatus(state.repository);
      setScanStatus(res);
      if (res.hasScan) {
        onScanConfirmed?.(state.repository);
      }
    } catch {
      // simulate failed
    } finally {
      setIsSimulating(false);
    }
  };

  // Steps definitions
  const steps = [
    { num: 1, title: "Repository", icon: FolderGit2 },
    { num: 2, title: "Scan Options", icon: Sliders },
    { num: 3, title: "Workflow File", icon: FileCode },
    { num: 4, title: "Secrets", icon: Key },
    { num: 5, title: "Confirm Scan", icon: CheckCircle2 },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto bg-zinc-950 border-zinc-800 text-zinc-100 p-6 sm:p-8"
        aria-describedby="connect-wizard-desc"
        data-testid="connect-repo-wizard"
      >
        <DialogHeader className="space-y-1">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-xl font-bold font-headline uppercase tracking-wider text-foreground flex items-center gap-2">
              <FolderGit2 className="w-5 h-5 text-primary" />
              Connect Repository Wizard
            </DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="text-xs font-mono text-zinc-400 hover:text-foreground gap-1.5 h-8 px-2"
              title="Reset wizard options to defaults"
              data-testid="reset-wizard-btn"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </Button>
          </div>
          <DialogDescription id="connect-wizard-desc" className="text-xs font-mono text-muted-foreground">
            Configure automated security analysis, generate workflow YAML, and verify scan arrival in 5 steps.
          </DialogDescription>
        </DialogHeader>

        {/* ─── Step Stepper Indicator ─────────────────────────────────────── */}
        <div className="py-2 border-b border-zinc-800" role="tablist" aria-label="Wizard Steps">
          <div className="flex items-center justify-between gap-1 overflow-x-auto pb-1">
            {steps.map((st) => {
              const Icon = st.icon;
              const isActive = state.step === st.num;
              const isDone = state.step > st.num;
              return (
                <button
                  key={st.num}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`step-${st.num}-panel`}
                  onClick={() => updateField("step", st.num)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-mono transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    isActive
                      ? "bg-primary text-primary-foreground font-bold"
                      : isDone
                        ? "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                        : "text-zinc-500 hover:text-zinc-400"
                  }`}
                  data-testid={`step-tab-${st.num}`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden sm:inline">{st.title}</span>
                  <span className="sm:hidden">{st.num}</span>
                  {isDone && <Check className="w-3 h-3 text-emerald-400 shrink-0 ml-0.5" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* ─── Step Content ────────────────────────────────────────────────── */}
        <div className="min-h-[280px] py-2">
          {/* STEP 1: Repository Selection */}
          {state.step === 1 && (
            <div className="space-y-4 animate-in fade-in-50 duration-200" id="step-1-panel">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-zinc-200 font-headline uppercase tracking-wider">
                  Step 1: Choose Repository
                </h3>
                <p className="text-xs text-muted-foreground font-mono">
                  Select an existing repository from your account or enter a new repository name.
                </p>
              </div>

              {initialRepositories.length > 0 && (
                <div className="space-y-2">
                  <label htmlFor={repoSelectId} className="text-xs font-mono font-medium text-zinc-300 block">
                    Synced Repositories
                  </label>
                  <select
                    id={repoSelectId}
                    value={state.repository}
                    onChange={(e) => updateField("repository", e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 text-foreground rounded-md px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    data-testid="repo-select"
                  >
                    <option value="" disabled>
                      -- Select a repository --
                    </option>
                    {initialRepositories.map((repo) => (
                      <option key={repo.id} value={repo.fullName}>
                        {repo.fullName} {repo.hasScans ? "(Scanned)" : "(New)"}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor={repoInputId} className="text-xs font-mono font-medium text-zinc-300 block">
                  Or enter repository name (e.g. <code className="text-primary font-mono">owner/repo</code>)
                </label>
                <Input
                  id={repoInputId}
                  placeholder="e.g. acme-corp/api-service"
                  value={state.repository}
                  onChange={(e) => updateField("repository", e.target.value)}
                  className="bg-zinc-900 border-zinc-800 text-sm font-mono"
                  data-testid="repo-input"
                />
              </div>

              {state.repository && (
                <div className="p-3 rounded-md bg-zinc-900/60 border border-zinc-800 flex items-center justify-between text-xs font-mono">
                  <span className="text-zinc-400">Target Repository:</span>
                  <span className="font-bold text-primary">{state.repository}</span>
                </div>
              )}
            </div>
          )}

          {/* STEP 2: Scan Options */}
          {state.step === 2 && (
            <div className="space-y-5 animate-in fade-in-50 duration-200" id="step-2-panel">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-zinc-200 font-headline uppercase tracking-wider">
                  Step 2: Scan & Policy Options
                </h3>
                <p className="text-xs text-muted-foreground font-mono">
                  Fine-tune finding reporting, CI build gate thresholds, and automated review capabilities.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Reporting Severity */}
                <div className="space-y-1.5">
                  <label htmlFor={severitySelectId} className="text-xs font-mono font-medium text-zinc-300 block">
                    Minimum Reporting Severity
                  </label>
                  <select
                    id={severitySelectId}
                    value={state.severity}
                    onChange={(e) => updateField("severity", e.target.value as WizardFormState["severity"])}
                    className="w-full bg-zinc-900 border border-zinc-800 text-foreground rounded-md px-3 py-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    data-testid="severity-select"
                  >
                    <option value="low">Low (Report all findings)</option>
                    <option value="medium">Medium (Report medium, high, critical)</option>
                    <option value="high">High (Report high and critical only)</option>
                    <option value="critical">Critical (Report critical only)</option>
                  </select>
                </div>

                {/* Fail Threshold */}
                <div className="space-y-1.5">
                  <label htmlFor={failSelectId} className="text-xs font-mono font-medium text-zinc-300 block">
                    Fail CI Build Threshold
                  </label>
                  <select
                    id={failSelectId}
                    value={state.failThreshold}
                    onChange={(e) => updateField("failThreshold", e.target.value as WizardFormState["failThreshold"])}
                    className="w-full bg-zinc-900 border border-zinc-800 text-foreground rounded-md px-3 py-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    data-testid="fail-threshold-select"
                  >
                    <option value="critical">Critical (Fail only on critical)</option>
                    <option value="high">High (Fail on high or critical - Recommended)</option>
                    <option value="medium">Medium (Fail on medium, high, or critical)</option>
                    <option value="low">Low (Fail on any finding)</option>
                    <option value="none">None (Never fail CI build)</option>
                  </select>
                </div>
              </div>

              {/* Toggles */}
              <div className="space-y-3 pt-2 border-t border-zinc-800/80">
                {/* PR Comments */}
                <div className="flex items-center justify-between p-3 rounded-md bg-zinc-900/40 border border-zinc-800/80">
                  <div className="space-y-0.5 pr-4">
                    <label
                      htmlFor="pr-comments-toggle"
                      className="text-xs font-mono font-bold text-zinc-200 cursor-pointer block"
                    >
                      Pull Request Review Comments
                    </label>
                    <p className="text-[11px] font-mono text-zinc-400">
                      Post an automated security summary and inline code annotations on new PRs.
                    </p>
                  </div>
                  <Switch
                    id="pr-comments-toggle"
                    checked={state.prComments}
                    onCheckedChange={(checked) => updateField("prComments", checked)}
                    data-testid="pr-comments-toggle"
                  />
                </div>

                {/* AI Remediation */}
                <div className="flex items-center justify-between p-3 rounded-md bg-zinc-900/40 border border-zinc-800/80">
                  <div className="space-y-0.5 pr-4">
                    <label
                      htmlFor="ai-remediation-toggle"
                      className="text-xs font-mono font-bold text-zinc-200 cursor-pointer flex items-center gap-1.5"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                      AI Remediation & Patch Suggestions
                    </label>
                    <p className="text-[11px] font-mono text-zinc-400">
                      Generate intelligent vulnerability explanations and copy-paste code patches using AI.
                    </p>
                  </div>
                  <Switch
                    id="ai-remediation-toggle"
                    checked={state.aiRemediation}
                    onCheckedChange={(checked) => updateField("aiRemediation", checked)}
                    data-testid="ai-remediation-toggle"
                  />
                </div>
              </div>

              {/* Advanced Scan Path & Branch */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div className="space-y-1">
                  <label htmlFor={pathsInputId} className="text-[11px] font-mono text-zinc-400 block">
                    Scan Path (default: <code className="text-zinc-300">.</code>)
                  </label>
                  <Input
                    id={pathsInputId}
                    value={state.paths}
                    onChange={(e) => updateField("paths", e.target.value)}
                    placeholder="."
                    className="bg-zinc-900 border-zinc-800 text-xs font-mono h-8"
                    data-testid="scan-paths-input"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={branchInputId} className="text-[11px] font-mono text-zinc-400 block">
                    Trigger Branch (default: <code className="text-zinc-300">main</code>)
                  </label>
                  <Input
                    id={branchInputId}
                    value={state.workflowBranch}
                    onChange={(e) => updateField("workflowBranch", e.target.value)}
                    placeholder="main"
                    className="bg-zinc-900 border-zinc-800 text-xs font-mono h-8"
                    data-testid="branch-input"
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: Workflow File Generation */}
          {state.step === 3 && (
            <div className="space-y-4 animate-in fade-in-50 duration-200" id="step-3-panel">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-zinc-200 font-headline uppercase tracking-wider">
                  Step 3: Workflow File Generation
                </h3>
                <p className="text-xs text-muted-foreground font-mono">
                  Create this workflow file in your repository to run SecureFlow automatically on push and PR.
                </p>
              </div>

              {/* Target Path Banner with Copy */}
              <div className="p-3 rounded-md bg-primary/10 border border-primary/30 flex items-center justify-between gap-3 text-xs font-mono">
                <div className="flex items-center gap-2 overflow-hidden">
                  <FileCode className="w-4 h-4 text-primary shrink-0" />
                  <span className="text-zinc-400 shrink-0">Target File Path:</span>
                  <code className="text-primary font-bold truncate" data-testid="workflow-file-path">
                    {WORKFLOW_FILE_PATH}
                  </code>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCopyPath}
                  className="h-7 px-2 text-xs font-mono shrink-0 gap-1 border-primary/30 text-primary hover:bg-primary/20"
                  data-testid="copy-path-btn"
                >
                  {copiedPath ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  {copiedPath ? "Copied" : "Copy Path"}
                </Button>
              </div>

              {/* Generated YAML Box */}
              <div className="relative rounded-md border border-zinc-800 bg-zinc-950 font-mono text-xs overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/80 border-b border-zinc-800">
                  <span className="text-[11px] text-zinc-400">secureflow.yml</span>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={handleCopyYaml}
                    className="h-7 px-2.5 text-xs font-mono gap-1.5"
                    data-testid="copy-yaml-btn"
                  >
                    {copiedYaml ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedYaml ? "Copied to Clipboard!" : "Copy Workflow YAML"}
                  </Button>
                </div>
                <pre
                  className="p-3 text-[11px] text-zinc-300 overflow-x-auto max-h-[220px] leading-relaxed selection:bg-primary/30"
                  data-testid="workflow-yaml-preview"
                >
                  {generatedYaml}
                </pre>
              </div>
            </div>
          )}

          {/* STEP 4: Configure GitHub Secrets */}
          {state.step === 4 && (
            <div className="space-y-4 animate-in fade-in-50 duration-200" id="step-4-panel">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-zinc-200 font-headline uppercase tracking-wider">
                  Step 4: Configure GitHub Secrets
                </h3>
                <p className="text-xs text-muted-foreground font-mono">
                  Configure repository secrets in GitHub to run scans and AI remediation securely.
                </p>
              </div>

              {/* Secrets security notice */}
              <div className="p-3 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs font-mono text-blue-300 flex items-start gap-2.5">
                <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">Zero Secret Exposure:</span> SecureFlow explains the exact secret names and where to configure them in GitHub. Raw secret values are never displayed or stored in plain text.
                </div>
              </div>

              {/* Secrets List */}
              <div className="space-y-3 font-mono text-xs">
                {/* GITHUB_TOKEN */}
                <div className="p-3 rounded-md border border-zinc-800 bg-zinc-900/40 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-zinc-200 flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-zinc-400" />
                      GITHUB_TOKEN
                    </span>
                    <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                      Automatic / Built-in
                    </Badge>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Provided automatically by GitHub Actions on each run. Used to post pull request review comments and upload SARIF security events.
                  </p>
                </div>

                {/* SECUREFLOW_TOKEN */}
                <div className="p-3 rounded-md border border-zinc-800 bg-zinc-900/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-zinc-200 flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-amber-400" />
                      SECUREFLOW_TOKEN
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCopySecret("SECUREFLOW_TOKEN")}
                      className="h-6 px-2 text-[10px] text-zinc-400 hover:text-foreground gap-1"
                      data-testid="copy-secret-secureflow"
                    >
                      {copiedSecret === "SECUREFLOW_TOKEN" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      Copy Name
                    </Button>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Connects CLI scans to your SecureFlow dashboard. Add in GitHub under:
                    <span className="text-zinc-300 block mt-0.5">
                      <strong>Settings</strong> &rarr; <strong>Secrets and variables</strong> &rarr; <strong>Actions</strong> &rarr; <strong>New repository secret</strong>
                    </span>
                  </p>
                </div>

                {/* OPENAI_API_KEY (if AI remediation enabled) */}
                {state.aiRemediation && (
                  <div className="p-3 rounded-md border border-cyan-500/30 bg-cyan-500/5 space-y-2 animate-in fade-in-50">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-cyan-300 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                        OPENAI_API_KEY
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleCopySecret("OPENAI_API_KEY")}
                        className="h-6 px-2 text-[10px] text-cyan-400 hover:text-cyan-300 gap-1"
                        data-testid="copy-secret-openai"
                      >
                        {copiedSecret === "OPENAI_API_KEY" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        Copy Name
                      </Button>
                    </div>
                    <p className="text-[11px] text-zinc-400">
                      Required for AI remediation, vulnerability explanations, and suggested patch diffs. Add under GitHub Actions secrets. The key is securely passed to the runner via environment secrets.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 5: Confirm First Scan */}
          {state.step === 5 && (
            <div className="space-y-4 animate-in fade-in-50 duration-200" id="step-5-panel">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-zinc-200 font-headline uppercase tracking-wider">
                  Step 5: Confirm First Scan Arrival
                </h3>
                <p className="text-xs text-muted-foreground font-mono">
                  Once your GitHub Actions workflow runs, SecureFlow will detect the incoming scan results here.
                </p>
              </div>

              {/* Status Display Card */}
              {scanStatus?.hasScan ? (
                <div
                  className="p-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 space-y-3 font-mono"
                  data-testid="scan-confirmed-card"
                >
                  <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                    <CheckCircle2 className="w-5 h-5" />
                    First Scan Received!
                  </div>
                  <p className="text-xs text-zinc-300">
                    SecureFlow successfully processed the security scan for{" "}
                    <strong>{state.repository}</strong>.
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] pt-1">
                    <div className="p-2 rounded bg-zinc-950/60 border border-white/5">
                      <span className="text-zinc-500 block">Decision</span>
                      <span className="font-bold text-emerald-400">
                        {scanStatus.scan?.policyDecision || "PASSED"}
                      </span>
                    </div>
                    <div className="p-2 rounded bg-zinc-950/60 border border-white/5">
                      <span className="text-zinc-500 block">Findings</span>
                      <span className="font-bold text-zinc-200">
                        {scanStatus.scan?.findingsCount ?? 0}
                      </span>
                    </div>
                    <div className="p-2 rounded bg-zinc-950/60 border border-white/5">
                      <span className="text-zinc-500 block">Risk Score</span>
                      <span className="font-bold text-primary">
                        {scanStatus.scan?.riskScore ?? 100} / 100
                      </span>
                    </div>
                    <div className="p-2 rounded bg-zinc-950/60 border border-white/5">
                      <span className="text-zinc-500 block">Timestamp</span>
                      <span className="text-zinc-300 truncate block">
                        {scanStatus.scan?.createdAt
                          ? new Date(scanStatus.scan.createdAt).toLocaleTimeString()
                          : "Just now"}
                      </span>
                    </div>
                  </div>

                  <div className="pt-2 flex flex-wrap gap-2">
                    <Link href={`/dashboard/findings?repo=${encodeURIComponent(state.repository)}`}>
                      <Button size="sm" variant="default" className="text-xs font-mono gap-1.5 h-8">
                        View Findings
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Button>
                    </Link>
                  </div>
                </div>
              ) : (
                <div
                  className="p-5 rounded-md border border-zinc-800 bg-zinc-900/30 text-center space-y-3 font-mono"
                  data-testid="waiting-scan-card"
                >
                  <div className="w-10 h-10 mx-auto rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                    <RefreshCw className={`w-5 h-5 ${isCheckingScan ? "animate-spin" : ""}`} />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-zinc-200">Waiting for First Scan</h4>
                    <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                      Push <code className="text-primary">{WORKFLOW_FILE_PATH}</code> to{" "}
                      <strong>{state.repository || "your repository"}</strong> to trigger your first scan.
                    </p>
                  </div>

                  <div className="pt-2 flex flex-wrap justify-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleCheckScan}
                      disabled={isCheckingScan}
                      className="text-xs font-mono gap-1.5 h-8"
                      data-testid="check-scan-btn"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isCheckingScan ? "animate-spin" : ""}`} />
                      {isCheckingScan ? "Checking..." : "Check Scan Status"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleSimulateScan}
                      disabled={isSimulating}
                      className="text-xs font-mono text-zinc-400 hover:text-foreground h-8"
                      title="Test scan arrival simulation without committing files"
                      data-testid="simulate-scan-btn"
                    >
                      {isSimulating ? "Simulating..." : "Simulate Test Scan"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ─── Dialog Footer & Navigation ──────────────────────────────────── */}
        <div className="flex items-center justify-between pt-4 border-t border-zinc-800">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => updateField("step", Math.max(1, state.step - 1))}
            disabled={state.step <= 1}
            className="text-xs font-mono gap-1.5 h-8"
            data-testid="wizard-prev-btn"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </Button>

          <div className="text-xs font-mono text-zinc-500">
            Step {state.step} of {steps.length}
          </div>

          {state.step < steps.length ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => updateField("step", Math.min(steps.length, state.step + 1))}
              disabled={state.step === 1 && !state.repository.trim()}
              className="text-xs font-mono gap-1.5 h-8"
              data-testid="wizard-next-btn"
            >
              Next
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="text-xs font-mono gap-1.5 h-8"
              data-testid="wizard-finish-btn"
            >
              Finish
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
export default ConnectRepositoryWizard;

