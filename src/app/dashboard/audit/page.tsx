import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Shield, Activity, Database } from "lucide-react"; 
import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function AuditPage() {
  const session = await auth();
  
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }
  
  const userId = session.user.id;

  // Fetch real logs belonging to the user
  const logs = await prisma.auditLog.findMany({
    where: { userId },
    orderBy: { timestamp: 'desc' },
    take: 100, 
  });
  
  // FIX: Fetch User details to map User IDs to User Names/Emails
  const uniqueUserIds = [...new Set(logs.map(l => l.userId).filter((id): id is string => id !== null))];
  const users = await prisma.user.findMany({
    where: { id: { in: uniqueUserIds } },
    select: { id: true, name: true, email: true }
  });
  const userMap = new Map(users.map(u => [u.id, u.name || u.email || 'Unknown User']));
  
  const activeReposCount = await prisma.repository.count({
    where: { 
      userId,
      isActive: true
    }
  });
  
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  const actions24hCount = await prisma.auditLog.count({
    where: { 
      userId,
      timestamp: { gte: yesterday } 
    }
  });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight mb-2">Audit Logs</h1>
          <p className="text-muted-foreground">Comprehensive trail of all security decisions and system actions.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white/5 rounded-xl border border-white/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Monitored Repos</div>
            <div className="text-lg font-bold">{activeReposCount} Active</div>
          </div>
        </div>
        
        <div className="bg-white/5 rounded-xl border border-white/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-secondary/10 flex items-center justify-center text-secondary">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">System Actions</div>
            <div className="text-lg font-bold">{actions24hCount.toLocaleString()}</div>
          </div>
        </div>
      </div>

      <Card className="glass-card">
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
                // FIX: Retrieve user name from Map instead of rendering ID
                const displayUser = log.userId ? (userMap.get(log.userId) || log.userId) : "System";
                return (
                  <TableRow key={log.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <TableCell className="py-4">
                      <span className="font-bold text-sm">{log.action}</span>
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex items-center gap-2">
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