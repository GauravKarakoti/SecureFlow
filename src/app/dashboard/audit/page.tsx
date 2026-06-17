import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Search, Filter, Download, User, Activity, Database } from "lucide-react";
import prisma from "@/lib/prisma";

export default async function AuditPage() {
  // Fetch real logs from the DB
  const logs = await prisma.auditLog.findMany({
    orderBy: { timestamp: 'desc' },
    take: 100, // Limit to 100 recent logs for performance
  });

  // Calculate stats dynamically
  const activeAdminsCount = await prisma.user.count();
  
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const actions24hCount = await prisma.auditLog.count({
    where: { timestamp: { gte: yesterday } }
  });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight mb-2">Audit Logs</h1>
          <p className="text-muted-foreground">Comprehensive trail of all security decisions and system actions.</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs font-bold text-muted-foreground hover:text-white transition-colors">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white/5 rounded-xl border border-white/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <User className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Active Admins</div>
            <div className="text-lg font-bold">{activeAdminsCount} Users</div>
          </div>
        </div>
        <div className="bg-white/5 rounded-xl border border-white/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-secondary/10 flex items-center justify-center text-secondary">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">System Actions</div>
            <div className="text-lg font-bold">{actions24hCount.toLocaleString()} (24h)</div>
          </div>
        </div>
        <div className="bg-white/5 rounded-xl border border-white/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400">
            <Database className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Data Retention</div>
            <div className="text-lg font-bold">90 Days</div>
          </div>
        </div>
      </div>

      <Card className="glass-card">
        <CardHeader className="flex flex-row items-center justify-between border-b border-white/5 pb-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input 
              className="bg-white/5 border border-white/10 rounded-lg pl-10 pr-4 py-2 text-xs w-80 focus:outline-none" 
              placeholder="Filter by user, action or PR..."
            />
          </div>
          <div className="flex gap-2">
            <button className="p-2 rounded-lg bg-white/5 border border-white/10 text-muted-foreground hover:text-white">
              <Filter className="w-4 h-4" />
            </button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-white/5">
              <TableRow className="border-b border-white/5 hover:bg-transparent">
                <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4">Action</TableHead>
                <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4">User</TableHead>
                <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4">Resource</TableHead>
                <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4">Decision</TableHead>
                <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4 text-right">Timestamp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const displayUser = log.userId || "System";
                return (
                  <TableRow key={log.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <TableCell className="py-4">
                      <span className="font-bold text-sm">{log.action}</span>
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-[8px] font-bold">
                          {displayUser[0].toUpperCase()}
                        </div>
                        <span className="text-xs font-medium">{displayUser}</span>
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      <span className="text-xs text-muted-foreground font-mono">{log.resource}</span>
                    </TableCell>
                    <TableCell className="py-4">
                      <Badge variant={
                        log.decision === 'BLOCK' ? 'destructive' : 
                        log.decision === 'SUCCESS' ? 'default' : 'secondary'
                      } className="text-[10px] tracking-widest px-1.5">
                        {log.decision || 'INFO'}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-4 text-right">
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {new Intl.DateTimeFormat('en-US', { 
                          dateStyle: 'medium', 
                          timeStyle: 'short' 
                        }).format(new Date(log.timestamp))}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}