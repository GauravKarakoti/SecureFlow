"use client";

import React, { useState, useTransition } from "react";
import { 
  requeueDLQJob, 
  deleteDLQJob, 
  clearAllDLQ, 
  requeueAllDLQ 
} from "@/lib/actions/queue";
import { 
  Play, 
  Trash2, 
  RefreshCw, 
  Trash, 
  AlertCircle, 
  ChevronDown, 
  ChevronUp, 
  Loader2, 
  Search 
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface DLQTableProps {
  initialJobs: any[];
}

export default function DLQTable({ initialJobs }: DLQTableProps) {
  const [jobs, setJobs] = useState<any[]>(initialJobs || []);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();

  // Local loading states for individual job actions
  const [actionLoadingJobId, setActionLoadingJobId] = useState<string | null>(null);

  const filteredJobs = jobs.filter((job) => {
    const searchLower = search.toLowerCase();
    const event = job.data?.data?.event || "";
    const action = job.data?.data?.payload?.action || "";
    const repo = job.data?.data?.payload?.repository?.full_name || "";
    const reason = job.data?.failedReason || "";

    return (
      event.toLowerCase().includes(searchLower) ||
      action.toLowerCase().includes(searchLower) ||
      repo.toLowerCase().includes(searchLower) ||
      reason.toLowerCase().includes(searchLower)
    );
  });

  const itemsPerPage = 10;
  const totalItems = filteredJobs.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
  const startIndex = (page - 1) * itemsPerPage;
  const currentJobs = filteredJobs.slice(startIndex, startIndex + itemsPerPage);

  const handlePrev = () => setPage((p) => Math.max(1, p - 1));
  const handleNext = () => setPage((p) => Math.min(totalPages, p + 1));

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    setPage(1);
  };

  const handleSingleRequeue = async (jobId: string) => {
    setActionLoadingJobId(jobId);
    startTransition(async () => {
      try {
        const res = await requeueDLQJob(jobId);
        if (res.success) {
          setJobs((prev) => prev.filter((j) => j.id !== jobId));
          toast({
            title: "Job Requeued",
            description: "The job has been successfully sent back to the main queue.",
          });
        }
      } catch (err: any) {
        toast({
          variant: "destructive",
          title: "Requeue Failed",
          description: err.message || "An error occurred while requeuing.",
        });
      } finally {
        setActionLoadingJobId(null);
      }
    });
  };

  const handleSingleDelete = async (jobId: string) => {
    setActionLoadingJobId(jobId);
    startTransition(async () => {
      try {
        const res = await deleteDLQJob(jobId);
        if (res.success) {
          setJobs((prev) => prev.filter((j) => j.id !== jobId));
          toast({
            title: "Job Deleted",
            description: "The job has been permanently removed from the DLQ.",
          });
        }
      } catch (err: any) {
        toast({
          variant: "destructive",
          title: "Deletion Failed",
          description: err.message || "An error occurred while deleting.",
        });
      } finally {
        setActionLoadingJobId(null);
      }
    });
  };

  const handleRequeueAll = async () => {
    if (jobs.length === 0) return;
    startTransition(async () => {
      try {
        const res = await requeueAllDLQ();
        if (res.success) {
          setJobs([]);
          toast({
            title: "All Jobs Requeued",
            description: "All DLQ jobs have been returned to the processing queue.",
          });
        }
      } catch (err: any) {
        toast({
          variant: "destructive",
          title: "Bulk Requeue Failed",
          description: err.message || "An error occurred during bulk requeue.",
        });
      }
    });
  };

  const handleClearAll = async () => {
    if (jobs.length === 0) return;
    startTransition(async () => {
      try {
        const res = await clearAllDLQ();
        if (res.success) {
          setJobs([]);
          toast({
            title: "DLQ Cleared",
            description: "All DLQ jobs have been permanently deleted.",
          });
        }
      } catch (err: any) {
        toast({
          variant: "destructive",
          title: "Clear Failed",
          description: err.message || "An error occurred while clearing.",
        });
      }
    });
  };

  const toggleExpand = (jobId: string) => {
    setExpandedJobId((prev) => (prev === jobId ? null : jobId));
  };

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter DLQ jobs by repo, event, action..."
            value={search}
            onChange={handleSearch}
            className="bg-background border border-border text-foreground text-sm rounded-lg pl-9 pr-4 py-2 w-full focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex gap-2 w-full sm:w-auto shrink-0">
          <button
            onClick={handleRequeueAll}
            disabled={isPending || jobs.length === 0}
            className="flex items-center justify-center gap-1.5 px-4 py-2 bg-primary/10 hover:bg-primary/20 border border-primary/30 hover:border-primary/50 text-primary text-xs font-bold uppercase tracking-wider rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
          >
            {isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Requeue All
          </button>
          <button
            onClick={handleClearAll}
            disabled={isPending || jobs.length === 0}
            className="flex items-center justify-center gap-1.5 px-4 py-2 bg-destructive/10 hover:bg-destructive/20 border border-destructive/30 hover:border-destructive/50 text-destructive text-xs font-bold uppercase tracking-wider rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
          >
            {isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash className="w-3.5 h-3.5" />
            )}
            Clear All
          </button>
        </div>
      </div>

      <div className="w-full glass-card rounded-xl border border-white/10 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-muted-foreground border-collapse">
            <thead className="bg-black/20 text-muted-foreground text-xs uppercase tracking-wider border-b border-white/5">
              <tr>
                <th className="w-6 px-6 py-4"></th>
                <th className="px-6 py-4">Target / Event</th>
                <th className="px-6 py-4">Action</th>
                <th className="px-6 py-4">Failed At</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {currentJobs.length > 0 ? (
                currentJobs.map((job) => {
                  const event = job.data?.data?.event || "unknown";
                  const action = job.data?.data?.payload?.action || "unknown";
                  const repo = job.data?.data?.payload?.repository?.full_name || null;
                  const isExpanded = expandedJobId === job.id;
                  const isLoading = actionLoadingJobId === job.id;

                  return (
                    <React.Fragment key={job.id}>
                      <tr className="border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer" onClick={() => toggleExpand(job.id)}>
                        <td className="px-6 py-4 text-center">
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          )}
                        </td>
                        <td className="px-6 py-4 font-mono font-medium text-foreground">
                          {repo ? (
                            <span className="text-white hover:underline">{repo}</span>
                          ) : (
                            <span className="text-zinc-400 capitalize">{event}</span>
                          )}
                        </td>
                        <td className="px-6 py-4 capitalize">
                          <span className="px-2 py-1 rounded bg-white/5 border border-white/10 text-xs">
                            {action}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-xs font-mono">
                          {job.data?.failedAt ? new Date(job.data.failedAt).toLocaleString() : "Unknown"}
                        </td>
                        <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => handleSingleRequeue(job.id)}
                              disabled={isPending || isLoading}
                              title="Requeue Job"
                              className="p-1.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 hover:border-primary/40 rounded transition-colors disabled:opacity-50"
                            >
                              {isLoading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Play className="w-3.5 h-3.5 fill-current" />
                              )}
                            </button>
                            <button
                              onClick={() => handleSingleDelete(job.id)}
                              disabled={isPending || isLoading}
                              title="Delete Job"
                              className="p-1.5 bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/20 hover:border-destructive/40 rounded transition-colors disabled:opacity-50"
                            >
                              {isLoading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-black/10 border-b border-white/5">
                          <td colSpan={5} className="px-6 py-4">
                            <div className="flex flex-col gap-2">
                              <div className="flex items-start gap-2 p-3 bg-red-500/5 border border-red-500/10 rounded-lg">
                                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                                <div className="flex flex-col gap-1">
                                  <span className="text-xs font-bold text-red-400 uppercase tracking-widest font-mono">
                                    Failure Reason
                                  </span>
                                  <p className="text-xs text-red-200/90 font-mono break-all whitespace-pre-wrap">
                                    {job.data?.failedReason || "No error details available."}
                                  </p>
                                </div>
                              </div>

                              <div className="flex flex-col gap-1.5 p-3 bg-white/5 border border-white/10 rounded-lg">
                                <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest font-mono">
                                  Job Data Payload
                                </span>
                                <pre className="text-xs text-zinc-300 font-mono overflow-auto max-h-48 p-2 bg-black/40 rounded border border-white/5 leading-relaxed">
                                  {JSON.stringify(job.data?.data || {}, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <AlertCircle className="w-8 h-8 text-zinc-600" />
                      <span className="text-sm font-medium">No failed jobs in the DLQ.</span>
                      <span className="text-xs text-zinc-600">The Resistance is operating smoothly.</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {totalItems > itemsPerPage && (
          <div className="p-4 border-t border-white/5 flex justify-between items-center text-sm">
            <span>
              Showing {startIndex + 1} to {Math.min(startIndex + itemsPerPage, totalItems)} of {totalItems} results
            </span>
            <div className="space-x-2">
              <button
                onClick={handlePrev}
                disabled={page === 1}
                className="px-3 py-1 bg-white/5 text-foreground rounded-lg hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={handleNext}
                disabled={page === totalPages}
                className="px-3 py-1 bg-white/5 text-foreground rounded-lg hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
