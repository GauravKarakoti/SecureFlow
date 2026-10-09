import Link from "next/link";
import Image from "next/image";
import { GitBranch, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Footer } from "@/components/footer";
import { ErrorState } from "@/components/error-state";

/**
 * Branded 404 (#560).
 *
 * Aligned with the global UI and theme layout. Replaces the default
 * black-on-white Next.js page, offering a consistent navigation bar,
 * theme toggle, branded 404 card, and global footer.
 * Reached by unknown URLs and by any `notFound()` call.
 *
 * No `reset()` here: a 404 is not transient, so offering "Try again" would just
 * re-render the same 404.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Navigation */}
      <nav className="border-b border-border/40 px-4 sm:px-6 py-4 flex items-center justify-between glass-card sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2 flex-shrink-0">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary glow-primary">
            <Image
              src="/logo.png"
              alt="SecureFlow Logo"
              width={64}
              height={64}
              className="object-contain"
            />
          </div>
          <span className="font-headline font-bold text-xl tracking-widest uppercase">
            SecureFlow
          </span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-4">
          <ThemeToggle />
          <Link
            href="/leaderboard"
            className="hidden sm:inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted-foreground hover:text-primary transition-colors"
          >
            <Trophy className="w-4 h-4" />
            Leaderboard
          </Link>
          <Link href="/dashboard">
            <Button
              variant="outline"
              className="hidden sm:inline-flex hover:border-primary/30 hover:bg-primary/5"
            >
              Dashboard
            </Button>
          </Link>
          <Link href={process.env.GITHUB_APP_URL || "/setup"}>
            <Button className="bg-primary text-background hover:bg-primary/90 glow-primary rounded-sm font-bold uppercase tracking-wide cursor-pointer">
              <GitBranch className="w-4 h-4 mr-2" />
              Engage System
            </Button>
          </Link>
        </div>
      </nav>

      {/* Main Content */}
      <main className="relative flex-1 flex flex-col items-center justify-center px-4 py-12 sm:px-6 overflow-hidden">
        {/* Ambient background glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-4xl h-[500px] bg-[radial-gradient(circle_at_center,rgba(229,9,20,0.12)_0%,transparent_70%)] pointer-events-none" />

        <div className="relative z-10 w-full flex items-center justify-center">
          <ErrorState
            code="404"
            title="Nothing at this address"
            description="This page does not exist, or the resource it pointed at has been removed. If you followed a shared link, the transmission may have expired."
            showHomeLink
          />
        </div>
      </main>

      {/* Footer */}
      <Footer />
    </div>
  );
}
