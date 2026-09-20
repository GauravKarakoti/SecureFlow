import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  BellRing,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  GitPullRequest,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  ScanSearch,
  ShieldCheck,
  Terminal,
  Trophy,
  Workflow,
} from "lucide-react";
import Image from "next/image";
import { ThemeToggle } from "@/components/theme-toggle";

const sections = [
  { id: "getting-started", label: "Getting Started", icon: BookOpen },
  { id: "security-overview", label: "Security Overview", icon: ShieldCheck },
  { id: "scanning", label: "PR & Secret Scanning", icon: ScanSearch },
  { id: "ci-cd", label: "CI/CD Integration", icon: Workflow },
  { id: "authentication", label: "Authentication", icon: LockKeyhole },
  { id: "alerts", label: "Security Alerts", icon: BellRing },
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "leaderboard", label: "Leaderboard", icon: Trophy },
  { id: "faq", label: "FAQ", icon: CircleHelp },
];

export const metadata = {
  title: "Documentation | SecureFlow",
  description: "Learn how SecureFlow protects pull requests, secrets, and CI/CD pipelines.",
};

export default function DocumentationPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-50 border-b border-white/10 bg-background/90 px-4 py-4 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2" aria-label="Back to SecureFlow home">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary glow-primary">
              <Image src="/logo.png" alt="" width={64} height={64} className="object-contain" />
            </div>
            <span className="font-headline text-lg font-bold uppercase tracking-[0.2em]">
              SecureFlow
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/"
              className="hidden items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted-foreground transition-colors hover:text-primary sm:flex"
            >
              <ArrowLeft className="h-4 w-4" /> Home
            </Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-16 lg:py-16">
        <aside className="lg:sticky lg:top-28 lg:h-fit">
          <p className="mb-4 text-xs font-bold uppercase tracking-[0.25em] text-primary">
            Field manual
          </p>
          <nav
            aria-label="Documentation sections"
            className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-1"
          >
            {sections.map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                href={`#${id}`}
                className="group flex items-center gap-2 border-l border-white/10 px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              >
                <Icon className="h-4 w-4 shrink-0 text-primary/70 group-hover:text-primary" />
                <span>{label}</span>
              </a>
            ))}
          </nav>
        </aside>

        <article className="min-w-0">
          <header className="relative overflow-hidden border-b border-white/10 pb-12">
            <div className="absolute -right-24 -top-32 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
            <p className="relative mb-5 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.28em] text-primary">
              <span className="h-2 w-2 animate-pulse rounded-full bg-primary" /> System
              documentation
            </p>
            <h1 className="relative max-w-4xl font-headline text-4xl font-bold uppercase leading-[1.05] tracking-tight sm:text-6xl">
              Protect every change <span className="text-gradient">before it ships.</span>
            </h1>
            <p className="relative mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
              SecureFlow is the security barrier around your GitHub workflow. It scans pull
              requests, catches exposed secrets, and gives teams a clear decision before code
              reaches production.
            </p>
            <div className="relative mt-8 flex flex-wrap gap-3 text-sm">
              <Link
                href="/setup"
                className="inline-flex items-center gap-2 bg-primary px-4 py-3 font-bold uppercase tracking-wide text-background transition-transform hover:-translate-y-0.5"
              >
                Connect GitHub <ArrowUpRight className="h-4 w-4" />
              </Link>
              <a
                href="#getting-started"
                className="inline-flex items-center gap-2 border border-white/15 px-4 py-3 font-bold uppercase tracking-wide text-muted-foreground hover:border-primary hover:text-foreground"
              >
                Read the brief <ChevronRight className="h-4 w-4" />
              </a>
              <Link
                href="/docs/api-playground"
                className="inline-flex items-center gap-2 border border-white/15 px-4 py-3 font-bold uppercase tracking-wide text-muted-foreground hover:border-primary hover:text-foreground"
              >
                API playground <Terminal className="h-4 w-4" />
              </Link>
            </div>
          </header>

          <div className="divide-y divide-white/10">
            <DocSection
              id="getting-started"
              eyebrow="01 / First contact"
              title="Getting Started"
              icon={<BookOpen />}
            >
              <p>
                SecureFlow works with a GitHub App and a PostgreSQL-backed workspace. Setup takes
                three steps:
              </p>
              <div className="mt-6 grid gap-3 md:grid-cols-3">
                <Step
                  number="01"
                  title="Configure"
                  text="Add the GitHub App and OAuth credentials to your environment."
                />
                <Step
                  number="02"
                  title="Install"
                  text="Install SecureFlow on the repositories you want to protect."
                />
                <Step
                  number="03"
                  title="Open a PR"
                  text="Create a pull request and let the scanner report its verdict."
                />
              </div>
              <CodeBlock>
                npm install{`\n`}cp .env.example .env{`\n`}npm run db:migrate{`\n`}npm run dev
              </CodeBlock>
            </DocSection>

            <DocSection
              id="security-overview"
              eyebrow="02 / Perimeter"
              title="Security Overview"
              icon={<ShieldCheck />}
            >
              <p>
                SecureFlow turns security checks into an auditable decision system rather than a
                last-minute review.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <Feature
                  icon={<KeyRound />}
                  title="Secret detection"
                  text="Finds API keys, tokens, credentials, and high-confidence leaked material before merge."
                />
                <Feature
                  icon={<LockKeyhole />}
                  title="Policy gates"
                  text="Map severity to pass, review, or blocked states with rules your team controls."
                />
                <Feature
                  icon={<BellRing />}
                  title="Auditable actions"
                  text="Records security decisions and workflow events for investigation and compliance."
                />
                <Feature
                  icon={<ShieldCheck />}
                  title="Defense in depth"
                  text="Combines signatures, context-aware analysis, GitHub checks, and protected webhooks."
                />
              </div>
            </DocSection>

            <DocSection
              id="scanning"
              eyebrow="03 / The watcher"
              title="PR & Secret Scanning"
              icon={<ScanSearch />}
            >
              <p>
                Every pull request is evaluated as a change set. SecureFlow inspects the diff,
                classifies findings, and reports the result back to GitHub.
              </p>
              <ul className="mt-6 grid gap-3 sm:grid-cols-2">
                <Bullet>Hardcoded credentials and provider tokens</Bullet>
                <Bullet>Vulnerability signatures and risky patterns</Bullet>
                <Bullet>Changed files and pull request context</Bullet>
                <Bullet>Severity-aware remediation guidance</Bullet>
              </ul>
              <Callout>
                Findings are redacted and minimized before they are persisted or shown to users.
              </Callout>
            </DocSection>

            <DocSection
              id="ci-cd"
              eyebrow="04 / The pipeline"
              title="CI/CD Integration"
              icon={<Workflow />}
            >
              <p>
                GitHub webhooks acknowledge quickly, then queue scan work for asynchronous
                processing. This keeps the provider callback reliable while the deeper scan runs.
              </p>
              <div className="mt-6 grid gap-0 overflow-hidden border border-white/10 sm:grid-cols-4">
                {["Pull request", "Webhook", "Scan queue", "GitHub verdict"].map((label, index) => (
                  <div
                    key={label}
                    className="relative border-b border-white/10 p-4 last:border-0 sm:border-b-0 sm:border-r sm:last:border-0"
                  >
                    <span className="text-xs font-bold text-primary">0{index + 1}</span>
                    <p className="mt-3 text-sm font-semibold">{label}</p>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-sm text-muted-foreground">
                Use the repository status check as a merge gate in your protected branch rules.
              </p>
            </DocSection>

            <DocSection
              id="authentication"
              eyebrow="05 / Identity"
              title="Authentication"
              icon={<LockKeyhole />}
            >
              <p>
                Sign in with GitHub using OAuth. SecureFlow creates or retrieves your account,
                assigns the standard user role, encrypts the session as a JWT, and redirects you to
                the dashboard.
              </p>
              <div className="mt-6 border border-primary/20 bg-primary/5 p-5">
                <p className="text-sm font-bold uppercase tracking-wider text-primary">
                  Required environment
                </p>
                <p className="mt-3 font-mono text-sm leading-7 text-muted-foreground">
                  GITHUB_CLIENT_ID · GITHUB_CLIENT_SECRET · AUTH_SECRET · DATABASE_URL
                </p>
              </div>
            </DocSection>

            <DocSection
              id="alerts"
              eyebrow="06 / Response"
              title="Security Alerts"
              icon={<BellRing />}
            >
              <p>
                Alerts surface findings where developers already work. A finding includes its
                severity, file context, policy decision, and suggested next action.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((severity) => (
                  <span
                    key={severity}
                    className="border border-primary/30 px-3 py-2 text-xs font-bold tracking-widest text-primary"
                  >
                    {severity}
                  </span>
                ))}
              </div>
            </DocSection>

            <DocSection
              id="dashboard"
              eyebrow="07 / Mission control"
              title="Dashboard"
              icon={<LayoutDashboard />}
            >
              <p>
                The dashboard is the operational view for your workspace. Review active findings,
                scan status, repository coverage, policy outcomes, and the audit trail from one
                place.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <Metric
                  icon={<BarChart3 />}
                  label="Analytics"
                  text="Track trends and scan performance."
                />
                <Metric
                  icon={<GitPullRequest />}
                  label="Findings"
                  text="Prioritize what needs attention."
                />
                <Metric icon={<Terminal />} label="Audit" text="Inspect security decisions." />
              </div>
            </DocSection>

            <DocSection
              id="leaderboard"
              eyebrow="08 / Team signal"
              title="Leaderboard"
              icon={<Trophy />}
            >
              <p>
                The leaderboard turns secure engineering into a visible team signal. It highlights
                contributors by reviewed and resolved security work without exposing sensitive
                finding content.
              </p>
              <Link
                href="/leaderboard"
                className="mt-6 inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-primary hover:text-foreground"
              >
                View leaderboard <ArrowUpRight className="h-4 w-4" />
              </Link>
            </DocSection>

            <DocSection id="faq" eyebrow="09 / Quick answers" title="FAQ" icon={<CircleHelp />}>
              <div className="divide-y divide-white/10 border-y border-white/10">
                <Faq
                  question="Does SecureFlow block every pull request?"
                  answer="No. Policy thresholds decide what passes, needs review, or is blocked. Teams can tune those policies in the dashboard."
                />
                <Faq
                  question="Where are secrets stored?"
                  answer="Findings are minimized and redacted. OAuth credentials and application secrets stay in server-side environment variables."
                />
                <Faq
                  question="Can I scan private repositories?"
                  answer="Yes. Install the GitHub App only on the repositories and organizations you authorize."
                />
                <Faq
                  question="What happens when the scanner is busy?"
                  answer="The webhook is acknowledged and the scan is placed on a queue, so GitHub does not have to wait for the full analysis."
                />
              </div>
            </DocSection>
          </div>
        </article>
      </div>
    </main>
  );
}

function DocSection({
  id,
  eyebrow,
  title,
  icon,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 py-12 first:pt-10 sm:py-16">
      <div className="mb-6 flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
          {icon}
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">{eyebrow}</p>
          <h2 className="mt-2 font-headline text-2xl font-bold uppercase tracking-tight sm:text-3xl">
            {title}
          </h2>
        </div>
      </div>
      <div className="max-w-3xl text-base leading-8 text-muted-foreground">{children}</div>
    </section>
  );
}

function Step({ number, title, text }: { number: string; title: string; text: string }) {
  return (
    <div className="border border-white/10 p-4">
      <span className="font-mono text-xs text-primary">{number}</span>
      <h3 className="mt-4 font-bold text-foreground">{title}</h3>
      <p className="mt-2 text-sm leading-6">{text}</p>
    </div>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="border border-white/10 p-4">
      <div className="text-primary">{icon}</div>
      <h3 className="mt-4 font-bold text-foreground">{title}</h3>
      <p className="mt-2 text-sm leading-6">{text}</p>
    </div>
  );
}

function Metric({ icon, label, text }: { icon: React.ReactNode; label: string; text: string }) {
  return (
    <div className="border border-white/10 p-4">
      <div className="flex items-center gap-2 text-primary">
        {icon}
        <span className="font-bold text-foreground">{label}</span>
      </div>
      <p className="mt-2 text-sm leading-6">{text}</p>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-sm leading-6">
      <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-primary" />
      {children}
    </li>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 border-l-2 border-primary bg-primary/5 px-4 py-3 text-sm text-foreground">
      {children}
    </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-6 overflow-x-auto border border-white/10 bg-black/50 p-4 font-mono text-sm leading-7 text-primary">
      <code>{children}</code>
    </pre>
  );
}

function Faq({ question, answer }: { question: string; answer: string }) {
  return (
    <details className="group p-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-foreground [&::-webkit-details-marker]:hidden">
        {question}
        <ChevronRight className="h-4 w-4 shrink-0 text-primary transition-transform group-open:rotate-90" />
      </summary>
      <p className="mt-3 max-w-2xl pr-8 text-sm leading-7 text-muted-foreground">{answer}</p>
    </details>
  );
}
