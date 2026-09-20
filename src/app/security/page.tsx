import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Security Policies | SecureFlow",
  description:
    "SecureFlow's security posture, detection policies and vulnerability reporting process.",
};

export default function SecurityPoliciesPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to home
      </Link>

      <h1 className="font-headline mt-8 text-3xl font-bold tracking-tight">Security Policies</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This page is a working draft and is pending review before release.
      </p>

      <div className="mt-10 space-y-8 text-muted-foreground">
        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">
            Detection policies
          </h2>
          <p className="mt-2 leading-relaxed">
            SecureFlow ships with policy templates covering parameterized queries, PII logging,
            SSRF, CORS, unsafe deserialization, weak hashing, public cloud storage, container
            privileges and smart contract reentrancy. Each can be toggled per user or organisation
            from the policy dashboard.
          </p>
          <Link
            href="/dashboard/policies"
            className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline"
          >
            Manage policies
          </Link>
        </section>

        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">
            Prompt injection defence
          </h2>
          <p className="mt-2 leading-relaxed">
            Because scanning sends untrusted code to a language model, the scanner applies policy
            isolation boundaries and pre-filtering before the model sees a diff. The threat model
            and controls are documented in the repository.
          </p>
          <Link
            href="https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/security/prompt-injection.md"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline"
          >
            Read the prompt injection documentation
          </Link>
        </section>

        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">
            Reporting a vulnerability
          </h2>
          <p className="mt-2 leading-relaxed">
            If you find a security issue in SecureFlow itself, please report it privately rather
            than opening a public issue, so it can be fixed before disclosure.
          </p>
          <Link
            href="https://github.com/GauravKarakoti/SecureFlow/security/advisories/new"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline"
          >
            Open a private security advisory
          </Link>
        </section>
      </div>
    </main>
  );
}
