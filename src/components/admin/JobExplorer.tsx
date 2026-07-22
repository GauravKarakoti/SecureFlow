"use client";

import React, { useEffect, useState, useTransition } from "react";
import {
  getQueueJobs,
  removeQueueJob,
  type QueueJobState,
} from "@/lib/actions/queue";
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Activity,
  CheckCircle,
  AlertOctagon,
  Loader2,
  Search,
  X,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface JobRow {
  id: string;
  name: string;
  data: any;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  progress: unknown;
  attemptsMade: number;
  failedReason: string | null;
}

const TABS: { key: QueueJobState; label: string; icon: typeof Clock }[] = [
  { key: "waiting", label: "Waiting", icon: Clock },
  { key: "active", label: "Active", icon: Activity },
  { key: "completed", label: "Completed", icon: CheckCircle },
  { key: "delayed", label: "Delayed", icon: AlertOctagon },
];

const ITEMS_PER_PAGE = 10;

export default function JobExplorer() {
  const [activeTab, setActiveTab] = useState<QueueJobState>("waiting");
  const [jobsByTab, setJobsByTab] = useState<Partial<Record<QueueJobState, JobRow[]>>>({});
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loadingTab, setLoadingTab] = useState<QueueJobState | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [removingJobId, setRemovingJobId] = useState<string | null>(null);
  const { toast } = useToast();

  const loadTab = (tab: QueueJobState, force = false) => {
    if (!force && jobsByTab[tab] !== undefined) return;
    setLoadingTab(tab);
    startTransition(async () => {
      try {
        const jobs = await getQueueJobs(tab);
        setJobsByTab((prev) => ({ ...prev, [tab]: jobs }));
      } catch (err: any) {
        toast({
          variant: "destructive",
          title: "Failed to load jobs",
          description: err.message || `Could not fetch ${tab} jobs.`,
        });
        setJobsByTab((prev) => ({ ...prev, [tab]: [] }));
      } finally {
        setLoadingTab(null);
      }
    });
  };

  useEffect(() => {
    // Deferred to a microtask so loadTab's setState calls run after this
    // effect has finished committing, instead of synchronously inside it.
    const microtask = Promise.resolve().then(() => loadTab(activeTab));
    return () => {
      microtask.catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const handleTabChange = (tab: QueueJobState) => {
    setActiveTab(tab);
    setSearch("");
    setPage(1);
    setExpandedJobId(null);
  };

  const handleRefresh = () => loadTab(activeTab, true);

  const jobs = jobsByTab[activeTab] || [];

  const filteredJobs = jobs.filter((job) => {
    const searchLower = search.toLowerCase();
    const event = job.data?.event || "";
    const action = job.data?.payload?.action || "";
    const repo = job.data?.payload?.repository?.full_name || "";

    return (
      event.toLowerCase().includes(searchLower) ||
      action.toLowerCase().includes(searchLower) ||
      repo.toLowerCase().includes(searchLower)
    );
  });

  const totalItems = filteredJobs.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  const startIndex = (page - 1) * ITEMS_PER_PAGE;
  const currentJobs = filteredJobs.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const toggleExpand = (jobId: string) => {
    setExpandedJobId((prev) => (prev === jobId ? null : jobId));
  };

  const handleRemove = async (jobId: string) => {
    setRemovingJobId(jobId);
    startTransition(async () => {
      try {
        const res = await removeQueueJob(jobId, activeTab);
        if (res.success) {
          setJobsByTab((prev) => ({
            ...prev,
            [activeTab]: (prev[activeTab] || []).filter((j) => j.id !== jobId),
          }));
          toast({
            title: "Job Removed",
            description: `The job was removed from the ${activeTab} list.`,
          });
        }
      } catch (err: any) {
        toast({
          variant: "destructive",
          title: "Removal Failed",
          description: err.message || "An error occurred while removing the job.",
        });
      } finally {
        setRemovingJobId(null);
      }
    });
  };

  const fmtDate = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : "—");

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="flex gap-1 bg-black/20 border border-white/10 rounded-lg p-1 w-full sm:w-auto overflow-x-auto">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => handleTabChange(key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider transition-colors whitespace-nowrap ${
                activeTab === key
                  ? "bg-primary/20 text-primary border border-primary/30"
                  : "text-muted-foreground hover:text-white hover:bg-white/5 border border-transparent"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
              {jobsByTab[key] !== undefined && (
                <span className="ml-1 text-[10px] text-zinc-500">
                  {jobsByTab[key]!.length}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex gap-2 w-full sm:w-auto shrink-0">
          <div className="relative w-full sm:max-w-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Filter by repo, event, action..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="bg-background border border-border text-foreground text-sm rounded-lg pl-9 pr-4 py-2 w-full focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
            />
          </div>
          <button
            onClick={handleRefresh}
            disabled={loadingTab === activeTab}
            title="Refresh"
            className="flex items-center justify-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-muted-foreground hover:text-white text-xs font-bold uppercase tracking-wider rounded-lg transition-colors disabled:opacity-50"
          >
            {loadingTab === activeTab ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
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
                <th className="px-6 py-4">
                  {activeTab === "completed" ? "Finished At" : "Enqueued At"}
                </th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loadingTab === activeTab && currentJobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Loader2 className="w-6 h-6 text-zinc-600 animate-spin" />
                      <span className="text-sm font-medium">Loading {activeTab} jobs...</span>
                    </div>
                  </td>
                </tr>
              ) : currentJobs.length > 0 ? (
                currentJobs.map((job) => {
                  const event = job.data?.event || "unknown";
                  const action = job.data?.payload?.action || "unknown";
                  const repo = job.data?.payload?.repository?.full_name || null;
                  const isExpanded = expandedJobId === job.id;
                  const isRemoving = removingJobId === job.id;
                  const canRemove = activeTab === "waiting" || activeTab === "delayed";

                  return (
                    <React.Fragment key={job.id}>
                      <tr
                        className="border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer"
                        onClick={() => toggleExpand(job.id)}
                      >
                        <td className="px-6 py-4 text-center">
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          )}
                        </td>
                        <td className="px-6 py-4 font-mono font-medium text-foreground">
                          {repo ? (
                            <span className="text-white">{repo}</span>
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
                          {activeTab === "completed"
                            ? fmtDate(job.finishedOn)
                            : fmtDate(job.timestamp)}
                        </td>
                        <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                          {canRemove && (
                            <button
                              onClick={() => handleRemove(job.id)}
                              disabled={isPending || isRemoving}
                              title="Remove from queue"
                              className="p-1.5 bg-destructive/10 hover:bg-destructive/20 text-destructive border border-destructive/20 hover:border-destructive/40 rounded transition-colors disabled:opacity-50 inline-flex"
                            >
                              {isRemoving ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <X className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-black/10 border-b border-white/5">
                          <td colSpan={5} className="px-6 py-4">
                            <div className="flex flex-col gap-2">
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-zinc-500 uppercase tracking-widest">Job ID</span>
                                  <span className="font-mono text-zinc-300">{job.id}</span>
                                </div>
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-zinc-500 uppercase tracking-widest">Attempts</span>
                                  <span className="font-mono text-zinc-300">{job.attemptsMade}</span>
                                </div>
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-zinc-500 uppercase tracking-widest">Enqueued</span>
                                  <span className="font-mono text-zinc-300">{fmtDate(job.timestamp)}</span>
                                </div>
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-zinc-500 uppercase tracking-widest">Finished</span>
                                  <span className="font-mono text-zinc-300">{fmtDate(job.finishedOn)}</span>
                                </div>
                              </div>

                              <div className="flex flex-col gap-1.5 p-3 bg-white/5 border border-white/10 rounded-lg">
                                <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest font-mono">
                                  Job Data Payload
                                </span>
                                <pre className="text-xs text-zinc-300 font-mono overflow-auto max-h-48 p-2 bg-black/40 rounded border border-white/5 leading-relaxed">
                                  {JSON.stringify(job.data || {}, null, 2)}
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
                      <Search className="w-8 h-8 text-zinc-600" />
                      <span className="text-sm font-medium">No {activeTab} jobs found.</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {totalItems > ITEMS_PER_PAGE && (
          <div className="p-4 border-t border-white/5 flex justify-between items-center text-sm">
            <span>
              Showing {startIndex + 1} to {Math.min(startIndex + ITEMS_PER_PAGE, totalItems)} of {totalItems} results
            </span>
            <div className="space-x-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 bg-white/5 text-foreground rounded-lg hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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