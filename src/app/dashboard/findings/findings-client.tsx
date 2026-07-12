"use client";

import { Badge } from "@/components/ui/badge";
import { ShieldAlert, Info, CheckCircle2, AlertOctagon, Terminal, Cpu } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSeverityTheme } from "@/lib/severity-theme";

interface FindingsClientProps {
  findings: any[];
  stats: { criticalSecrets: number; vulnerabilities: number; misconfigs: number; };
}

export default function FindingsClient({ findings, stats }: FindingsClientProps) {
  return (
    <div className="space-y-8 max-w-5xl animate-in fade-in slide-in-from-bottom-2">
      <div>
        <h1 className="font-headline text-3xl font-bold tracking-tight mb-2">Security Findings</h1>
        <p className="text-muted-foreground">Analysis of all detected issues across your organization.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatBox icon={<AlertOctagon />} value={stats.criticalSecrets} label="Critical Secrets" color="red" />
        <StatBox icon={<ShieldAlert />} value={stats.vulnerabilities} label="Vulnerabilities" color="orange" />
        <StatBox icon={<Info />} value={stats.misconfigs} label="Misconfigs" color="blue" />
      </div>

      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="text-lg">Recent Findings</CardTitle>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible className="space-y-4">
            {findings.map((finding) => {
              const theme = getSeverityTheme(finding.severity);
              return (
              <AccordionItem key={finding.id} value={finding.id} className="border border-white/10 rounded-xl overflow-hidden px-4">
                <AccordionTrigger className="hover:no-underline py-4">
                  <div className="flex items-center gap-4 w-full text-left">
                    <div className="flex-1">
                      <div className="font-bold text-sm mb-0.5">{finding.type} Detected</div>
                      <div className="text-[10px] font-mono text-muted-foreground">{finding.fileLocation}</div>
                    </div>
                    {finding.promptInjectionSuspected && (
                      <Badge className="bg-yellow-500 text-black" title="The scanned code may contain content crafted to influence the AI explanation. Trust the severity badge over the narrative below.">
                        ⚠️ Verify manually
                      </Badge>
                    )}
                    <Badge className={theme.badgeClass} title={`Raw severity: ${finding.severity}`}>
                      {theme.label}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-6 pt-2">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pl-12 pr-4">
                    <div className="space-y-6">
                      {finding.promptInjectionSuspected && (
                        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-xs text-yellow-200">
                          ⚠️ <strong>AI explanation may be unreliable for this finding — verify manually.</strong> The scanned code may contain content crafted to look like instructions. The severity badge is set by the static scanner and is not affected by this.
                        </div>
                      )}
                      <div className="bg-primary/5 border border-primary/20 rounded-xl p-6 relative overflow-hidden group">
                        <h4 className="text-xs font-bold text-primary uppercase tracking-widest mb-3 flex items-center gap-2">
                          <Cpu className="w-3 h-3" /> Radio Comms
                        </h4>
                        <p className="text-sm leading-relaxed text-foreground/90 italic">
                          &quot;{finding.explanation || 'No explanation provided.'}&quot;
                        </p>
                      </div>
                      
                      <div>
                        <h4 className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                          <CheckCircle2 className="w-3 h-3" /> Remediation Steps
                        </h4>
                        <div className="text-sm text-muted-foreground leading-relaxed p-4 bg-white/5 border border-white/5 rounded-xl">
                          {finding.remediation || 'Follow standard security practices to resolve this.'}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1 flex items-center gap-2">
                        <Terminal className="w-3 h-3" /> Source Context
                      </h4>
                      <div className="bg-black/40 rounded-xl p-6 font-mono text-[10px] text-primary/80 border border-white/5 overflow-x-auto whitespace-pre">
                        {finding.codeSnippet || 'Code snippet unavailable.'}
                      </div>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
              );
            })}
          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
}

function StatBox({ icon, value, label, color }: any) {
  // Helper for rendering your top stats blocks based on passed color variants.
  return (
    <div className={`p-6 rounded-2xl glass-card border-${color}-500/20 flex flex-col items-center text-center`}>
      <div className={`w-12 h-12 rounded-full bg-${color}-500/10 flex items-center justify-center text-${color}-500 mb-4`}>
        {icon}
      </div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mt-1">{label}</div>
    </div>
  )
}