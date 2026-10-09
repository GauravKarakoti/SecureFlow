import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, BookOpen, KeyRound, ShieldAlert } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { ApiPlayground } from "@/components/docs/api-playground";

/** Where the browser fetches the spec from. See `src/app/api/openapi/route.ts`. */
const SPEC_URL = "/api/openapi";

export const metadata = {
  title: "API Playground | SecureFlow",
  description:
    "Explore and call the SecureFlow API interactively, generated from the project's OpenAPI specification.",
};

export default function ApiPlaygroundPage() {
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
              href="/docs"
              className="hidden items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted-foreground transition-colors hover:text-primary sm:flex"
            >
              <ArrowLeft className="h-4 w-4" /> Documentation
            </Link>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:py-16">
        <header className="relative overflow-hidden border-b border-white/10 pb-10">
          <div className="absolute -right-24 -top-32 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
          <p className="relative mb-5 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.28em] text-primary">
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary" /> Live API explorer
          </p>
          <h1 className="relative max-w-4xl font-headline text-4xl font-bold uppercase leading-[1.05] tracking-tight sm:text-5xl">
            Call the API <span className="text-gradient">from your browser.</span>
          </h1>
          <p className="relative mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            Every operation below is generated from{" "}
            <code className="rounded bg-white/10 px-1.5 py-0.5 text-base">openapi.yaml</code> in the
            repository, so this page describes the API as it is today rather than as it was when
            someone last updated a document by hand.
          </p>
        </header>

        <section className="mt-8 grid gap-4 md:grid-cols-3">
          <InfoCard
            icon={<KeyRound className="h-4 w-4" />}
            title="Authentication"
            body="Most routes authenticate with your SecureFlow session. Sign in first and requests you send from this page carry that session automatically."
          />
          <InfoCard
            icon={<ShieldAlert className="h-4 w-4" />}
            title="Webhooks"
            body="Webhook routes verify an HMAC signature that the browser cannot compute. Send those with the signed payload examples in the API reference instead."
          />
          <InfoCard
            icon={<BookOpen className="h-4 w-4" />}
            title="Written reference"
            body="Prefer prose? The API reference in docs/api.md covers the same routes with request and response examples."
          />
        </section>

        <p className="mt-8 text-sm text-muted-foreground">
          Requests you send here are real. Pick the server you mean to call from the dropdown below
          before pressing Execute — the production server is selected first.
        </p>

        <section className="mt-4" aria-label="Interactive API explorer">
          <ApiPlayground specUrl={SPEC_URL} />
        </section>
      </div>
    </main>
  );
}

function InfoCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="border border-white/10 bg-white/[0.02] p-5">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-primary">
        {icon} {title}
      </p>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}
