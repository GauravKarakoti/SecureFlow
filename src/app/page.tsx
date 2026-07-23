import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Shield, Lock, ArrowRight, CheckCircle, Search, Cpu, ChevronDown, GitPullRequest, ScanSearch, GitMerge, GitBranch, Trophy } from 'lucide-react';
import Image from 'next/image';
import { LoginButton } from '@/components/ui/login-button';
import { ThemeToggle } from '@/components/theme-toggle';
import InteractiveDemo from '@/components/landing/InteractiveDemo';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export default async function LandingPage() {
  let prsCount = 45208;
  let secretsCount = 1842;
  let reposCount = 948;

  try {
    const [dbPrs, dbSecrets, dbRepos] = await Promise.all([
      prisma.pullRequest.count(),
      prisma.finding.count({
        where: {
          type: {
            in: ['Secret', 'Hardcoded Secret', 'Data Leak', 'Contextual Leak']
          }
        }
      }),
      prisma.repository.count()
    ]);

    prsCount = dbPrs;
    secretsCount = dbSecrets;
    reposCount = dbRepos;
  } catch (error) {
    console.error("Failed to fetch landing page stats from database:", error);
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Navigation */}
      <nav className="border-b border-white/10 px-4 sm:px-6 py-4 flex items-center justify-between glass-card sticky top-0 z-50">
       <div className="flex items-center gap-2 flex-shrink-0">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary glow-primary">
            <Image 
              src="/logo.png" 
              alt="SecureFlow Logo" 
              width={64} 
              height={64} 
              className="object-contain"
            />
          </div>
          <span className="font-headline font-bold text-xl tracking-widest uppercase">SecureFlow</span>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-4">
            <ThemeToggle />
          </div>
          <Link
            href="/leaderboard"
            className="hidden sm:inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted-foreground hover:text-primary transition-colors"
          >
            <Trophy className="w-4 h-4" />
            Leaderboard
          </Link>
          <LoginButton />
          <Link href={process.env.GITHUB_APP_URL || '/setup'}>
            <Button className="bg-primary text-background hover:bg-primary/90 glow-primary rounded-sm font-bold uppercase tracking-wide cursor-pointer">
              <GitBranch className="w-4 h-4 mr-2" />
              Engage System
            </Button>
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-12 md:pt-16 pb-20 md:pb-32 px-4 sm:px-6 overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[600px] bg-[radial-gradient(circle_at_center,rgba(229,9,20,0.15)_0%,transparent_70%)] pointer-events-none" />
        
        <div className="max-w-6xl mx-auto text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-sm bg-primary/10 border border-primary/20 text-xs font-bold text-primary mb-6 tracking-widest">
            <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
            SECURITY BARRIER ENGAGED
          </div>
          <h1 className="font-headline text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tighter mb-6 md:mb-8 leading-tight uppercase">
            The Digital Heist <br /><span className="text-gradient">Defense System</span>
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto mb-4 leading-relaxed px-2 font-medium">
            In this heist... we&apos;re not stealing. We&apos;re protecting digital information.
          </p>
          <p className="text-sm text-muted-foreground max-w-2xl mx-auto mb-8 md:mb-10 leading-relaxed px-2">
            Every heist needs a plan... We make sure hackers don&apos;t have one. &ldquo;The Professor&rdquo; orchestrates your CI/CD, scanning every PR for leaks before they breach The Vault.
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-4 w-full sm:w-auto mb-16">
            <Link href="https://github.com/GauravKarakoti/SecureFlow/tree/main/docs" target="_blank" rel="noopener noreferrer">
              <Button size="lg" className="h-14 px-8 text-lg bg-primary text-background hover:bg-primary/90 hover:scale-105 transition-all duration-300 glow-primary font-bold uppercase rounded-sm cursor-pointer">
               Initiate Defense
               <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <Link href="https://github.com/GauravKarakoti/SecureFlow/tree/main/docs" target="_blank" rel="noopener noreferrer">
              <Button
               size="lg"
               variant="ghost"
               className="h-14 px-8 text-lg border border-transparent hover:border-primary/30 hover:bg-primary/5 hover:scale-105 transition-all duration-300 cursor-pointer"
>              View Documentation
              </Button>
            </Link>
          </div>
        </div>

        {/* Hero Interactive Terminal & Counters */}
        <div className="max-w-5xl mx-auto px-2 sm:px-4 relative z-10">
          <InteractiveDemo
            prsCount={prsCount}
            secretsCount={secretsCount}
            reposCount={reposCount}
          />
        </div>


        <div className="flex justify-center mt-12 animate-bounce">
          <a
            href="#features"
            className="text-muted-foreground hover:text-primary transition-colors"
          >
            <ChevronDown className="w-8 h-8" />
          </a>
         </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="pt-6 pb-14 px-6 border-t border-white/5 bg-black/40">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="font-headline text-3xl md:text-5xl font-bold mb-4 uppercase tracking-tight">Bella Ciao for Hackers</h2>
            <p className="text-muted-foreground text-lg">The system stops them before they even start.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard 
              icon={<Search className="text-primary w-6 h-6" />}
              title="The Watcher"
              description="Deep-context scanning for API keys and vulnerability signatures. Nothing gets past the perimeter."
            />
            <FeatureCard 
              icon={<Cpu className="text-primary w-6 h-6" />}
              title="The Professor"
              description="Our AI engine calculates the exact risk and dictates the remediation strategy with cold precision."
            />
            <FeatureCard 
              icon={<Shield className="text-primary w-6 h-6" />}
              title="Defense Strategy"
              description="Define custom merge gates based on severity. Automate your security decisions at scale."
            />
          </div>
        </div>
      </section>

      <section className="py-20 px-6">
  <div className="max-w-6xl mx-auto">
    <div className="text-center mb-16">
      <h2 className="font-headline text-3xl md:text-5xl font-bold mb-4">
        How SecureFlow Works
      </h2>
      <p className="text-muted-foreground text-lg">
        Secure every pull request in three simple steps.
      </p>
    </div>

    <div className="grid md:grid-cols-3 gap-8">

      <div className="glass-card p-8 rounded-2xl border border-white/5 hover:border-primary/20 transition-all duration-300 hover:-translate-y-2">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-6">
          <GitPullRequest className="w-7 h-7 text-primary" />
        </div>
        <h3 className="text-xl font-bold mb-3">1. Open a Pull Request</h3>
        <p className="text-muted-foreground">
          Developers create a pull request as part of their normal workflow.
        </p>
      </div>

      <div className="glass-card p-8 rounded-2xl border border-white/5 hover:border-primary/20 transition-all duration-300 hover:-translate-y-2">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-6">
          <ScanSearch className="w-7 h-7 text-primary" />
        </div>
        <h3 className="text-xl font-bold mb-3">2. Automated Security Scan</h3>
        <p className="text-muted-foreground">
          SecureFlow detects secrets, vulnerabilities, and risky code before merging.
        </p>
      </div>

      <div className="glass-card p-8 rounded-2xl border border-white/5 hover:border-primary/20 transition-all duration-300 hover:-translate-y-2">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-6">
          <GitMerge className="w-7 h-7 text-primary" />
        </div>
        <h3 className="text-xl font-bold mb-3">3. Merge with Confidence</h3>
        <p className="text-muted-foreground">
          Only secure pull requests move forward, helping teams ship safely.
        </p>
      </div>

    </div>
  </div>
</section>

      {/* Footer */}
      <footer className="mt-auto border-t border-white/5 px-6 py-12 bg-background">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded flex items-center justify-center bg-primary glow-primary">
              <Image 
                src="/logo.png" 
                alt="SecureFlow Logo" 
                width={64} 
                height={64} 
                className="object-contain"
              />
            </div>
            <span className="font-headline font-bold text-lg tracking-tight">SecureFlow</span>
          </div>
          <div className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} SecureFlow Inc. All rights reserved.
          </div>
          <div className="flex items-center gap-6">
            <Link href="https://x.com/GauravKara_Koti" className="text-muted-foreground hover:text-white transition-colors">Twitter</Link>
            <Link href="https://github.com/GauravKarakoti/SecureFlow" className="text-muted-foreground hover:text-white transition-colors">GitHub</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode, title: string, description: string }) {
  return (
    <div className="p-8 rounded-sm bg-black/60 border border-white/10 hover:border-primary/50 hover:-translate-y-2 hover:shadow-2xl hover:shadow-primary/10 transition-all duration-300 group relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-1 bg-primary/20 group-hover:bg-primary transition-colors" />
      <div className="w-12 h-12 rounded-sm bg-white/5 border border-white/10 flex items-center justify-center mb-6 group-hover:bg-primary/10 transition-colors">
        {icon}
      </div>
      <h3 className="font-headline text-xl font-bold mb-3 uppercase tracking-wide">{title}</h3>
      <p className="text-muted-foreground leading-relaxed">
        {description}
      </p>
    </div>
  );
}