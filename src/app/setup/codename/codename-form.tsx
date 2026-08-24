"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { setCrewCodename } from "./actions";
import { RESISTANCE_CITIES } from "./constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Dice5,
  Shield,
  CheckCircle2,
  ArrowRight,
  Lock,
  Globe,
  Terminal,
  AlertTriangle,
} from "lucide-react";

export function CodenameForm({ initialName }: { initialName?: string | null }) {
  const router = useRouter();
  const { update } = useSession();
  const { toast } = useToast();
  const [codename, setCodename] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isRolling, setIsRolling] = useState(false);

  const handleRollDice = () => {
    setIsRolling(true);
    setError(null);
    let count = 0;
    const interval = setInterval(() => {
      const randomCity = RESISTANCE_CITIES[Math.floor(Math.random() * RESISTANCE_CITIES.length)];
      setCodename(randomCity);
      count++;
      if (count >= 8) {
        clearInterval(interval);
        setIsRolling(false);
      }
    }, 60);
  };

  const handleSelectCity = (city: string) => {
    setCodename(city);
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!codename.trim()) {
      setError("Please choose or generate a city codename.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const res = await setCrewCodename(codename);
      if (!res.success) {
        setError(res.error || "Failed to secure codename.");
        toast({
          title: "TRANSMISSION REJECTED",
          description: res.error || "Could not lock in codename.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "🎭 IDENTITY SECURED // CLEARANCE GRANTED",
          description: `Welcome to the Resistance, Agent ${res.codename}. Redirecting to Mission Control...`,
          variant: "success",
        });
        // Refresh session state to propagate new codename to JWT token
        await update({ codename: res.codename });
        // Full navigation ensures middleware and SSR components receive updated session cookie
        window.location.href = "/dashboard";
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Warning Notice Banner */}
      <div className="rounded-lg border border-red-500/30 bg-red-950/20 p-3.5 text-xs sm:text-sm text-red-400 flex items-start gap-3 shadow-inner">
        <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
        <div>
          <span className="font-mono font-bold uppercase tracking-wider block mb-0.5">
            Security Protocol 0x01: Identity Minimization
          </span>
          No real names or personal identities allowed in Vault logs. All crew members must operate under a designated city codename.
        </div>
      </div>

      {/* Codename Input Group */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <label htmlFor="codename-input" className="font-mono font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-primary" /> City Codename
          </label>
          <span className="text-[10px] font-mono text-muted-foreground/80">
            Letters, numbers & hyphens (2-30 chars)
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Terminal className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="codename-input"
              type="text"
              placeholder="e.g. Tokyo, Berlin, Nairobi..."
              value={codename}
              onChange={(e) => {
                setCodename(e.target.value);
                if (error) setError(null);
              }}
              disabled={isPending || isRolling}
              maxLength={30}
              className="pl-9 font-mono text-sm tracking-wide bg-background/60 border-foreground/20 focus-visible:ring-primary focus-visible:border-primary h-11"
              autoFocus
            />
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={handleRollDice}
            disabled={isPending || isRolling}
            className="h-11 px-3.5 border-foreground/20 hover:bg-primary/10 hover:border-primary/50 text-xs font-mono gap-1.5 shrink-0"
            title="Generate Random Resistance City"
          >
            <Dice5 className={`w-4 h-4 text-primary ${isRolling ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Random</span>
          </Button>
        </div>

        {error && (
          <p className="text-xs font-medium text-red-500 font-mono flex items-center gap-1 mt-1.5">
            <Lock className="w-3 h-3" /> {error}
          </p>
        )}
      </div>

      {/* Suggested Resistance Cities */}
      <div className="space-y-2 pt-1">
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground flex items-center justify-between">
          <span>Resistance City Registry (Quick Pick)</span>
          <span className="text-[9px] text-muted-foreground/60">{RESISTANCE_CITIES.length} Available</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2 max-h-48 overflow-y-auto pr-1 p-0.5">
          {RESISTANCE_CITIES.map((city) => {
            const isSelected = codename.toLowerCase() === city.toLowerCase();
            return (
              <button
                key={city}
                type="button"
                onClick={() => handleSelectCity(city)}
                disabled={isPending}
                className={`px-3 py-1.5 text-xs font-mono rounded-md border text-center transition-all ${
                  isSelected
                    ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/20 scale-[1.02] font-semibold"
                    : "bg-background/40 hover:bg-primary/10 hover:border-primary/30 border-foreground/10 text-muted-foreground hover:text-foreground"
                }`}
              >
                {city}
              </button>
            );
          })}
        </div>
      </div>

      {/* Submit Button */}
      <div className="pt-3 border-t border-foreground/10">
        <Button
          type="submit"
          disabled={isPending || isRolling || !codename.trim()}
          className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-bold tracking-wider uppercase text-xs shadow-lg shadow-primary/20 gap-2"
        >
          {isPending ? (
            <>
              <Shield className="w-4 h-4 animate-spin" /> Securing Identity in Vault...
            </>
          ) : (
            <>
              <CheckCircle2 className="w-4 h-4" /> Finalize Naming Ceremony & Enter Vault <ArrowRight className="w-4 h-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
