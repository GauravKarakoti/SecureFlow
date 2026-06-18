"use client";

import { useOptimistic } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Lock, AlertCircle, ShieldCheck } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function PolicyCard({ 
  id, 
  title, 
  description, 
  isActive, 
  severity, 
  action, 
  rules, 
  toggleAction 
}: any) {
  // Initialize optimistic state using the real state from the database
  const [optimisticActive, addOptimisticActive] = useOptimistic(
    isActive,
    (currentState: boolean, optimisticValue: boolean) => optimisticValue
  );

  return (
    <Card className={`glass-card relative overflow-hidden flex flex-col transition-all duration-300 ${optimisticActive ? 'border-primary/30 shadow-[0_0_15px_rgba(var(--primary),0.1)]' : 'opacity-60 border-white/5'}`}>
      <div className="absolute top-0 right-0 p-5 z-10">
        <form action={async (formData) => {
          // 1. Instantly flip the UI state locally
          addOptimisticActive(!optimisticActive);
          
          // 2. Perform the server update in the background
          await toggleAction(formData);
        }}>
          <input type="hidden" name="templateId" value={id} />
          {/* Note: We pass the real DB isActive state to the server, not the optimistic one */}
          <input type="hidden" name="currentState" value={String(isActive)} />
          <button type="submit" className="hover:opacity-80 transition-opacity">
             <Switch checked={optimisticActive} className="pointer-events-none" aria-readonly />
          </button>
        </form>
      </div>
      
      <CardHeader className="pt-6">
        <div className="flex items-center gap-3 mb-3">
          <div className={`p-2 rounded-lg ${optimisticActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
            <Lock className="w-4 h-4" />
          </div>
          <Badge variant="outline" className={`text-[10px] tracking-widest ${optimisticActive ? 'border-primary/50 text-primary' : ''}`}>
            {action}
          </Badge>
        </div>
        
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <CardTitle className="text-lg pr-12">{title}</CardTitle>
            </TooltipTrigger>
            <TooltipContent 
              side="bottom" 
              align="start" 
              className="max-w-xs md:max-w-sm glass-card bg-black/90 border-white/10 text-slate-200 z-50 p-3"
            >
              <p className="text-xs leading-relaxed">{description}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>        
      </CardHeader>
      
      <CardContent className="space-y-4 flex-1">
        <div className="space-y-2">
          {rules.length > 0 ? rules.slice(0, 3).map((rule: string, i: number) => (
            <div key={i} className="flex items-start gap-3 text-xs text-muted-foreground p-2.5 bg-white/5 border border-white/5 rounded-md">
              <ShieldCheck className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${optimisticActive ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="font-mono text-[10px] truncate">{rule}</span>
            </div>
          )) : (
            <div className="text-xs text-muted-foreground italic p-2">Standard protection enabled.</div>
          )}
          {rules.length > 3 && (
             <div className="text-[10px] text-muted-foreground pl-2 italic">
               + {rules.length - 3} more condition{rules.length - 3 > 1 ? 's' : ''}
             </div>
          )}
        </div>
      </CardContent>
      
      <CardFooter className="pt-4 flex items-center justify-between border-t border-white/5 text-[10px] font-bold uppercase text-muted-foreground mt-auto bg-black/10">
        <div className="flex items-center gap-1.5">
          <AlertCircle className={`w-3 h-3 ${severity === 'CRITICAL' && optimisticActive ? 'text-red-400' : ''}`} /> 
          {severity}
        </div>
      </CardFooter>
    </Card>
  );
}