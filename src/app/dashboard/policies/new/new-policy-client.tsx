"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Plus,
  Trash2,
  ShieldCheck,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { createCustomPolicy } from "@/lib/actions/create-policy";
import Link from "next/link";

const SEVERITY_OPTIONS = [
  { value: "CRITICAL", label: "Critical", color: "text-red-400" },
  { value: "HIGH", label: "High", color: "text-orange-400" },
  { value: "MEDIUM", label: "Medium", color: "text-yellow-400" },
  { value: "LOW", label: "Low", color: "text-blue-400" },
];

const ACTION_OPTIONS = [
  { value: "BLOCK", label: "Block PR", desc: "Prevent merge when triggered" },
  { value: "REVIEW REQUIRED", label: "Review Required", desc: "Require manual approval" },
  { value: "ALERT ONLY", label: "Alert Only", desc: "Log without blocking" },
];

const SEVERITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-red-500/10 border-red-500/30 text-red-400",
  HIGH: "bg-orange-500/10 border-orange-500/30 text-orange-400",
  MEDIUM: "bg-yellow-500/10 border-yellow-500/30 text-yellow-400",
  LOW: "bg-blue-500/10 border-blue-500/30 text-blue-400",
};

export default function NewPolicyClient() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("HIGH");
  const [action, setAction] = useState("REVIEW REQUIRED");
  const [conditions, setConditions] = useState<string[]>([""]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addCondition = () => setConditions([...conditions, ""]);
  const removeCondition = (i: number) => setConditions(conditions.filter((_, idx) => idx !== i));
  const updateCondition = (i: number, val: string) => {
    const next = [...conditions];
    next[i] = val;
    setConditions(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await createCustomPolicy({ name, description, severity, action, conditions });
      if (result.ok && result.policyId) {
        router.push("/dashboard/policies");
      } else {
        setError(result.error ?? "Failed to create policy.");
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/dashboard/policies" className="p-2 rounded-lg hover:bg-white/5 transition-colors">
          <ArrowLeft className="w-5 h-5 text-muted-foreground" />
        </Link>
        <div>
          <span className="text-sm font-medium uppercase tracking-widest text-primary">Defense Strategy</span>
          <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight">Create Custom Rule</h1>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Name */}
        <Card className="glass-card">
          <CardHeader><CardTitle className="text-sm font-bold">Rule Identity</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Enforce HTTPS Redirects"
                className="w-full px-4 py-2.5 rounded-sm bg-foreground/[0.04] border border-white/10 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
                maxLength={100}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what this rule checks for and why it matters..."
                rows={3}
                className="w-full px-4 py-2.5 rounded-sm bg-foreground/[0.04] border border-white/10 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors resize-none"
                maxLength={500}
              />
            </div>
          </CardContent>
        </Card>

        {/* Severity & Action */}
        <Card className="glass-card">
          <CardHeader><CardTitle className="text-sm font-bold">Configuration</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Severity</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {SEVERITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSeverity(opt.value)}
                    className={`px-3 py-2 rounded-sm text-xs font-bold uppercase tracking-wider border transition-all ${
                      severity === opt.value
                        ? `${SEVERITY_BADGE[opt.value]} border-current`
                        : "border-white/10 text-muted-foreground hover:border-white/20"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Action</label>
              <div className="space-y-2">
                {ACTION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setAction(opt.value)}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-sm text-left border transition-all ${
                      action === opt.value
                        ? "bg-primary/10 border-primary/30 text-white"
                        : "border-white/10 text-muted-foreground hover:border-white/20"
                    }`}
                  >
                    <span className="text-sm font-bold">{opt.label}</span>
                    <span className="text-[10px] text-muted-foreground">{opt.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Conditions */}
        <Card className="glass-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold">Rule Conditions</CardTitle>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCondition}
                className="border-white/10 hover:border-primary/40 bg-white/5 cursor-pointer text-xs font-bold"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {conditions.map((cond, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="flex items-center gap-2 shrink-0 pt-2.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                  <span className="text-[10px] font-mono text-muted-foreground w-4">{i + 1}.</span>
                </div>
                <input
                  type="text"
                  value={cond}
                  onChange={(e) => updateCondition(i, e.target.value)}
                  placeholder="e.g. All API routes must use HTTPS redirects"
                  className="flex-1 px-4 py-2.5 rounded-sm bg-foreground/[0.04] border border-white/10 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
                  maxLength={300}
                />
                {conditions.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeCondition(i)}
                    className="mt-2 p-1.5 rounded-sm hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            disabled={submitting}
            className="bg-primary text-background hover:bg-primary/90 glow-primary font-bold uppercase rounded-sm cursor-pointer h-11 px-8"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4 mr-2" />
            )}
            {submitting ? "Creating..." : "Create Rule"}
          </Button>
          <Link href="/dashboard/policies">
            <Button
              type="button"
              variant="outline"
              className="border-white/10 hover:border-white/20 cursor-pointer h-11 px-6"
            >
              Cancel
            </Button>
          </Link>
        </div>
      </form>
    </div>
  );
}
