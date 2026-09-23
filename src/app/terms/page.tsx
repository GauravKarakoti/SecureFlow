import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Terms of Service | SecureFlow",
  description: "The terms under which SecureFlow is provided and used.",
};

export default function TermsOfServicePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to home
      </Link>

      <h1 className="font-headline mt-8 text-3xl font-bold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This page is a working draft and is pending review before release.
      </p>

      <div className="mt-10 space-y-8 text-muted-foreground">
        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">Licence</h2>
          <p className="mt-2 leading-relaxed">
            SecureFlow is distributed under the MIT Licence. You are free to use, modify and
            self-host it, subject to the terms in the{" "}
            <Link
              href="https://github.com/GauravKarakoti/SecureFlow/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              LICENSE file
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">Acceptable use</h2>
          <p className="mt-2 leading-relaxed">
            Scan only repositories you own or have been granted access to. Do not use SecureFlow to
            analyse code you are not authorised to read, and do not attempt to use scan output to
            exploit third-party systems.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">No warranty</h2>
          <p className="mt-2 leading-relaxed">
            SecureFlow is an automated aid, not a guarantee. Findings are produced by a language
            model and may include false positives or miss genuine issues. The software is provided
            &ldquo;as is&rdquo;, without warranty of any kind, and should complement rather than
            replace human review.
          </p>
        </section>

        <section>
          <h2 className="font-headline text-lg font-semibold text-foreground">Changes</h2>
          <p className="mt-2 leading-relaxed">
            These terms may be updated as the project develops. Material changes will be noted in
            the project changelog.
          </p>
        </section>
      </div>
    </main>
  );
}
