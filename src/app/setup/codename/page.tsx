"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { updateCodename } from "@/lib/actions/codename";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Shuffle, Check, Loader2, Lock } from "lucide-react";
import Image from "next/image";
import { ThemeToggle } from "@/components/theme-toggle";

const CITIES = [
  "Tokyo", "Berlin", "Nairobi", "Rio", "Denver",
  "Helsinki", "Oslo", "Bogota", "Palermo", "Moscow"
];

export default function CodenameSetupPage() {
  const { data: session, update } = useSession();
  const useRouterResult = useRouter();
  const [codename, setCodename] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleSelectCity = (city: string) => {
    setCodename(city);
    setError(null);
  };

  const handleRandomize = () => {
    const randomIndex = Math.floor(Math.random() * CITIES.length);
    setCodename(CITIES[randomIndex]);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPending) return;

    setError(null);
    setIsPending(true);

    try {
      const result = await updateCodename(codename);
      if (result.ok) {
        // Trigger NextAuth session update to sync the new codename
        await update();
        useRouterResult.push("/dashboard");
      } else {
        setError(result.error || "Failed to update codename.");
      }
    } catch (err) {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center relative overflow-hidden px-4">
      <div className="absolute top-6 right-6 z-20">
        <ThemeToggle />
      </div>

      {/* Cyber theme background gradients */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl h-[600px] bg-[radial-gradient(circle_at_center,rgba(235,5,20,0.08)_0%,transparent_60%)] pointer-events-none" />

      <div className="w-full max-w-lg p-8 rounded-lg glass-card border border-white/10 shadow-2xl relative z-10 flex flex-col items-center">
        {/* Logo */}
        <div className="w-14 h-14 rounded-md flex items-center justify-center bg-primary glow-primary mb-6">
          <Image
            src="/logo.png"
            alt="SecureFlow Logo"
            width={64}
            height={64}
            className="object-contain"
          />
        </div>

        {/* Title */}
        <h1 className="font-headline text-2xl sm:text-3xl font-bold mb-2 tracking-widest text-center uppercase text-foreground">
          The Naming Ceremony
        </h1>
        <p className="text-sm font-mono text-primary uppercase tracking-widest mb-6 flex items-center gap-1.5 justify-center">
          <Lock className="w-3.5 h-3.5" /> First Rule of the Heist
        </p>

        {/* Narrative Box */}
        <div className="w-full bg-white/5 border border-white/5 rounded-md p-4 mb-6 text-center text-sm font-mono text-muted-foreground leading-relaxed">
          &ldquo;No personal questions, no real names. In this crew, we protect the Vault in secrecy. Choose your city codename before we begin.&rdquo;
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="w-full space-y-6">
          <div className="space-y-2">
            <label className="text-xs font-mono font-bold uppercase tracking-wider text-muted-foreground block">
              Enter Your Codename (City Name)
            </label>
            <div className="relative flex items-center">
              <Input
                type="text"
                required
                placeholder="e.g. Marseille"
                value={codename}
                onChange={(e) => {
                  setCodename(e.target.value);
                  setError(null);
                }}
                className="bg-black/40 border-white/10 focus-visible:ring-primary focus-visible:border-primary text-foreground font-mono tracking-wide pr-10"
                disabled={isPending}
              />
              <button
                type="button"
                onClick={handleRandomize}
                title="Pick random city"
                className="absolute right-3 p-1 rounded-sm text-muted-foreground hover:text-primary hover:bg-white/5 transition-all"
                disabled={isPending}
              >
                <Shuffle className="w-4 h-4" />
              </button>
            </div>
            {error && (
              <p className="text-xs font-mono text-red-500 mt-1 uppercase tracking-wide">
                &bull; {error}
              </p>
            )}
          </div>

          {/* Preset Grid */}
          <div className="space-y-2">
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-muted-foreground block">
              Or Choose from the Core Crew
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {CITIES.map((city) => {
                const isSelected = codename.trim().toLowerCase() === city.toLowerCase();
                return (
                  <button
                    key={city}
                    type="button"
                    onClick={() => handleSelectCity(city)}
                    className={`px-2 py-1.5 rounded-sm border text-xs font-mono transition-all uppercase tracking-wider text-center ${
                      isSelected
                        ? "bg-primary/20 border-primary text-primary font-bold shadow-[0_0_10px_rgba(235,5,20,0.2)]"
                        : "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                    }`}
                    disabled={isPending}
                  >
                    {city}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Action button */}
          <Button
            type="submit"
            size="lg"
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-bold h-12 text-sm tracking-widest uppercase transition-all glow-primary"
            disabled={isPending || !codename.trim()}
          >
            {isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Updating Roster...
              </>
            ) : (
              <>
                <Check className="w-4 h-4 mr-2" />
                Join the Crew
              </>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
