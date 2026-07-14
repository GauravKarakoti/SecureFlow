import { getQueueMetrics } from '@/lib/actions/queue';
import { Activity, CheckCircle, Clock, AlertTriangle, AlertOctagon } from 'lucide-react';

export default async function QueueMonitorPage() {
  const metrics = await getQueueMetrics();

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Queue Monitor</h1>
        <p className="text-muted-foreground">
          Real-time observability of the BullMQ async processing pipelines and Dead-Letter Queue.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <div className="p-6 bg-card border rounded-xl shadow-sm">
          <div className="flex flex-row items-center justify-between pb-2 space-y-0">
            <h3 className="text-sm font-medium tracking-tight">Waiting</h3>
            <Clock className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="text-2xl font-bold">{metrics.waiting}</div>
        </div>

        <div className="p-6 bg-card border rounded-xl shadow-sm">
          <div className="flex flex-row items-center justify-between pb-2 space-y-0">
            <h3 className="text-sm font-medium tracking-tight">Active</h3>
            <Activity className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-2xl font-bold">{metrics.active}</div>
        </div>

        <div className="p-6 bg-card border rounded-xl shadow-sm">
          <div className="flex flex-row items-center justify-between pb-2 space-y-0">
            <h3 className="text-sm font-medium tracking-tight">Completed</h3>
            <CheckCircle className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold">{metrics.completed}</div>
        </div>

        <div className="p-6 bg-card border rounded-xl shadow-sm">
          <div className="flex flex-row items-center justify-between pb-2 space-y-0">
            <h3 className="text-sm font-medium tracking-tight">Failed (DLQ)</h3>
            <AlertTriangle className="w-4 h-4 text-red-500" />
          </div>
          <div className="text-2xl font-bold">{metrics.failed}</div>
        </div>

        <div className="p-6 bg-card border rounded-xl shadow-sm">
          <div className="flex flex-row items-center justify-between pb-2 space-y-0">
            <h3 className="text-sm font-medium tracking-tight">Delayed</h3>
            <AlertOctagon className="w-4 h-4 text-yellow-500" />
          </div>
          <div className="text-2xl font-bold">{metrics.delayed}</div>
        </div>
      </div>
    </div>
  );
}
