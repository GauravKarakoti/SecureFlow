import React from 'react';
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

export default async function AuditPage({ searchParams }: { searchParams: { cursor?: string } }) {
  const session = await auth();
  
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }
  
  const userId = session.user.id;

  const cursor = searchParams?.cursor;

  // Fetch real logs belonging to the user
  const logs = await prisma.auditLog.findMany({
    where: { userId },
    orderBy: { timestamp: 'desc' },
    take: 10, 
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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
                  <React.Fragment key={log.id}>
                    <TableRow className="border-b border-white/5 hover:bg-white/5 transition-colors">
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
                          log.decision === 'PASS' ? 'default' : 'secondary'
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
                    {log.decision === 'PASS' && (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <div className="mt-4">
                            <details className="group border border-red-500/20 bg-black rounded-lg p-4 cursor-pointer">
                              <summary className="text-red-500 font-bold outline-none flex items-center justify-between">
                                <span>📥 Reveal Heist Success Card</span>
                                <span className="text-xs text-red-500/70 group-open:hidden">Click to expand</span>
                              </summary>
                              
                              <div className="mt-6 flex flex-col items-center">
                                {/* Image Preview */}
                                <img 
                                  src={`/api/og/heist?project=${encodeURIComponent(log.resource || 'The Royal Mint')}`} 
                                  alt="Heist Success Card" 
                                  className="w-full max-w-2xl rounded-md border border-red-900/50 shadow-2xl mb-6"
                                />
                                {/* Share Button — links to /share/heist, which has proper OG/Twitter
                                    meta tags pointing at the image, so Twitter's card scraper can
                                    actually render a preview. Linking directly to the image API
                                    route (as before) doesn't work because that route returns a raw
                                    PNG, not an HTML page with meta tags. */}
                                <a 
                                  href={`https://twitter.com/intent/tweet?text=The%20vault%20is%20empty.%20Zero%20traces%20left%20behind.%20%F0%9F%8E%AD%0A%0AAudit%20passed%20via%20SecureFlow.&url=${encodeURIComponent(`https://secure-flow-six.vercel.app/share/heist?project=${log.resource || 'The Royal Mint'}`)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded shadow-lg transition-all"
                                >
                                  Broadcast to the Resistance 📢
                                </a>
                              </div>
                            </details>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}