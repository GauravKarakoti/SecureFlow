import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Privacy Policy | SecureFlow",
  description: "How SecureFlow handles the data it processes when scanning pull requests.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to home
      </Link>

      <h1 className="font-headline mt-8 text-3xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This page is a working draft and is pending review before release.
      </p>

      <div className="mt-10 space-y-8 text-muted-foreground">
        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">What we process</h2>
          <p className="mt-2 leading-relaxed">
            SecureFlow reads the code diff of a pull request in order to scan it for secrets,
            vulnerabilities and misconfigurations. Scan results, including the file path and the
            matched snippet, are stored so they can be displayed on the dashboard and audited later.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">
            Third-party processing
          </h2>
          <p className="mt-2 leading-relaxed">
            Code diffs are sent to Groq for analysis by a large language model. Repository metadata
            is read from GitHub through a GitHub App installation that you authorise and can revoke
            at any time.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">Retention</h2>
          <p className="mt-2 leading-relaxed">
            Retention windows for findings, webhook events, scan results and audit logs are
            configurable per deployment. Because SecureFlow is open source and self-hostable, the
            operator of a given instance controls where data lives and how long it is kept.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">Questions</h2>
          <p className="mt-2 leading-relaxed">
            Raise an issue on the{" "}
            <Link
              href="https://github.com/GauravKarakoti/SecureFlow"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              project repository
            </Link>{" "}
            for anything not covered here.
          </p>
        </section>
      </div>
    </main>
  );
}
