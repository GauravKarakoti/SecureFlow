import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Lock, AlertCircle, ShieldCheck, HelpCircle, Plus } from "lucide-react";
import prisma from "@/lib/prisma";

export default async function PoliciesPage() {
  // Fetch real policies from the DB
  const policies = await prisma.policy.findMany({
    orderBy: { createdAt: 'desc' }
  });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight mb-2">ArmorIQ Policies</h1>
          <p className="text-muted-foreground">Define the automated logic used to protect your main branch.</p>
        </div>
        <Button className="bg-primary text-background hover:bg-primary/90">
          <Plus className="w-4 h-4 mr-2" /> New Policy
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {policies.length === 0 && (
          <div className="col-span-2 text-center text-muted-foreground p-8 border border-dashed border-white/10 rounded-xl">
            No policies found. Create your first policy to get started.
          </div>
        )}
        
        {policies.map((policy) => {
          // Parse the JSON rules field based on our expected metadata structure
          // Prisma types Json as any/JsonValue, so we safely cast to extract info
          const rulesMeta = (policy.rules as any) || {};
          
          return (
            <PolicyCard 
              key={policy.id}
              title={policy.name}
              description={rulesMeta.description || "Custom automated logic rule."}
              isActive={policy.isActive}
              severity={rulesMeta.severity || "MEDIUM"}
              action={rulesMeta.action || "REVIEW REQUIRED"}
              rules={rulesMeta.conditions || []}
            />
          );
        })}
      </div>
    </div>
  );
}

function PolicyCard({ title, description, isActive, severity, action, rules }: any) {
  return (
    <Card className={`glass-card relative overflow-hidden ${!isActive && 'opacity-60'}`}>
      <div className="absolute top-0 right-0 p-6 z-10">
        {/* Note: Connecting the Switch to update the DB will require wrapping it in a client component or using a Next.js Server Action */}
        <Switch checked={isActive} />
      </div>
      <CardHeader>
        <div className="flex items-center gap-3 mb-2">
          <div className={`p-2 rounded-lg ${isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
            <Lock className="w-5 h-5" />
          </div>
          <Badge variant="outline" className="text-[10px] tracking-widest">{action}</Badge>
        </div>
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {rules.length > 0 ? rules.map((rule: string, i: number) => (
            <div key={i} className="flex items-start gap-3 text-xs text-muted-foreground p-3 bg-white/5 border border-white/5 rounded-lg">
              <ShieldCheck className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
              {rule}
            </div>
          )) : (
            <div className="text-xs text-muted-foreground italic">No conditions defined.</div>
          )}
        </div>
        <div className="pt-4 flex items-center justify-between border-t border-white/5 text-[10px] font-bold uppercase text-muted-foreground">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-3 h-3" /> Minimum Severity: {severity}
          </div>
          <button className="hover:text-white transition-colors flex items-center gap-1">
            Edit Rules <HelpCircle className="w-3 h-3" />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}