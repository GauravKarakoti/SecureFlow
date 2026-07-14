"use client";

import CountUp from "react-countup";
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
  <div className="space-y-8 max-w-5xl animate-in fade-in duration-700">
      <div>
       <span className="text-sm font-medium uppercase tracking-widest text-primary">
  Security Center
</span>

<h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">
  Security Findings
</h1>

<p className="mt-2 max-w-2xl text-muted-foreground">
  Review detected threats, vulnerabilities, and repository security insights across your organization.
</p>
        <p className="text-muted-foreground">Analysis of all detected issues across your organization.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatBox icon={<AlertOctagon />} value={stats.criticalSecrets} label="Critical Secrets" color="red" />
        <StatBox icon={<ShieldAlert />} value={stats.vulnerabilities} label="Vulnerabilities" color="orange" />
        <StatBox icon={<Info />} value={stats.misconfigs} label="Misconfigs" color="blue" />
      </div>

      <Card className="glass-card">
        <CardHeader className="flex flex-row items-center justify-between">
  <CardTitle className="text-lg">Recent Findings</CardTitle>

  <Badge
    variant="outline"
    className="border-primary/20 bg-primary/5 text-primary"
  >
    {findings.length} {findings.length === 1 ? "Finding" : "Findings"}
  </Badge>
</CardHeader>
        
     <CardContent className="min-h-[520px] flex items-center justify-center">
  {findings.length === 0 ? (
   <div className="flex min-h-[320px] flex-col items-center justify-center text-center">
     <ShieldAlert className="mb-5 h-16 w-16 text-red-500 opacity-70" />

<h3 className="text-2xl font-bold">
  No Security Findings
</h3>

<p className="mt-3 max-w-md text-sm text-muted-foreground">
  Great news! Your repositories are currently secure.
</p>

<p className="mt-2 text-xs text-muted-foreground">
  Continue scanning your repositories to detect future vulnerabilities.
</p>
    </div>
  ) : (
    <Accordion type="single" collapsible className="space-y-4">
      
      {findings.map((finding) => {
        const theme = getSeverityTheme(finding.severity);
           
        return (
              <AccordionItem key={finding.id} value={finding.id} 
            className="border border-white/10 rounded-xl overflow-hidden px-4 transition-all duration-300 hover:border-primary/40 hover:shadow-lg">
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
                    <div className="rounded-xl border border-primary/20 bg-black/60 p-6 font-mono text-[11px] text-primary overflow-x-auto whitespace-pre shadow-inner">
                        {finding.codeSnippet || 'Code snippet unavailable.'}
                      </div>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
              );
            })}
          </Accordion>
  )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatBox({
  icon,
  value,
  label,
  color,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  color: "red" | "orange" | "blue";
}) {
  const styles = {
    red: {
      border: "border-red-500/20",
      bg: "bg-red-500/10",
      text: "text-red-400",
    },
    orange: {
      border: "border-orange-500/20",
      bg: "bg-orange-500/10",
      text: "text-orange-400",
    },
    blue: {
      border: "border-blue-500/20",
      bg: "bg-blue-500/10",
      text: "text-blue-400",
    },
  };

 const theme = styles[color];

return (
 <Card
  className={`glass-card group overflow-hidden transition-all duration-300
  hover:-translate-y-2
  hover:shadow-2xl
  hover:border-primary/40
  cursor-pointer
  ${theme.border}`}
>
    <CardContent className="flex flex-col items-center p-6">
     <div
  className={`mb-4 flex h-14 w-14 items-center justify-center rounded-full
  ${theme.bg} ${theme.text}
  transition-all duration-300
  group-hover:scale-110
  group-hover:rotate-6`}
>
        {icon}
      </div>

      <h3 className="text-4xl font-bold">
        <CountUp end={value} duration={1.8} />
      </h3>

      <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
    </CardContent>
  </Card>
);
}