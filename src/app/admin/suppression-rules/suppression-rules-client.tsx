"use client";

import { useState, useTransition } from "react";
import {
  ShieldAlert,
  Plus,
  Trash2,
  Edit2,
  Calendar,
  FolderGit2,
  FileCode,
  Tag,
  Clock,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import {
  createSuppressionRuleAction,
  updateSuppressionRuleAction,
  deleteSuppressionRuleAction,
} from "./actions";
import type { SuppressionRuleWithStats } from "@/lib/suppression-rules/service";

interface RepositoryOption {
  id: string;
  fullName: string;
}

interface SuppressionRulesClientProps {
  initialRules: SuppressionRuleWithStats[];
  repositories: RepositoryOption[];
}

export default function SuppressionRulesClient({
  initialRules,
  repositories,
}: SuppressionRulesClientProps) {
  const [rules, setRules] = useState<SuppressionRuleWithStats[]>(initialRules);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<SuppressionRuleWithStats | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"ALL" | "SELECTED">("ALL");
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [matchCategory, setMatchCategory] = useState("");
  const [matchPolicy, setMatchPolicy] = useState("");
  const [pathGlob, setPathGlob] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const resetForm = () => {
    setName("");
    setDescription("");
    setScope("ALL");
    setSelectedRepoIds([]);
    setMatchCategory("");
    setMatchPolicy("");
    setPathGlob("");
    setReason("");
    setExpiresAt("");
    setEditingRule(null);
    setError(null);
  };

  const openCreateModal = () => {
    resetForm();
    setIsModalOpen(true);
  };

  const openEditModal = (rule: SuppressionRuleWithStats) => {
    setEditingRule(rule);
    setName(rule.name);
    setDescription(rule.description || "");
    setScope(rule.scope === "SELECTED" ? "SELECTED" : "ALL");
    setSelectedRepoIds(rule.repositoryIds || []);
    setMatchCategory(rule.matchCategory || "");
    setMatchPolicy(rule.matchPolicy || "");
    setPathGlob(rule.pathGlob || "");
    setReason(rule.reason);
    setExpiresAt(rule.expiresAt ? new Date(rule.expiresAt).toISOString().split("T")[0] : "");
    setError(null);
    setIsModalOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    startTransition(async () => {
      try {
        if (!name.trim()) throw new Error("Rule name is required.");
        if (!reason.trim()) throw new Error("Reason is required.");

        if (editingRule) {
          const updated = await updateSuppressionRuleAction(editingRule.id, {
            name: name.trim(),
            description: description.trim() || null,
            scope,
            repositoryIds: scope === "SELECTED" ? selectedRepoIds : [],
            matchCategory: matchCategory.trim() || null,
            matchPolicy: matchPolicy.trim() || null,
            pathGlob: pathGlob.trim() || null,
            reason: reason.trim(),
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          });

          setRules((prev) =>
            prev.map((r) =>
              r.id === updated.id
                ? { ...r, ...updated, thirtyDaySuppressionCount: r.thirtyDaySuppressionCount }
                : r,
            ),
          );
          setSuccess("Suppression rule updated successfully.");
        } else {
          const created = await createSuppressionRuleAction({
            name: name.trim(),
            description: description.trim() || null,
            scope,
            repositoryIds: scope === "SELECTED" ? selectedRepoIds : [],
            matchCategory: matchCategory.trim() || null,
            matchPolicy: matchPolicy.trim() || null,
            pathGlob: pathGlob.trim() || null,
            reason: reason.trim(),
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          });

          setRules((prev) => [{ ...created, thirtyDaySuppressionCount: 0 }, ...prev]);
          setSuccess("Suppression rule created successfully.");
        }

        setIsModalOpen(false);
        resetForm();
      } catch (err: any) {
        setError(err?.message || "Failed to save suppression rule.");
      }
    });
  };

  const handleDelete = (id: string, ruleName: string) => {
    if (!confirm(`Are you sure you want to delete the suppression rule "${ruleName}"?`)) {
      return;
    }

    startTransition(async () => {
      try {
        await deleteSuppressionRuleAction(id);
        setRules((prev) => prev.filter((r) => r.id !== id));
        setSuccess(`Suppression rule "${ruleName}" deleted.`);
      } catch (err: any) {
        setError(err?.message || "Failed to delete suppression rule.");
      }
    });
  };

  const toggleRepoSelection = (repoId: string) => {
    setSelectedRepoIds((prev) =>
      prev.includes(repoId) ? prev.filter((id) => id !== repoId) : [...prev, repoId],
    );
  };

  const totalSuppressions30d = rules.reduce((acc, r) => acc + (r.thirtyDaySuppressionCount || 0), 0);
  const activeRulesCount = rules.filter((r) => !r.expiresAt || new Date(r.expiresAt) > new Date()).length;

  return (
    <div className="space-y-6">
      {/* Top Banner & Notifications */}
      {error && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}
      {success && (
        <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20 text-green-600 dark:text-green-400 flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <p className="text-sm">{success}</p>
        </div>
      )}

      {/* Metrics Row */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="p-5 rounded-xl border border-border bg-card">
          <div className="text-sm font-medium text-muted-foreground">Total Rules</div>
          <div className="text-2xl font-bold mt-1 text-foreground">{rules.length}</div>
        </div>
        <div className="p-5 rounded-xl border border-border bg-card">
          <div className="text-sm font-medium text-muted-foreground">Active Rules</div>
          <div className="text-2xl font-bold mt-1 text-emerald-600 dark:text-emerald-400">
            {activeRulesCount}
          </div>
        </div>
        <div className="p-5 rounded-xl border border-border bg-card">
          <div className="text-sm font-medium text-muted-foreground">Suppressed in Last 30 Days</div>
          <div className="text-2xl font-bold mt-1 text-blue-600 dark:text-blue-400">
            {totalSuppressions30d}
          </div>
        </div>
      </div>

      {/* Actions header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Configured Suppression Rules
        </h2>
        <button
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Create Suppression Rule
        </button>
      </div>

      {/* Rules Table / Cards */}
      {rules.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <ShieldAlert className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
          <h3 className="text-lg font-medium text-foreground">No suppression rules configured</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            Create an organization-wide suppression rule to safely accept specific finding types, policy checks, or file patterns across your repositories.
          </p>
          <button
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition"
          >
            <Plus className="w-4 h-4" />
            New Suppression Rule
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border">
          {rules.map((rule) => {
            const isExpired = rule.expiresAt && new Date(rule.expiresAt) <= new Date();

            return (
              <div key={rule.id} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-2 flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-base text-foreground">{rule.name}</span>
                    {isExpired ? (
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                        Expired
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                        Active
                      </span>
                    )}

                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground border border-border">
                      {rule.scope === "ALL" ? "All Repositories" : `${rule.repositoryIds.length} Selected Repo(s)`}
                    </span>

                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                      {rule.thirtyDaySuppressionCount} suppressed (30d)
                    </span>
                  </div>

                  {rule.description && (
                    <p className="text-sm text-muted-foreground">{rule.description}</p>
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pt-1">
                    {rule.matchCategory && (
                      <div className="flex items-center gap-1">
                        <Tag className="w-3.5 h-3.5" />
                        <span>Category: <strong>{rule.matchCategory}</strong></span>
                      </div>
                    )}
                    {rule.matchPolicy && (
                      <div className="flex items-center gap-1">
                        <FileCode className="w-3.5 h-3.5" />
                        <span>Policy: <strong>{rule.matchPolicy}</strong></span>
                      </div>
                    )}
                    {rule.pathGlob && (
                      <div className="flex items-center gap-1">
                        <FolderGit2 className="w-3.5 h-3.5" />
                        <span>Path: <code>{rule.pathGlob}</code></span>
                      </div>
                    )}
                    {rule.expiresAt ? (
                      <div className="flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5" />
                        <span>Expires: {new Date(rule.expiresAt).toLocaleDateString()}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        <span>No Expiry</span>
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded border border-border/50">
                    <strong>Reason:</strong> {rule.reason}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0 self-start md:self-center">
                  <button
                    onClick={() => openEditModal(rule)}
                    className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition"
                    title="Edit Rule"
                    aria-label="Edit Rule"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(rule.id, rule.name)}
                    className="p-2 text-red-600 hover:text-red-700 hover:bg-red-500/10 rounded-lg transition"
                    title="Delete Rule"
                    aria-label="Delete Rule"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal Dialog */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-card border border-border rounded-xl shadow-xl max-w-xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <h3 className="text-lg font-semibold text-foreground">
              {editingRule ? "Edit Suppression Rule" : "Create Suppression Rule"}
            </h3>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Rule Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Suppress test fixture dummy tokens"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Description
                </label>
                <input
                  type="text"
                  placeholder="Optional context about this rule"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Scope *
                </label>
                <div className="flex items-center gap-4 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="scope"
                      value="ALL"
                      checked={scope === "ALL"}
                      onChange={() => setScope("ALL")}
                      className="accent-primary"
                    />
                    <span>All Repositories</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="scope"
                      value="SELECTED"
                      checked={scope === "SELECTED"}
                      onChange={() => setScope("SELECTED")}
                      className="accent-primary"
                    />
                    <span>Selected Repositories</span>
                  </label>
                </div>
              </div>

              {scope === "SELECTED" && (
                <div className="p-3 rounded-lg border border-border bg-muted/30 space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    Select target repositories ({selectedRepoIds.length} selected):
                  </div>
                  <div className="max-h-36 overflow-y-auto space-y-1 pr-1 text-sm">
                    {repositories.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No repositories found.</p>
                    ) : (
                      repositories.map((repo) => (
                        <label
                          key={repo.id}
                          className="flex items-center gap-2 p-1.5 rounded hover:bg-muted cursor-pointer text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={selectedRepoIds.includes(repo.id)}
                            onChange={() => toggleRepoSelection(repo.id)}
                            className="accent-primary rounded"
                          />
                          <span className="truncate">{repo.fullName}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Finding Category
                  </label>
                  <select
                    value={matchCategory}
                    onChange={(e) => setMatchCategory(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="">Any Category</option>
                    <option value="SECRET">SECRET</option>
                    <option value="VULNERABILITY">VULNERABILITY</option>
                    <option value="MISCONFIG">MISCONFIG</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Policy Name / Keyword
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. AWS, Private Key"
                    value={matchPolicy}
                    onChange={(e) => setMatchPolicy(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                  </input>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Path Glob Pattern
                </label>
                <input
                  type="text"
                  placeholder="e.g. fixtures/**, test/**/*.ts"
                  value={pathGlob}
                  onChange={(e) => setPathGlob(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Reason for Suppression *
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="Explain why this finding is accepted or suppressed organization-wide"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Optional Expiry Date
                </label>
                <input
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Leave empty for a permanent rule. Rules with an expiry stop applying after this date.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
                <button
                  type="button"
                  onClick={() => {
                    setIsModalOpen(false);
                    resetForm();
                  }}
                  className="px-4 py-2 rounded-lg border border-border text-foreground text-sm hover:bg-muted transition"
                  disabled={isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition shadow-sm disabled:opacity-50"
                >
                  {isPending ? "Saving..." : editingRule ? "Update Rule" : "Create Rule"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
