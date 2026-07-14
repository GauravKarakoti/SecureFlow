import Link from "next/link";
import Image from "next/image";
import { GitBranch, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoginButton } from "@/components/ui/login-button";
import { ThemeToggle } from "@/components/theme-toggle";
import LeaderboardClient from "./leaderboard-client";
import { loadLeaderboard } from "./aggregate";

export const dynamic = "force-dynamic";

// How many contributors to rank on the public board.
const TOP_N = 50;

export default async function LeaderboardPage() {
  const contributors = await loadLeaderboard(TOP_N);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Navigation — mirrors the landing page so the page stands on its own. */}
      <nav className="border-b border-white/10 px-4 sm:px-6 py-4 flex items-center justify-between glass-card sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2 flex-shrink-0">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary glow-primary">
            <Image src="/logo.png" alt="SecureFlow Logo" width={64} height={64} className="object-contain" />
          </div>
          <span className="font-headline font-bold text-xl tracking-widest uppercase">SecureFlow</span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-4">
          <ThemeToggle />
          <Link
            href="/"
            className="hidden sm:inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted-foreground hover:text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Home
          </Link>
          <LoginButton />
          <Link href={process.env.GITHUB_APP_URL!}>
            <Button className="bg-primary text-background hover:bg-primary/90 glow-primary rounded-sm font-bold uppercase tracking-wide">
              <GitBranch className="w-4 h-4 mr-2" />
              Engage System
            </Button>
          </Link>
        </div>
      </nav>

      {/* Body */}
      <main className="relative flex-1 px-4 pt-10 sm:px-6 sm:pt-14 overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[500px] bg-[radial-gradient(circle_at_center,rgba(229,9,20,0.12)_0%,transparent_70%)] pointer-events-none" />
        <div className="relative z-10">
          <LeaderboardClient contributors={contributors} />
        </div>
      </main>
    </div>
  );
}
