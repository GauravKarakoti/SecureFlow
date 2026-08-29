"use client";

import { useOptimistic, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Lock, AlertCircle, ShieldCheck, FileKey2, ScanLine } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";

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
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();

  /**
   * Send the state the user asked for.
   *
   * `checked` is what the switch is being moved to. It used to be used for the
   * optimistic update and then discarded: the request carried `currentState`
   * — the `isActive` prop, which does not change until the server component
   * re-renders — and the action wrote `!currentState`. Two clicks before that
   * re-render sent the same previous state and wrote the same value twice, so
   * the switch showed off, the database said on, and the revalidation snapped
   * it back with no explanation (#660).
   *
   * The optimistic update is inside the transition so React reverts it on its
   * own when the action settles; the toast is what tells the user why.
   */
  const handleToggle = (checked: boolean) => {
    startTransition(async () => {
      addOptimisticActive(checked);

      const result = await toggleAction({ templateId: id, isActive: checked });

      if (!result?.ok) {
        toast({
          variant: "destructive",
          title: "Rule not updated",
          description: result?.error ?? "The rule could not be updated. Please try again.",
        });
      }
    });
  };

  return (
    <Card className={`glass-card group relative overflow-hidden flex flex-col rounded-sm transition-all duration-300 ${optimisticActive ? 'border-primary/40 shadow-[0_0_24px_hsl(var(--primary)/0.12)]' : 'opacity-60 border-foreground/10'}`}>
      <div className="absolute inset-x-0 top-0 h-1 bg-primary/80" aria-hidden="true" />
      <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(hsl(var(--foreground)/0.45)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.45)_1px,transparent_1px)] [background-size:18px_18px] pointer-events-none" aria-hidden="true" />
      <div className="absolute -right-12 -top-12 h-28 w-28 rotate-45 border border-primary/20 bg-primary/5" aria-hidden="true" />
      <div className="absolute top-5 right-5 z-10">
        <Switch
          checked={optimisticActive}
          disabled={isPending}
          onCheckedChange={handleToggle}
          aria-label={`${optimisticActive ? 'Disable' : 'Enable'} rule: ${title}`}
          className="focus-visible:ring-2 focus-visible:ring-primary"
        />
      </div>
      
      <CardHeader className="relative z-[1] pt-7 pb-4">
        <div className="flex items-center justify-between gap-3 mb-5 pr-12 text-[9px] font-mono uppercase tracking-[0.24em] text-muted-foreground">
          <span className="flex items-center gap-1.5"><FileKey2 className="w-3 h-3 text-primary" /> The Rules</span>
          <span className="flex items-center gap-1"><ScanLine className="w-3 h-3" /> Active file</span>
        </div>

        <div className="flex items-start gap-3 mb-3">
          <div className={`p-2.5 rounded-sm border ${optimisticActive ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-muted border-border text-muted-foreground'}`}>
            <Lock className="w-4 h-4" aria-hidden="true" />
          </div>
          <Badge variant="outline" className={`mt-0.5 text-[10px] tracking-widest rounded-sm ${optimisticActive ? 'border-primary/50 text-primary' : ''}`}>
            {action}
          </Badge>
        </div>
        
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <CardTitle className="text-lg leading-tight pr-12 cursor-help select-none">{title}</CardTitle>
            </TooltipTrigger>
            <TooltipContent 
              side="bottom" 
              align="center"
              sideOffset={6}
              collisionPadding={12}
              className="w-[calc(100vw-2rem)] max-w-[var(--radix-tooltip-trigger-width)] bg-neutral-950 dark:bg-zinc-950 text-neutral-100 dark:text-zinc-100 border border-neutral-800 dark:border-zinc-800 shadow-2xl z-50 p-3 rounded-md opacity-100 backdrop-blur-none"
            >
              <p className="text-xs leading-relaxed font-normal">{description}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>        
      </CardHeader>
      
      <CardContent className="relative z-[1] space-y-4 flex-1 pt-0">
        <div className="mb-3 border-l-2 border-primary/50 pl-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Rule conditions
        </div>
        <div className="space-y-2">
          {rules.length > 0 ? rules.slice(0, 3).map((rule: string, i: number) => (
            <div key={i} className="flex items-start gap-3 text-xs text-muted-foreground p-2.5 bg-background/40 border border-foreground/10 rounded-sm">
              <ShieldCheck className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${optimisticActive ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="font-mono text-[10px] truncate">{rule}</span>
            </div>
          )) : (
            <div className="text-xs text-muted-foreground italic p-2">Standard rule set enforced.</div>
          )}
          {rules.length > 3 && (
             <div className="text-[10px] text-muted-foreground pl-2 italic">
               + {rules.length - 3} more rule{rules.length - 3 > 1 ? 's' : ''}
             </div>
          )}
        </div>
      </CardContent>
      
      <CardFooter className="relative z-[1] pt-4 flex items-center justify-between border-t border-foreground/10 text-[10px] font-bold uppercase tracking-wider text-muted-foreground mt-auto bg-background/30">
        <div className="flex items-center gap-1.5">
          <AlertCircle className={`w-3 h-3 ${severity === 'CRITICAL' && optimisticActive ? 'text-red-400' : ''}`} aria-hidden="true" />
          {severity}
        </div>
        <span className="font-mono text-[9px] text-muted-foreground/70">SECUREFLOW // RULE</span>
      </CardFooter>
    </Card>
  );
}
