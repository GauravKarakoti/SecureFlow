
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Shield, Lock, Github, ArrowRight, CheckCircle, Search, Cpu, ChevronDown, GitPullRequest, ScanSearch, GitMerge } from 'lucide-react';
import Image from 'next/image';
import { LoginButton } from '@/components/ui/login-button';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Navigation */}
      <nav className="border-b border-white/5 px-4 sm:px-6 py-4 flex items-center justify-between glass-card sticky top-0 z-50">
       <div className="flex items-center gap-2 flex-shrink-0">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center glow-primary">
            <Image 
              src="/logo.jpeg" 
              alt="SecureFlow Logo" 
              width={28} 
              height={28} 
              className="object-contain"
            />
          </div>
          <span className="font-headline font-bold text-xl tracking-tight">SecureFlow</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <LoginButton />
          <Link href={process.env.GITHUB_APP_URL!}>
            <Button className="bg-primary text-background hover:bg-primary/90 glow-primary">
              <Github className="w-4 h-4 mr-2" />
              Install on GitHub
            </Button>
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-12 md:pt-16 pb-20 md:pb-32 px-4 sm:px-6 overflow-hidden">
        {/* Background Gradients */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[600px] bg-[radial-gradient(circle_at_center,rgba(146,123,255,0.08)_0%,transparent_70%)] pointer-events-none" />
        
        <div className="max-w-6xl mx-auto text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-semibold text-primary mb-6">
            <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
            V1.0 MVP NOW AVAILABLE
          </div>
          <h1 className="font-headline text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-6 md:mb-8 leading-tight">
            Automated <span className="text-gradient">Security Gatekeeper</span><br />
            for Modern CI/CD
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto mb-8 md:mb-10 leading-relaxed px-2">
            SecureFlow scans every Pull Request for secrets, vulnerabilities, and risky code patterns before they ever reach your production branch.
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-4 w-full sm:w-auto">
            <Link href="https://github.com/GauravKarakoti/SecureFlow/tree/main/docs" target="_blank" rel="noopener noreferrer">
              <Button
               size="lg"
               className="h-14 px-8 text-lg bg-primary text-background hover:bg-primary/90 hover:scale-105 transition-all duration-300 glow-primary font-semibold"
>              Get Started for Free
               <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <Link href="https://github.com/GauravKarakoti/SecureFlow/tree/main/docs" target="_blank" rel="noopener noreferrer">
              <Button
               size="lg"
               variant="ghost"
               className="h-14 px-8 text-lg border border-transparent hover:border-primary/30 hover:bg-primary/5 hover:scale-105 transition-all duration-300"
>              View Documentation

              </Button>
            </Link>
          </div>
        </div>

        {/* Hero Image Mockup */}
        <div className="max-w-5xl mx-auto mt-12 md:mt-20 relative px-2 sm:px-4">
          <div className="relative rounded-2xl border border-white/10 overflow-hidden glass-card shadow-2xl">
            <div className="flex items-center gap-1.5 px-4 py-3 bg-white/5 border-b border-white/10">
              <div className="w-3 h-3 rounded-full bg-red-500/50" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/50" />
              <div className="w-3 h-3 rounded-full bg-green-500/50" />
              <div className="ml-4 text-xs font-mono text-muted-foreground">secureflow/dashboard/acme-corp</div>
            </div>
            <div className="relative aspect-video">
              <Image 
                src="https://picsum.photos/seed/secure-hero/1200/800"
                alt="Dashboard Mockup"
                fill
                className="object-cover opacity-80"
                data-ai-hint="cyber security network"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
              
              {/* Floating Cards */}
              <div className="absolute bottom-8 left-8 p-4 rounded-xl glass-card border-primary/20 animate-bounce duration-[3000ms]">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-red-500/20 text-red-400">
                    <Lock className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-sm font-bold">Secret Detected</div>
                    <div className="text-xs text-muted-foreground">PR #452 Blocked</div>
                  </div>
                </div>
              </div>

              <div className="absolute top-1/4 right-8 p-4 rounded-xl glass-card border-primary/20">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-green-500/20 text-green-400">
                    <CheckCircle className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-sm font-bold">Scan Clean</div>
                    <div className="text-xs text-muted-foreground">Approved for Merge</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
          <div className="flex justify-center mt-10 animate-bounce">
          <a
            href="#features"
            className="text-muted-foreground hover:text-primary transition-colors"
          >
            <ChevronDown className="w-8 h-8" />
          </a>
         </div>
      
      </section>

      {/* Features Grid */}
      <section id="features" className="pt-6 pb-14 px-6 bg-card/30">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="font-headline text-3xl md:text-5xl font-bold mb-4">Securing every commit</h2>
            <p className="text-muted-foreground text-lg">Integrated tools to make your developer experience safer.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard 
              icon={<Search className="text-primary w-6 h-6" />}
              title="ArmorIQ Scanner"
              description="Deep-context scanning for API keys, AWS credentials, and thousands of known vulnerability signatures."
            />
            <FeatureCard 
              icon={<Cpu className="text-primary w-6 h-6" />}
              title="AI Security Reasoner"
              description="AI converts cryptic scanner output into plain English explanations and actionable fix suggestions."
            />
            <FeatureCard 
              icon={<Shield className="text-primary w-6 h-6" />}
              title="ArmorIQ Policies"
              description="Define custom merge gates based on severity and finding type. Automate security decisions at scale."
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
            <div className="w-6 h-6 rounded flex items-center justify-center">
              <Image 
                src="/logo.jpeg" 
                alt="SecureFlow Logo" 
                width={28} 
                height={28} 
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
    <div className="p-8 rounded-2xl glass-card border border-white/5 hover:border-primary/20 hover:-translate-y-2 hover:shadow-2xl hover:shadow-primary/20 hover:scale-[1.02] transition-all duration-300 group">
      <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mb-6 group-hover:bg-primary/10 transition-colors">
        {icon}
      </div>

      <h3 className="font-headline text-xl font-bold mb-3">{title}</h3>

      <p className="text-muted-foreground leading-relaxed">
        {description}
      </p>
    </div>
  );
}